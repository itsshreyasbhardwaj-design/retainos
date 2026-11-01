import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { harness, must, DAY, T0 } from "./helpers.ts";
import { newId } from "@retainos/shared";
import { upsertActivationDefinition } from "../src/activation.ts";
import { ensureDefaultAlertRules, fireAlert } from "../src/alerts.ts";
import { recordImpact } from "../src/revenue-impact.ts";
import {
  generateBrief, saveBrief, listBriefs, getBrief, executiveBriefToMarkdown,
  type ExecutiveBrief,
} from "../src/copilot.ts";

const TZ = "UTC";

function sectionOf(brief: ExecutiveBrief, id: string) {
  return brief.sections.find((s) => s.id === id)!;
}

/** A project with sound instrumentation and a flat week. */
function quietProject() {
  const h = harness(TZ);
  must(upsertActivationDefinition(h.db, h.scope, {
    name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
    windowDays: 7, isPrimary: true,
  }, T0 - 200 * DAY));
  for (let i = 0; i < 200; i++) {
    h.event(`a${i}`, "signup_completed", T0 - 12 * DAY + i * 1000);
    if (i < 100) h.event(`a${i}`, "project_published", T0 - 11 * DAY + i * 1000);
    h.event(`b${i}`, "signup_completed", T0 - 5 * DAY + i * 1000);
    if (i < 100) h.event(`b${i}`, "project_published", T0 - 4 * DAY + i * 1000);
  }
  ensureDefaultAlertRules(h.db, h, T0 - 100 * DAY);
  return h;
}

describe("structure", () => {
  test("the brief runs with no model, no key and no network", () => {
    const h = quietProject();
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    assert.equal(brief.generator, "rules_v1");
  });

  test("data quality comes before the numbers it would undermine", () => {
    const h = quietProject();
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    assert.equal(brief.sections[0]!.id, "data_quality");
    assert.ok(brief.sections.findIndex((s) => s.id === "what_changed") > 0);
  });

  test("every section is present even when it has nothing to say", () => {
    const h = quietProject();
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    const ids = brief.sections.map((s) => s.id);
    assert.deepEqual(ids, [
      "data_quality", "what_changed", "what_to_do", "attention", "customers", "impact",
    ]);
  });

  test("an empty section says why it is empty instead of showing a blank panel", () => {
    const h = quietProject();
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    const attention = sectionOf(brief, "attention");
    assert.equal(attention.findings.length, 0);
    assert.equal(attention.emptyNote, "No high-severity alerts are open.");
  });

  test("a quiet week is reported as a finding, not as a gap", () => {
    const h = quietProject();
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    assert.match(sectionOf(brief, "what_changed").emptyNote!, /A quiet week is a result, not a gap/);
    assert.match(brief.headline, /Nothing moved far enough to report/);
  });

  test("every finding carries its evidence and a confidence label", () => {
    const h = quietProject();
    // Give it something to report.
    fireAlert(h.db, h, {
      kind: "error_spike", severity: "critical", title: "Import failures up sharply",
      triggeringRule: "error_spike: at least 2x the previous week.",
      metricDetail: "180 occurrences across 42 users.",
      comparisonDetail: "30 occurrences the week before.",
      suggestedAction: "Open the error group.",
      affectedUsers: 42, dedupeKey: "error_spike:fp-1:1",
    }, { timezone: TZ, now: T0 });

    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    for (const s of brief.sections) {
      for (const f of s.findings) {
        assert.ok(f.statement.length > 5, `${s.id} finding has no statement`);
        assert.ok(f.evidence.length > 0, `${s.id} finding has no evidence`);
        assert.ok(["measured", "qualified", "uncertain"].includes(f.confidence));
      }
    }
  });

  test("the disclaimers from each engine travel with the brief", () => {
    const h = quietProject();
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    assert.ok(brief.disclaimers.some((d) => /orders a list/.test(d)));
    assert.ok(brief.disclaimers.some((d) => /never summed/.test(d)));
    assert.ok(brief.disclaimers.some((d) => /not a churn probability/.test(d)));
  });
});

describe("honesty", () => {
  test("a broken instrumentation project is told to start there", () => {
    const h = harness(TZ);
    ensureDefaultAlertRules(h.db, h, T0 - 100 * DAY);
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    assert.match(brief.headline, /Start with the data/);
    assert.ok(sectionOf(brief, "data_quality").findings.length > 0);
  });

  test("an activation move on a thin sample becomes an unknown, not a finding", () => {
    const h = harness(TZ);
    must(upsertActivationDefinition(h.db, h.scope, {
      name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }, T0 - 200 * DAY));
    for (let i = 0; i < 8; i++) {
      h.event(`a${i}`, "signup_completed", T0 - 12 * DAY + i * 1000);
      if (i < 6) h.event(`a${i}`, "project_published", T0 - 11 * DAY + i * 1000);
      h.event(`b${i}`, "signup_completed", T0 - 5 * DAY + i * 1000);
      if (i < 2) h.event(`b${i}`, "project_published", T0 - 4 * DAY + i * 1000);
    }
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    const changed = sectionOf(brief, "what_changed").findings
      .filter((f) => /Activation/.test(f.statement));
    assert.equal(changed.length, 0);
    assert.ok(brief.unknowns.some((u) => /too few to tell a change from noise/.test(u)));
  });

  test("an unconfigured activation definition is named as an unknown", () => {
    const h = harness(TZ);
    for (let i = 0; i < 100; i++) h.event(`u${i}`, "page_viewed", T0 - 3 * DAY + i * 1000);
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    assert.ok(brief.unknowns.some((u) => /cannot say whether users are reaching value/.test(u)));
  });

  test("a real activation fall is reported with both weeks' figures", () => {
    const h = harness(TZ);
    must(upsertActivationDefinition(h.db, h.scope, {
      name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }, T0 - 200 * DAY));
    for (let i = 0; i < 300; i++) {
      h.event(`a${i}`, "signup_completed", T0 - 12 * DAY + i * 1000);
      if (i < 180) h.event(`a${i}`, "project_published", T0 - 11 * DAY + i * 1000);
      h.event(`b${i}`, "signup_completed", T0 - 5 * DAY + i * 1000);
      if (i < 90) h.event(`b${i}`, "project_published", T0 - 4 * DAY + i * 1000);
    }
    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    const finding = sectionOf(brief, "what_changed").findings
      .find((f) => /Activation fell/.test(f.statement));
    assert.ok(finding, "expected an activation finding");
    assert.ok(finding!.evidence[0]!.includes("against"));
  });

  test("impact records keep their classification in the brief", () => {
    const h = quietProject();
    must(recordImpact(h.db, h, {
      label: "Churned MRR among affected accounts",
      classification: "observed",
      basis: {
        billingRecordsForExactEntities: true, randomisedExperimentId: null,
        experimentConclusive: false, assumptions: [], observationalComparison: false, entityCount: 4,
      },
      amountMinor: 3_600_000, currency: "INR",
      method: "Summed from billing rows.",
    }, T0));
    must(recordImpact(h.db, h, {
      label: "Projected uplift",
      classification: "estimated",
      basis: {
        billingRecordsForExactEntities: false, randomisedExperimentId: null,
        experimentConclusive: false,
        assumptions: [{ name: "delta", value: "10%", unit: "pp", source: "default" }],
        observationalComparison: false, entityCount: 40,
      },
      amountMinor: 3_600_000, currency: "INR",
      method: "Model.",
    }, T0));

    const brief = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    const findings = sectionOf(brief, "impact").findings;
    assert.equal(findings.length, 2);
    const observed = findings.find((f) => /observed/.test(f.statement))!;
    const estimated = findings.find((f) => /estimated/.test(f.statement))!;
    assert.equal(observed.confidence, "measured");
    assert.equal(estimated.confidence, "qualified");
    // And no finding claims a combined total.
    assert.ok(!findings.some((f) => /7200000/.test(f.statement)));
  });

  test("an alert in the brief brings its data-quality note with it", () => {
    const h = quietProject();
    fireAlert(h.db, h, {
      kind: "error_spike", severity: "high", title: "Import failures up sharply",
      triggeringRule: "error_spike: at least 2x the previous week.",
      metricDetail: "180 occurrences across 42 users.",
      comparisonDetail: "30 occurrences the week before.",
      suggestedAction: "Open the error group.",
      affectedUsers: 42, dedupeKey: "error_spike:fp-1:1",
    }, { timezone: TZ, now: T0 });
    const finding = sectionOf(brief(h), "attention").findings[0]!;
    assert.equal(finding.evidence.length, 3);
    assert.match(finding.evidence[2]!, /instrumentation/);
  });

  function brief(h: ReturnType<typeof harness>) {
    return generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
  }

  test("low-severity alerts do not reach the brief", () => {
    const h = quietProject();
    fireAlert(h.db, h, {
      kind: "cancellation_increase", severity: "low", title: "Cancellations up slightly",
      triggeringRule: "cancellation_increase.", metricDetail: "8 cancellations.",
      comparisonDetail: "6 the month before.", suggestedAction: "Read the feedback.",
      affectedUsers: 8, dedupeKey: "cancellation_increase:1",
    }, { timezone: TZ, now: T0 });
    assert.equal(sectionOf(brief(h), "attention").findings.length, 0);
  });
});

describe("persistence and rendering", () => {
  test("a brief is saved and read back whole", () => {
    const h = quietProject();
    const generated = generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 });
    const { id } = saveBrief(h.db, h, generated, T0);
    const stored = getBrief(h.db, h.projectId, id)!;
    assert.equal(stored.headline, generated.headline);
    assert.equal(stored.sections.length, generated.sections.length);
    assert.equal(listBriefs(h.db, h.projectId).length, 1);
  });

  test("one project's briefs are invisible to another", () => {
    const a = quietProject();
    const b = quietProject();
    saveBrief(a.db, a, generateBrief(a.db, a.projectId, { timezone: TZ, now: T0 }), T0);
    assert.equal(listBriefs(b.db, b.projectId).length, 0);
  });

  test("the markdown rendering keeps the empty notes and the unknowns", () => {
    const h = quietProject();
    const md = executiveBriefToMarkdown(
      generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 }), "Acme App");
    assert.match(md, /# Acme App/);
    assert.match(md, /## Anything on fire/);
    assert.match(md, /No high-severity alerts are open/);
    assert.match(md, /## What this brief cannot tell you/);
  });

  test("the markdown labels each finding's confidence", () => {
    const h = harness(TZ);
    ensureDefaultAlertRules(h.db, h, T0 - 100 * DAY);
    const md = executiveBriefToMarkdown(
      generateBrief(h.db, h.projectId, { timezone: TZ, now: T0 }), "Acme App");
    assert.match(md, /_\(measured\)_/);
  });
});

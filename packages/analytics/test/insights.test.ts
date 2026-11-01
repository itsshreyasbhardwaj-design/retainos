import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateInsights, persistInsights, listInsights, getInsight, dismissInsight } from "../src/insights.ts";
import { assessConfidence } from "../src/confidence.ts";
import { upsertActivationDefinition } from "../src/activation.ts";
import { clusterFeedback, similarity, tokenise, rebuildClusters, duplicateCandidates } from "../src/clustering.ts";
import { submitFeedback } from "@retainos/database";
import { harness, must, DAY, HOUR, T0 } from "./helpers.ts";

const NOW = T0 + 60 * DAY;

describe("assessConfidence", () => {
  test("refuses to make a claim below the minimum sample", () => {
    const a = assessConfidence({ affectedUsers: 5, effectSize: 0.9 });
    assert.equal(a.label, "insufficient_data");
    assert.match(a.basis, /below the minimum/);
  });

  test("a huge effect on a small sample is only preliminary", () => {
    const a = assessConfidence({ affectedUsers: 30, effectSize: 0.9, periodComplete: true });
    assert.equal(a.label, "preliminary_observation");
  });

  test("a large sample with a large effect is strong", () => {
    const a = assessConfidence({ affectedUsers: 500, population: 1000, effectSize: 0.3, periodComplete: true });
    assert.equal(a.label, "strong_supporting_evidence");
  });

  test("corroboration raises a moderate effect to strong at scale", () => {
    const plain = assessConfidence({ affectedUsers: 400, effectSize: 0.15, periodComplete: true });
    const corroborated = assessConfidence({ affectedUsers: 400, effectSize: 0.15, corroborated: true, periodComplete: true });
    assert.equal(plain.label, "moderate_supporting_evidence");
    assert.equal(corroborated.label, "strong_supporting_evidence");
  });

  test("an incomplete period caps confidence at preliminary", () => {
    const a = assessConfidence({ affectedUsers: 5000, effectSize: 0.5, periodComplete: false });
    assert.equal(a.label, "preliminary_observation");
    assert.match(a.basis, /not fully elapsed/);
  });

  test("always states the thresholds it used", () => {
    const a = assessConfidence({ affectedUsers: 100, effectSize: 0.2, periodComplete: true });
    assert.match(a.basis, /Thresholds:/);
    assert.match(a.basis, /not statistical confidence intervals/);
  });
});

describe("generateInsights", () => {
  function projectWithFunnel() {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "First project", activationEvent: "project_created", windowDays: 7, isPrimary: true,
    }));
    // 500 signups, 400 start onboarding, 150 complete, 120 activate.
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 500; i++) {
      h.event(`u${i}`, "signup_completed", base + i * 1000);
      if (i < 400) h.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
      if (i < 150) h.event(`u${i}`, "onboarding_completed", base + i * 1000 + 2 * HOUR);
      if (i < 120) h.event(`u${i}`, "project_created", base + i * 1000 + 3 * HOUR);
    }
    return h;
  }

  test("finds the largest activation drop-off", () => {
    const h = projectWithFunnel();
    const insights = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW });
    const drop = insights.find((i) => i.kind === "activation_drop_off")!;
    assert.ok(drop);
    // The biggest loss is onboarding_started -> onboarding_completed (250).
    assert.match(drop.title, /Onboarding started → Onboarding completed/);
    assert.equal(drop.affectedUsers, 250);
  });

  test("keeps observation and hypotheses strictly separate", () => {
    const h = projectWithFunnel();
    const drop = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW })
      .find((i) => i.kind === "activation_drop_off")!;
    // The observation is a measurement with numbers and no speculation.
    assert.match(drop.observation, /\d+ of \d+ users/);
    assert.ok(!/\bmay\b|\bmight\b|\bprobably\b|\blikely\b/i.test(drop.observation),
      `observation must not speculate: "${drop.observation}"`);
    // Hypotheses are hedged guesses.
    assert.ok(drop.hypotheses.length >= 3);
    assert.ok(drop.hypotheses.every((hy) => /\bmay\b|\bmight\b/i.test(hy)),
      "every hypothesis must read as a guess");
  });

  test("always states limitations and never claims a cause", () => {
    const h = projectWithFunnel();
    const drop = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW })
      .find((i) => i.kind === "activation_drop_off")!;
    assert.ok(drop.limitations.some((l) => /not why/.test(l) || /establishes a cause/.test(l)));
    assert.ok(drop.suggestedInvestigation.length >= 3);
  });

  test("attaches evidence with a frozen snapshot", () => {
    const h = projectWithFunnel();
    const drop = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW })
      .find((i) => i.kind === "activation_drop_off")!;
    assert.equal(drop.evidence[0]!.kind, "funnel_step");
    const snap = drop.evidence[0]!.snapshot;
    assert.equal(snap.fromUsers, 400);
    assert.equal(snap.toUsers, 150);
    assert.equal(snap.lostUsers, 250);
  });

  test("records that a rule engine, not a model, produced it", () => {
    const h = projectWithFunnel();
    for (const i of generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW })) {
      assert.equal(i.generator, "rules_v1");
    }
  });

  test("reports an activation decline against the prior period", () => {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "First project", activationEvent: "project_created", windowDays: 7, isPrimary: true,
    }));
    // Prior 28-day window: 60% activation. Current window: 20%.
    const priorBase = NOW - 50 * DAY;
    for (let i = 0; i < 100; i++) {
      h.event(`p${i}`, "signup_completed", priorBase + i * 1000);
      if (i < 60) h.event(`p${i}`, "project_created", priorBase + i * 1000 + HOUR);
    }
    const currentBase = NOW - 20 * DAY;
    for (let i = 0; i < 100; i++) {
      h.event(`c${i}`, "signup_completed", currentBase + i * 1000);
      if (i < 20) h.event(`c${i}`, "project_created", currentBase + i * 1000 + HOUR);
    }
    const insights = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW, lookbackDays: 28 });
    const decline = insights.find((i) => i.kind === "activation_declined")!;
    assert.ok(decline, `expected a decline insight, got: ${insights.map((i) => i.kind).join(", ")}`);
    assert.match(decline.title, /fell by 40\.0 points/);
    assert.ok(decline.limitations.some((l) => /not a controlled experiment/.test(l)));
  });

  test("stays quiet when a change is too small to matter", () => {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "First project", activationEvent: "project_created", windowDays: 7, isPrimary: true,
    }));
    for (const [prefix, base, converts] of [["p", NOW - 50 * DAY, 50], ["c", NOW - 20 * DAY, 52]] as const) {
      for (let i = 0; i < 100; i++) {
        h.event(`${prefix}${i}`, "signup_completed", base + i * 1000);
        if (i < converts) h.event(`${prefix}${i}`, "project_created", base + i * 1000 + HOUR);
      }
    }
    const insights = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW, lookbackDays: 28 });
    assert.ok(!insights.some((i) => i.kind === "activation_declined" || i.kind === "activation_improved"),
      "a 2-point move must not be reported as a finding");
  });

  test("flags poor instrumentation health", () => {
    const h = harness("UTC");
    for (let i = 0; i < 50; i++) {
      h.db.run(
        `INSERT INTO event_rejections (id, org_id, project_id, received_at, event_name, reason, detail)
         VALUES (?, ?, ?, ?, 'BadName', 'invalid_event_name', '{}')`,
        [`rej_${i}`, h.orgId, h.projectId, NOW - DAY],
      );
    }
    h.event("u1", "signup_completed", NOW - DAY);
    const insights = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW });
    const health = insights.find((i) => i.kind === "instrumentation_health")!;
    assert.ok(health);
    assert.match(health.observation, /invalid_event_name/);
    assert.ok(health.limitations.some((l) => /incomplete data/.test(l)));
  });

  test("findings are ordered by severity", () => {
    const h = projectWithFunnel();
    const insights = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW });
    for (let i = 1; i < insights.length; i++) {
      assert.ok(insights[i - 1]!.severity >= insights[i]!.severity);
    }
  });

  test("an empty project produces no findings rather than invented ones", () => {
    const h = harness("UTC");
    assert.deepEqual(generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW }), []);
  });
});

describe("persistInsights", () => {
  test("stores findings with their evidence and records the run", () => {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "A", activationEvent: "project_created", windowDays: 7, isPrimary: true,
    }));
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 300; i++) {
      h.event(`u${i}`, "signup_completed", base + i * 1000);
      if (i < 90) h.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
    }
    const generated = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW });
    const r = persistInsights(h.db, { orgId: h.orgId, projectId: h.projectId }, generated, NOW);
    assert.ok(r.created > 0);
    const rows = listInsights(h.db, h.projectId);
    assert.equal(rows.length, r.created);
    const run = h.db.get<{ generator: string; insights_created: number }>(
      "SELECT generator, insights_created FROM analysis_runs WHERE id = ?", [r.runId],
    )!;
    assert.equal(run.generator, "rules_v1");
    assert.equal(run.insights_created, r.created);
  });

  test("the same finding is not stored twice", () => {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "A", activationEvent: "project_created", windowDays: 7, isPrimary: true,
    }));
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 300; i++) {
      h.event(`u${i}`, "signup_completed", base + i * 1000);
      if (i < 90) h.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
    }
    const generated = generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW });
    const first = persistInsights(h.db, { orgId: h.orgId, projectId: h.projectId }, generated, NOW);
    const second = persistInsights(h.db, { orgId: h.orgId, projectId: h.projectId }, generated, NOW + 1000);
    assert.equal(second.created, 0);
    assert.equal(second.skipped, first.created);
  });

  test("a finding can be fetched with evidence and dismissed", () => {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "A", activationEvent: "project_created", windowDays: 7, isPrimary: true,
    }));
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 300; i++) {
      h.event(`u${i}`, "signup_completed", base + i * 1000);
      if (i < 90) h.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
    }
    persistInsights(h.db, { orgId: h.orgId, projectId: h.projectId },
      generateInsights(h.db, h.projectId, { timezone: "UTC", now: NOW }), NOW);
    const row = listInsights(h.db, h.projectId)[0] as Record<string, unknown>;
    const detail = getInsight(h.db, h.projectId, String(row.id))!;
    assert.ok(detail.evidence.length > 0);
    assert.equal(dismissInsight(h.db, h.projectId, String(row.id), NOW), true);
    assert.equal(listInsights(h.db, h.projectId).length, 0);
    assert.equal(listInsights(h.db, h.projectId, { includeDismissed: true }).length, 1);
    assert.equal(dismissInsight(h.db, h.projectId, String(row.id), NOW), false, "dismissing twice is a no-op");
  });
});

describe("feedback clustering", () => {
  test("tokenises away stop words and punctuation", () => {
    const tokens = tokenise("The export button is BROKEN on the settings page!");
    assert.ok(tokens.includes("export"));
    assert.ok(tokens.includes("broken"));
    assert.ok(tokens.includes("settings"));
    assert.ok(!tokens.includes("the"));
    assert.ok(!tokens.includes("is"));
    assert.ok(!tokens.includes("page"), "'page' is a stop word here: it appears in nearly every report");
  });

  test("similarity is symmetric and bounded", () => {
    const a = new Set(["export", "broken", "csv"]);
    const b = new Set(["export", "csv"]);
    assert.equal(similarity(a, b), similarity(b, a));
    assert.equal(similarity(a, a), 1);
    assert.equal(similarity(a, new Set()), 0);
    assert.ok(similarity(a, b) > 0 && similarity(a, b) < 1);
  });

  test("groups reports describing the same problem", () => {
    const clusters = clusterFeedback([
      { id: "1", title: "CSV export is broken", body: "The CSV export fails with an error every time" },
      { id: "2", title: "Export to CSV fails", body: "CSV export broken, shows an error" },
      { id: "3", title: "CSV export error", body: "Cannot export CSV, error appears" },
      { id: "4", title: "Dark mode request", body: "Please add a dark theme to the dashboard" },
    ]);
    const exportCluster = clusters.find((c) => c.itemIds.length >= 3);
    assert.ok(exportCluster, `expected an export cluster, got ${JSON.stringify(clusters.map((c) => c.itemIds))}`);
    assert.deepEqual(exportCluster!.itemIds.sort(), ["1", "2", "3"]);
    assert.ok(exportCluster!.keywords.includes("csv") || exportCluster!.keywords.includes("export"));
    // The unrelated request must not be swept in.
    assert.ok(!exportCluster!.itemIds.includes("4"));
  });

  test("does not group unrelated reports", () => {
    const clusters = clusterFeedback([
      { id: "1", title: "Dark mode please", body: "Add a dark theme" },
      { id: "2", title: "Billing invoice wrong", body: "My invoice shows the wrong amount" },
      { id: "3", title: "Slow dashboard", body: "The dashboard takes ages to load" },
    ]);
    assert.deepEqual(clusters, [], "three unrelated items should form no cluster");
  });

  test("rebuildClusters persists groups and is repeatable", () => {
    const h = harness("UTC");
    const ids = { orgId: h.orgId, projectId: h.projectId };
    for (const [title, body] of [
      ["CSV export is broken", "The CSV export fails with an error"],
      ["Export to CSV fails", "CSV export broken with an error"],
      ["CSV export error", "Cannot export CSV, error shown"],
    ] as const) {
      must(submitFeedback(h.db, ids, { kind: "bug", title, body, source: "widget" }));
    }
    const first = rebuildClusters(h.db, ids, {}, NOW);
    assert.equal(first.clusters, 1);
    assert.equal(first.itemsGrouped, 3);
    // Running again replaces machine clusters rather than accumulating them.
    const second = rebuildClusters(h.db, ids, {}, NOW + 1000);
    assert.equal(second.clusters, 1);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM feedback_clusters")!.n, 1);
  });

  test("a human-edited cluster survives a rebuild", () => {
    const h = harness("UTC");
    const ids = { orgId: h.orgId, projectId: h.projectId };
    h.db.run(
      `INSERT INTO feedback_clusters (id, org_id, project_id, label, keywords, item_count, edited_by_human, created_at, updated_at)
       VALUES ('fcl_human', ?, ?, 'Curated theme', '[]', 0, 1, ?, ?)`,
      [h.orgId, h.projectId, NOW, NOW],
    );
    rebuildClusters(h.db, ids, {}, NOW);
    assert.ok(h.db.get("SELECT 1 FROM feedback_clusters WHERE id = 'fcl_human'"),
      "a cluster a human curated must not be deleted by the automatic rebuild");
  });

  test("duplicateCandidates suggests near-identical reports", () => {
    const h = harness("UTC");
    const ids = { orgId: h.orgId, projectId: h.projectId };
    const a = must(submitFeedback(h.db, ids, {
      kind: "bug", title: "CSV export is broken", body: "The CSV export fails with an error", source: "widget",
    }));
    must(submitFeedback(h.db, ids, {
      kind: "bug", title: "CSV export broken", body: "CSV export fails with an error", source: "widget",
    }));
    must(submitFeedback(h.db, ids, {
      kind: "feature_request", title: "Dark mode", body: "Please add a dark theme", source: "widget",
    }));
    const candidates = duplicateCandidates(h.db, h.projectId, a.id);
    assert.equal(candidates.length, 1);
    assert.ok(candidates[0]!.similarity > 0.3);
    assert.match(candidates[0]!.title, /CSV export broken/);
  });
});

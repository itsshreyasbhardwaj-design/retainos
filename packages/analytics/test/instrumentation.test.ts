import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, DAY, T0, must } from "./helpers.ts";
import { upsertActivationDefinition } from "../src/activation.ts";
import {
  runInstrumentationDoctor, persistFindings, listFindings, type Finding,
} from "../src/instrumentation.ts";
import { newId } from "@retainos/shared";

function run(h: ReturnType<typeof harness>, now = T0, windowDays = 14) {
  return runInstrumentationDoctor(h.db, h.projectId, { timezone: h.timezone, now, windowDays });
}

function find(findings: Finding[], checkId: string): Finding | undefined {
  return findings.find((f) => f.checkId === checkId);
}

// --- the empty project -----------------------------------------------------

test("an empty project is told it has no events, not that it is healthy", () => {
  const h = harness();
  const report = run(h);
  const f = find(report.findings, "no_events");
  assert.ok(f, "expected a no_events finding");
  assert.equal(f.severity, "blocking");
  assert.equal(report.healthy, false);
});

test("an empty project is not accused of an undefined activation event", () => {
  const h = harness();
  const report = run(h);
  // Nagging a project that has not started yet is noise, not diagnosis.
  assert.equal(find(report.findings, "activation_undefined"), undefined);
});

// --- activation ------------------------------------------------------------

test("events arriving with no activation definition is blocking", () => {
  const h = harness();
  h.event("u1", "page_viewed", T0 - DAY);
  const report = run(h);
  const f = find(report.findings, "activation_undefined");
  assert.ok(f);
  assert.equal(f.severity, "blocking");
});

test("an activation event that never arrives is named as an instrumentation gap", () => {
  const h = harness();
  h.event("u1", "signup_completed", T0 - DAY);
  must(upsertActivationDefinition(h.db, h.scope, {
    name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
    windowDays: 14, isPrimary: true,
  }));
  const report = run(h);
  const f = find(report.findings, "activation_event_never_seen");
  assert.ok(f);
  assert.equal(f.severity, "blocking");
  assert.match(f.title, /project_published/);
  // The whole point: it must say the 0% is a gap, not a product failure.
  assert.match(f.whyItMatters, /instrumentation gap/);
  assert.equal(f.evidence.occurrences, 0);
});

test("a correctly instrumented activation definition raises nothing", () => {
  const h = harness();
  h.event("u1", "signup_completed", T0 - 2 * DAY);
  h.event("u1", "project_published", T0 - DAY);
  must(upsertActivationDefinition(h.db, h.scope, {
    name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
    windowDays: 14, isPrimary: true,
  }));
  const report = run(h);
  assert.equal(find(report.findings, "activation_event_never_seen"), undefined);
  assert.equal(find(report.findings, "signup_event_never_seen"), undefined);
});

test("both a missing signup event and a missing activation event are reported", () => {
  const h = harness();
  h.event("u1", "page_viewed", T0 - DAY);
  must(upsertActivationDefinition(h.db, h.scope, {
    name: "Core", activationEvent: "project_published", signupEvent: "account_created",
    windowDays: 14, isPrimary: true,
  }));
  const report = run(h);
  assert.ok(find(report.findings, "activation_event_never_seen"));
  assert.ok(find(report.findings, "signup_event_never_seen"));
});

// --- rejection rate --------------------------------------------------------

function reject(h: ReturnType<typeof harness>, reason: string, at: number, n: number) {
  for (let i = 0; i < n; i++) {
    h.db.run(
      `INSERT INTO event_rejections (id, org_id, project_id, received_at, event_name, reason, detail)
       VALUES (?, ?, ?, ?, ?, ?, '{}')`,
      [newId("rej"), h.orgId, h.projectId, at, "Bad Event", reason],
    );
  }
}

test("a high rejection rate is blocking and names the dominant reason", () => {
  const h = harness();
  for (let i = 0; i < 20; i++) h.event(`u${i}`, "page_viewed", T0 - DAY);
  reject(h, "invalid_event_name", T0 - DAY, 60);
  reject(h, "schema_violation", T0 - DAY, 5);
  const report = run(h);
  const f = find(report.findings, "high_rejection_rate");
  assert.ok(f);
  assert.equal(f.severity, "blocking");
  assert.match(f.detail, /invalid_event_name/);
});

test("a modest rejection rate is a warning, not blocking", () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.event(`u${i}`, "page_viewed", T0 - DAY);
  reject(h, "schema_violation", T0 - DAY, 12);
  const f = find(run(h).findings, "high_rejection_rate");
  assert.ok(f);
  assert.equal(f.severity, "warning");
});

test("a handful of rejections is not reported at all", () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.event(`u${i}`, "page_viewed", T0 - DAY);
  reject(h, "schema_violation", T0 - DAY, 3);
  assert.equal(find(run(h).findings, "high_rejection_rate"), undefined);
});

test("rejections outside the window do not count against the current report", () => {
  const h = harness();
  for (let i = 0; i < 50; i++) h.event(`u${i}`, "page_viewed", T0 - DAY);
  reject(h, "schema_violation", T0 - 90 * DAY, 500);
  assert.equal(find(run(h).findings, "high_rejection_rate"), undefined);
});

// --- name variants ---------------------------------------------------------

test("the same event in two spellings is reported as a split funnel risk", () => {
  const h = harness();
  h.event("u1", "project_published", T0 - DAY);
  h.event("u2", "projectPublished", T0 - DAY);
  const f = find(run(h).findings, "event_name_variants");
  assert.ok(f);
  assert.match(f.detail, /project_published/);
  assert.match(f.detail, /projectPublished/);
});

test("genuinely different event names are not flagged as variants", () => {
  const h = harness();
  h.event("u1", "project_published", T0 - DAY);
  h.event("u2", "project_deleted", T0 - DAY);
  assert.equal(find(run(h).findings, "event_name_variants"), undefined);
});

// --- identity --------------------------------------------------------------

test("mostly anonymous identities is a warning about joinability", () => {
  const h = harness();
  for (let i = 0; i < 30; i++) h.event(`u${i}`, "page_viewed", T0 - DAY);
  // The harness always sets external_id; strip most of them to simulate a
  // project that never calls identify().
  h.db.run(
    `UPDATE identities SET external_id = NULL
      WHERE project_id = ? AND id IN (SELECT id FROM identities WHERE project_id = ? LIMIT 27)`,
    [h.projectId, h.projectId],
  );
  const f = find(run(h).findings, "low_identity_linking");
  assert.ok(f);
  assert.equal(f.severity, "warning");
  assert.match(f.whyItMatters, /cannot be joined/);
});

test("a fully identified project raises no identity warning", () => {
  const h = harness();
  for (let i = 0; i < 30; i++) h.event(`u${i}`, "page_viewed", T0 - DAY);
  assert.equal(find(run(h).findings, "low_identity_linking"), undefined);
});

test("a tiny project is not judged on its identity ratio", () => {
  const h = harness();
  for (let i = 0; i < 5; i++) h.event(`u${i}`, "page_viewed", T0 - DAY);
  h.db.run("UPDATE identities SET external_id = NULL WHERE project_id = ?", [h.projectId]);
  assert.equal(find(run(h).findings, "low_identity_linking"), undefined);
});

// --- volume ----------------------------------------------------------------

test("a collapse in event volume is called out as probably broken tracking", () => {
  const h = harness();
  for (let i = 0; i < 400; i++) h.event(`u${i % 40}`, "page_viewed", T0 - 20 * DAY);
  for (let i = 0; i < 20; i++) h.event(`u${i % 40}`, "page_viewed", T0 - 2 * DAY);
  const f = find(run(h).findings, "volume_collapse");
  assert.ok(f);
  assert.equal(f.severity, "blocking");
  assert.match(f.whyItMatters, /broken deploy|removed SDK call|consent/);
});

test("steady volume is not reported as a collapse", () => {
  const h = harness();
  for (let i = 0; i < 200; i++) h.event(`u${i % 20}`, "page_viewed", T0 - 20 * DAY);
  for (let i = 0; i < 190; i++) h.event(`u${i % 20}`, "page_viewed", T0 - 2 * DAY);
  assert.equal(find(run(h).findings, "volume_collapse"), undefined);
});

test("a brand-new project with no prior window is not accused of a collapse", () => {
  const h = harness();
  for (let i = 0; i < 50; i++) h.event(`u${i}`, "page_viewed", T0 - DAY);
  assert.equal(find(run(h).findings, "volume_collapse"), undefined);
});

// --- clock skew ------------------------------------------------------------

test("timestamp rejections are explained as loss rather than misplacement", () => {
  const h = harness();
  h.event("u1", "page_viewed", T0 - DAY);
  reject(h, "timestamp_out_of_range", T0 - DAY, 9);
  const f = find(run(h).findings, "clock_skew");
  assert.ok(f);
  assert.match(f.whyItMatters, /rather than clamping/);
});

// --- experiments -----------------------------------------------------------

test("a running experiment with no exposures is blocking", () => {
  const h = harness();
  h.event("u1", "page_viewed", T0 - DAY);
  h.db.run(
    `INSERT INTO experiments
      (id, org_id, project_id, key, name, hypothesis, status, primary_metric_event,
       started_at, created_at, updated_at)
     VALUES (?, ?, ?, 'new_onboarding', 'New onboarding', 'It will help', 'running',
             'project_published', ?, ?, ?)`,
    [newId("exp"), h.orgId, h.projectId, T0 - 10 * DAY, T0 - 10 * DAY, T0 - 10 * DAY],
  );
  const f = find(run(h).findings, "experiment_without_exposure");
  assert.ok(f);
  assert.equal(f.severity, "blocking");
  assert.match(f.whyItMatters, /exposures, not assignments/);
});

test("a draft experiment with no exposures is not a problem", () => {
  const h = harness();
  h.event("u1", "page_viewed", T0 - DAY);
  h.db.run(
    `INSERT INTO experiments
      (id, org_id, project_id, key, name, hypothesis, status, primary_metric_event,
       created_at, updated_at)
     VALUES (?, ?, ?, 'later', 'Later', 'Maybe', 'draft', 'project_published', ?, ?)`,
    [newId("exp"), h.orgId, h.projectId, T0 - DAY, T0 - DAY],
  );
  assert.equal(find(run(h).findings, "experiment_without_exposure"), undefined);
});

// --- revenue ---------------------------------------------------------------

function subscription(h: ReturnType<typeof harness>, identityId: string | null) {
  h.db.run(
    `INSERT INTO customer_subscriptions
      (id, org_id, project_id, provider, external_id, identity_id, plan_name, status,
       amount_minor, currency, interval, started_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, 'Pro', 'active', 900000, 'INR', 'month', ?, ?)`,
    [newId("sub"), h.orgId, h.projectId, newId("ext"), identityId, T0 - 60 * DAY, T0 - DAY],
  );
}

test("subscriptions that cannot be joined to a user are reported", () => {
  const h = harness();
  h.event("u1", "page_viewed", T0 - DAY);
  const identityId = h.db.get<{ id: string }>(
    "SELECT id FROM identities WHERE project_id = ?", [h.projectId])!.id;
  subscription(h, identityId);
  for (let i = 0; i < 4; i++) subscription(h, null);
  const f = find(run(h).findings, "unlinked_subscriptions");
  assert.ok(f);
  assert.equal(f.evidence.unlinked, 4);
  assert.match(f.whyItMatters, /understate/);
});

test("fully linked subscriptions raise nothing", () => {
  const h = harness();
  h.event("u1", "page_viewed", T0 - DAY);
  const identityId = h.db.get<{ id: string }>(
    "SELECT id FROM identities WHERE project_id = ?", [h.projectId])!.id;
  subscription(h, identityId);
  assert.equal(find(run(h).findings, "unlinked_subscriptions"), undefined);
});

// --- severity ordering and summary ----------------------------------------

test("findings are ordered blocking first", () => {
  const h = harness();
  h.event("u1", "project_published", T0 - DAY);
  h.event("u2", "projectPublished", T0 - DAY);
  const ranks = run(h).findings.map((f) => f.severity);
  const order = { blocking: 0, warning: 1, advisory: 2 } as const;
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(order[ranks[i - 1]!] <= order[ranks[i]!], `out of order at ${i}`);
  }
});

test("every finding carries all five explanation fields", () => {
  const h = harness();
  h.event("u1", "project_published", T0 - DAY);
  h.event("u2", "projectPublished", T0 - DAY);
  reject(h, "schema_violation", T0 - DAY, 40);
  for (const f of run(h).findings) {
    for (const key of ["title", "detail", "whyItMatters", "suggestedFix", "howToVerify"] as const) {
      assert.ok(f[key].length > 10, `${f.checkId} has a thin ${key}`);
    }
  }
});

test("a healthy project is told so rather than given invented problems", () => {
  const h = harness();
  must(upsertActivationDefinition(h.db, h.scope, {
    name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
    windowDays: 14, isPrimary: true,
  }));
  for (let i = 0; i < 150; i++) {
    h.event(`u${i}`, "signup_completed", T0 - 20 * DAY + i * 1000);
    h.event(`u${i}`, "project_published", T0 - 19 * DAY + i * 1000);
  }
  for (let i = 0; i < 150; i++) {
    h.event(`u${i}`, "page_viewed", T0 - 5 * DAY + i * 1000);
    h.event(`u${i}`, "page_viewed", T0 - 4 * DAY + i * 1000);
  }
  const report = run(h);
  const serious = report.findings.filter((f) => f.severity !== "advisory");
  assert.deepEqual(serious.map((f) => f.checkId), []);
  assert.equal(report.healthy, true);
  assert.match(report.summary, /checks passed/);
});

test("the report says how many checks it ran", () => {
  const h = harness();
  const report = run(h);
  assert.ok(report.checksRun >= 12, `expected at least 12 checks, got ${report.checksRun}`);
});

// --- persistence -----------------------------------------------------------

test("findings persist and re-running does not duplicate them", () => {
  const h = harness();
  h.event("u1", "project_published", T0 - DAY);
  h.event("u2", "projectPublished", T0 - DAY);
  const first = persistFindings(h.db, h, run(h), T0);
  assert.ok(first.created > 0);
  const second = persistFindings(h.db, h, run(h), T0 + 1000);
  assert.equal(second.created, 0);
  const open = listFindings(h.db, h.projectId);
  assert.equal(open.length, first.created);
});

test("a check that stops firing is resolved rather than left open", () => {
  const h = harness();
  h.event("u1", "project_published", T0 - DAY);
  h.event("u2", "projectPublished", T0 - DAY);
  persistFindings(h.db, h, run(h), T0);
  assert.ok(listFindings(h.db, h.projectId).some((f: any) => f.check_id === "event_name_variants"));

  // Fix the spelling at the source; the finding should clear.
  h.db.run("UPDATE analytics_events SET name = 'project_published' WHERE project_id = ?", [h.projectId]);
  const again = persistFindings(h.db, h, run(h), T0 + 1000);
  assert.ok(again.resolved > 0);
  assert.ok(!listFindings(h.db, h.projectId).some((f: any) => f.check_id === "event_name_variants"));
  assert.ok(listFindings(h.db, h.projectId, true).some((f: any) => f.check_id === "event_name_variants"));
});

test("the doctor never reads another project's data", () => {
  const a = harness();
  const b = harness();
  for (let i = 0; i < 20; i++) a.event(`u${i}`, "page_viewed", T0 - DAY);
  const report = runInstrumentationDoctor(b.db, b.projectId, { timezone: "UTC", now: T0 });
  assert.ok(find(report.findings, "no_events"), "b should still look empty");
});

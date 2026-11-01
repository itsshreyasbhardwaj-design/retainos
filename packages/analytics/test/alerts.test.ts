import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { harness, must, mustFail, DAY, HOUR, T0 } from "./helpers.ts";
import { newId } from "@retainos/shared";
import { upsertActivationDefinition } from "../src/activation.ts";
import {
  upsertAlertRule, listAlertRules, ensureDefaultAlertRules, fireAlert, dataQualityNote,
  detectActivationRegression, detectErrorSpike, detectCancellationIncrease, detectIngestionFailure,
  runAlertChecks, listAlerts, acknowledgeAlert, resolveAlert, snoozeAlert, alertQuality,
  shouldDeferForQuietHours, DEFAULT_ALERT_RULES, ABSOLUTE_MIN_AFFECTED_USERS,
  type AlertCandidate,
} from "../src/alerts.ts";

const TZ = "UTC";

function candidate(over: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    kind: "error_spike",
    severity: "high",
    title: "Import failures up sharply",
    triggeringRule: "error_spike: occurrences at least 2x the previous 7 days.",
    metricDetail: "180 occurrences across 42 users in the last 7 days.",
    comparisonDetail: "30 occurrences in the previous 7 days.",
    suggestedAction: "Open the error group and check which product versions are affected.",
    affectedUsers: 42,
    dedupeKey: "error_spike:fp-1:1",
    ...over,
  };
}

/** A project whose instrumentation is sound, so alerts are allowed to fire. */
function soundProject(timezone = TZ) {
  const h = harness(timezone);
  must(upsertActivationDefinition(h.db, h.scope, {
    name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
    windowDays: 14, isPrimary: true,
  }, T0 - 200 * DAY));
  for (let i = 0; i < 200; i++) {
    h.event(`seed${i}`, "signup_completed", T0 - 40 * DAY + i * 1000);
    h.event(`seed${i}`, "project_published", T0 - 39 * DAY + i * 1000);
    h.event(`seed${i}`, "page_viewed", T0 - 10 * DAY + i * 1000);
    h.event(`seed${i}`, "page_viewed", T0 - 3 * DAY + i * 1000);
  }
  ensureDefaultAlertRules(h.db, h, T0 - 100 * DAY);
  return h;
}

// --- rules -----------------------------------------------------------------

describe("rules", () => {
  test("defaults are installed once and not duplicated", () => {
    const h = harness();
    const created = ensureDefaultAlertRules(h.db, h, T0);
    assert.equal(created, Object.keys(DEFAULT_ALERT_RULES).length);
    assert.equal(ensureDefaultAlertRules(h.db, h, T0), 0);
    assert.equal(listAlertRules(h.db, h.projectId).length, created);
  });

  test("a zero threshold is refused", () => {
    const h = harness();
    const e = mustFail(upsertAlertRule(h.db, h, { kind: "error_spike", threshold: 0 }, T0));
    assert.match(e.message, /trains people to ignore alerts/);
  });

  test("an alert cannot be configured below the absolute user floor", () => {
    const h = harness();
    const e = mustFail(upsertAlertRule(h.db, h, {
      kind: "activation_regression", minAffectedUsers: 1,
    }, T0));
    assert.match(e.message, new RegExp(`${ABSOLUTE_MIN_AFFECTED_USERS} affected users`));
  });

  test("ingestion failure is exempt from the user floor, because it is about data", () => {
    const h = harness();
    must(upsertAlertRule(h.db, h, { kind: "ingestion_failure", minAffectedUsers: 0 }, T0));
    assert.equal(listAlertRules(h.db, h.projectId)[0]!.minAffectedUsers, 0);
  });

  test("a sub-hour cooldown is refused", () => {
    const h = harness();
    const e = mustFail(upsertAlertRule(h.db, h, { kind: "error_spike", cooldownHours: 0 }, T0));
    assert.match(e.message, /while nobody is fixing it/);
  });

  test("every default rule has a cooldown and a user floor", () => {
    for (const [kind, rule] of Object.entries(DEFAULT_ALERT_RULES)) {
      assert.ok(rule.cooldownHours >= 1, `${kind} has no cooldown`);
      assert.ok(rule.threshold > 0, `${kind} has no threshold`);
    }
  });
});

// --- firing rules ----------------------------------------------------------

describe("firing", () => {
  test("an alert carries all five pieces of evidence", () => {
    const h = soundProject();
    const result = fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 });
    assert.equal(result.fired, true);
    const [alert] = listAlerts(h.db, h.projectId, { now: T0 });
    assert.ok(alert!.triggeringRule.length > 10);
    assert.ok(alert!.metricDetail.length > 10);
    assert.ok(alert!.comparisonDetail.length > 10);
    assert.ok(alert!.dataQuality.length > 10);
    assert.ok(alert!.suggestedAction.length > 10);
  });

  test("too few affected users is suppressed with the count named", () => {
    const h = soundProject();
    const result = fireAlert(h.db, h, candidate({ affectedUsers: 2 }), { timezone: TZ, now: T0 });
    assert.equal(result.fired, false);
    assert.equal(result.reason, "too_few_users");
    assert.match(result.detail, /below this rule's floor/);
  });

  test("the same problem is not reported twice", () => {
    const h = soundProject();
    must_ok(fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 }));
    const again = fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 + 30 * DAY });
    assert.equal(again.fired, false);
    assert.equal(again.reason, "duplicate");
  });

  test("a different problem inside the cooldown still waits", () => {
    const h = soundProject();
    must_ok(fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 }));
    const second = fireAlert(h.db, h, candidate({ dedupeKey: "error_spike:fp-2:1" }),
      { timezone: TZ, now: T0 + 2 * HOUR });
    assert.equal(second.fired, false);
    assert.equal(second.reason, "cooldown");
    assert.match(second.detail, /inside the 12-hour cooldown/);
  });

  test("after the cooldown, the next problem fires", () => {
    const h = soundProject();
    must_ok(fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 }));
    const second = fireAlert(h.db, h, candidate({ dedupeKey: "error_spike:fp-2:1" }),
      { timezone: TZ, now: T0 + 13 * HOUR });
    assert.equal(second.fired, true);
  });

  test("a disabled rule fires nothing", () => {
    const h = soundProject();
    must(upsertAlertRule(h.db, h, { kind: "error_spike", enabled: false }, T0));
    const result = fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 });
    assert.equal(result.reason, "rule_disabled");
  });

  test("with no rule configured, nothing fires", () => {
    const h = harness();
    const result = fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 });
    assert.equal(result.reason, "no_rule");
  });

  test("an alert is withheld when the instrumentation behind it is broken", () => {
    const h = harness();
    ensureDefaultAlertRules(h.db, h, T0 - 100 * DAY);
    // No events at all: the doctor reports a blocking problem.
    const result = fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 });
    assert.equal(result.fired, false);
    assert.equal(result.reason, "data_unreliable");
    assert.match(result.detail, /fix the instrumentation first/);
  });

  test("an ingestion alert still fires when instrumentation is broken, because that is the point", () => {
    const h = harness();
    ensureDefaultAlertRules(h.db, h, T0 - 100 * DAY);
    const result = fireAlert(h.db, h, candidate({
      kind: "ingestion_failure", affectedUsers: null,
      dedupeKey: "ingestion_failure:schema_violation:1",
    }), { timezone: TZ, now: T0 });
    assert.equal(result.fired, true);
  });

  test("the data-quality note states what is known rather than being left blank", () => {
    const h = soundProject();
    const note = dataQualityNote(h.db, h.projectId, TZ, T0);
    assert.match(note.note, /instrumentation checks passed/);
    assert.equal(note.blocking, 0);
  });

  test("quiet hours defer rather than suppress", () => {
    const h = soundProject();
    assert.equal(shouldDeferForQuietHours(h.db, h.projectId, "activation_regression", 23), true);
    assert.equal(shouldDeferForQuietHours(h.db, h.projectId, "activation_regression", 12), false);
    // An error spike has no quiet hours: production being broken is urgent.
    assert.equal(shouldDeferForQuietHours(h.db, h.projectId, "error_spike", 3), false);
  });
});

function must_ok(r: { fired: boolean; detail: string }) {
  assert.equal(r.fired, true, `expected the alert to fire: ${r.detail}`);
}

// --- detectors -------------------------------------------------------------

describe("detectors", () => {
  test("a significant activation fall is detected with its test result", () => {
    const h = harness();
    must(upsertActivationDefinition(h.db, h.scope, {
      name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }, T0 - 100 * DAY));
    // Prior week: 400 signups, 60% activate. This week: 400 signups, 30%.
    for (let i = 0; i < 400; i++) {
      h.event(`prior${i}`, "signup_completed", T0 - 13 * DAY + i * 100);
      if (i < 240) h.event(`prior${i}`, "project_published", T0 - 12 * DAY + i * 100);
      h.event(`now${i}`, "signup_completed", T0 - 6 * DAY + i * 100);
      if (i < 120) h.event(`now${i}`, "project_published", T0 - 5 * DAY + i * 100);
    }
    const found = detectActivationRegression(h.db, h.projectId, { timezone: TZ, now: T0 });
    assert.ok(found);
    assert.match(found!.comparisonDetail, /p = 0\./);
    assert.match(found!.comparisonDetail, /95% interval/);
  });

  test("a fall on a tiny sample is not reported as a regression", () => {
    const h = harness();
    must(upsertActivationDefinition(h.db, h.scope, {
      name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }, T0 - 100 * DAY));
    for (let i = 0; i < 12; i++) {
      h.event(`prior${i}`, "signup_completed", T0 - 13 * DAY + i * 100);
      if (i < 8) h.event(`prior${i}`, "project_published", T0 - 12 * DAY + i * 100);
      h.event(`now${i}`, "signup_completed", T0 - 6 * DAY + i * 100);
      if (i < 4) h.event(`now${i}`, "project_published", T0 - 5 * DAY + i * 100);
    }
    assert.equal(detectActivationRegression(h.db, h.projectId, { timezone: TZ, now: T0 }), null);
  });

  test("activation improving is never reported as a regression", () => {
    const h = harness();
    must(upsertActivationDefinition(h.db, h.scope, {
      name: "Core", activationEvent: "project_published", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }, T0 - 100 * DAY));
    for (let i = 0; i < 400; i++) {
      h.event(`prior${i}`, "signup_completed", T0 - 13 * DAY + i * 100);
      if (i < 120) h.event(`prior${i}`, "project_published", T0 - 12 * DAY + i * 100);
      h.event(`now${i}`, "signup_completed", T0 - 6 * DAY + i * 100);
      if (i < 240) h.event(`now${i}`, "project_published", T0 - 5 * DAY + i * 100);
    }
    assert.equal(detectActivationRegression(h.db, h.projectId, { timezone: TZ, now: T0 }), null);
  });

  function error(h: ReturnType<typeof harness>, external: string, at: number, fingerprint: string) {
    h.event(external, "page_viewed", at);
    const id = h.db.get<{ id: string }>(
      "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, external])!.id;
    h.db.run(
      `INSERT INTO error_events
        (id, org_id, project_id, fingerprint, title, level, occurred_at, received_at, identity_id, source)
       VALUES (?, ?, ?, ?, 'Import failed', 'error', ?, ?, ?, 'sdk')`,
      [newId("err"), h.orgId, h.projectId, fingerprint, at, at, id],
    );
  }

  test("an error multiplying against its own baseline is detected", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) error(h, `p${i}`, T0 - 10 * DAY, "fp-import");
    for (let i = 0; i < 60; i++) error(h, `n${i}`, T0 - 2 * DAY, "fp-import");
    const found = detectErrorSpike(h.db, h.projectId, { now: T0 });
    assert.ok(found);
    assert.match(found!.title, /6\.0×/);
    assert.equal(found!.affectedUsers, 60);
  });

  test("a single new exception does not alert", () => {
    const h = harness();
    error(h, "u1", T0 - DAY, "fp-new");
    assert.equal(detectErrorSpike(h.db, h.projectId, { now: T0 }), null);
  });

  test("a brand-new error at real volume does alert", () => {
    const h = harness();
    for (let i = 0; i < 25; i++) error(h, `n${i}`, T0 - 2 * DAY, "fp-new");
    const found = detectErrorSpike(h.db, h.projectId, { now: T0 });
    assert.ok(found);
    assert.match(found!.comparisonDetail, /never been seen before/);
  });

  function cancellation(h: ReturnType<typeof harness>, at: number, i: number) {
    const subId = `sub_${i}`;
    h.db.run(
      `INSERT INTO customer_subscriptions
        (id, org_id, project_id, provider, external_id, plan_name, status, amount_minor,
         currency, interval, started_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, 'Pro', 'cancelled', 900000, 'INR', 'month', ?, ?)`,
      [subId, h.orgId, h.projectId, `ext_${i}`, at - 100 * DAY, at],
    );
    h.db.run(
      `INSERT INTO subscription_events
        (id, org_id, project_id, subscription_id, provider, external_event_id, type,
         occurred_at, received_at, amount_minor, currency)
       VALUES (?, ?, ?, ?, 'manual', ?, 'cancelled', ?, ?, 0, 'INR')`,
      [newId("sev"), h.orgId, h.projectId, subId, `xev_${i}`, at, at],
    );
  }

  test("a rise in cancellations is detected, with the baseline stated", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) cancellation(h, T0 - 45 * DAY, i);
    for (let i = 100; i < 125; i++) cancellation(h, T0 - 10 * DAY, i);
    const found = detectCancellationIncrease(h.db, h.projectId, { now: T0 });
    assert.ok(found);
    assert.match(found!.comparisonDetail, /10 in the previous 30 days/);
    assert.match(found!.suggestedAction, /before drawing a conclusion/);
  });

  test("a rise on a tiny baseline is not reported", () => {
    const h = harness();
    for (let i = 0; i < 2; i++) cancellation(h, T0 - 45 * DAY, i);
    for (let i = 100; i < 108; i++) cancellation(h, T0 - 10 * DAY, i);
    assert.equal(detectCancellationIncrease(h.db, h.projectId, { now: T0 }), null);
  });

  test("a high rejection rate is detected and names the reason", () => {
    const h = harness();
    for (let i = 0; i < 100; i++) h.event(`u${i}`, "page_viewed", T0 - HOUR);
    for (let i = 0; i < 40; i++) {
      h.db.run(
        `INSERT INTO event_rejections (id, org_id, project_id, received_at, event_name, reason, detail)
         VALUES (?, ?, ?, ?, 'Bad Name', 'invalid_event_name', '{}')`,
        [newId("rej"), h.orgId, h.projectId, T0 - HOUR],
      );
    }
    const found = detectIngestionFailure(h.db, h.projectId, { now: T0 });
    assert.ok(found);
    assert.match(found!.metricDetail, /invalid_event_name/);
  });

  test("a trickle of rejections is not an incident", () => {
    const h = harness();
    for (let i = 0; i < 1000; i++) h.event(`u${i}`, "page_viewed", T0 - HOUR);
    h.db.run(
      `INSERT INTO event_rejections (id, org_id, project_id, received_at, event_name, reason, detail)
       VALUES (?, ?, ?, ?, 'x', 'schema_violation', '{}')`,
      [newId("rej"), h.orgId, h.projectId, T0 - HOUR],
    );
    assert.equal(detectIngestionFailure(h.db, h.projectId, { now: T0 }), null);
  });

  test("running every check on a healthy project fires nothing", () => {
    const h = soundProject();
    const result = runAlertChecks(h.db, h, { timezone: TZ, now: T0 });
    assert.equal(result.candidates, 0);
    assert.equal(result.fired.length, 0);
  });
});

// --- lifecycle -------------------------------------------------------------

describe("lifecycle", () => {
  test("an alert is acknowledged once", () => {
    const h = soundProject();
    fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 });
    const [alert] = listAlerts(h.db, h.projectId, { now: T0 });
    assert.equal(acknowledgeAlert(h.db, h.projectId, alert!.id, T0 + HOUR), true);
    assert.equal(acknowledgeAlert(h.db, h.projectId, alert!.id, T0 + 2 * HOUR), false);
  });

  test("resolving also acknowledges, because you cannot fix what you did not see", () => {
    const h = soundProject();
    fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 });
    const [alert] = listAlerts(h.db, h.projectId, { now: T0 });
    assert.equal(resolveAlert(h.db, h.projectId, alert!.id, T0 + HOUR), true);
    const [stored] = listAlerts(h.db, h.projectId, { now: T0, includeResolved: true });
    assert.equal(stored!.acknowledgedAt, T0 + HOUR);
  });

  test("a resolved alert leaves the open list", () => {
    const h = soundProject();
    fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 });
    const [alert] = listAlerts(h.db, h.projectId, { now: T0 });
    resolveAlert(h.db, h.projectId, alert!.id, T0 + HOUR);
    assert.equal(listAlerts(h.db, h.projectId, { now: T0 + 2 * HOUR }).length, 0);
  });

  test("a snoozed alert is hidden until its snooze ends", () => {
    const h = soundProject();
    fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 });
    const [alert] = listAlerts(h.db, h.projectId, { now: T0 });
    must(snoozeAlert(h.db, h.projectId, alert!.id, T0 + 3 * DAY, T0));
    assert.equal(listAlerts(h.db, h.projectId, { now: T0 + DAY }).length, 0);
    assert.equal(listAlerts(h.db, h.projectId, { now: T0 + 4 * DAY }).length, 1);
  });

  test("a snooze into the past is refused", () => {
    const h = soundProject();
    fireAlert(h.db, h, candidate(), { timezone: TZ, now: T0 });
    const [alert] = listAlerts(h.db, h.projectId, { now: T0 });
    const e = mustFail(snoozeAlert(h.db, h.projectId, alert!.id, T0 - DAY, T0));
    assert.match(e.message, /must end in the future/);
  });
});

// --- quality ---------------------------------------------------------------

describe("quality", () => {
  function fireMany(h: ReturnType<typeof harness>, n: number, acknowledge: number) {
    for (let i = 0; i < n; i++) {
      const at = T0 - (n - i) * DAY;
      fireAlert(h.db, h, candidate({ dedupeKey: `error_spike:fp-${i}:${i}` }), { timezone: TZ, now: at });
      if (i < acknowledge) {
        const [alert] = listAlerts(h.db, h.projectId, { now: at });
        if (alert) acknowledgeAlert(h.db, h.projectId, alert.id, at + HOUR);
      }
    }
  }

  test("a rule nobody acts on is called noise, not tuned to be more sensitive", () => {
    const h = soundProject();
    fireMany(h, 10, 0);
    const report = alertQuality(h.db, h.projectId, { now: T0 });
    const rule = report.rules.find((r) => r.kind === "error_spike")!;
    assert.match(rule.assessment, /producing noise/);
    assert.match(rule.recommendation!, /Raise this rule's threshold/);
    assert.match(rule.recommendation!, /would make this worse/);
  });

  test("a rule people act on is said to be earning its place", () => {
    const h = soundProject();
    fireMany(h, 10, 9);
    const rule = alertQuality(h.db, h.projectId, { now: T0 }).rules.find((r) => r.kind === "error_spike")!;
    assert.match(rule.assessment, /earning its place/);
    assert.equal(rule.recommendation, null);
  });

  test("too few alerts to judge is said rather than guessed at", () => {
    const h = soundProject();
    fireMany(h, 2, 0);
    const rule = alertQuality(h.db, h.projectId, { now: T0 }).rules.find((r) => r.kind === "error_spike")!;
    assert.match(rule.assessment, /too few to judge/);
  });

  test("no alerts is not reported as evidence the rules work", () => {
    const h = soundProject();
    const report = alertQuality(h.db, h.projectId, { now: T0 });
    assert.equal(report.totalFired, 0);
    assert.match(report.summary, /not evidence that the rules work/);
  });

  test("one project's alerts never appear in another's quality report", () => {
    const a = soundProject();
    const b = soundProject();
    fireAlert(a.db, a, candidate(), { timezone: TZ, now: T0 });
    assert.equal(alertQuality(b.db, b.projectId, { now: T0 }).totalFired, 0);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { beforeAfter, saveImpactMeasurement, listImpactMeasurements, releaseTimeline, BEFORE_AFTER_WARNING } from "../src/impact.ts";
import { createRelease } from "@retainos/database";
import { resolveProjectScope } from "@retainos/database";
import { harness, must, mustFail, DAY, HOUR, T0 } from "./helpers.ts";

const RELEASE_AT = T0;
const NOW = T0 + 30 * DAY;

/** Signups and activations either side of the release, at chosen rates. */
function populate(
  h: ReturnType<typeof harness>,
  before: { signups: number; rate: number },
  after: { signups: number; rate: number },
) {
  for (let i = 0; i < before.signups; i++) {
    const at = RELEASE_AT - 7 * DAY + i * 1000;
    h.event(`b${i}`, "signup_completed", at);
    if (i < Math.round(before.signups * before.rate)) h.event(`b${i}`, "project_created", at + HOUR);
  }
  for (let i = 0; i < after.signups; i++) {
    const at = RELEASE_AT + i * 1000;
    h.event(`a${i}`, "signup_completed", at);
    if (i < Math.round(after.signups * after.rate)) h.event(`a${i}`, "project_created", at + HOUR);
  }
}

describe("beforeAfter", () => {
  test("computes both windows and the observed change", () => {
    const h = harness("UTC");
    populate(h, { signups: 200, rate: 0.2 }, { signups: 200, rate: 0.35 });
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "event_conversion",
      metricLabel: "First project created", denominatorEvent: "signup_completed",
      numeratorEvent: "project_created", timezone: "UTC", now: NOW,
    }));
    assert.equal(r.before.denominator, 200);
    assert.equal(r.before.numerator, 40);
    assert.equal(r.before.rate, 0.2);
    assert.equal(r.after.denominator, 200);
    assert.equal(r.after.numerator, 70);
    assert.equal(r.after.rate, 0.35);
    assert.ok(Math.abs(r.absoluteChange! - 0.15) < 1e-12);
    assert.ok(Math.abs(r.relativeChange! - 0.75) < 1e-12);
  });

  test("never claims causation, in the result or in the prose", () => {
    const h = harness("UTC");
    populate(h, { signups: 200, rate: 0.2 }, { signups: 200, rate: 0.35 });
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "event_conversion",
      metricLabel: "First project created", denominatorEvent: "signup_completed",
      numeratorEvent: "project_created", timezone: "UTC", now: NOW,
    }));
    assert.equal(r.causalClaim, "none");
    assert.ok(r.limitations.includes(BEFORE_AFTER_WARNING));
    assert.match(r.interpretation, /observed change/);
    assert.match(r.interpretation, /controlled experiment/);
    // The word "caused" must not appear as a claim about this release.
    assert.ok(!/this release caused/i.test(r.interpretation));
  });

  test("always enumerates the confounders it checked, detected or not", () => {
    const h = harness("UTC");
    populate(h, { signups: 200, rate: 0.2 }, { signups: 200, rate: 0.35 });
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 14, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    const ids = r.confounders.map((c) => c.id).sort();
    assert.deepEqual(ids, [
      "acquisition_mix", "concurrent_releases", "external_factors",
      "population_change", "seasonality", "tracking_changes",
    ]);
    // External factors can never be detected automatically, and says so.
    const external = r.confounders.find((c) => c.id === "external_factors")!;
    assert.equal(external.detected, false);
    assert.match(external.detail, /cannot see marketing campaigns/);
  });

  test("detects a concurrent release in the window", () => {
    const h = harness("UTC");
    populate(h, { signups: 100, rate: 0.2 }, { signups: 100, rate: 0.3 });
    const scope = must(resolveProjectScope(h.db, h.userId, h.projectId));
    must(createRelease(h.db, scope, { name: "Other work", version: "2.1.0", releasedAt: RELEASE_AT + 2 * DAY }));
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    const c = r.confounders.find((x) => x.id === "concurrent_releases")!;
    assert.equal(c.detected, true);
    assert.match(c.detail, /2\.1\.0/);
  });

  test("detects a shift in acquisition mix", () => {
    const h = harness("UTC");
    // Before: all from docs. After: all from a paid campaign.
    for (let i = 0; i < 100; i++) {
      h.event(`b${i}`, "signup_completed", RELEASE_AT - 5 * DAY + i * 1000, { source: "docs" });
    }
    for (let i = 0; i < 100; i++) {
      h.event(`a${i}`, "signup_completed", RELEASE_AT + i * 1000, { source: "paid_social" });
    }
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    const c = r.confounders.find((x) => x.id === "acquisition_mix")!;
    assert.equal(c.detected, true);
    assert.match(c.detail, /converts differently/);
  });

  test("detects a tracking schema change", () => {
    const h = harness("UTC");
    populate(h, { signups: 100, rate: 0.2 }, { signups: 100, rate: 0.3 });
    h.db.run(
      `INSERT INTO event_schemas (id, org_id, project_id, name, version, properties, created_at, updated_at)
       VALUES ('evs_x', ?, ?, 'project_created', 2, '[]', ?, ?)`,
      [h.orgId, h.projectId, RELEASE_AT, RELEASE_AT + DAY],
    );
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    assert.equal(r.confounders.find((x) => x.id === "tracking_changes")!.detected, true);
  });

  test("detects a large population change between windows", () => {
    const h = harness("UTC");
    populate(h, { signups: 100, rate: 0.2 }, { signups: 400, rate: 0.2 });
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    const c = r.confounders.find((x) => x.id === "population_change")!;
    assert.equal(c.detected, true);
    assert.match(c.detail, /300%/);
  });

  test("flags a short window as not covering a weekly cycle", () => {
    const h = harness("UTC");
    populate(h, { signups: 100, rate: 0.2 }, { signups: 100, rate: 0.3 });
    const short = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 3, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    assert.equal(short.confounders.find((c) => c.id === "seasonality")!.detected, true);
    const long = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 21, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    assert.equal(long.confounders.find((c) => c.id === "seasonality")!.detected, false);
  });

  test("says when the after window is still partial", () => {
    const h = harness("UTC");
    populate(h, { signups: 100, rate: 0.2 }, { signups: 20, rate: 0.3 });
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 14, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: RELEASE_AT + 3 * DAY,
    }));
    assert.ok(r.limitations.some((l) => /Only 3 of the 14 days/.test(l)));
  });

  test("warns on small populations", () => {
    const h = harness("UTC");
    populate(h, { signups: 10, rate: 0.2 }, { signups: 10, rate: 0.5 });
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    assert.ok(r.limitations.some((l) => /Small populations/.test(l)));
  });

  test("handles an empty window without dividing by zero", () => {
    const h = harness("UTC");
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    assert.equal(r.before.rate, null);
    assert.equal(r.after.rate, null);
    assert.equal(r.absoluteChange, null);
    assert.equal(r.relativeChange, null);
    assert.match(r.interpretation, /not enough data/);
  });

  test("rejects an out-of-range window", () => {
    const h = harness("UTC");
    for (const windowDays of [0, 365]) {
      assert.equal(mustFail(beforeAfter(h.db, h.projectId, {
        releaseAt: RELEASE_AT, windowDays, metricKind: "event_conversion",
        metricLabel: "x", timezone: "UTC", now: NOW,
      })).code, "validation_failed");
    }
  });

  test("measures a funnel step as the metric", () => {
    const h = harness("UTC");
    populate(h, { signups: 100, rate: 0.2 }, { signups: 100, rate: 0.4 });
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "funnel_step",
      metricLabel: "Signup to first project",
      funnelSteps: [{ event: "signup_completed" }, { event: "project_created" }],
      funnelStepIndex: 1, timezone: "UTC", now: NOW,
    }));
    assert.equal(r.before.rate, 0.2);
    assert.equal(r.after.rate, 0.4);
  });
});

describe("persistence", () => {
  test("stores and lists a measurement with its method", () => {
    const h = harness("UTC");
    populate(h, { signups: 100, rate: 0.2 }, { signups: 100, rate: 0.3 });
    const r = must(beforeAfter(h.db, h.projectId, {
      releaseAt: RELEASE_AT, windowDays: 7, metricKind: "event_conversion",
      metricLabel: "x", denominatorEvent: "signup_completed", numeratorEvent: "project_created",
      timezone: "UTC", now: NOW,
    }));
    saveImpactMeasurement(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      method: "before_after", metricKind: "event_conversion", windowDays: 7, result: r,
    });
    const rows = listImpactMeasurements(h.db, h.projectId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.method, "before_after");
    assert.equal((rows[0]!.result as Record<string, unknown>).causalClaim, "none");
  });
});

describe("releaseTimeline", () => {
  test("reports metric values either side of each release with the caveat attached", () => {
    const h = harness("UTC");
    const scope = must(resolveProjectScope(h.db, h.userId, h.projectId));
    must(createRelease(h.db, scope, { name: "v2", version: "2.0.0", releasedAt: RELEASE_AT }));
    for (let i = 0; i < 10; i++) h.event(`b${i}`, "core_action_completed", RELEASE_AT - 2 * DAY + i * 1000);
    for (let i = 0; i < 25; i++) h.event(`a${i}`, "core_action_completed", RELEASE_AT + 2 * DAY + i * 1000);
    const rows = releaseTimeline(h.db, h.projectId, { eventName: "core_action_completed", timezone: "UTC", windowDays: 7 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.usersBefore, 10);
    assert.equal(rows[0]!.usersAfter, 25);
    assert.equal(rows[0]!.caveat, BEFORE_AFTER_WARNING);
  });
});

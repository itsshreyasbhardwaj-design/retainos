import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeRetention, retentionCurve } from "../src/retention.ts";
import { harness, DAY, HOUR, T0 } from "./helpers.ts";

// A clock well after the test data, so every period is complete unless a test
// deliberately arranges otherwise.
const LATER = T0 + 200 * DAY;

describe("cohort assignment", () => {
  test("cohorts users by their first-ever event day", () => {
    const h = harness("UTC");
    h.event("u1", "signup_completed", Date.UTC(2026, 2, 1, 10));
    h.event("u2", "signup_completed", Date.UTC(2026, 2, 1, 23));
    h.event("u3", "signup_completed", Date.UTC(2026, 2, 2, 1));
    const r = computeRetention(h.db, h.projectId, {
      from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 2, 5),
      timezone: "UTC", periods: [0], now: LATER,
    });
    assert.deepEqual(r.cohorts.map((c) => c.cohort), ["2026-03-01", "2026-03-02"]);
    assert.equal(r.cohorts[0]!.cohortSize, 2);
    assert.equal(r.cohorts[1]!.cohortSize, 1);
  });

  test("cohort days respect the project's reporting timezone", () => {
    const h = harness("Asia/Kolkata");
    // 2026-03-01T20:00Z is already 2026-03-02 in Kolkata (UTC+5:30).
    h.event("u1", "signup_completed", Date.UTC(2026, 2, 1, 20));
    const r = computeRetention(h.db, h.projectId, {
      from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 2, 5),
      timezone: "Asia/Kolkata", periods: [0], now: LATER,
    });
    assert.deepEqual(r.cohorts.map((c) => c.cohort), ["2026-03-02"]);
  });

  test("a signup-event basis ignores users who never fired it", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u2", "page_viewed", T0); // never signed up
    const r = computeRetention(h.db, h.projectId, {
      from: T0 - DAY, to: T0 + DAY, basis: "signup_event", cohortEvent: "signup_completed",
      timezone: "UTC", periods: [0], now: LATER,
    });
    assert.equal(r.cohorts[0]!.cohortSize, 1);
  });

  test("a user is assigned to exactly one cohort", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "signup_completed", T0 + 5 * DAY); // duplicate signup event
    const r = computeRetention(h.db, h.projectId, {
      from: T0 - DAY, to: T0 + 10 * DAY, basis: "signup_event", cohortEvent: "signup_completed",
      timezone: "UTC", periods: [0], now: LATER,
    });
    const total = r.cohorts.reduce((s, c) => s + c.cohortSize, 0);
    assert.equal(total, 1);
  });
});

describe("retention arithmetic", () => {
  /**
   * Ten users all signed up on day 0.
   * Day 1: users 0-4 return (5).
   * Day 7: users 0-1 return (2).
   * Expected: D0 = 10/10, D1 = 5/10, D7 = 2/10.
   */
  function tenUsers() {
    const h = harness("UTC");
    const day0 = Date.UTC(2026, 2, 1, 12);
    for (let i = 0; i < 10; i++) {
      h.event(`u${i}`, "signup_completed", day0 + i * 1000);
      if (i < 5) h.event(`u${i}`, "core_action_completed", day0 + DAY + i * 1000);
      if (i < 2) h.event(`u${i}`, "core_action_completed", day0 + 7 * DAY + i * 1000);
    }
    return { h, day0 };
  }

  test("computes the expected rates with the cohort as the denominator", () => {
    const { h, day0 } = tenUsers();
    const r = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, timezone: "UTC", periods: [0, 1, 7], now: LATER,
    });
    const cells = r.cohorts[0]!.cells;
    assert.equal(r.cohorts[0]!.cohortSize, 10);
    assert.equal(cells.find((c) => c.period === 0)!.rate, 1);
    assert.equal(cells.find((c) => c.period === 1)!.rate, 0.5);
    assert.equal(cells.find((c) => c.period === 7)!.rate, 0.2);
  });

  test("the denominator never shrinks over time", () => {
    const { h, day0 } = tenUsers();
    const r = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, timezone: "UTC", periods: [0, 1, 7, 14], now: LATER,
    });
    // Day 14 has nobody returning. The rate must be 0/10, not 0/0 or omitted.
    const d14 = r.cohorts[0]!.cells.find((c) => c.period === 14)!;
    assert.equal(d14.retained, 0);
    assert.equal(d14.rate, 0);
    assert.equal(r.cohorts[0]!.cohortSize, 10);
  });

  test("a specific return event narrows what counts as retained", () => {
    const h = harness("UTC");
    const day0 = Date.UTC(2026, 2, 1, 12);
    h.event("u1", "signup_completed", day0);
    h.event("u1", "page_viewed", day0 + DAY); // came back, but did nothing
    h.event("u2", "signup_completed", day0);
    h.event("u2", "core_action_completed", day0 + DAY); // came back and did the thing

    const any = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, timezone: "UTC", periods: [1], now: LATER,
    });
    assert.equal(any.cohorts[0]!.cells[0]!.retained, 2);

    const core = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, timezone: "UTC", periods: [1],
      returnEvent: "core_action_completed", now: LATER,
    });
    assert.equal(core.cohorts[0]!.cells[0]!.retained, 1);
    assert.match(core.definition.returnDefinition, /core_action_completed/);
  });

  test("multiple events on the same day count once", () => {
    const h = harness("UTC");
    const day0 = Date.UTC(2026, 2, 1, 12);
    h.event("u1", "signup_completed", day0);
    for (let i = 0; i < 20; i++) h.event("u1", "core_action_completed", day0 + DAY + i * HOUR / 4);
    const r = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, timezone: "UTC", periods: [1], now: LATER,
    });
    assert.equal(r.cohorts[0]!.cells[0]!.retained, 1);
    assert.equal(r.cohorts[0]!.cells[0]!.rate, 1);
  });

  test("period N is measured from each user's own cohort day", () => {
    const h = harness("UTC");
    // Two users in the same weekly cohort but signing up two days apart. Each
    // returns exactly one day after their own signup, so both are day-1 retained.
    const monday = Date.UTC(2026, 2, 2, 12); // a Monday
    h.event("uA", "signup_completed", monday);
    h.event("uA", "core_action_completed", monday + DAY);
    h.event("uB", "signup_completed", monday + 2 * DAY);
    h.event("uB", "core_action_completed", monday + 3 * DAY);
    const r = computeRetention(h.db, h.projectId, {
      from: monday - DAY, to: monday + 6 * DAY, granularity: "week",
      timezone: "UTC", periods: [0], now: LATER,
    });
    assert.equal(r.cohorts.length, 1, "both users belong to the same weekly cohort");
    assert.equal(r.cohorts[0]!.cohortSize, 2);
  });
});

describe("incomplete periods", () => {
  test("a period that has not elapsed is marked incomplete", () => {
    const h = harness("UTC");
    const day0 = Date.UTC(2026, 2, 1, 12);
    h.event("u1", "signup_completed", day0);
    // "Now" is only three days after signup, so day 7 cannot be known yet.
    const now = day0 + 3 * DAY;
    const r = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, timezone: "UTC", periods: [0, 1, 7], now,
    });
    const cells = r.cohorts[0]!.cells;
    assert.equal(cells.find((c) => c.period === 0)!.complete, true);
    assert.equal(cells.find((c) => c.period === 1)!.complete, true);
    assert.equal(cells.find((c) => c.period === 7)!.complete, false);
  });

  test("incomplete cells are excluded from the average, not counted as zero", () => {
    const h = harness("UTC");
    const day0 = Date.UTC(2026, 2, 1, 12);
    for (let i = 0; i < 10; i++) {
      h.event(`u${i}`, "signup_completed", day0 + i * 1000);
      h.event(`u${i}`, "core_action_completed", day0 + DAY + i * 1000);
    }
    const now = day0 + 3 * DAY;
    const r = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, timezone: "UTC", periods: [1, 7], now,
    });
    const d1 = r.averageByPeriod.find((p) => p.period === 1)!;
    const d7 = r.averageByPeriod.find((p) => p.period === 7)!;
    assert.equal(d1.rate, 1);
    assert.equal(d1.cohortsCounted, 1);
    // Day 7 is unknown. Reporting 0% here would invent a cliff that is purely
    // an artefact of when the report was run.
    assert.equal(d7.rate, null);
    assert.equal(d7.cohortsCounted, 0);
  });

  test("completeness accounts for the latest member of the cohort", () => {
    const h = harness("UTC");
    const monday = Date.UTC(2026, 2, 2, 12);
    h.event("uA", "signup_completed", monday);
    h.event("uB", "signup_completed", monday + 6 * DAY); // same week, six days later
    // Eight days after the first signup: day 7 is complete for A but not for B,
    // so the weekly cohort's period-1 cell is not yet complete.
    const now = monday + 8 * DAY;
    const r = computeRetention(h.db, h.projectId, {
      from: monday - DAY, to: monday + 6 * DAY, granularity: "week",
      timezone: "UTC", periods: [0, 1], now,
    });
    assert.equal(r.cohorts[0]!.cells.find((c) => c.period === 1)!.complete, false);
  });
});

describe("small samples", () => {
  test("a small cohort is flagged", () => {
    const h = harness("UTC");
    h.event("u1", "signup_completed", T0);
    const r = computeRetention(h.db, h.projectId, {
      from: T0 - DAY, to: T0 + DAY, timezone: "UTC", periods: [0, 1], now: LATER,
    });
    assert.equal(r.cohorts[0]!.smallSample, true);
  });

  test("a large cohort is not flagged", () => {
    const h = harness("UTC");
    for (let i = 0; i < 50; i++) h.event(`u${i}`, "signup_completed", T0 + i * 1000);
    const r = computeRetention(h.db, h.projectId, {
      from: T0 - DAY, to: T0 + DAY, timezone: "UTC", periods: [0], now: LATER,
    });
    assert.equal(r.cohorts[0]!.smallSample, false);
  });

  test("a single retained user out of one does not read as a certain 100%", () => {
    const h = harness("UTC");
    h.event("u1", "signup_completed", T0);
    h.event("u1", "core_action_completed", T0 + DAY);
    const r = computeRetention(h.db, h.projectId, {
      from: T0 - DAY, to: T0 + DAY, timezone: "UTC", periods: [1], now: LATER,
    });
    const cell = r.cohorts[0]!.cells[0]!;
    assert.equal(cell.rate, 1);
    assert.ok(cell.interval[0] < 0.5, `interval ${cell.interval} should be wide on n=1`);
  });
});

describe("edge cases", () => {
  test("an empty project returns no cohorts and null averages", () => {
    const h = harness();
    const r = computeRetention(h.db, h.projectId, {
      from: T0 - DAY, to: T0 + DAY, timezone: "UTC", periods: [0, 1, 7], now: LATER,
    });
    assert.deepEqual(r.cohorts, []);
    assert.ok(r.averageByPeriod.every((p) => p.rate === null));
  });

  test("activity before the cohort day is ignored rather than treated as period 0", () => {
    const h = harness("UTC");
    const day0 = Date.UTC(2026, 2, 10, 12);
    h.event("u1", "page_viewed", day0 - 5 * DAY);
    h.event("u1", "signup_completed", day0);
    const r = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, basis: "signup_event", cohortEvent: "signup_completed",
      timezone: "UTC", periods: [0], now: LATER,
    });
    assert.equal(r.cohorts[0]!.cells[0]!.retained, 1, "the signup itself lands in period 0");
  });

  test("retention survives a DST boundary without an off-by-one", () => {
    const h = harness("America/New_York");
    // Signup the day before the US spring-forward, returning exactly one
    // calendar day later across the 23-hour day.
    const signup = Date.UTC(2026, 2, 7, 18); // 2026-03-07 13:00 EST
    h.event("u1", "signup_completed", signup);
    h.event("u1", "core_action_completed", Date.UTC(2026, 2, 8, 17)); // 2026-03-08 13:00 EDT
    const r = computeRetention(h.db, h.projectId, {
      from: signup - DAY, to: signup + DAY, timezone: "America/New_York",
      periods: [0, 1], now: LATER,
    });
    const cells = r.cohorts[0]!.cells;
    assert.equal(cells.find((c) => c.period === 0)!.retained, 1);
    assert.equal(cells.find((c) => c.period === 1)!.retained, 1,
      "the return is one calendar day later, even though only 23 hours elapsed");
  });

  test("handles a cohort larger than the SQL variable chunk size", () => {
    const h = harness("UTC");
    const day0 = Date.UTC(2026, 2, 1, 12);
    for (let i = 0; i < 900; i++) {
      h.event(`u${i}`, "signup_completed", day0 + i);
      if (i % 2 === 0) h.event(`u${i}`, "core_action_completed", day0 + DAY + i);
    }
    const r = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, timezone: "UTC", periods: [1], now: LATER,
    });
    assert.equal(r.cohorts[0]!.cohortSize, 900);
    assert.equal(r.cohorts[0]!.cells[0]!.retained, 450);
    assert.equal(r.cohorts[0]!.cells[0]!.rate, 0.5);
  });

  test("retentionCurve flattens the averages", () => {
    const h = harness("UTC");
    const day0 = Date.UTC(2026, 2, 1, 12);
    for (let i = 0; i < 10; i++) {
      h.event(`u${i}`, "signup_completed", day0 + i * 1000);
      if (i < 3) h.event(`u${i}`, "core_action_completed", day0 + DAY + i * 1000);
    }
    const r = computeRetention(h.db, h.projectId, {
      from: day0 - DAY, to: day0 + DAY, timezone: "UTC", periods: [0, 1], now: LATER,
    });
    assert.deepEqual(retentionCurve(r), [{ period: 0, rate: 1 }, { period: 1, rate: 0.3 }]);
  });

  test("the definition block states the denominator and boundaries", () => {
    const h = harness("Asia/Kolkata");
    h.event("u1", "signup_completed", T0);
    const r = computeRetention(h.db, h.projectId, {
      from: T0 - DAY, to: T0 + DAY, timezone: "Asia/Kolkata", periods: [0], now: LATER,
    });
    assert.match(r.definition.denominator, /never shrinks/);
    assert.match(r.definition.periodBoundaries, /Asia\/Kolkata/);
    assert.match(r.definition.incompletePeriods, /excluded from averages/);
  });
});

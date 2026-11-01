import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { recomputeDay, recomputeRevenueMonth, runNextJob, drainJobs, schedulePeriodicJobs } from "../src/aggregate.ts";
import { enqueueJob, applyProviderEvent } from "@retainos/database";
import { harness, must, DAY, HOUR, T0 } from "./helpers.ts";

const DAY_KEY = "2026-03-14";

describe("recomputeDay", () => {
  test("computes actives, new and returning for one day", () => {
    const h = harness("UTC");
    const day = Date.UTC(2026, 2, 14, 10);
    // u1 is new today; u2 was first seen yesterday so is returning.
    h.event("u1", "signup_completed", day);
    h.event("u2", "page_viewed", day - DAY);
    h.event("u2", "core_action_completed", day + HOUR);
    recomputeDay(h.db, h.projectId, DAY_KEY, "UTC");
    const row = h.db.get<{ active_users: number; new_users: number; returning_users: number; event_count: number }>(
      "SELECT * FROM daily_active_aggregates WHERE project_id = ? AND day_key = ?", [h.projectId, DAY_KEY],
    )!;
    assert.equal(row.active_users, 2);
    assert.equal(row.new_users, 1);
    assert.equal(row.returning_users, 1);
    assert.equal(row.event_count, 2);
  });

  test("is idempotent", () => {
    const h = harness("UTC");
    h.event("u1", "signup_completed", Date.UTC(2026, 2, 14, 10));
    recomputeDay(h.db, h.projectId, DAY_KEY, "UTC");
    recomputeDay(h.db, h.projectId, DAY_KEY, "UTC");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM daily_active_aggregates")!.n, 1);
    assert.equal(
      h.db.get<{ active_users: number }>("SELECT active_users FROM daily_active_aggregates")!.active_users, 1,
    );
  });

  test("per-event rows are replaced, so a deleted event does not linger", () => {
    const h = harness("UTC");
    h.event("u1", "signup_completed", Date.UTC(2026, 2, 14, 10));
    h.event("u1", "core_action_completed", Date.UTC(2026, 2, 14, 11));
    recomputeDay(h.db, h.projectId, DAY_KEY, "UTC");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM event_daily_aggregates")!.n, 2);
    // Erase one event and recompute: the stale aggregate row must disappear.
    h.db.run("DELETE FROM analytics_events WHERE name = 'core_action_completed'");
    recomputeDay(h.db, h.projectId, DAY_KEY, "UTC");
    const names = h.db.all<{ event_name: string }>("SELECT event_name FROM event_daily_aggregates").map((r) => r.event_name);
    assert.deepEqual(names, ["signup_completed"]);
  });

  test("respects the project's reporting timezone", () => {
    const h = harness("Asia/Kolkata");
    // 2026-03-14T20:00Z is 2026-03-15 in Kolkata.
    h.event("u1", "signup_completed", Date.UTC(2026, 2, 14, 20));
    recomputeDay(h.db, h.projectId, "2026-03-15", "Asia/Kolkata");
    recomputeDay(h.db, h.projectId, "2026-03-14", "Asia/Kolkata");
    // node:sqlite hands back null-prototype rows, so compare mapped plain objects.
    const rows = h.db.all<{ day_key: string; active_users: number }>(
      "SELECT day_key, active_users FROM daily_active_aggregates ORDER BY day_key",
    ).map((r) => ({ day_key: r.day_key, active_users: r.active_users }));
    assert.deepEqual(rows, [
      { day_key: "2026-03-14", active_users: 0 },
      { day_key: "2026-03-15", active_users: 1 },
    ]);
  });
});

describe("recomputeRevenueMonth", () => {
  test("writes one snapshot per currency and is idempotent", () => {
    const h = harness("UTC");
    for (const [sub, currency, amount] of [["a", "INR", 99_900], ["b", "USD", 2_900]] as const) {
      must(applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, {
        provider: "simulator", externalEventId: `e-${sub}`, externalSubscriptionId: sub,
        type: "subscription_started", occurredAt: Date.UTC(2026, 2, 2), amountMinor: amount,
        currency, interval: "month",
      }));
    }
    recomputeRevenueMonth(h.db, h.projectId, "2026-03", "UTC");
    recomputeRevenueMonth(h.db, h.projectId, "2026-03", "UTC");
    const rows = h.db.all<{ currency: string; mrr_minor: number }>(
      "SELECT currency, mrr_minor FROM revenue_snapshots WHERE month_key = '2026-03' ORDER BY currency",
    ).map((r) => ({ currency: r.currency, mrr_minor: r.mrr_minor }));
    assert.deepEqual(rows, [
      { currency: "INR", mrr_minor: 99_900 },
      { currency: "USD", mrr_minor: 2_900 },
    ]);
  });

  test("handles a December month boundary", () => {
    const h = harness("UTC");
    must(applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      provider: "simulator", externalEventId: "e1", externalSubscriptionId: "s1",
      type: "subscription_started", occurredAt: Date.UTC(2026, 11, 5), amountMinor: 99_900,
      currency: "INR", interval: "month",
    }));
    recomputeRevenueMonth(h.db, h.projectId, "2026-12", "UTC");
    assert.equal(
      h.db.get<{ mrr_minor: number }>("SELECT mrr_minor FROM revenue_snapshots WHERE month_key = '2026-12'")!.mrr_minor,
      99_900,
    );
  });
});

describe("job queue", () => {
  test("enqueue is idempotent for the same dedupe key while pending", () => {
    const h = harness("UTC");
    const a = enqueueJob(h.db, { orgId: h.orgId, projectId: h.projectId, kind: "recompute_day", dedupeKey: "k1" });
    const b = enqueueJob(h.db, { orgId: h.orgId, projectId: h.projectId, kind: "recompute_day", dedupeKey: "k1" });
    assert.equal(a.created, true);
    assert.equal(b.created, false, "the second call must report that it reused the pending job");
    assert.equal(a.id, b.id);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM aggregation_jobs")!.n, 1);
  });

  test("runs a job and marks it done", () => {
    const h = harness("UTC");
    h.event("u1", "signup_completed", Date.UTC(2026, 2, 14, 10));
    enqueueJob(h.db, {
      orgId: h.orgId, projectId: h.projectId, kind: "recompute_day",
      payload: { dayKey: DAY_KEY }, dedupeKey: "d1",
    });
    const r = runNextJob(h.db)!;
    assert.equal(r.ok, true);
    assert.match(r.detail, /Recomputed daily aggregates/);
    assert.equal(h.db.get<{ status: string }>("SELECT status FROM aggregation_jobs")!.status, "done");
    assert.equal(runNextJob(h.db), null, "the queue is now empty");
  });

  test("a failing job is retried then marked failed, not retried forever", () => {
    const h = harness("UTC");
    enqueueJob(h.db, { orgId: h.orgId, projectId: h.projectId, kind: "no_such_kind", dedupeKey: "bad" });
    const now = Date.now();
    const first = runNextJob(h.db, now)!;
    assert.equal(first.ok, false);
    assert.equal(h.db.get<{ status: string }>("SELECT status FROM aggregation_jobs")!.status, "pending");
    // The retry is delayed, so an immediate drain does not spin.
    assert.equal(runNextJob(h.db, now), null);
    runNextJob(h.db, now + 60_000);
    runNextJob(h.db, now + 180_000);
    const row = h.db.get<{ status: string; attempts: number; last_error: string }>(
      "SELECT status, attempts, last_error FROM aggregation_jobs",
    )!;
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 3);
    assert.match(row.last_error, /Unknown job kind/);
  });

  test("a claimed job is not handed to a second worker", () => {
    const h = harness("UTC");
    enqueueJob(h.db, {
      orgId: h.orgId, projectId: h.projectId, kind: "recompute_day",
      payload: { dayKey: DAY_KEY }, dedupeKey: "d1",
    });
    h.db.run("UPDATE aggregation_jobs SET status = 'running'");
    assert.equal(runNextJob(h.db), null);
  });

  test("drainJobs processes the whole queue", () => {
    const h = harness("UTC");
    h.event("u1", "signup_completed", Date.UTC(2026, 2, 14, 10));
    for (const day of ["2026-03-12", "2026-03-13", "2026-03-14"]) {
      enqueueJob(h.db, {
        orgId: h.orgId, projectId: h.projectId, kind: "recompute_day",
        payload: { dayKey: day }, dedupeKey: `d:${day}`,
      });
    }
    const results = drainJobs(h.db);
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.ok));
  });

  test("schedulePeriodicJobs queues every job kind once per project", () => {
    const h = harness("UTC");
    const queued = schedulePeriodicJobs(h.db, T0);
    assert.equal(queued, 5);
    // A second call enqueues nothing new while the first batch is pending.
    assert.equal(schedulePeriodicJobs(h.db, T0), 0);
    const kinds = h.db.all<{ kind: string }>("SELECT DISTINCT kind FROM aggregation_jobs ORDER BY kind")
      .map((r) => r.kind);
    assert.deepEqual(kinds, [
      "apply_retention_policy", "generate_insights", "rebuild_feedback_clusters",
      "recompute_day", "recompute_revenue_month",
    ]);
  });

  test("the full periodic batch runs end to end", () => {
    const h = harness("UTC");
    const base = T0 - 10 * DAY;
    for (let i = 0; i < 20; i++) h.event(`u${i}`, "signup_completed", base + i * 1000);
    schedulePeriodicJobs(h.db, T0);
    const results = drainJobs(h.db, { now: T0 });
    const failures = results.filter((r) => !r.ok);
    assert.deepEqual(failures, [], `jobs failed: ${failures.map((f) => `${f.kind}: ${f.detail}`).join("; ")}`);
    assert.equal(results.length, 5);
  });

  test("the retention policy job deletes events past the window", () => {
    const h = harness("UTC");
    h.db.run("UPDATE projects SET raw_retention_days = 30 WHERE id = ?", [h.projectId]);
    h.event("old", "signup_completed", T0 - 60 * DAY);
    h.event("new", "signup_completed", T0 - DAY);
    enqueueJob(h.db, {
      orgId: h.orgId, projectId: h.projectId, kind: "apply_retention_policy", dedupeKey: "ret",
    }, T0);
    const r = runNextJob(h.db, T0)!;
    assert.equal(r.ok, true);
    assert.match(r.detail, /Deleted 1 expired events/);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_events")!.n, 1);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyProviderEvent } from "@retainos/database";
import {
  normaliseToMrr, contributesToMrr, mrrSnapshot, mrrMovement, churnBreakdown,
  revenueAtRisk, currenciesInUse,
} from "../src/revenue.ts";
import { harness, must, DAY, T0 } from "./helpers.ts";

const JAN = { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 31, 23, 59, 59, 999) };
const FEB = { start: Date.UTC(2026, 1, 1), end: Date.UTC(2026, 1, 28, 23, 59, 59, 999) };

let eventSeq = 0;
function send(
  h: ReturnType<typeof harness>,
  sub: string,
  type: string,
  at: number,
  amountMinor: number,
  opts: { interval?: "month" | "quarter" | "year"; currency?: string; userId?: string } = {},
) {
  return applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, {
    provider: "simulator",
    externalEventId: `evt-${eventSeq++}`,
    externalSubscriptionId: sub,
    type: type as never,
    occurredAt: at,
    amountMinor,
    currency: opts.currency ?? "INR",
    interval: opts.interval ?? "month",
    planName: "growth",
    externalUserId: opts.userId ?? null,
  });
}

describe("normaliseToMrr", () => {
  test("normalises each billing interval to a month", () => {
    assert.equal(normaliseToMrr(99_900, "month"), 99_900);
    assert.equal(normaliseToMrr(1_198_800, "year"), 99_900);
    assert.equal(normaliseToMrr(299_700, "quarter"), 99_900);
  });

  test("an annual plan contributes one twelfth per month, not its full price", () => {
    // The classic MRR inflation bug: counting a ₹11,988 annual plan as ₹11,988 MRR.
    assert.equal(normaliseToMrr(1_198_800, "year"), 99_900);
    assert.notEqual(normaliseToMrr(1_198_800, "year"), 1_198_800);
  });
});

describe("contributesToMrr", () => {
  test("trials contribute nothing", () => {
    assert.equal(contributesToMrr("trialing"), false);
  });

  test("active and past_due contribute", () => {
    assert.equal(contributesToMrr("active"), true);
    assert.equal(contributesToMrr("past_due"), true);
  });

  test("ended states contribute nothing", () => {
    for (const s of ["cancelled", "expired", "paused", "none"]) {
      assert.equal(contributesToMrr(s), false, s);
    }
  });
});

describe("mrrSnapshot", () => {
  test("sums normalised MRR for active subscriptions", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", JAN.start, 99_900, { interval: "month" }));
    must(send(h, "sub-2", "subscription_started", JAN.start, 1_198_800, { interval: "year" }));
    const snaps = mrrSnapshot(h.db, h.projectId, JAN.end);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]!.currency, "INR");
    assert.equal(snaps[0]!.mrrMinor, 199_800);
    assert.equal(snaps[0]!.arrMinor, 199_800 * 12);
    assert.equal(snaps[0]!.activeSubscriptions, 2);
  });

  test("a trial is counted separately and adds no MRR", () => {
    const h = harness();
    must(send(h, "sub-1", "trial_started", JAN.start, 0));
    const snap = mrrSnapshot(h.db, h.projectId, JAN.end)[0]!;
    assert.equal(snap.mrrMinor, 0);
    assert.equal(snap.trialingSubscriptions, 1);
    assert.equal(snap.activeSubscriptions, 0);
  });

  test("a failed payment keeps its MRR but is reported as at risk", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", JAN.start, 99_900));
    must(send(h, "sub-1", "payment_failed", JAN.start + DAY, 99_900));
    const snap = mrrSnapshot(h.db, h.projectId, JAN.end)[0]!;
    assert.equal(snap.mrrMinor, 99_900);
    assert.equal(snap.pastDueMrrMinor, 99_900);
    assert.equal(snap.pastDueSubscriptions, 1);
    assert.equal(snap.activeSubscriptions, 0);
  });

  test("currencies are kept apart and never summed", () => {
    const h = harness();
    must(send(h, "sub-inr", "subscription_started", JAN.start, 99_900, { currency: "INR" }));
    must(send(h, "sub-usd", "subscription_started", JAN.start, 2_900, { currency: "USD" }));
    const snaps = mrrSnapshot(h.db, h.projectId, JAN.end);
    assert.equal(snaps.length, 2);
    const inr = snaps.find((s) => s.currency === "INR")!;
    const usd = snaps.find((s) => s.currency === "USD")!;
    assert.equal(inr.mrrMinor, 99_900);
    assert.equal(usd.mrrMinor, 2_900);
  });

  test("a cancelled subscription drops out of MRR", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", JAN.start, 99_900));
    must(send(h, "sub-1", "cancelled", JAN.start + 10 * DAY, 99_900));
    assert.equal(mrrSnapshot(h.db, h.projectId, JAN.start + 5 * DAY)[0]!.mrrMinor, 99_900);
    assert.equal(mrrSnapshot(h.db, h.projectId, JAN.end)[0]!.mrrMinor, 0);
  });
});

describe("mrrMovement", () => {
  test("decomposes new business", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", JAN.start + DAY, 99_900));
    const m = mrrMovement(h.db, h.projectId, { periodStart: JAN.start, periodEnd: JAN.end, currency: "INR" });
    assert.equal(m.startMrrMinor, 0);
    assert.equal(m.endMrrMinor, 99_900);
    assert.equal(m.newMinor, 99_900);
    assert.equal(m.expansionMinor, 0);
    assert.equal(m.churnMinor, 0);
  });

  test("decomposes expansion and contraction", () => {
    const h = harness();
    must(send(h, "up", "subscription_started", JAN.start, 99_900));
    must(send(h, "down", "subscription_started", JAN.start, 249_900));
    must(send(h, "up", "upgraded", FEB.start + DAY, 249_900));
    must(send(h, "down", "downgraded", FEB.start + DAY, 99_900));
    const m = mrrMovement(h.db, h.projectId, { periodStart: FEB.start, periodEnd: FEB.end, currency: "INR" });
    assert.equal(m.startMrrMinor, 349_800);
    assert.equal(m.endMrrMinor, 349_800);
    assert.equal(m.expansionMinor, 150_000);
    assert.equal(m.contractionMinor, 150_000);
    assert.equal(m.newMinor, 0);
  });

  test("decomposes churn and counts churned customers", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", JAN.start, 99_900));
    must(send(h, "sub-2", "subscription_started", JAN.start, 249_900));
    must(send(h, "sub-1", "cancelled", FEB.start + DAY, 99_900));
    const m = mrrMovement(h.db, h.projectId, { periodStart: FEB.start, periodEnd: FEB.end, currency: "INR" });
    assert.equal(m.startMrrMinor, 349_800);
    assert.equal(m.endMrrMinor, 249_900);
    assert.equal(m.churnMinor, 99_900);
    assert.equal(m.churnedCustomers, 1);
    assert.equal(m.startCustomers, 2);
  });

  test("distinguishes reactivation from new business", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", JAN.start, 99_900));
    must(send(h, "sub-1", "cancelled", JAN.start + 10 * DAY, 99_900));
    must(send(h, "sub-1", "reactivated", FEB.start + DAY, 99_900));
    const m = mrrMovement(h.db, h.projectId, { periodStart: FEB.start, periodEnd: FEB.end, currency: "INR" });
    assert.equal(m.reactivationMinor, 99_900, "a returning customer is reactivation, not new");
    assert.equal(m.newMinor, 0);
  });

  test("the decomposition reconciles with the change in MRR", () => {
    const h = harness();
    must(send(h, "keep", "subscription_started", JAN.start, 99_900));
    must(send(h, "grow", "subscription_started", JAN.start, 99_900));
    must(send(h, "shrink", "subscription_started", JAN.start, 249_900));
    must(send(h, "leave", "subscription_started", JAN.start, 99_900));
    must(send(h, "grow", "upgraded", FEB.start + DAY, 249_900));
    must(send(h, "shrink", "downgraded", FEB.start + DAY, 99_900));
    must(send(h, "leave", "cancelled", FEB.start + DAY, 99_900));
    must(send(h, "fresh", "subscription_started", FEB.start + 2 * DAY, 99_900));

    const m = mrrMovement(h.db, h.projectId, { periodStart: FEB.start, periodEnd: FEB.end, currency: "INR" });
    const reconciled =
      m.startMrrMinor + m.newMinor + m.reactivationMinor + m.expansionMinor - m.contractionMinor - m.churnMinor;
    assert.equal(reconciled, m.endMrrMinor,
      "start + new + reactivation + expansion - contraction - churn must equal end");
  });

  test("computes NRR and GRR to their stated definitions", () => {
    const h = harness();
    // Start: 1000. Expansion +200, churn -100. End = 1100.
    must(send(h, "a", "subscription_started", JAN.start, 50_000));
    must(send(h, "b", "subscription_started", JAN.start, 40_000));
    must(send(h, "c", "subscription_started", JAN.start, 10_000));
    must(send(h, "a", "upgraded", FEB.start + DAY, 70_000));
    must(send(h, "c", "cancelled", FEB.start + DAY, 10_000));
    const m = mrrMovement(h.db, h.projectId, { periodStart: FEB.start, periodEnd: FEB.end, currency: "INR" });
    assert.equal(m.startMrrMinor, 100_000);
    assert.equal(m.expansionMinor, 20_000);
    assert.equal(m.churnMinor, 10_000);
    // NRR = (100000 + 20000 - 0 - 10000) / 100000 = 1.10
    assert.equal(m.netRevenueRetention, 1.1);
    // GRR = (100000 - 0 - 10000) / 100000 = 0.90, and cannot exceed 1.
    assert.equal(m.grossRevenueRetention, 0.9);
    assert.ok(m.grossRevenueRetention! <= 1);
  });

  test("retention ratios are null rather than Infinity when MRR started at zero", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", FEB.start + DAY, 99_900));
    const m = mrrMovement(h.db, h.projectId, { periodStart: FEB.start, periodEnd: FEB.end, currency: "INR" });
    assert.equal(m.netRevenueRetention, null);
    assert.equal(m.grossRevenueRetention, null);
    assert.ok(m.caveats.some((c) => /Starting MRR was zero/.test(c)));
  });

  test("warns that simulator figures are not real payments", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", JAN.start, 99_900));
    const m = mrrMovement(h.db, h.projectId, { periodStart: JAN.start, periodEnd: JAN.end, currency: "INR" });
    assert.ok(m.caveats.some((c) => /simulator/i.test(c) && /not real payments/i.test(c)));
  });

  test("warns when other currencies exist", () => {
    const h = harness();
    must(send(h, "inr", "subscription_started", JAN.start, 99_900, { currency: "INR" }));
    must(send(h, "usd", "subscription_started", JAN.start, 2_900, { currency: "USD" }));
    const m = mrrMovement(h.db, h.projectId, { periodStart: JAN.start, periodEnd: JAN.end, currency: "INR" });
    assert.ok(m.caveats.some((c) => /USD/.test(c) && /never converted/.test(c)));
  });

  test("publishes the definition of every metric it reports", () => {
    const h = harness();
    const m = mrrMovement(h.db, h.projectId, { periodStart: JAN.start, periodEnd: JAN.end, currency: "INR" });
    assert.match(m.definitions.mrr, /divided by 12/);
    assert.match(m.definitions.netRevenueRetention, /Excludes new and reactivated/);
    assert.match(m.definitions.grossRevenueRetention, /never exceed/);
  });
});

describe("idempotent provider events", () => {
  test("a repeated webhook delivery does not double-count", () => {
    const h = harness();
    const event = {
      provider: "simulator" as const,
      externalEventId: "stable-event-id",
      externalSubscriptionId: "sub-1",
      type: "subscription_started" as const,
      occurredAt: JAN.start,
      amountMinor: 99_900,
      currency: "INR",
      interval: "month" as const,
    };
    const first = must(applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, event));
    assert.equal(first.applied, true);
    const second = must(applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, event));
    assert.equal(second.applied, false, "a replayed event is a no-op");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM subscription_events")!.n, 1);
    assert.equal(mrrSnapshot(h.db, h.projectId, JAN.end)[0]!.mrrMinor, 99_900);
  });

  test("rejects a malformed amount or currency", () => {
    const h = harness();
    const bad = applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      provider: "simulator", externalEventId: "x", externalSubscriptionId: "s",
      type: "subscription_started", occurredAt: JAN.start, amountMinor: -1, currency: "INR",
    });
    assert.equal(bad.ok, false);
    const badCurrency = applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      provider: "simulator", externalEventId: "y", externalSubscriptionId: "s",
      type: "subscription_started", occurredAt: JAN.start, amountMinor: 100, currency: "rupees",
    });
    assert.equal(badCurrency.ok, false);
  });

  test("a refund does not end the subscription", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", JAN.start, 99_900));
    must(send(h, "sub-1", "refunded", JAN.start + DAY, 99_900));
    assert.equal(mrrSnapshot(h.db, h.projectId, JAN.end)[0]!.mrrMinor, 99_900);
  });

  test("payment recovery restores active status", () => {
    const h = harness();
    must(send(h, "sub-1", "subscription_started", JAN.start, 99_900));
    must(send(h, "sub-1", "payment_failed", JAN.start + DAY, 99_900));
    must(send(h, "sub-1", "payment_recovered", JAN.start + 2 * DAY, 99_900));
    const snap = mrrSnapshot(h.db, h.projectId, JAN.end)[0]!;
    assert.equal(snap.activeSubscriptions, 1);
    assert.equal(snap.pastDueSubscriptions, 0);
  });
});

describe("churnBreakdown", () => {
  test("separates verified causes and never invents one", () => {
    const h = harness();
    must(send(h, "vol", "subscription_started", JAN.start, 99_900));
    must(send(h, "exp", "subscription_started", JAN.start, 99_900));
    must(send(h, "vol", "cancelled", FEB.start + DAY, 99_900));
    must(send(h, "exp", "expired", FEB.start + DAY, 99_900));
    const b = churnBreakdown(h.db, h.projectId, FEB.start, FEB.end);
    assert.equal(b.voluntary, 1);
    assert.equal(b.expiration, 1);
    assert.equal(b.total, 2);
    assert.equal(b.unknown, 0);
    assert.match(b.note, /does not infer why/);
  });
});

describe("revenueAtRisk", () => {
  test("reports observed amounts in each at-risk state", () => {
    const h = harness("UTC");
    // An active paying user who has not been seen for three weeks.
    h.event("quiet-user", "signup_completed", T0 - 40 * DAY);
    must(send(h, "sub-quiet", "subscription_started", T0 - 40 * DAY, 99_900, { userId: "quiet-user" }));
    // An active paying user seen today.
    h.event("busy-user", "core_action_completed", T0);
    must(send(h, "sub-busy", "subscription_started", T0 - 40 * DAY, 99_900, { userId: "busy-user" }));
    // A failed payment.
    must(send(h, "sub-failed", "subscription_started", T0 - 40 * DAY, 249_900));
    must(send(h, "sub-failed", "payment_failed", T0 - DAY, 249_900));

    const r = revenueAtRisk(h.db, h.projectId, { thresholdDays: 14, currency: "INR", now: T0 });
    assert.equal(r.inactivePaidCount, 1);
    assert.equal(r.inactivePaidMrrMinor, 99_900);
    assert.equal(r.paymentFailureCount, 1);
    assert.equal(r.paymentFailureMrrMinor, 249_900);
    assert.match(r.label, /not evidence that a\s+customer will cancel/);
  });

  test("labels its figures as observed, never as recoverable", () => {
    const h = harness();
    const r = revenueAtRisk(h.db, h.projectId, { thresholdDays: 14, currency: "INR", now: T0 });
    assert.match(r.label, /Observed amounts/);
    assert.match(r.label, /no amount here is promised recoverable/i);
  });
});

describe("currenciesInUse", () => {
  test("lists only currencies actually present", () => {
    const h = harness();
    assert.deepEqual(currenciesInUse(h.db, h.projectId), []);
    must(send(h, "a", "subscription_started", JAN.start, 1, { currency: "INR" }));
    must(send(h, "b", "subscription_started", JAN.start, 1, { currency: "USD" }));
    assert.deepEqual(currenciesInUse(h.db, h.projectId), ["INR", "USD"]);
  });
});

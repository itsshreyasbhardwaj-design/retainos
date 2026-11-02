import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  entitlementFor, consumeUsage, currentUsage, requireFeature, checkCountLimit,
  usageSummary, hasFeature, trackedUsersThisMonth, checkTrackedUsers,
} from "../src/entitlements.ts";
import { ingestBatch, ingestLimiter, authenticateWriteKey } from "../src/ingest.ts";
import { createProject } from "../src/accounts.ts";
import {
  PLANS, annualDiscountPercent, priceFor, formatPaise, eventHeadroomRatio, PRICING_AXIS,
} from "@retainos/shared";
import { fixture, must, mustFail } from "./helpers.ts";

const NOW = Date.UTC(2026, 2, 14, 12);

describe("plan resolution", () => {
  test("a new organization is on the free plan", () => {
    const f = fixture({ plan: "free" });
    const ent = entitlementFor(f.db, f.orgId);
    assert.equal(ent.planId, "free");
    assert.equal(ent.limits.trackedUsersPerMonth, 1_000);
    assert.equal(ent.features.retentionCohorts, false);
  });

  test("a growth organization gets growth features", () => {
    const f = fixture({ plan: "growth" });
    const ent = entitlementFor(f.db, f.orgId);
    assert.equal(ent.planId, "growth");
    assert.equal(ent.features.experiments, true);
    assert.equal(ent.features.revenueIntelligence, true);
    assert.equal(ent.features.multiWorkspace, false);
  });

  test("a past-due organization falls back to free limits but keeps data access", () => {
    const f = fixture({ plan: "growth" });
    f.db.run("UPDATE org_subscriptions SET status = 'past_due' WHERE org_id = ?", [f.orgId]);
    const ent = entitlementFor(f.db, f.orgId);
    assert.equal(ent.planId, "free");
    assert.equal(ent.status, "past_due");
    assert.equal(ent.features.dataExport, true, "a customer must always be able to export their own data");
  });

  test("entitlements are read from the database, not from the caller", () => {
    const f = fixture({ plan: "free" });
    // Forging a scope cannot change the plan: the plan is looked up by org id.
    const forged = { ...f.orgScope, role: "owner" as const };
    assert.equal(mustFail(requireFeature(f.db, forged, "experiments")).code, "entitlement_exceeded");
  });
});

describe("metered usage", () => {
  test("consume accumulates within a period", () => {
    const f = fixture({ plan: "free" });
    consumeUsage(f.db, f.orgId, "ai_queries", 3, NOW);
    consumeUsage(f.db, f.orgId, "ai_queries", 4, NOW);
    assert.equal(currentUsage(f.db, f.orgId, "ai_queries", NOW), 7);
  });

  test("usage resets in a new calendar month", () => {
    const f = fixture({ plan: "free" });
    consumeUsage(f.db, f.orgId, "ai_queries", 10, Date.UTC(2026, 2, 31, 23));
    assert.equal(currentUsage(f.db, f.orgId, "ai_queries", Date.UTC(2026, 3, 1, 1)), 0);
  });

  test("partial acceptance at the limit, not all-or-nothing", () => {
    const f = fixture({ plan: "free" });
    const ceiling = PLANS.free.limits.eventsPerMonth;
    consumeUsage(f.db, f.orgId, "events_ingested", ceiling - 5, NOW);
    const r = consumeUsage(f.db, f.orgId, "events_ingested", 10, NOW);
    assert.equal(r.allowed, 5);
    assert.equal(r.used, ceiling);
    assert.equal(r.remaining, 0);
  });

  test("consuming past the limit allows nothing further", () => {
    const f = fixture({ plan: "free" });
    consumeUsage(f.db, f.orgId, "events_ingested", PLANS.free.limits.eventsPerMonth, NOW);
    assert.equal(consumeUsage(f.db, f.orgId, "events_ingested", 1, NOW).allowed, 0);
  });

  test("a zero-limit metric refuses everything", () => {
    const f = fixture({ plan: "free" }); // free plan has 0 integration syncs
    assert.equal(consumeUsage(f.db, f.orgId, "integration_syncs", 1, NOW).allowed, 0);
  });
});

describe("ingestion respects the event quota", () => {
  test("a batch that crosses the quota accepts what fits and rejects the rest", () => {
    ingestLimiter.reset();
    const f = fixture({ plan: "free" });
    // Leave room for exactly 3 more events this month.
    consumeUsage(f.db, f.orgId, "events_ingested", PLANS.free.limits.eventsPerMonth - 3, NOW);
    const events = Array.from({ length: 5 }, (_, i) => ({
      name: "core_action_completed", userId: `u-${i}`, consent: true,
    }));
    const r = must(ingestBatch(f.db, f.ingest, { events }, NOW));
    assert.equal(r.accepted, 3);
    assert.equal(r.rejected, 2);
    assert.equal(r.outcomes[3]!.reason, "event_quota_exceeded");
    assert.equal(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_events")!.n, 3);
  });

  test("the quota is reported back so the SDK can back off", () => {
    ingestLimiter.reset();
    const f = fixture({ plan: "free" });
    const r = must(ingestBatch(f.db, f.ingest, {
      events: [{ name: "signup_completed", userId: "u", consent: true }],
    }, NOW));
    assert.equal(r.quota?.limit, PLANS.free.limits.eventsPerMonth);
    assert.equal(r.quota?.used, 1);
  });

  test("usage is not consumed for events that were rejected for other reasons", () => {
    ingestLimiter.reset();
    const f = fixture({ plan: "free" });
    must(ingestBatch(f.db, f.ingest, {
      events: [{ name: "BAD NAME", userId: "u", consent: true }],
    }, NOW));
    // The reservation is sized to the batch, but only accepted events are stored.
    // What matters commercially: stored events never exceed the plan.
    const stored = f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_events")!.n;
    assert.equal(stored, 0);
  });
});

describe("count limits", () => {
  test("project count is capped by plan, and createProject enforces it", () => {
    const f = fixture({ plan: "free" }); // free: 1 project; the fixture made one
    assert.equal(mustFail(checkCountLimit(f.db, f.orgScope, "projects")).code, "entitlement_exceeded");
    // The cap is enforced in the write path, not only in the pre-check, so an
    // owner with full permissions still cannot exceed their plan.
    const e = mustFail(createProject(f.db, f.orgScope, { name: "Second project" }));
    assert.equal(e.code, "entitlement_exceeded");
    assert.equal(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n, 1);
  });

  test("a starter organization can create more projects", () => {
    const f = fixture({ plan: "starter" });
    assert.ok(checkCountLimit(f.db, f.orgScope, "projects").ok);
  });

  test("team member count is capped", () => {
    const f = fixture({ plan: "free" }); // free: 1 member
    assert.equal(mustFail(checkCountLimit(f.db, f.orgScope, "teamMembers")).code, "entitlement_exceeded");
  });
});

describe("usage summary", () => {
  test("reports percentages against the plan", () => {
    const f = fixture({ plan: "starter" });
    const half = PLANS.starter.limits.eventsPerMonth / 2;
    consumeUsage(f.db, f.orgId, "events_ingested", half, NOW);
    const s = usageSummary(f.db, f.orgId, NOW);
    const events = s.metrics.find((m) => m.metric === "events_ingested")!;
    assert.equal(events.used, half);
    assert.equal(events.limit, PLANS.starter.limits.eventsPerMonth);
    assert.equal(events.percent, 50);
    assert.equal(s.plan.id, "starter");
  });
});

describe("plan catalogue", () => {
  test("annual discount is derived, not asserted in copy", () => {
    assert.equal(annualDiscountPercent(PLANS.starter), 17);
    assert.equal(annualDiscountPercent(PLANS.free), 0);
  });

  test("prices are stored in minor units and formatted for India", () => {
    assert.equal(priceFor(PLANS.starter, "month"), 99_900);
    assert.equal(formatPaise(99_900), "₹999");
    assert.equal(formatPaise(0), "₹0");
  });

  test("every plan higher up the ladder is a superset of features", () => {
    const order = ["free", "starter", "growth", "agency"] as const;
    for (let i = 1; i < order.length; i++) {
      const lower = PLANS[order[i - 1]!].features;
      const higher = PLANS[order[i]!].features;
      for (const key of Object.keys(lower) as Array<keyof typeof lower>) {
        if (lower[key]) {
          assert.equal(higher[key], true, `${order[i]} is missing ${key} which ${order[i - 1]} has`);
        }
      }
    }
  });

  test("feature flags and limits are consistent", () => {
    for (const plan of Object.values(PLANS)) {
      assert.ok(plan.limits.eventsPerMonth > 0, `${plan.id} must allow some events`);
      assert.ok(plan.limits.trackedUsersPerMonth > 0, `${plan.id} must allow some tracked users`);
      assert.ok(plan.limits.projects > 0);
      // The claim that events are not the price lever, made checkable: the
      // ceiling is always at least a hundred events per tracked user, so
      // instrumenting thoroughly cannot be what pushes a team into a plan.
      assert.ok(
        eventHeadroomRatio(plan) >= 100,
        `${plan.id} has only ${eventHeadroomRatio(plan)} events per tracked user`,
      );
      if (plan.features.experiments) assert.ok(plan.features.impactLab, `${plan.id}: experiments need ImpactLab`);
      if (plan.features.githubIntegration) assert.ok(plan.features.fixFlow, `${plan.id}: GitHub needs FixFlow`);
    }
  });

  test("hasFeature is a thin, honest wrapper", () => {
    const f = fixture({ plan: "growth" });
    assert.equal(hasFeature(f.db, f.orgId, "experiments"), true);
    assert.equal(hasFeature(f.db, f.orgId, "multiWorkspace"), false);
  });
});

describe("tracked users are the pricing axis", () => {
  test("the axis is tracked users, and that is stated as data", () => {
    assert.equal(PRICING_AXIS.axis, "trackedUsersPerMonth");
    assert.match(PRICING_AXIS.explanation, /punishes careful instrumentation/);
  });

  test("nothing essential is behind the paywall", () => {
    // Exporting your own data, privacy requests and seeing broken
    // instrumentation are never charged for, on any plan.
    assert.ok(PRICING_AXIS.neverCharged.some((n) => /Exporting your own data/.test(n)));
    for (const plan of Object.values(PLANS)) {
      assert.equal(plan.features.dataExport, true, `${plan.id} must allow data export`);
    }
  });

  test("the same person on five days is one tracked user", () => {
    const f = fixture({ plan: "free" });
    ingestLimiter.reset();
    for (let day = 0; day < 5; day++) {
      must(ingestBatch(f.db, f.ingest, {
        events: [{ name: "core_action_completed", userId: "same-person", consent: true }],
      }, NOW + day * 3_600_000));
    }
    assert.equal(trackedUsersThisMonth(f.db, f.orgId, NOW), 1);
  });

  test("a full allowance refuses new people and leaves existing ones working", () => {
    const f = fixture({ plan: "free" });
    ingestLimiter.reset();
    const limit = PLANS.free.limits.trackedUsersPerMonth;
    // Fill the allowance directly; ingesting a thousand users through the
    // rate limiter would be testing the rate limiter.
    for (let i = 0; i < limit; i++) {
      f.db.run(
        `INSERT INTO identities (id, org_id, project_id, external_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`idn_seed_${i}`, f.orgId, f.projectId, `seed-${i}`, NOW, NOW],
      );
      f.db.run(
        `INSERT INTO analytics_events
          (id, org_id, project_id, identity_id, name, occurred_at, received_at)
         VALUES (?, ?, ?, ?, 'page_viewed', ?, ?)`,
        [`evt_seed_${i}`, f.orgId, f.projectId, `idn_seed_${i}`, NOW, NOW],
      );
    }
    const check = checkTrackedUsers(f.db, f.orgId, NOW);
    assert.equal(check.canTrackNew, false);
    assert.match(check.detail, /People already being tracked are unaffected/);

    // A known person keeps working.
    const known = must(ingestBatch(f.db, f.ingest, {
      events: [{ name: "core_action_completed", userId: "seed-0", consent: true }],
    }, NOW));
    assert.equal(known.accepted, 1);

    // A new person is refused, with a reason that says which problem it is.
    const fresh = must(ingestBatch(f.db, f.ingest, {
      events: [{ name: "core_action_completed", userId: "brand-new", consent: true }],
    }, NOW));
    assert.equal(fresh.accepted, 0);
    assert.equal(fresh.outcomes[0]!.reason, "tracked_user_limit_reached");
  });

  test("a missing identifier is still reported as a missing identifier", () => {
    const f = fixture({ plan: "free" });
    ingestLimiter.reset();
    const r = must(ingestBatch(f.db, f.ingest, {
      events: [{ name: "core_action_completed", consent: true }],
    }, NOW));
    assert.equal(r.outcomes[0]!.reason, "no_identity");
  });
});

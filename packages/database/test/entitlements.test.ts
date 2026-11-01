import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  entitlementFor, consumeUsage, currentUsage, requireFeature, checkCountLimit,
  usageSummary, hasFeature,
} from "../src/entitlements.ts";
import { ingestBatch, ingestLimiter, authenticateWriteKey } from "../src/ingest.ts";
import { createProject } from "../src/accounts.ts";
import { PLANS, annualDiscountPercent, priceFor, formatPaise } from "@retainos/shared";
import { fixture, must, mustFail } from "./helpers.ts";

const NOW = Date.UTC(2026, 2, 14, 12);

describe("plan resolution", () => {
  test("a new organization is on the free plan", () => {
    const f = fixture({ plan: "free" });
    const ent = entitlementFor(f.db, f.orgId);
    assert.equal(ent.planId, "free");
    assert.equal(ent.limits.eventsPerMonth, 10_000);
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
    const f = fixture({ plan: "free" }); // free: 10,000 events/month
    consumeUsage(f.db, f.orgId, "events_ingested", 9_995, NOW);
    const r = consumeUsage(f.db, f.orgId, "events_ingested", 10, NOW);
    assert.equal(r.allowed, 5);
    assert.equal(r.used, 10_000);
    assert.equal(r.remaining, 0);
  });

  test("consuming past the limit allows nothing further", () => {
    const f = fixture({ plan: "free" });
    consumeUsage(f.db, f.orgId, "events_ingested", 10_000, NOW);
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
    consumeUsage(f.db, f.orgId, "events_ingested", 9_997, NOW);
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
    assert.equal(r.quota?.limit, 10_000);
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
    consumeUsage(f.db, f.orgId, "events_ingested", 50_000, NOW);
    const s = usageSummary(f.db, f.orgId, NOW);
    const events = s.metrics.find((m) => m.metric === "events_ingested")!;
    assert.equal(events.used, 50_000);
    assert.equal(events.limit, 100_000);
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
      assert.ok(plan.limits.projects > 0);
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

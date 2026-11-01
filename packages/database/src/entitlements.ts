import {
  PLANS, type PlanId, type PlanFeatures, type PlanLimits,
  ok, err, domainError, monthKey, type Result, type DomainError,
} from "@retainos/shared";
import type { Db } from "./db.ts";
import type { OrgScope } from "./scope.ts";

export type UsageMetric =
  | "events_ingested"
  | "ai_queries"
  | "reports_generated"
  | "integration_syncs";

export interface Entitlement {
  planId: PlanId;
  limits: PlanLimits;
  features: PlanFeatures;
  status: "active" | "past_due" | "cancelled" | "trialing";
}

/**
 * Entitlements are resolved from the database, never from the client, and every
 * gate below is called server-side. A past-due or cancelled organization falls
 * back to free-plan limits rather than losing access to its own data.
 */
export function entitlementFor(db: Db, orgId: string): Entitlement {
  const row = db.get<{ plan_id: string; status: string }>(
    "SELECT plan_id, status FROM org_subscriptions WHERE org_id = ?",
    [orgId],
  );
  const status = (row?.status ?? "active") as Entitlement["status"];
  const requested = (row?.plan_id ?? "free") as PlanId;
  const effective: PlanId = status === "active" || status === "trialing" ? requested : "free";
  const plan = PLANS[effective] ?? PLANS.free;
  return { planId: plan.id, limits: plan.limits, features: plan.features, status };
}

export function hasFeature(db: Db, orgId: string, feature: keyof PlanFeatures): boolean {
  return entitlementFor(db, orgId).features[feature];
}

export function requireFeature(
  db: Db,
  scope: OrgScope,
  feature: keyof PlanFeatures,
): Result<true, DomainError> {
  const ent = entitlementFor(db, scope.orgId);
  if (ent.features[feature]) return ok(true);
  return err(
    domainError("entitlement_exceeded", `Your ${PLANS[ent.planId].name} plan does not include this capability.`, {
      feature, plan: ent.planId,
    }),
  );
}

export function usagePeriodKey(now = Date.now()): string {
  return monthKey(now, "UTC");
}

export function currentUsage(db: Db, orgId: string, metric: UsageMetric, now = Date.now()): number {
  const row = db.get<{ value: number }>(
    "SELECT value FROM usage_counters WHERE org_id = ? AND period_key = ? AND metric = ?",
    [orgId, usagePeriodKey(now), metric],
  );
  return row?.value ?? 0;
}

const LIMIT_FOR: Record<UsageMetric, keyof PlanLimits> = {
  events_ingested: "eventsPerMonth",
  ai_queries: "aiQueriesPerMonth",
  reports_generated: "reportsPerMonth",
  integration_syncs: "integrationSyncsPerMonth",
};

export interface UsageCheck {
  allowed: number;
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Reserve `amount` of a metered metric.
 *
 * Partial acceptance is deliberate for ingestion: when a batch of 100 events
 * crosses the monthly limit at event 60, RetainOS accepts 60 and reports 40
 * rejected rather than silently dropping the batch or billing beyond the plan.
 */
export function consumeUsage(
  db: Db,
  orgId: string,
  metric: UsageMetric,
  amount: number,
  now = Date.now(),
): UsageCheck {
  const limit = entitlementFor(db, orgId).limits[LIMIT_FOR[metric]];
  const period = usagePeriodKey(now);
  const used = currentUsage(db, orgId, metric, now);
  const remaining = Math.max(0, limit - used);
  const allowed = Math.max(0, Math.min(amount, remaining));
  if (allowed > 0) {
    db.run(
      `INSERT INTO usage_counters (org_id, period_key, metric, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, period_key, metric)
       DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at`,
      [orgId, period, metric, allowed, now],
    );
  }
  return { allowed, used: used + allowed, limit, remaining: Math.max(0, remaining - allowed) };
}

/** Count-based limits (projects, members, saved funnels) are checked, not metered. */
export function checkCountLimit(
  db: Db,
  scope: OrgScope,
  what: "projects" | "teamMembers" | "savedFunnels",
): Result<true, DomainError> {
  const ent = entitlementFor(db, scope.orgId);
  const limit = ent.limits[what];
  const counts: Record<typeof what, () => number> = {
    projects: () =>
      (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE org_id = ? AND archived_at IS NULL", [scope.orgId])?.n ?? 0),
    teamMembers: () =>
      (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM organization_memberships WHERE org_id = ?", [scope.orgId])?.n ?? 0),
    savedFunnels: () =>
      (db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM funnel_definitions f JOIN projects p ON p.id = f.project_id WHERE p.org_id = ?",
        [scope.orgId],
      )?.n ?? 0),
  };
  const current = counts[what]();
  if (current >= limit) {
    return err(
      domainError("entitlement_exceeded", `Your ${PLANS[ent.planId].name} plan allows ${limit}. You have ${current}.`, {
        limit, current, what, plan: ent.planId,
      }),
    );
  }
  return ok(true);
}

export function usageSummary(db: Db, orgId: string, now = Date.now()) {
  const ent = entitlementFor(db, orgId);
  const metrics: UsageMetric[] = ["events_ingested", "ai_queries", "reports_generated", "integration_syncs"];
  return {
    plan: PLANS[ent.planId],
    status: ent.status,
    periodKey: usagePeriodKey(now),
    metrics: metrics.map((m) => {
      const limit = ent.limits[LIMIT_FOR[m]];
      const used = currentUsage(db, orgId, m, now);
      return { metric: m, used, limit, percent: limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100)) };
    }),
  };
}

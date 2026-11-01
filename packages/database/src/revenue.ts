import { newId, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";
import { createHash } from "node:crypto";
import type { Db } from "./db.ts";
import { type ProjectScope, require_ } from "./scope.ts";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "paused" | "cancelled" | "expired";
export type SubscriptionInterval = "month" | "quarter" | "year";
export type SubscriptionEventType =
  | "trial_started" | "subscription_started" | "renewed" | "upgraded" | "downgraded"
  | "payment_failed" | "payment_recovered" | "paused" | "resumed" | "cancelled"
  | "expired" | "reactivated" | "refunded";

/** Status a subscription lands in after each verified provider event. */
const STATUS_AFTER: Partial<Record<SubscriptionEventType, SubscriptionStatus>> = {
  trial_started: "trialing",
  subscription_started: "active",
  renewed: "active",
  upgraded: "active",
  downgraded: "active",
  payment_failed: "past_due",
  payment_recovered: "active",
  paused: "paused",
  resumed: "active",
  cancelled: "cancelled",
  expired: "expired",
  reactivated: "active",
};

const CANCELLATION_TYPE: Partial<Record<SubscriptionEventType, "voluntary" | "payment_failure" | "expiration" | "trial_expired" | "downgrade">> = {
  cancelled: "voluntary",
  expired: "expiration",
};

export interface ProviderEvent {
  provider: "razorpay" | "stripe" | "revenuecat" | "simulator" | "manual";
  /** The provider's own event id. Ingestion is idempotent on this value. */
  externalEventId: string;
  externalSubscriptionId: string;
  type: SubscriptionEventType;
  occurredAt: number;
  amountMinor: number;
  currency: string;
  interval?: SubscriptionInterval;
  planName?: string;
  /** Pseudonymous customer id matching an `identify()` call in the SDK. */
  externalUserId?: string | null;
  previousAmountMinor?: number | null;
  payloadDigestSource?: string;
}

/**
 * Apply a verified provider event.
 *
 * Preconditions, all enforced here rather than trusted:
 *  - The caller has already verified the provider's webhook signature.
 *  - Repeat delivery is expected, so the same external event id is a no-op.
 *  - A payment is recorded as successful only because the provider said so in a
 *    signed event. Visiting a checkout success page is not evidence of payment.
 */
export function applyProviderEvent(
  db: Db,
  ids: { orgId: string; projectId: string },
  event: ProviderEvent,
  now = Date.now(),
): Result<{ subscriptionId: string; applied: boolean }, DomainError> {
  if (!Number.isInteger(event.amountMinor) || event.amountMinor < 0) {
    return err(domainError("validation_failed", "amountMinor must be a non-negative integer in minor units."));
  }
  if (!/^[A-Z]{3}$/.test(event.currency)) {
    return err(domainError("validation_failed", "currency must be a 3-letter ISO code."));
  }
  if (!STATUS_AFTER[event.type] && event.type !== "refunded") {
    return err(domainError("validation_failed", `Unknown subscription event type '${event.type}'.`));
  }

  return db.tx(() => {
    const dup = db.get<{ id: string; subscription_id: string }>(
      "SELECT id, subscription_id FROM subscription_events WHERE project_id = ? AND provider = ? AND external_event_id = ?",
      [ids.projectId, event.provider, event.externalEventId],
    );
    if (dup) return ok({ subscriptionId: dup.subscription_id ?? "", applied: false });

    let sub = db.get<{ id: string; amount_minor: number; status: string; currency: string }>(
      "SELECT id, amount_minor, status, currency FROM customer_subscriptions WHERE project_id = ? AND provider = ? AND external_id = ?",
      [ids.projectId, event.provider, event.externalSubscriptionId],
    );

    const identityId = event.externalUserId
      ? db.get<{ id: string }>("SELECT id FROM identities WHERE project_id = ? AND external_id = ?",
          [ids.projectId, event.externalUserId])?.id ?? null
      : null;

    if (!sub) {
      const id = newId("sub");
      db.run(
        `INSERT INTO customer_subscriptions
          (id, org_id, project_id, provider, external_id, identity_id, plan_name, status,
           amount_minor, currency, interval, started_at, trial_ends_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, ids.orgId, ids.projectId, event.provider, event.externalSubscriptionId, identityId,
          event.planName ?? "unknown", STATUS_AFTER[event.type] ?? "active",
          event.amountMinor, event.currency, event.interval ?? "month", event.occurredAt,
          event.type === "trial_started" ? event.occurredAt : null, now,
        ],
      );
      sub = { id, amount_minor: event.amountMinor, status: STATUS_AFTER[event.type] ?? "active", currency: event.currency };
    } else {
      const nextStatus = STATUS_AFTER[event.type] ?? sub.status;
      const amount = event.type === "refunded" ? sub.amount_minor : event.amountMinor;
      db.run(
        `UPDATE customer_subscriptions
            SET status = ?, amount_minor = ?, currency = ?,
                interval = COALESCE(?, interval),
                plan_name = COALESCE(?, plan_name),
                identity_id = COALESCE(?, identity_id),
                cancelled_at = CASE WHEN ? IN ('cancelled','expired') THEN ? ELSE cancelled_at END,
                cancellation_type = CASE WHEN ? IN ('cancelled','expired') THEN ? ELSE cancellation_type END,
                updated_at = ?
          WHERE id = ?`,
        [
          nextStatus, amount, event.currency, event.interval ?? null, event.planName ?? null, identityId,
          event.type, event.occurredAt, event.type, CANCELLATION_TYPE[event.type] ?? null, now, sub.id,
        ],
      );
    }

    db.run(
      `INSERT INTO subscription_events
        (id, org_id, project_id, subscription_id, provider, external_event_id, type, occurred_at, received_at,
         amount_minor, currency, previous_amount_minor, interval, payload_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("sve"), ids.orgId, ids.projectId, sub.id, event.provider, event.externalEventId, event.type,
        event.occurredAt, now, event.amountMinor, event.currency,
        event.previousAmountMinor ?? null, event.interval ?? null,
        event.payloadDigestSource ? createHash("sha256").update(event.payloadDigestSource).digest("hex").slice(0, 32) : null,
      ],
    );

    db.run(
      `INSERT INTO billing_connections (id, org_id, project_id, provider, status, last_event_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'connected', ?, ?, ?)
       ON CONFLICT(project_id, provider) DO UPDATE SET status = 'connected', last_event_at = ?, updated_at = ?`,
      [newId("bcn"), ids.orgId, ids.projectId, event.provider, event.occurredAt, now, now, event.occurredAt, now],
    );

    return ok({ subscriptionId: sub.id, applied: true });
  });
}

export function listSubscriptions(db: Db, scope: ProjectScope, status?: SubscriptionStatus[]) {
  const where = ["s.project_id = ?"];
  const params: unknown[] = [scope.projectId];
  if (status?.length) {
    where.push(`s.status IN (${status.map(() => "?").join(",")})`);
    params.push(...status);
  }
  return db.all(
    `SELECT s.*, i.external_id AS user_external_id, i.last_seen_at
       FROM customer_subscriptions s LEFT JOIN identities i ON i.id = s.identity_id
      WHERE ${where.join(" AND ")} ORDER BY s.amount_minor DESC`,
    params,
  );
}

export function subscriptionEvents(db: Db, projectId: string, from: number, to: number) {
  return db.all<{
    id: string; subscription_id: string; type: SubscriptionEventType; occurred_at: number;
    amount_minor: number; currency: string; previous_amount_minor: number | null; interval: string | null;
  }>(
    `SELECT id, subscription_id, type, occurred_at, amount_minor, currency, previous_amount_minor, interval
       FROM subscription_events WHERE project_id = ? AND occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at ASC, id ASC`,
    [projectId, from, to],
  );
}

export function connectBilling(
  db: Db,
  scope: ProjectScope,
  provider: "razorpay" | "stripe" | "revenuecat" | "simulator" | "manual",
  now = Date.now(),
): Result<true, DomainError> {
  const allowed = require_(scope, "integration:manage");
  if (!allowed.ok) return allowed;
  db.run(
    `INSERT INTO billing_connections (id, org_id, project_id, provider, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'disconnected', ?, ?)
     ON CONFLICT(project_id, provider) DO UPDATE SET updated_at = ?`,
    [newId("bcn"), scope.orgId, scope.projectId, provider, now, now, now],
  );
  return ok(true);
}

export function billingConnections(db: Db, scope: ProjectScope) {
  return db.all("SELECT provider, status, last_event_at, last_error FROM billing_connections WHERE project_id = ?",
    [scope.projectId]);
}

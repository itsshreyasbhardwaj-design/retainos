import { newId } from "@retainos/shared";
import type { Db } from "./db.ts";
import type { ProjectScope } from "./scope.ts";

/**
 * B2B accounts.
 *
 * An account is a company; an identity is a person. RetainOS keeps them apart
 * because conflating one inactive employee with a lost customer account is the
 * single most common way account health gets read wrong.
 *
 * The account key comes from the integrator via an `account_key` event
 * property. RetainOS never infers it from an email domain.
 */
export function upsertAccount(
  db: Db,
  ids: { orgId: string; projectId: string },
  accountKey: string,
  at: number,
  name?: string | null,
): string {
  const existing = db.get<{ id: string }>(
    "SELECT id FROM accounts WHERE project_id = ? AND account_key = ?", [ids.projectId, accountKey],
  );
  if (existing) {
    db.run(
      `UPDATE accounts SET last_seen_at = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_at END,
         first_seen_at = CASE WHEN ? < first_seen_at THEN ? ELSE first_seen_at END,
         name = COALESCE(?, name)
       WHERE id = ?`,
      [at, at, at, at, name ?? null, existing.id],
    );
    return existing.id;
  }
  const id = newId("acc");
  db.run(
    "INSERT INTO accounts (id, org_id, project_id, account_key, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, ids.orgId, ids.projectId, accountKey, name ?? null, at, at],
  );
  return id;
}

export interface AccountRollup {
  accountKey: string;
  name: string | null;
  seats: number;
  activeSeats: number;
  coreFeatureSeats: number;
  activatedSeats: number;
  openFeedback: number;
  subscriptionStatus: string | null;
  mrrMinor: number | null;
  currency: string | null;
  lastSeenAt: number;
}

/**
 * Account-level rollup.
 *
 * Seats are counted from identities carrying the account key. "Active" means
 * activity inside the window; it does not mean the account is healthy, and the
 * health engine is what turns these counts into a judgement.
 */
export function accountRollups(
  db: Db,
  scope: ProjectScope,
  input: { windowDays: number; coreEvent?: string; activationEvent?: string; now?: number; limit?: number },
): AccountRollup[] {
  const now = input.now ?? Date.now();
  const from = now - input.windowDays * 86_400_000;

  return db.all<{
    account_key: string; name: string | null; last_seen_at: number;
    seats: number; active_seats: number; core_seats: number; activated_seats: number;
    open_feedback: number; sub_status: string | null; mrr: number | null; currency: string | null;
  }>(
    `SELECT a.account_key,
            a.name,
            a.last_seen_at,
            (SELECT COUNT(*) FROM identities i
              WHERE i.project_id = a.project_id AND i.account_key = a.account_key
                AND i.deleted_at IS NULL) AS seats,
            (SELECT COUNT(*) FROM identities i
              WHERE i.project_id = a.project_id AND i.account_key = a.account_key
                AND i.deleted_at IS NULL AND i.last_seen_at >= ?) AS active_seats,
            (SELECT COUNT(DISTINCT e.identity_id) FROM analytics_events e
               JOIN identities i ON i.id = e.identity_id
              WHERE e.project_id = a.project_id AND i.account_key = a.account_key
                AND e.name = ? AND e.occurred_at >= ?) AS core_seats,
            (SELECT COUNT(DISTINCT e.identity_id) FROM analytics_events e
               JOIN identities i ON i.id = e.identity_id
              WHERE e.project_id = a.project_id AND i.account_key = a.account_key
                AND e.name = ?) AS activated_seats,
            (SELECT COUNT(*) FROM feedback_items f
               JOIN identities i ON i.id = f.identity_id
              WHERE f.project_id = a.project_id AND i.account_key = a.account_key
                AND f.deleted_at IS NULL AND f.status NOT IN ('closed','released','duplicate')) AS open_feedback,
            (SELECT s.status FROM customer_subscriptions s
               JOIN identities i ON i.id = s.identity_id
              WHERE s.project_id = a.project_id AND i.account_key = a.account_key
              ORDER BY s.amount_minor DESC LIMIT 1) AS sub_status,
            (SELECT s.amount_minor FROM customer_subscriptions s
               JOIN identities i ON i.id = s.identity_id
              WHERE s.project_id = a.project_id AND i.account_key = a.account_key
                AND s.status IN ('active','past_due')
              ORDER BY s.amount_minor DESC LIMIT 1) AS mrr,
            (SELECT s.currency FROM customer_subscriptions s
               JOIN identities i ON i.id = s.identity_id
              WHERE s.project_id = a.project_id AND i.account_key = a.account_key
              ORDER BY s.amount_minor DESC LIMIT 1) AS currency
       FROM accounts a
      WHERE a.project_id = ?
      ORDER BY a.last_seen_at DESC
      LIMIT ?`,
    [
      from,
      input.coreEvent ?? "core_action_completed", from,
      input.activationEvent ?? "project_created",
      scope.projectId,
      Math.min(input.limit ?? 100, 500),
    ],
  ).map((r) => ({
    accountKey: r.account_key,
    name: r.name,
    seats: r.seats,
    activeSeats: r.active_seats,
    coreFeatureSeats: r.core_seats,
    activatedSeats: r.activated_seats,
    openFeedback: r.open_feedback,
    subscriptionStatus: r.sub_status,
    mrrMinor: r.mrr,
    currency: r.currency,
    lastSeenAt: r.last_seen_at,
  }));
}

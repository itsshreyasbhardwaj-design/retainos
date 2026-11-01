import type { Db } from "@retainos/database";
import { monthKey, dayKey, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";

export type Interval = "month" | "quarter" | "year";

/**
 * Normalise a billing amount to monthly recurring revenue.
 *
 * Annual plans are divided by 12 and quarterly by 3. This is the standard
 * convention and it is applied in exactly one place so no two screens can
 * disagree about what MRR means.
 */
export function normaliseToMrr(amountMinor: number, interval: Interval): number {
  if (interval === "year") return amountMinor / 12;
  if (interval === "quarter") return amountMinor / 3;
  return amountMinor;
}

const MRR_BEARING_STATUSES = new Set(["active", "past_due"]);

/**
 * Statuses that contribute to MRR.
 *
 * `trialing` is excluded: a trial has not paid, and counting it as revenue is
 * the fastest way to make MRR a number nobody trusts. `past_due` is included
 * because the subscription still exists and the revenue is at risk rather than
 * gone; it is reported separately under revenue-at-risk.
 */
export function contributesToMrr(status: string): boolean {
  return MRR_BEARING_STATUSES.has(status);
}

export interface SubState {
  subscriptionId: string;
  currency: string;
  mrrMinor: number;
  status: string;
  /** True once this subscription has ever had MRR, for new vs reactivation. */
  hadRevenueBefore: boolean;
}

/**
 * Replay subscription events up to `at` and return each subscription's state.
 * The event log is the source of truth, so any snapshot can be rebuilt.
 */
export function replayTo(db: Db, projectId: string, at: number): Map<string, SubState> {
  const rows = db.all<{
    subscription_id: string; type: string; occurred_at: number; amount_minor: number;
    currency: string; interval: string | null;
  }>(
    `SELECT subscription_id, type, occurred_at, amount_minor, currency, interval
       FROM subscription_events
      WHERE project_id = ? AND occurred_at <= ?
      ORDER BY occurred_at ASC, id ASC`,
    [projectId, at],
  );

  const state = new Map<string, SubState>();
  for (const row of rows) {
    if (!row.subscription_id) continue;
    let s = state.get(row.subscription_id);
    if (!s) {
      s = {
        subscriptionId: row.subscription_id,
        currency: row.currency,
        mrrMinor: 0,
        status: "none",
        hadRevenueBefore: false,
      };
      state.set(row.subscription_id, s);
    }
    s.currency = row.currency;

    switch (row.type) {
      case "trial_started":
        s.status = "trialing";
        s.mrrMinor = 0;
        break;
      case "subscription_started":
      case "renewed":
      case "upgraded":
      case "downgraded":
      case "reactivated":
      case "resumed":
      case "payment_recovered":
        s.status = "active";
        s.mrrMinor = normaliseToMrr(row.amount_minor, (row.interval as Interval) ?? "month");
        if (s.mrrMinor > 0) s.hadRevenueBefore = true;
        break;
      case "payment_failed":
        // Still a live subscription with revenue at risk, not yet lost.
        s.status = "past_due";
        break;
      case "paused":
        s.status = "paused";
        s.mrrMinor = 0;
        break;
      case "cancelled":
        s.status = "cancelled";
        s.mrrMinor = 0;
        break;
      case "expired":
        s.status = "expired";
        s.mrrMinor = 0;
        break;
      case "refunded":
        // A refund does not by itself end the subscription; it is reported in
        // the billing records, not as a churn event.
        break;
    }
  }
  return state;
}

export interface MrrSnapshot {
  at: number;
  currency: string;
  mrrMinor: number;
  arrMinor: number;
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  trialingSubscriptions: number;
  pastDueMrrMinor: number;
}

/** MRR by currency at an instant. Currencies are never summed together. */
export function mrrSnapshot(db: Db, projectId: string, at: number): MrrSnapshot[] {
  const state = replayTo(db, projectId, at);
  const byCurrency = new Map<string, MrrSnapshot>();
  for (const s of state.values()) {
    let snap = byCurrency.get(s.currency);
    if (!snap) {
      snap = {
        at, currency: s.currency, mrrMinor: 0, arrMinor: 0, activeSubscriptions: 0,
        pastDueSubscriptions: 0, trialingSubscriptions: 0, pastDueMrrMinor: 0,
      };
      byCurrency.set(s.currency, snap);
    }
    if (s.status === "active") {
      snap.mrrMinor += s.mrrMinor;
      snap.activeSubscriptions++;
    } else if (s.status === "past_due") {
      snap.mrrMinor += s.mrrMinor;
      snap.pastDueMrrMinor += s.mrrMinor;
      snap.pastDueSubscriptions++;
    } else if (s.status === "trialing") {
      snap.trialingSubscriptions++;
    }
  }
  for (const snap of byCurrency.values()) snap.arrMinor = snap.mrrMinor * 12;
  return [...byCurrency.values()].sort((a, b) => b.mrrMinor - a.mrrMinor);
}

export interface MrrMovement {
  periodKey: string;
  currency: string;
  startMrrMinor: number;
  endMrrMinor: number;
  newMinor: number;
  expansionMinor: number;
  contractionMinor: number;
  churnMinor: number;
  reactivationMinor: number;
  /** Count of subscriptions that went from paying to not paying. */
  churnedCustomers: number;
  startCustomers: number;
  /** Net revenue retention: expansion counted, new business excluded. */
  netRevenueRetention: number | null;
  /** Gross revenue retention: expansion excluded, so it cannot exceed 1. */
  grossRevenueRetention: number | null;
  grossRevenueChurnRate: number | null;
  customerChurnRate: number | null;
  definitions: RevenueDefinitions;
  /** Reasons the figures may be unreliable, stated rather than hidden. */
  caveats: string[];
}

/** The definition of every revenue figure RetainOS reports, as a closed set. */
export interface RevenueDefinitions {
  mrr: string;
  new: string;
  reactivation: string;
  expansion: string;
  contraction: string;
  churn: string;
  netRevenueRetention: string;
  grossRevenueRetention: string;
}

export const REVENUE_DEFINITIONS: RevenueDefinitions = {
  mrr:
    "Sum of normalised monthly amounts for subscriptions in 'active' or 'past_due' status. " +
    "Annual plans are divided by 12, quarterly by 3. Trials contribute nothing.",
  new: "MRR from subscriptions that began paying in this period and had never paid before.",
  reactivation: "MRR from subscriptions that had paid before, stopped, and began paying again in this period.",
  expansion: "Increase in MRR from subscriptions that were already paying at the start of the period.",
  contraction: "Decrease in MRR from subscriptions that were still paying at the end of the period.",
  churn: "MRR lost from subscriptions that were paying at the start of the period and paying nothing at the end.",
  netRevenueRetention:
    "(start + expansion - contraction - churn) / start. Excludes new and reactivated business, so it measures " +
    "what happened to the revenue you already had.",
  grossRevenueRetention:
    "(start - contraction - churn) / start. Expansion is excluded, so this can never exceed 100%.",
};

/**
 * MRR movement for one calendar month, decomposed.
 *
 * The decomposition is computed by comparing each subscription's normalised MRR
 * at the start and the end of the period, which is why the parts always add up
 * to the change in MRR. Classifying from event types alone does not reconcile,
 * because a subscription can be upgraded and then cancelled inside one month.
 */
export function mrrMovement(
  db: Db,
  projectId: string,
  input: { periodStart: number; periodEnd: number; currency: string; periodKey?: string },
): MrrMovement {
  const before = replayTo(db, projectId, input.periodStart - 1);
  const after = replayTo(db, projectId, input.periodEnd);

  const mrrOf = (state: Map<string, SubState>, id: string): number => {
    const s = state.get(id);
    if (!s || s.currency !== input.currency) return 0;
    return contributesToMrr(s.status) ? s.mrrMinor : 0;
  };

  const ids = new Set<string>([...before.keys(), ...after.keys()]);
  let startMrr = 0;
  let endMrr = 0;
  let newMrr = 0;
  let reactivation = 0;
  let expansion = 0;
  let contraction = 0;
  let churn = 0;
  let churnedCustomers = 0;
  let startCustomers = 0;

  for (const id of ids) {
    const start = mrrOf(before, id);
    const end = mrrOf(after, id);
    startMrr += start;
    endMrr += end;
    if (start > 0) startCustomers++;

    if (start === 0 && end > 0) {
      // Paid before this period at some point? Then it is a reactivation.
      const hadBefore = before.get(id)?.hadRevenueBefore ?? false;
      if (hadBefore) reactivation += end;
      else newMrr += end;
    } else if (start > 0 && end === 0) {
      churn += start;
      churnedCustomers++;
    } else if (end > start) {
      expansion += end - start;
    } else if (end < start) {
      contraction += start - end;
    }
  }

  const caveats: string[] = [];
  const connection = db.get<{ provider: string; status: string }>(
    "SELECT provider, status FROM billing_connections WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1",
    [projectId],
  );
  if (!connection) {
    caveats.push("No billing provider is connected, so these figures come only from manually recorded subscriptions.");
  } else if (connection.provider === "simulator") {
    caveats.push("These figures come from the development billing simulator. They are not real payments.");
  }
  if (startMrr === 0) {
    caveats.push("Starting MRR was zero, so retention ratios cannot be computed for this period.");
  }
  if (startCustomers > 0 && startCustomers < 10) {
    caveats.push(`Only ${startCustomers} paying subscriptions at the start of the period; these ratios will swing a lot.`);
  }
  const otherCurrencies = new Set(
    [...after.values()].filter((s) => s.currency !== input.currency && contributesToMrr(s.status)).map((s) => s.currency),
  );
  if (otherCurrencies.size > 0) {
    caveats.push(
      `This project also has subscriptions in ${[...otherCurrencies].join(", ")}. ` +
      "Currencies are reported separately and never converted without an explicit exchange rate.",
    );
  }

  return {
    periodKey: input.periodKey ?? monthKey(input.periodStart, "UTC"),
    currency: input.currency,
    startMrrMinor: startMrr,
    endMrrMinor: endMrr,
    newMinor: newMrr,
    expansionMinor: expansion,
    contractionMinor: contraction,
    churnMinor: churn,
    reactivationMinor: reactivation,
    churnedCustomers,
    startCustomers,
    netRevenueRetention: startMrr === 0 ? null : (startMrr + expansion - contraction - churn) / startMrr,
    grossRevenueRetention: startMrr === 0 ? null : (startMrr - contraction - churn) / startMrr,
    grossRevenueChurnRate: startMrr === 0 ? null : (churn + contraction) / startMrr,
    customerChurnRate: startCustomers === 0 ? null : churnedCustomers / startCustomers,
    definitions: REVENUE_DEFINITIONS,
    caveats,
  };
}

export interface ChurnBreakdown {
  voluntary: number;
  paymentFailure: number;
  expiration: number;
  trialExpired: number;
  downgrade: number
  unknown: number;
  total: number;
  note: string;
}

/**
 * Churn by verified cause.
 *
 * The cause comes from the provider's own event type. RetainOS never infers a
 * cancellation reason, and anything it cannot attribute is reported as unknown
 * rather than bucketed into a guess.
 */
export function churnBreakdown(db: Db, projectId: string, from: number, to: number): ChurnBreakdown {
  const rows = db.all<{ cancellation_type: string | null; n: number }>(
    `SELECT cancellation_type, COUNT(*) AS n FROM customer_subscriptions
      WHERE project_id = ? AND cancelled_at >= ? AND cancelled_at <= ?
      GROUP BY cancellation_type`,
    [projectId, from, to],
  );
  const out: ChurnBreakdown = {
    voluntary: 0, paymentFailure: 0, expiration: 0, trialExpired: 0, downgrade: 0,
    unknown: 0, total: 0,
    note: "Causes come from verified provider events only. RetainOS does not infer why a customer left.",
  };
  const map: Record<string, keyof ChurnBreakdown> = {
    voluntary: "voluntary",
    payment_failure: "paymentFailure",
    expiration: "expiration",
    trial_expired: "trialExpired",
    downgrade: "downgrade",
  };
  for (const r of rows) {
    const key = r.cancellation_type ? map[r.cancellation_type] : undefined;
    if (key && typeof out[key] === "number") (out[key] as number) += r.n;
    else out.unknown += r.n;
    out.total += r.n;
  }
  return out;
}

export interface RevenueAtRisk {
  currency: string;
  /** MRR on subscriptions whose user has had no product activity for a while. */
  inactivePaidMrrMinor: number;
  inactivePaidCount: number;
  /** MRR on subscriptions in past_due, i.e. a failed payment. */
  paymentFailureMrrMinor: number;
  paymentFailureCount: number;
  /** MRR lost to subscriptions already cancelled in the window. */
  cancelledMrrMinor: number;
  cancelledCount: number;
  thresholdDays: number;
  label: string;
}

/**
 * Revenue at risk.
 *
 * Every figure here is an *observed* amount — MRR currently attached to
 * subscriptions in a given state — not a forecast. Inactivity is a signal worth
 * looking at, not proof that a customer will cancel, and the label says so.
 */
export function revenueAtRisk(
  db: Db,
  projectId: string,
  input: { thresholdDays: number; currency: string; now?: number },
): RevenueAtRisk {
  const now = input.now ?? Date.now();
  const cutoff = now - input.thresholdDays * 86_400_000;

  const inactive = db.all<{ amount_minor: number; interval: string }>(
    `SELECT s.amount_minor, s.interval FROM customer_subscriptions s
       JOIN identities i ON i.id = s.identity_id
      WHERE s.project_id = ? AND s.currency = ? AND s.status IN ('active','past_due')
        AND i.last_seen_at < ?`,
    [projectId, input.currency, cutoff],
  );
  const pastDue = db.all<{ amount_minor: number; interval: string }>(
    `SELECT amount_minor, interval FROM customer_subscriptions
      WHERE project_id = ? AND currency = ? AND status = 'past_due'`,
    [projectId, input.currency],
  );
  const cancelled = db.all<{ amount_minor: number; interval: string }>(
    `SELECT amount_minor, interval FROM customer_subscriptions
      WHERE project_id = ? AND currency = ? AND status IN ('cancelled','expired') AND cancelled_at >= ?`,
    [projectId, input.currency, cutoff],
  );

  const sum = (rows: Array<{ amount_minor: number; interval: string }>) =>
    rows.reduce((s, r) => s + normaliseToMrr(r.amount_minor, (r.interval as Interval) ?? "month"), 0);

  return {
    currency: input.currency,
    inactivePaidMrrMinor: sum(inactive),
    inactivePaidCount: inactive.length,
    paymentFailureMrrMinor: sum(pastDue),
    paymentFailureCount: pastDue.length,
    cancelledMrrMinor: sum(cancelled),
    cancelledCount: cancelled.length,
    thresholdDays: input.thresholdDays,
    label:
      "Observed amounts and heuristic risk exposure. Inactivity is a signal to investigate, not evidence that a " +
      "customer will cancel, and no amount here is promised recoverable.",
  };
}

/** Monthly MRR series, for a chart. Each month is computed independently. */
export function mrrSeries(
  db: Db,
  projectId: string,
  input: { months: Array<{ key: string; start: number; end: number }>; currency: string },
): MrrMovement[] {
  return input.months.map((m) =>
    mrrMovement(db, projectId, {
      periodStart: m.start,
      periodEnd: m.end,
      currency: input.currency,
      periodKey: m.key,
    }),
  );
}

export function currenciesInUse(db: Db, projectId: string): string[] {
  return db.all<{ currency: string }>(
    "SELECT DISTINCT currency FROM customer_subscriptions WHERE project_id = ? ORDER BY currency",
    [projectId],
  ).map((r) => r.currency);
}

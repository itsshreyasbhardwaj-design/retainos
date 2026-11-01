import { type Db } from "@retainos/database";
import { newId, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";
import { normaliseToMrr, contributesToMrr, type Interval } from "./revenue.ts";

/**
 * Customer and account health, explained.
 *
 * Health scores in this category are almost always a number between 0 and 100
 * produced by a formula nobody outside the vendor has seen. That number cannot
 * be argued with, which is exactly why it is popular and exactly why it is
 * useless: a success manager cannot act on "67", and cannot tell whether 67
 * means "logged in less" or "about to leave".
 *
 * So there is no score here. There are named signals, each with what was
 * observed, how it counted, and what would change it — and a state that is a
 * category a human can disagree with. Thin data produces
 * `insufficient_information` rather than a confident middling number, because
 * the most damaging failure mode of a health score is looking fine.
 */

export type HealthState =
  | "strong_engagement"
  | "mixed_signals"
  | "attention_suggested"
  | "insufficient_information";

export const HEALTH_STATE_MEANING: Record<HealthState, string> = {
  strong_engagement:
    "Every signal with enough data behind it points the same way, and none is concerning.",
  mixed_signals:
    "Some signals are positive and some are not. This is the normal state for most accounts and is not a warning.",
  attention_suggested:
    "One or more signals are concerning enough to be worth a look. This is not a prediction that the customer will leave.",
  insufficient_information:
    "Too few signals have enough data to say anything. Stated plainly rather than reported as a middling score.",
};

export const HEALTH_DISCLAIMER =
  "A health state is a summary of observed product signals. It is not a churn probability, not a prediction, " +
  "and not a reason to treat a customer differently without talking to them.";

export type SignalId =
  | "recent_activity"
  | "activity_trend"
  | "breadth_of_use"
  | "activation_reached"
  | "seat_engagement"
  | "error_exposure"
  | "unresolved_feedback"
  | "billing_status";

export type SignalDirection = "supporting" | "concerning" | "neutral" | "unknown";

export interface SignalObservation {
  signal: SignalId;
  label: string;
  /** What the data says, in the signal's own units. */
  observed: string;
  /** Numeric value where one exists, for sorting and charting. */
  value: number | null;
  direction: SignalDirection;
  /** Why this direction, in one sentence a customer-facing person can repeat. */
  detail: string;
  /** What would move this signal. An explanation nobody can act on is decoration. */
  whatWouldChangeIt: string;
  /** False when the signal had too little data to say anything. */
  hasEnoughData: boolean;
}

export interface SignalWeight {
  signal: SignalId;
  weight: number;
}

export const DEFAULT_SIGNAL_WEIGHTS: Record<SignalId, number> = {
  recent_activity: 1.0,
  activity_trend: 0.8,
  breadth_of_use: 0.6,
  activation_reached: 0.9,
  seat_engagement: 0.7,
  error_exposure: 0.8,
  unresolved_feedback: 0.4,
  billing_status: 1.0,
};

/** Below this many signals with data, no state is claimed. */
export const MINIMUM_SIGNALS_WITH_DATA = 3;

export interface HealthAssessment {
  subjectKind: "identity" | "account";
  subjectId: string;
  /** For an account, the people it covers; for an identity, always 1. */
  subjects: number;
  state: HealthState;
  signals: SignalObservation[];
  /** The named signals that drove the state, strongest concern first. */
  drivers: SignalObservation[];
  /** Why the state is what it is, in order. */
  reasoning: string[];
  observedAt: number;
  windowDays: number;
  disclaimer: string;
}

export interface HealthConfig {
  windowDays?: number;
  /** The event that means a user got value. Health is weaker without one. */
  activationEvent?: string;
  /** Events that represent core use, for breadth. */
  coreEvents?: string[];
  weights?: Partial<Record<SignalId, number>>;
  now?: number;
}

// ---------------------------------------------------------------------------
// Signal computation
// ---------------------------------------------------------------------------

interface Window {
  from: number;
  to: number;
  priorFrom: number;
  priorTo: number;
  days: number;
}

function windowFor(config: HealthConfig): Window {
  const now = config.now ?? Date.now();
  const days = config.windowDays ?? 28;
  const span = days * 86_400_000;
  return { from: now - span, to: now, priorFrom: now - 2 * span, priorTo: now - span, days };
}

function identityIdsFor(
  db: Db, projectId: string, subject: { kind: "identity" | "account"; id: string },
): string[] {
  if (subject.kind === "identity") return [subject.id];
  return db.all<{ id: string }>(
    "SELECT id FROM identities WHERE project_id = ? AND account_key = ? AND deleted_at IS NULL",
    [projectId, subject.id],
  ).map((r) => r.id);
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

function recentActivity(db: Db, projectId: string, ids: string[], w: Window): SignalObservation {
  const row = db.get<{ days: number; events: number }>(
    `SELECT COUNT(DISTINCT occurred_at / 86400000) AS days, COUNT(*) AS events
       FROM analytics_events
      WHERE project_id = ? AND identity_id IN (${placeholders(ids.length)})
        AND occurred_at >= ? AND occurred_at <= ?`,
    [projectId, ...ids, w.from, w.to],
  );
  const activeDays = row?.days ?? 0;
  const events = row?.events ?? 0;
  // A quarter of the window is a deliberately low bar: this signal is meant to
  // separate "using it" from "gone", not to grade enthusiasm.
  const threshold = Math.max(2, Math.floor(w.days / 4));
  return {
    signal: "recent_activity",
    label: "Recent activity",
    observed: `${activeDays} active day(s) and ${events} event(s) in the last ${w.days} days`,
    value: activeDays,
    direction: events === 0 ? "concerning" : activeDays >= threshold ? "supporting" : "neutral",
    detail: events === 0
      ? `No activity at all in the last ${w.days} days.`
      : `${activeDays} active days against a threshold of ${threshold} for this window length.`,
    whatWouldChangeIt: `Activity on ${threshold} or more separate days inside the window.`,
    hasEnoughData: true,
  };
}

function activityTrend(db: Db, projectId: string, ids: string[], w: Window): SignalObservation {
  const count = (from: number, to: number) => db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM analytics_events
      WHERE project_id = ? AND identity_id IN (${placeholders(ids.length)})
        AND occurred_at >= ? AND occurred_at <= ?`,
    [projectId, ...ids, from, to],
  )?.n ?? 0;

  const current = count(w.from, w.to);
  const prior = count(w.priorFrom, w.priorTo);
  // Below this, the ratio is noise rather than a trend.
  const enough = prior >= 10;
  const change = enough ? (current - prior) / prior : null;

  return {
    signal: "activity_trend",
    label: "Activity trend",
    observed: enough
      ? `${prior} event(s) in the previous ${w.days} days, ${current} in the most recent ${w.days}`
      : `Only ${prior} event(s) in the previous period — too few to compare`,
    value: change,
    direction: !enough ? "unknown" : change! <= -0.5 ? "concerning" : change! >= 0 ? "supporting" : "neutral",
    detail: !enough
      ? "A trend needs at least 10 events in the earlier period to mean anything."
      : `Activity changed by ${(change! * 100).toFixed(0)}% between the two periods.`,
    whatWouldChangeIt: "Activity returning to or above its level in the previous period.",
    hasEnoughData: enough,
  };
}

function breadthOfUse(
  db: Db, projectId: string, ids: string[], w: Window, coreEvents: string[] | undefined,
): SignalObservation {
  if (!coreEvents || coreEvents.length === 0) {
    return {
      signal: "breadth_of_use",
      label: "Breadth of use",
      observed: "No core events configured",
      value: null,
      direction: "unknown",
      detail: "Breadth cannot be assessed until the project says which events represent core use.",
      whatWouldChangeIt: "Naming the handful of events that mean someone is really using the product.",
      hasEnoughData: false,
    };
  }
  const used = db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT name) AS n FROM analytics_events
      WHERE project_id = ? AND identity_id IN (${placeholders(ids.length)})
        AND name IN (${placeholders(coreEvents.length)})
        AND occurred_at >= ? AND occurred_at <= ?`,
    [projectId, ...ids, ...coreEvents, w.from, w.to],
  )?.n ?? 0;
  const share = used / coreEvents.length;
  return {
    signal: "breadth_of_use",
    label: "Breadth of use",
    observed: `${used} of ${coreEvents.length} core feature(s) used`,
    value: share,
    direction: used === 0 ? "concerning" : share >= 0.5 ? "supporting" : "neutral",
    detail: used === 0
      ? "None of the core features were used in this window."
      : `${(share * 100).toFixed(0)}% of the core features were touched.`,
    whatWouldChangeIt: "Using more than half of the configured core features inside the window.",
    hasEnoughData: true,
  };
}

function activationReached(
  db: Db, projectId: string, ids: string[], activationEvent: string | undefined,
): SignalObservation {
  if (!activationEvent) {
    return {
      signal: "activation_reached",
      label: "Activation",
      observed: "No activation event defined",
      value: null,
      direction: "unknown",
      detail: "Without an activation event, there is no way to say whether this customer ever got value.",
      whatWouldChangeIt: "Defining the single event that means a user reached real value.",
      hasEnoughData: false,
    };
  }
  const first = db.get<{ at: number }>(
    `SELECT MIN(occurred_at) AS at FROM analytics_events
      WHERE project_id = ? AND identity_id IN (${placeholders(ids.length)}) AND name = ?`,
    [projectId, ...ids, activationEvent],
  )?.at ?? null;
  return {
    signal: "activation_reached",
    label: "Activation",
    observed: first === null ? "Never activated" : "Activated",
    value: first === null ? 0 : 1,
    direction: first === null ? "concerning" : "supporting",
    detail: first === null
      ? `No "${activationEvent}" event has ever been recorded for this customer.`
      : `"${activationEvent}" was first recorded for this customer.`,
    whatWouldChangeIt: `A "${activationEvent}" event for anyone on this account.`,
    hasEnoughData: true,
  };
}

function seatEngagement(
  db: Db, projectId: string, subject: { kind: "identity" | "account"; id: string },
  ids: string[], w: Window,
): SignalObservation {
  if (subject.kind !== "account") {
    return {
      signal: "seat_engagement",
      label: "Seat engagement",
      observed: "Not an account",
      value: null,
      direction: "unknown",
      detail: "Seat engagement only means something for a B2B account with several people on it.",
      whatWouldChangeIt: "Assessing this at the account level instead.",
      hasEnoughData: false,
    };
  }
  if (ids.length < 2) {
    return {
      signal: "seat_engagement",
      label: "Seat engagement",
      observed: `${ids.length} seat(s) known`,
      value: null,
      direction: "unknown",
      detail: "A single-seat account has no seat distribution to assess.",
      whatWouldChangeIt: "More than one person using the account.",
      hasEnoughData: false,
    };
  }
  const active = db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT identity_id) AS n FROM analytics_events
      WHERE project_id = ? AND identity_id IN (${placeholders(ids.length)})
        AND occurred_at >= ? AND occurred_at <= ?`,
    [projectId, ...ids, w.from, w.to],
  )?.n ?? 0;
  const share = active / ids.length;
  return {
    signal: "seat_engagement",
    label: "Seat engagement",
    observed: `${active} of ${ids.length} seat(s) active in the last ${w.days} days`,
    value: share,
    direction: share <= 0.25 ? "concerning" : share >= 0.6 ? "supporting" : "neutral",
    detail: `${(share * 100).toFixed(0)}% of known seats were active. ` +
      "A product used by one person at a multi-seat account is easy to cancel.",
    whatWouldChangeIt: "More of the account's known users becoming active inside the window.",
    hasEnoughData: true,
  };
}

function errorExposure(db: Db, projectId: string, ids: string[], w: Window): SignalObservation {
  const row = db.get<{ n: number; fingerprints: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT fingerprint) AS fingerprints
       FROM error_events
      WHERE project_id = ? AND identity_id IN (${placeholders(ids.length)})
        AND occurred_at >= ? AND occurred_at <= ?`,
    [projectId, ...ids, w.from, w.to],
  );
  const errors = row?.n ?? 0;
  const anyErrorsOnProject = (db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM error_events WHERE project_id = ?", [projectId],
  )?.n ?? 0) > 0;

  if (!anyErrorsOnProject) {
    return {
      signal: "error_exposure",
      label: "Errors encountered",
      observed: "No error reporting connected",
      value: null,
      direction: "unknown",
      detail: "This project has never sent an error, so an absence of errors here proves nothing.",
      whatWouldChangeIt: "Sending errors from the SDK or connecting an error reporter.",
      hasEnoughData: false,
    };
  }

  return {
    signal: "error_exposure",
    label: "Errors encountered",
    observed: `${errors} error(s) across ${row?.fingerprints ?? 0} distinct problem(s)`,
    value: errors,
    direction: errors === 0 ? "supporting" : errors >= 5 ? "concerning" : "neutral",
    detail: errors === 0
      ? "This customer hit no reported errors in the window."
      : `This customer hit ${errors} reported error(s), which they experienced as the product not working.`,
    whatWouldChangeIt: "Fixing the problems behind those errors, or confirming they are not user-visible.",
    hasEnoughData: true,
  };
}

function unresolvedFeedback(db: Db, projectId: string, ids: string[]): SignalObservation {
  const row = db.get<{ open: number; bugs: number }>(
    `SELECT COUNT(*) AS open,
            SUM(CASE WHEN kind = 'bug' THEN 1 ELSE 0 END) AS bugs
       FROM feedback_items
      WHERE project_id = ? AND identity_id IN (${placeholders(ids.length)})
        AND status NOT IN ('released','closed','duplicate')`,
    [projectId, ...ids],
  );
  const open = row?.open ?? 0;
  const bugs = row?.bugs ?? 0;
  return {
    signal: "unresolved_feedback",
    label: "Unresolved feedback",
    observed: `${open} open item(s), ${bugs} of them bug report(s)`,
    value: open,
    direction: open === 0 ? "neutral" : bugs >= 2 || open >= 3 ? "concerning" : "neutral",
    detail: open === 0
      ? "Nothing open from this customer. That is not itself a positive signal — most people never report anything."
      : `${open} item(s) from this customer are still open, including ${bugs} bug report(s).`,
    whatWouldChangeIt: "Resolving or responding to their open items.",
    // Silence is genuinely uninformative here, so it is not treated as data.
    hasEnoughData: open > 0,
  };
}

function billingStatus(db: Db, projectId: string, ids: string[]): SignalObservation {
  const rows = db.all<{ status: string; amount_minor: number; currency: string; interval: string }>(
    `SELECT status, amount_minor, currency, interval FROM customer_subscriptions
      WHERE project_id = ? AND identity_id IN (${placeholders(ids.length)})`,
    [projectId, ...ids],
  );
  if (rows.length === 0) {
    return {
      signal: "billing_status",
      label: "Billing",
      observed: "No subscription linked",
      value: null,
      direction: "unknown",
      detail: "No subscription is linked to this customer, so billing says nothing either way.",
      whatWouldChangeIt: "Linking the subscription by passing your own user id in the billing metadata.",
      hasEnoughData: false,
    };
  }
  const worst = rows.find((r) => r.status === "past_due")
    ?? rows.find((r) => r.status === "cancelled" || r.status === "expired")
    ?? rows.find((r) => r.status === "paused")
    ?? rows[0]!;
  const mrr = rows
    .filter((r) => contributesToMrr(r.status))
    .reduce((s, r) => s + normaliseToMrr(r.amount_minor, r.interval as Interval), 0);

  const concerning = worst.status === "past_due" || worst.status === "cancelled" || worst.status === "expired";
  return {
    signal: "billing_status",
    label: "Billing",
    observed: `Subscription status "${worst.status}", ${mrr} ${worst.currency} minor units of MRR`,
    value: mrr,
    direction: concerning ? "concerning" : worst.status === "active" ? "supporting" : "neutral",
    detail: worst.status === "past_due"
      ? "A payment has failed and not yet recovered. This is often an expired card rather than a decision."
      : concerning
        ? `The subscription is ${worst.status}.`
        : `The subscription is ${worst.status}.`,
    whatWouldChangeIt: "The subscription returning to an active, paid state.",
    hasEnoughData: true,
  };
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/**
 * Assess one customer or account.
 *
 * The aggregation is deliberately boring: count what is concerning, count what
 * is supporting, weight each by its signal's importance, and compare. A simple
 * rule that a person can re-derive on paper beats a better rule they cannot
 * check, because the entire value of this feature is that someone will act on
 * it in a conversation with a real customer.
 */
export function assessHealth(
  db: Db,
  projectId: string,
  subject: { kind: "identity" | "account"; id: string },
  config: HealthConfig = {},
): HealthAssessment {
  const w = windowFor(config);
  const ids = identityIdsFor(db, projectId, subject);
  const weights = { ...DEFAULT_SIGNAL_WEIGHTS, ...config.weights };
  const observedAt = config.now ?? Date.now();

  if (ids.length === 0) {
    return {
      subjectKind: subject.kind,
      subjectId: subject.id,
      subjects: 0,
      state: "insufficient_information",
      signals: [],
      drivers: [],
      reasoning: ["No known users belong to this subject, so there is nothing to assess."],
      observedAt,
      windowDays: w.days,
      disclaimer: HEALTH_DISCLAIMER,
    };
  }

  const signals: SignalObservation[] = [
    recentActivity(db, projectId, ids, w),
    activityTrend(db, projectId, ids, w),
    breadthOfUse(db, projectId, ids, w, config.coreEvents),
    activationReached(db, projectId, ids, config.activationEvent),
    seatEngagement(db, projectId, subject, ids, w),
    errorExposure(db, projectId, ids, w),
    unresolvedFeedback(db, projectId, ids),
    billingStatus(db, projectId, ids),
  ];

  const withData = signals.filter((s) => s.hasEnoughData);
  const reasoning: string[] = [];

  if (withData.length < MINIMUM_SIGNALS_WITH_DATA) {
    reasoning.push(
      `Only ${withData.length} of ${signals.length} signals have enough data behind them, ` +
      `below the minimum of ${MINIMUM_SIGNALS_WITH_DATA}.`,
    );
    for (const s of signals.filter((x) => !x.hasEnoughData)) {
      reasoning.push(`${s.label}: ${s.detail}`);
    }
    return {
      subjectKind: subject.kind,
      subjectId: subject.id,
      subjects: ids.length,
      state: "insufficient_information",
      signals,
      drivers: [],
      reasoning,
      observedAt,
      windowDays: w.days,
      disclaimer: HEALTH_DISCLAIMER,
    };
  }

  const concerning = withData.filter((s) => s.direction === "concerning");
  const supporting = withData.filter((s) => s.direction === "supporting");
  const concernWeight = concerning.reduce((s, x) => s + weights[x.signal], 0);
  const supportWeight = supporting.reduce((s, x) => s + weights[x.signal], 0);

  let state: HealthState;
  if (concerning.length === 0) {
    state = supporting.length > 0 ? "strong_engagement" : "mixed_signals";
    reasoning.push(
      supporting.length > 0
        ? `${supporting.length} signal(s) are positive and none is concerning.`
        : "No signal is concerning, but none is clearly positive either.",
    );
  } else if (concernWeight >= supportWeight) {
    state = "attention_suggested";
    reasoning.push(
      `${concerning.length} concerning signal(s) outweigh ${supporting.length} supporting one(s) ` +
      `(${concernWeight.toFixed(2)} against ${supportWeight.toFixed(2)}).`,
    );
  } else {
    state = "mixed_signals";
    reasoning.push(
      `${concerning.length} concerning signal(s) are outweighed by ${supporting.length} supporting one(s) ` +
      `(${concernWeight.toFixed(2)} against ${supportWeight.toFixed(2)}).`,
    );
  }

  for (const s of concerning) reasoning.push(`${s.label}: ${s.detail}`);
  const missing = signals.filter((s) => !s.hasEnoughData);
  if (missing.length > 0) {
    reasoning.push(
      `${missing.length} signal(s) could not be assessed: ` + missing.map((s) => s.label).join(", ") + ".",
    );
  }

  const drivers = [...concerning, ...supporting].sort(
    (a, b) => weights[b.signal] - weights[a.signal],
  );

  return {
    subjectKind: subject.kind,
    subjectId: subject.id,
    subjects: ids.length,
    state,
    signals,
    drivers,
    reasoning,
    observedAt,
    windowDays: w.days,
    disclaimer: HEALTH_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Definitions and persistence
// ---------------------------------------------------------------------------

export interface HealthDefinition {
  id: string;
  name: string;
  signals: SignalWeight[];
  isPrimary: boolean;
}

export function upsertHealthDefinition(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: { id?: string; name: string; signals: SignalWeight[]; isPrimary?: boolean },
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  if (!input.name.trim()) {
    return err(domainError("validation_failed", "A health definition needs a name."));
  }
  for (const s of input.signals) {
    if (!(s.signal in DEFAULT_SIGNAL_WEIGHTS)) {
      return err(domainError("validation_failed", `Unknown health signal "${s.signal}".`));
    }
    if (s.weight < 0 || s.weight > 5) {
      return err(domainError("validation_failed", "A signal weight must be between 0 and 5."));
    }
  }
  const id = input.id ?? newId("hdf");
  return db.tx(() => {
    if (input.isPrimary) {
      db.run("UPDATE health_definitions SET is_primary = 0 WHERE project_id = ?", [ids.projectId]);
    }
    const existing = db.get<{ id: string }>(
      "SELECT id FROM health_definitions WHERE project_id = ? AND (id = ? OR name = ?)",
      [ids.projectId, id, input.name],
    );
    if (existing) {
      db.run(
        `UPDATE health_definitions SET name = ?, signals = ?, is_primary = ?, updated_at = ?
         WHERE id = ?`,
        [input.name, JSON.stringify(input.signals), input.isPrimary ? 1 : 0, now, existing.id],
      );
      return ok({ id: existing.id });
    }
    db.run(
      `INSERT INTO health_definitions (id, org_id, project_id, name, signals, is_primary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ids.orgId, ids.projectId, input.name, JSON.stringify(input.signals),
       input.isPrimary ? 1 : 0, now, now],
    );
    return ok({ id });
  });
}

export function listHealthDefinitions(db: Db, projectId: string): HealthDefinition[] {
  return db.all<{ id: string; name: string; signals: string; is_primary: number }>(
    "SELECT id, name, signals, is_primary FROM health_definitions WHERE project_id = ? ORDER BY is_primary DESC, name",
    [projectId],
  ).map((r) => ({
    id: r.id,
    name: r.name,
    signals: parseSignals(r.signals),
    isPrimary: r.is_primary === 1,
  }));
}

function parseSignals(raw: string): SignalWeight[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as SignalWeight[] : [];
  } catch {
    return [];
  }
}

export function weightsFromDefinition(def: HealthDefinition): Partial<Record<SignalId, number>> {
  const out: Partial<Record<SignalId, number>> = {};
  for (const s of def.signals) out[s.signal] = s.weight;
  return out;
}

/** Store an assessment so a state change over time can be seen. */
export function recordHealthObservation(
  db: Db,
  ids: { orgId: string; projectId: string },
  definitionId: string,
  assessment: HealthAssessment,
): { id: string; created: boolean } {
  const existing = db.get<{ id: string }>(
    `SELECT id FROM health_observations
      WHERE definition_id = ? AND subject_kind = ?
        AND COALESCE(identity_id, '') = ? AND COALESCE(account_key, '') = ?
        AND observed_at = ?`,
    [definitionId, assessment.subjectKind,
     assessment.subjectKind === "identity" ? assessment.subjectId : "",
     assessment.subjectKind === "account" ? assessment.subjectId : "",
     assessment.observedAt],
  );
  if (existing) return { id: existing.id, created: false };

  const id = newId("hob");
  db.run(
    `INSERT INTO health_observations
      (id, org_id, project_id, definition_id, subject_kind, identity_id, account_key,
       state, signal_detail, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ids.orgId, ids.projectId, definitionId, assessment.subjectKind,
     assessment.subjectKind === "identity" ? assessment.subjectId : null,
     assessment.subjectKind === "account" ? assessment.subjectId : null,
     assessment.state,
     JSON.stringify(assessment.signals.map((s) => ({
       signal: s.signal, observed: s.observed, contributed: s.direction, detail: s.detail,
     }))),
     assessment.observedAt],
  );
  return { id, created: true };
}

export interface HealthHistoryPoint {
  state: HealthState;
  observedAt: number;
}

export function healthHistory(
  db: Db,
  projectId: string,
  subject: { kind: "identity" | "account"; id: string },
  limit = 50,
): HealthHistoryPoint[] {
  const rows = db.all<{ state: string; observed_at: number }>(
    `SELECT state, observed_at FROM health_observations
      WHERE project_id = ? AND subject_kind = ?
        AND COALESCE(identity_id, account_key) = ?
      ORDER BY observed_at DESC LIMIT ?`,
    [projectId, subject.kind, subject.id, limit],
  );
  return rows.map((r) => ({ state: r.state as HealthState, observedAt: r.observed_at }));
}

export interface HealthRoster {
  subjectId: string;
  subjects: number;
  state: HealthState;
  topConcern: string | null;
  mrrMinor: number | null;
  currency: string | null;
}

/**
 * Assess every account on the project.
 *
 * Sorted so the accounts worth a conversation come first, and within those by
 * revenue — not because big customers matter more as people, but because a
 * success team has finite hours and needs an order.
 */
export function accountHealthRoster(
  db: Db,
  projectId: string,
  config: HealthConfig & { limit?: number } = {},
): HealthRoster[] {
  const accounts = db.all<{ account_key: string }>(
    "SELECT account_key FROM accounts WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT ?",
    [projectId, config.limit ?? 200],
  );

  const out: HealthRoster[] = [];
  for (const row of accounts) {
    const assessment = assessHealth(db, projectId, { kind: "account", id: row.account_key }, config);
    const billing = assessment.signals.find((s) => s.signal === "billing_status");
    const mrrMinor = billing?.hasEnoughData ? billing.value : null;
    const currency = billing?.hasEnoughData
      ? (billing.observed.match(/\s([A-Z]{3})\s/)?.[1] ?? null)
      : null;
    out.push({
      subjectId: row.account_key,
      subjects: assessment.subjects,
      state: assessment.state,
      topConcern: assessment.drivers.find((d) => d.direction === "concerning")?.label ?? null,
      mrrMinor,
      currency,
    });
  }

  const stateRank: Record<HealthState, number> = {
    attention_suggested: 0, mixed_signals: 1, insufficient_information: 2, strong_engagement: 3,
  };
  return out.sort((a, b) =>
    stateRank[a.state] - stateRank[b.state] || (b.mrrMinor ?? 0) - (a.mrrMinor ?? 0));
}

import { type Db } from "@retainos/database";
import { newId, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";
import { replayTo, contributesToMrr } from "./revenue.ts";
import { analyseExperiment, getExperiment } from "./experiments.ts";

/**
 * The Revenue Impact Studio.
 *
 * Every analytics product on the market will tell you a product change made
 * you money. Almost none of them can tell you how they know. The number is the
 * easy part; the honest part is saying what kind of evidence stands behind it,
 * and refusing to dress one kind up as another.
 *
 * So a figure cannot exist here without a classification, the classification
 * is derived from what the data actually supports rather than chosen by
 * whoever wants the number, and figures of different classifications are never
 * added together — because "₹4.2L of impact" built from one measured
 * cancellation and a pile of assumptions is not a finding, it is a sales deck.
 */

export type ImpactClassification =
  | "observed"
  | "experiment_supported"
  | "estimated"
  | "associated"
  | "insufficient_evidence";

export const CLASSIFICATION_MEANING: Record<ImpactClassification, string> = {
  observed:
    "The money movement is recorded in billing data for exactly these accounts and this period. " +
    "No model, no extrapolation. It does not by itself prove what caused the movement.",
  experiment_supported:
    "A randomised experiment measured this revenue metric and reached a conclusion. This is the only " +
    "classification that supports a causal claim.",
  estimated:
    "A figure produced by a model from measured inputs. Every assumption is listed with its source. " +
    "Change an assumption and the figure changes; it is a scenario, not a measurement.",
  associated:
    "Two things moved together in an observational comparison with no randomisation. Direction only. " +
    "Any number attached to it may be caused by something else entirely.",
  insufficient_evidence:
    "There is not enough data to put a figure on this. Stated rather than filled in with a guess.",
};

export const CLASSIFICATION_STRENGTH: Record<ImpactClassification, number> = {
  experiment_supported: 4,
  observed: 3,
  estimated: 2,
  associated: 1,
  insufficient_evidence: 0,
};

export const REVENUE_IMPACT_DISCLAIMER =
  "Figures of different classifications are never summed. An observed amount and an estimated amount " +
  "answer different questions, and adding them produces a number that answers neither.";

export interface Assumption {
  name: string;
  value: string;
  unit: string;
  /** Where the value came from. An assumption with no provenance is a guess. */
  source: "measured" | "user_supplied" | "default";
}

/** What the data actually supports, stated as facts rather than conclusions. */
export interface EvidenceBasis {
  /** Is the amount read from billing records for exactly these entities and period? */
  billingRecordsForExactEntities: boolean;
  /** The randomised experiment that measured this revenue metric, if there is one. */
  randomisedExperimentId: string | null;
  /** Did that experiment reach a conclusion, or is it still inconclusive? */
  experimentConclusive: boolean;
  /** Assumptions a model needed. Non-empty means the figure is modelled. */
  assumptions: Assumption[];
  /** An observational comparison (before/after, cohort split) with no randomisation. */
  observationalComparison: boolean;
  /** How many accounts or users the figure covers. */
  entityCount: number;
}

export interface Classification {
  classification: ImpactClassification;
  reasons: string[];
}

/**
 * Derive the classification from the basis.
 *
 * The order of these rules is the product. In particular an experiment that
 * did not reach a conclusion falls to insufficient_evidence rather than
 * becoming an estimate, because laundering a null result into a figure is the
 * single most tempting dishonesty available here.
 */
export function classifyEvidence(basis: EvidenceBasis): Classification {
  const reasons: string[] = [];

  if (basis.entityCount <= 0) {
    return {
      classification: "insufficient_evidence",
      reasons: ["No accounts or users fall inside this measurement."],
    };
  }

  if (basis.randomisedExperimentId) {
    if (basis.experimentConclusive) {
      reasons.push(`A randomised experiment (${basis.randomisedExperimentId}) measured this metric and reached a conclusion.`);
      return { classification: "experiment_supported", reasons };
    }
    return {
      classification: "insufficient_evidence",
      reasons: [
        `Experiment ${basis.randomisedExperimentId} measured this metric but did not reach a conclusion.`,
        "An inconclusive experiment is not evidence of an effect, and is not downgraded to an estimate here.",
      ],
    };
  }

  if (basis.billingRecordsForExactEntities && basis.assumptions.length === 0 && !basis.observationalComparison) {
    reasons.push(`Amount summed from billing records for ${basis.entityCount} account(s).`);
    reasons.push("No model was used, so the amount is what the billing data says.");
    return { classification: "observed", reasons };
  }

  if (basis.assumptions.length > 0) {
    reasons.push(`Modelled from ${basis.assumptions.length} stated assumption(s).`);
    const unmeasured = basis.assumptions.filter((a) => a.source !== "measured");
    if (unmeasured.length > 0) {
      reasons.push(
        `${unmeasured.length} assumption(s) are not measured from your data: ` +
        unmeasured.map((a) => a.name).join(", ") + ".",
      );
    }
    return { classification: "estimated", reasons };
  }

  if (basis.observationalComparison) {
    reasons.push("An observational comparison with no randomisation and no model.");
    reasons.push("Anything that changed at the same time could account for the movement.");
    return { classification: "associated", reasons };
  }

  return {
    classification: "insufficient_evidence",
    reasons: ["Nothing in the available data supports a revenue figure for this."],
  };
}

// ---------------------------------------------------------------------------
// Observed movement for a cohort
// ---------------------------------------------------------------------------

export interface ObservedMovement {
  currency: string;
  startMrrMinor: number;
  endMrrMinor: number;
  netChangeMinor: number;
  churnedMinor: number;
  contractionMinor: number;
  expansionMinor: number;
  newMinor: number;
  subscriptionsConsidered: number;
  entityCount: number;
}

/**
 * MRR movement restricted to a set of identities, decomposed.
 *
 * Restricting to a cohort is the whole value: "MRR fell 3%" is a company
 * metric, while "the 41 accounts affected by this case lost ₹X between them"
 * is something a team can act on. The decomposition compares each
 * subscription's state at both ends of the period, so the parts reconcile with
 * the net change even when a subscription both upgraded and cancelled inside
 * the window.
 */
export function observedMovementForIdentities(
  db: Db,
  projectId: string,
  identityIds: Iterable<string>,
  from: number,
  to: number,
): ObservedMovement[] {
  const ids = [...new Set(identityIds)];
  if (ids.length === 0) return [];

  const subs = new Map<string, string>(); // subscriptionId -> identityId
  const chunk = 400;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const rows = db.all<{ id: string; identity_id: string }>(
      `SELECT id, identity_id FROM customer_subscriptions
        WHERE project_id = ? AND identity_id IN (${slice.map(() => "?").join(",")})`,
      [projectId, ...slice],
    );
    for (const row of rows) subs.set(row.id, row.identity_id);
  }
  if (subs.size === 0) return [];

  const before = replayTo(db, projectId, from - 1);
  const after = replayTo(db, projectId, to);
  const byCurrency = new Map<string, ObservedMovement>();
  const entitiesByCurrency = new Map<string, Set<string>>();

  for (const subscriptionId of subs.keys()) {
    const b = before.get(subscriptionId);
    const a = after.get(subscriptionId);
    const currency = a?.currency ?? b?.currency;
    if (!currency) continue;

    let m = byCurrency.get(currency);
    if (!m) {
      m = {
        currency, startMrrMinor: 0, endMrrMinor: 0, netChangeMinor: 0, churnedMinor: 0,
        contractionMinor: 0, expansionMinor: 0, newMinor: 0, subscriptionsConsidered: 0, entityCount: 0,
      };
      byCurrency.set(currency, m);
      entitiesByCurrency.set(currency, new Set());
    }
    entitiesByCurrency.get(currency)!.add(subs.get(subscriptionId)!);
    m.subscriptionsConsidered++;

    const startMrr = b && contributesToMrr(b.status) ? b.mrrMinor : 0;
    const endMrr = a && contributesToMrr(a.status) ? a.mrrMinor : 0;
    m.startMrrMinor += startMrr;
    m.endMrrMinor += endMrr;

    if (startMrr === 0 && endMrr > 0) m.newMinor += endMrr;
    else if (startMrr > 0 && endMrr === 0) m.churnedMinor += startMrr;
    else if (endMrr > startMrr) m.expansionMinor += endMrr - startMrr;
    else if (endMrr < startMrr) m.contractionMinor += startMrr - endMrr;
  }

  for (const [currency, m] of byCurrency) {
    m.netChangeMinor = m.endMrrMinor - m.startMrrMinor;
    m.entityCount = entitiesByCurrency.get(currency)!.size;
  }
  return [...byCurrency.values()].sort((a, b) => b.startMrrMinor - a.startMrrMinor);
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

export interface EstimateInput {
  label: string;
  /** Users the change would apply to, measured from the product. */
  affectedUsers: number;
  /** The share of them expected to convert differently, as a proportion. */
  conversionDelta: number;
  conversionDeltaSource: Assumption["source"];
  /** Average revenue per converting user per month, in minor units. */
  arpuMinor: number;
  arpuSource: Assumption["source"];
  currency: string;
  /** Months the effect is assumed to persist. Longer horizons are weaker claims. */
  horizonMonths: number;
}

export interface Estimate {
  classification: "estimated" | "insufficient_evidence";
  label: string;
  amountMinor: number | null;
  currency: string;
  assumptions: Assumption[];
  method: string;
  limitations: string[];
  /** A low/high band from varying the delta, so the figure is never read as exact. */
  rangeMinor: [number, number] | null;
}

/**
 * A monthly-revenue estimate from an explicit model.
 *
 * The range matters more than the point. A single number invites a precision
 * nobody has, so the result carries a band built by halving and doubling the
 * least certain input, and the caller is expected to show the band.
 */
export function estimateMonthlyRevenue(input: EstimateInput): Estimate {
  const limitations = [
    "This is a model, not a measurement. It says what would follow if the assumptions hold.",
    "It assumes the affected users behave like the baseline population in every respect except the change.",
  ];
  if (input.horizonMonths > 12) {
    limitations.push(
      `A ${input.horizonMonths}-month horizon assumes nothing else changes for a year, which is rarely true.`,
    );
  }

  const assumptions: Assumption[] = [
    { name: "affected_users", value: String(input.affectedUsers), unit: "users", source: "measured" },
    {
      name: "conversion_delta",
      value: `${(input.conversionDelta * 100).toFixed(1)}%`,
      unit: "percentage points",
      source: input.conversionDeltaSource,
    },
    {
      name: "arpu",
      value: String(input.arpuMinor),
      unit: `${input.currency} minor units per month`,
      source: input.arpuSource,
    },
    { name: "horizon", value: String(input.horizonMonths), unit: "months", source: "user_supplied" },
  ];

  if (input.affectedUsers <= 0 || input.arpuMinor <= 0 || input.conversionDelta === 0) {
    return {
      classification: "insufficient_evidence",
      label: input.label,
      amountMinor: null,
      currency: input.currency,
      assumptions,
      method: "No estimate is produced when any input is zero; a zero input makes the model vacuous.",
      limitations: [...limitations, "One or more required inputs was zero or negative."],
      rangeMinor: null,
    };
  }

  const point = Math.round(input.affectedUsers * input.conversionDelta * input.arpuMinor);
  const low = Math.round(input.affectedUsers * (input.conversionDelta / 2) * input.arpuMinor);
  const high = Math.round(input.affectedUsers * (input.conversionDelta * 2) * input.arpuMinor);

  return {
    classification: "estimated",
    label: input.label,
    amountMinor: point,
    currency: input.currency,
    assumptions,
    method:
      "affected_users × conversion_delta × arpu, giving monthly recurring revenue. " +
      "The range halves and doubles conversion_delta, the least certain input.",
    limitations,
    rangeMinor: [Math.min(low, high), Math.max(low, high)],
  };
}

// ---------------------------------------------------------------------------
// Experiment-supported impact
// ---------------------------------------------------------------------------

export interface ExperimentImpact {
  classification: "experiment_supported" | "insufficient_evidence";
  experimentId: string;
  verdict: string;
  reasons: string[];
  /** Relative effect on the primary metric, with its interval, when conclusive. */
  effect: { relative: number; interval: [number, number] | null } | null;
}

/**
 * Read an experiment's result and say whether it supports a revenue claim.
 *
 * This deliberately does not compute a revenue figure from an experiment on a
 * non-revenue metric. An experiment showing a lift in activation does not say
 * what that is worth; combining the two is a model, and models are estimates.
 */
export function experimentSupportedImpact(
  db: Db,
  projectId: string,
  experimentId: string,
  now = Date.now(),
): ExperimentImpact {
  const config = getExperiment(db, projectId, experimentId);
  if (!config) {
    return {
      classification: "insufficient_evidence",
      experimentId,
      verdict: "not_found",
      reasons: ["No experiment with that id exists on this project."],
      effect: null,
    };
  }

  const result = analyseExperiment(db, projectId, experimentId, { now });
  if (!result.ok) {
    return {
      classification: "insufficient_evidence",
      experimentId,
      verdict: "no_analysis",
      reasons: [result.error.message],
      effect: null,
    };
  }
  const analysis = result.value;

  // Only a verdict the experiment's own validity checks stand behind counts.
  // "No clear difference" and "inconclusive" are answers, but they are not
  // evidence of revenue, and `invalid_experiment` is not evidence of anything.
  const conclusive =
    analysis.verdict === "improvement_supported" || analysis.verdict === "worse_outcome";
  if (!conclusive) {
    return {
      classification: "insufficient_evidence",
      experimentId,
      verdict: analysis.verdict,
      reasons: [
        `The experiment's verdict is "${analysis.verdict}", which does not support a revenue claim.`,
        ...analysis.reasoning,
      ],
      effect: null,
    };
  }

  const test = analysis.primary.test;
  const relative = test?.relativeDiff ?? null;
  return {
    classification: "experiment_supported",
    experimentId,
    verdict: analysis.verdict,
    reasons: analysis.reasoning,
    effect: relative === null || !test
      ? null
      : { relative, interval: test.confidenceInterval },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface ImpactRecordInput {
  label: string;
  classification: ImpactClassification;
  basis: EvidenceBasis;
  amountMinor?: number | null;
  currency?: string | null;
  periodStart?: number | null;
  periodEnd?: number | null;
  method: string;
  limitations?: string[];
  caseId?: string | null;
  improvementId?: string | null;
  releaseId?: string | null;
  experimentId?: string | null;
}

/**
 * Store a revenue impact record.
 *
 * The validation here is the feature. A caller may claim any classification it
 * likes; this refuses anything the basis does not support, and refuses a few
 * shapes that are contradictory on their face — an "observed" figure that
 * needed assumptions, an "insufficient evidence" record that nonetheless
 * carries an amount, an estimate with no assumptions to inspect.
 */
export function recordImpact(
  db: Db,
  ids: { orgId: string; projectId: string; userId?: string },
  input: ImpactRecordInput,
  now = Date.now(),
): Result<{ id: string; classification: ImpactClassification }, DomainError> {
  if (!input.label.trim()) {
    return err(domainError("validation_failed", "An impact record needs a label."));
  }
  if (!input.method.trim()) {
    return err(domainError(
      "validation_failed",
      "An impact record needs a method: how the figure was produced. A figure with no method cannot be checked.",
    ));
  }

  const derived = classifyEvidence(input.basis);
  if (CLASSIFICATION_STRENGTH[input.classification] > CLASSIFICATION_STRENGTH[derived.classification]) {
    return err(domainError(
      "validation_failed",
      `This record claims "${input.classification}" but the evidence supports at most ` +
      `"${derived.classification}". ${derived.reasons.join(" ")}`,
    ));
  }

  const amount = input.amountMinor ?? null;
  if (input.classification === "observed" && input.basis.assumptions.length > 0) {
    return err(domainError(
      "validation_failed",
      "An observed figure cannot carry assumptions. If something had to be assumed, it is an estimate.",
    ));
  }
  if (input.classification === "estimated" && input.basis.assumptions.length === 0) {
    return err(domainError(
      "validation_failed",
      "An estimate must list the assumptions it rests on, otherwise nobody can disagree with it.",
    ));
  }
  if (input.classification === "insufficient_evidence" && amount !== null) {
    return err(domainError(
      "validation_failed",
      "A record classified as insufficient evidence cannot carry an amount.",
    ));
  }
  if (amount !== null && !input.currency) {
    return err(domainError("validation_failed", "An amount needs a currency."));
  }

  const id = newId("rvi");
  db.run(
    `INSERT INTO revenue_impact_records
      (id, org_id, project_id, case_id, improvement_id, release_id, experiment_id, label,
       classification, amount_minor, currency, period_start, period_end, assumptions, method,
       limitations, computed_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ids.orgId, ids.projectId, input.caseId ?? null, input.improvementId ?? null,
     input.releaseId ?? null, input.experimentId ?? null, input.label, input.classification,
     amount, input.currency ?? null, input.periodStart ?? null, input.periodEnd ?? null,
     JSON.stringify(input.basis.assumptions), input.method,
     JSON.stringify(input.limitations ?? []), now, ids.userId ?? null],
  );
  return ok({ id, classification: input.classification });
}

export interface ImpactRecord {
  id: string;
  label: string;
  classification: ImpactClassification;
  amountMinor: number | null;
  currency: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  assumptions: Assumption[];
  method: string;
  limitations: string[];
  computedAt: number;
  caseId: string | null;
  improvementId: string | null;
  releaseId: string | null;
  experimentId: string | null;
}

export function listImpactRecords(
  db: Db,
  projectId: string,
  filter: { caseId?: string; classification?: ImpactClassification; limit?: number } = {},
): ImpactRecord[] {
  const where = ["project_id = ?"];
  const params: unknown[] = [projectId];
  if (filter.caseId) { where.push("case_id = ?"); params.push(filter.caseId); }
  if (filter.classification) { where.push("classification = ?"); params.push(filter.classification); }
  const rows = db.all<Record<string, any>>(
    `SELECT * FROM revenue_impact_records WHERE ${where.join(" AND ")}
      ORDER BY computed_at DESC LIMIT ?`,
    [...params, filter.limit ?? 100],
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    classification: r.classification as ImpactClassification,
    amountMinor: r.amount_minor ?? null,
    currency: r.currency ?? null,
    periodStart: r.period_start ?? null,
    periodEnd: r.period_end ?? null,
    assumptions: safeParse<Assumption[]>(r.assumptions, []),
    method: r.method,
    limitations: safeParse<string[]>(r.limitations, []),
    computedAt: r.computed_at,
    caseId: r.case_id ?? null,
    improvementId: r.improvement_id ?? null,
    releaseId: r.release_id ?? null,
    experimentId: r.experiment_id ?? null,
  }));
}

function safeParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return fallback;
  }
}

export interface ImpactBucket {
  classification: ImpactClassification;
  currency: string;
  totalMinor: number;
  records: number;
  meaning: string;
}

export interface ImpactSummary {
  /** One bucket per classification per currency. Never a single total. */
  buckets: ImpactBucket[];
  recordsWithoutAmount: number;
  disclaimer: string;
}

/**
 * Totals, bucketed by classification and currency.
 *
 * There is no grand total here and there will not be one. The only way to
 * produce a single "revenue impact" figure is to add an observed amount to a
 * modelled one, and the result would be a number nobody could defend.
 */
export function impactSummary(db: Db, projectId: string, filter: { caseId?: string } = {}): ImpactSummary {
  const records = listImpactRecords(db, projectId, { ...filter, limit: 1000 });
  const buckets = new Map<string, ImpactBucket>();
  let withoutAmount = 0;

  for (const r of records) {
    if (r.amountMinor === null || !r.currency) { withoutAmount++; continue; }
    const key = `${r.classification}:${r.currency}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        classification: r.classification, currency: r.currency, totalMinor: 0, records: 0,
        meaning: CLASSIFICATION_MEANING[r.classification],
      };
      buckets.set(key, bucket);
    }
    bucket.totalMinor += r.amountMinor;
    bucket.records++;
  }

  return {
    buckets: [...buckets.values()].sort(
      (a, b) => CLASSIFICATION_STRENGTH[b.classification] - CLASSIFICATION_STRENGTH[a.classification],
    ),
    recordsWithoutAmount: withoutAmount,
    disclaimer: REVENUE_IMPACT_DISCLAIMER,
  };
}

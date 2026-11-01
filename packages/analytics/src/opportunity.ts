import { type Db, jsonParse } from "@retainos/database";
import { newId, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";

/**
 * The Opportunity Engine.
 *
 * Deciding what to fix first is the question a founder actually has, and it is
 * the one most tools answer with an unexplained number between 0 and 100.
 *
 * This scoring is built to be **argued with**:
 *  - Every factor states its raw measurement, its unit, the transform that
 *    normalised it, its weight and its contribution to the total.
 *  - Every factor says whether it was **measured** from data, **estimated** by
 *    a human, or **absent** — and an absent factor contributes nothing rather
 *    than being quietly imputed as average.
 *  - Weights are per-project configuration, not a secret.
 *  - The score is explicitly an ordering device. It is not a probability, not a
 *    confidence, and not a prediction of business impact.
 */

export type FactorName =
  | "affected_users"
  | "revenue_exposure"
  | "evidence_quality"
  | "corroboration"
  | "recency"
  | "severity"
  | "engineering_effort"
  | "strategic_importance"
  | "has_workaround";

export interface FactorWeights {
  affected_users: number;
  revenue_exposure: number;
  evidence_quality: number;
  corroboration: number;
  recency: number;
  severity: number;
  engineering_effort: number;
  strategic_importance: number;
  has_workaround: number;
}

/**
 * Defaults, chosen and stated rather than tuned into a black box.
 *
 * Reach (how many people) and evidence quality dominate, because acting on a
 * confident reading of weak evidence is the expensive mistake. Effort is a
 * genuine input but deliberately not the largest: "easy" is not the same as
 * "worth doing".
 */
export const DEFAULT_WEIGHTS: FactorWeights = {
  affected_users: 0.22,
  revenue_exposure: 0.16,
  evidence_quality: 0.18,
  corroboration: 0.12,
  recency: 0.08,
  severity: 0.10,
  engineering_effort: 0.08,
  strategic_importance: 0.04,
  has_workaround: 0.02,
};

export const FACTOR_LABELS: Record<FactorName, string> = {
  affected_users: "Users affected",
  revenue_exposure: "Revenue exposure",
  evidence_quality: "Evidence quality",
  corroboration: "Independent corroboration",
  recency: "Recency",
  severity: "Severity of the problem kind",
  engineering_effort: "Engineering effort",
  strategic_importance: "Strategic importance",
  has_workaround: "No workaround available",
};

export interface ScoredFactor {
  factor: FactorName;
  label: string;
  rawValue: number | null;
  rawUnit: string;
  normalised: number;
  weight: number;
  contribution: number;
  provenance: "measured" | "user_estimate" | "absent";
  explanation: string;
}

export interface OpportunityScore {
  caseId: string;
  score: number;
  factors: ScoredFactor[];
  weakestFactor: FactorName | null;
  /** What would most improve the trustworthiness of this ranking. */
  howToImprove: string;
}

/**
 * Normalisation transforms.
 *
 * Each is a named, documented function rather than an inline magic number, so
 * the UI can show what happened to a raw measurement on its way to a 0..1.
 */

/** Diminishing returns: 100 affected users is not ten times 10 users. */
function logScale(value: number, saturationPoint: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log10(1 + value) / Math.log10(1 + saturationPoint));
}

/** Linear decay over a window; anything older contributes nothing. */
function recencyDecay(ageMs: number, windowMs: number): number {
  if (ageMs <= 0) return 1;
  if (ageMs >= windowMs) return 0;
  return 1 - ageMs / windowMs;
}

const EVIDENCE_QUALITY_SCALE: Record<string, number> = {
  strong_supporting_evidence: 1.0,
  moderate_supporting_evidence: 0.7,
  preliminary_observation: 0.35,
  insufficient_data: 0.1,
};

/**
 * How bad each kind of problem is, independent of how many it touches.
 *
 * A reliability failure outranks a feature-adoption gap at equal reach because
 * one breaks the product and the other merely under-uses it.
 */
const KIND_SEVERITY: Record<string, number> = {
  reliability: 1.0,
  billing_friction: 0.9,
  activation_friction: 0.75,
  retention_friction: 0.7,
  performance: 0.6,
  usability: 0.5,
  feedback_volume: 0.45,
  adoption: 0.35,
  unverified: 0.2,
};

const EFFORT_SCALE: Record<string, number> = { small: 1.0, medium: 0.6, large: 0.25, unknown: 0.5 };
const IMPORTANCE_SCALE: Record<string, number> = { high: 1.0, medium: 0.6, low: 0.2, unknown: 0.5 };

export interface ScoringInput {
  caseId: string;
  kind: string;
  affectedUsers: number;
  revenueExposureMinor: number | null;
  evidenceQuality: string;
  /** Distinct kinds of evidence, excluding the triggering signal. */
  independentEvidenceKinds: number;
  detectedAt: number;
  estimate?: {
    engineeringEffort?: string | null;
    strategicImportance?: string | null;
    hasWorkaround?: boolean | null;
  } | null;
  /** Project-wide figures, so a factor can be scaled against this product. */
  context: { activeUsers: number; totalMrrMinor: number; now: number };
}

/**
 * Score one case.
 *
 * Note what this does **not** do: it never invents a value for a missing
 * input. An absent factor is recorded with `provenance: "absent"`, a
 * normalised value of 0 and a contribution of 0, and its weight is removed
 * from the denominator — so a case is not punished for a question nobody has
 * answered yet, and the UI can say which question that is.
 */
export function scoreOpportunity(input: ScoringInput, weights: FactorWeights = DEFAULT_WEIGHTS): OpportunityScore {
  const factors: ScoredFactor[] = [];
  const RECENCY_WINDOW = 30 * 86_400_000;

  const add = (
    factor: FactorName,
    rawValue: number | null,
    rawUnit: string,
    normalised: number,
    provenance: ScoredFactor["provenance"],
    explanation: string,
  ) => {
    factors.push({
      factor,
      label: FACTOR_LABELS[factor],
      rawValue,
      rawUnit,
      normalised,
      weight: weights[factor],
      contribution: 0, // filled once the denominator is known
      provenance,
      explanation,
    });
  };

  // --- reach -------------------------------------------------------------
  const reachSaturation = Math.max(50, input.context.activeUsers * 0.25);
  add("affected_users", input.affectedUsers, "users",
    logScale(input.affectedUsers, reachSaturation), "measured",
    `${input.affectedUsers} affected users, scaled logarithmically against ${Math.round(reachSaturation)} ` +
    `(a quarter of this project's ${input.context.activeUsers} active users). Log rather than linear because ` +
    "100 affected users is not ten times as urgent as 10.");

  // --- revenue exposure ---------------------------------------------------
  if (input.revenueExposureMinor === null || input.revenueExposureMinor === 0) {
    add("revenue_exposure", null, "currency minor units", 0, "absent",
      "No paying accounts are attached to this case, so revenue exposure contributes nothing. " +
      "Its weight is removed rather than treated as zero exposure.");
  } else {
    const share = input.context.totalMrrMinor > 0
      ? input.revenueExposureMinor / input.context.totalMrrMinor
      : 0;
    add("revenue_exposure", input.revenueExposureMinor, "currency minor units",
      Math.min(1, share * 3), "measured",
      `${(input.revenueExposureMinor / 100).toFixed(0)} of MRR is attached to affected accounts, ` +
      `which is ${(share * 100).toFixed(1)}% of this project's total. Scaled so that a third of all MRR ` +
      "saturates the factor. This is exposure, not predicted loss.");
  }

  // --- evidence quality ---------------------------------------------------
  add("evidence_quality", null, "label",
    EVIDENCE_QUALITY_SCALE[input.evidenceQuality] ?? 0.1, "measured",
    `Evidence rated "${input.evidenceQuality.replace(/_/g, " ")}" by the sample-size rules in ` +
    "RetainOS's confidence model. Weak evidence lowers the ranking rather than being ignored, because " +
    "acting confidently on a weak reading is the expensive mistake.");

  // --- corroboration ------------------------------------------------------
  add("corroboration", input.independentEvidenceKinds, "distinct evidence kinds",
    Math.min(1, input.independentEvidenceKinds / 3), "measured",
    `${input.independentEvidenceKinds} independent kind(s) of evidence corroborate this case. ` +
    "Three or more saturates the factor. One signal alone is a measurement; several agreeing is a case.");

  // --- recency ------------------------------------------------------------
  const age = input.context.now - input.detectedAt;
  add("recency", Math.round(age / 86_400_000), "days since detection",
    recencyDecay(age, RECENCY_WINDOW), "measured",
    `Detected ${Math.round(age / 86_400_000)} day(s) ago, decaying linearly to zero over 30 days. ` +
    "An old finding nobody acted on is not automatically urgent.");

  // --- severity -----------------------------------------------------------
  add("severity", null, "problem kind",
    KIND_SEVERITY[input.kind] ?? 0.2, "measured",
    `A "${input.kind.replace(/_/g, " ")}" problem. Reliability and billing failures outrank adoption gaps ` +
    "at equal reach, because one breaks the product and the other under-uses it.");

  // --- human estimates ----------------------------------------------------
  const effort = input.estimate?.engineeringEffort;
  if (!effort || effort === "unknown") {
    add("engineering_effort", null, "t-shirt size", 0, "absent",
      "Nobody has estimated the engineering effort. RetainOS will not guess it, so this factor " +
      "contributes nothing and its weight is removed.");
  } else {
    add("engineering_effort", null, "t-shirt size", EFFORT_SCALE[effort] ?? 0.5, "user_estimate",
      `Estimated as ${effort} effort by a person, not measured. Smaller effort ranks higher, but effort is ` +
      "deliberately not the largest factor: easy is not the same as worth doing.");
  }

  const importance = input.estimate?.strategicImportance;
  if (!importance || importance === "unknown") {
    add("strategic_importance", null, "label", 0, "absent",
      "Nobody has recorded strategic importance. This is a judgement RetainOS cannot make from data.");
  } else {
    add("strategic_importance", null, "label", IMPORTANCE_SCALE[importance] ?? 0.5, "user_estimate",
      `Recorded as ${importance} strategic importance by a person. This is a judgement, not a measurement.`);
  }

  const workaround = input.estimate?.hasWorkaround;
  if (workaround === null || workaround === undefined) {
    add("has_workaround", null, "boolean", 0, "absent",
      "Nobody has recorded whether a workaround exists.");
  } else {
    add("has_workaround", workaround ? 1 : 0, "boolean", workaround ? 0 : 1, "user_estimate",
      workaround
        ? "A workaround exists, which lowers urgency."
        : "No workaround exists, which raises urgency.");
  }

  // --- combine ------------------------------------------------------------
  // Absent factors are excluded from the denominator so a case is not punished
  // for a question nobody has answered.
  const effectiveWeight = factors
    .filter((f) => f.provenance !== "absent")
    .reduce((sum, f) => sum + f.weight, 0);

  let total = 0;
  for (const f of factors) {
    f.contribution = f.provenance === "absent" || effectiveWeight === 0
      ? 0
      : (f.normalised * f.weight) / effectiveWeight;
    total += f.contribution;
  }

  const present = factors.filter((f) => f.provenance !== "absent");
  const weakest = present.length > 0
    ? present.reduce((lowest, f) => (f.normalised < lowest.normalised ? f : lowest)).factor
    : null;
  const absent = factors.filter((f) => f.provenance === "absent");

  const howToImprove = absent.length > 0
    ? `This ranking would be more trustworthy with ${absent.map((f) => FACTOR_LABELS[f.factor].toLowerCase()).join(" and ")}. ` +
      `${absent.length} factor(s) are missing and currently contribute nothing.`
    : weakest
      ? `The weakest input is ${FACTOR_LABELS[weakest].toLowerCase()}. Strengthening it would change this ranking most.`
      : "No factors could be evaluated.";

  return {
    caseId: input.caseId,
    score: Math.round(total * 1000) / 10, // 0..100, one decimal
    factors,
    weakestFactor: weakest,
    howToImprove,
  };
}

// ---------------------------------------------------------------------------
// Persistence and project-wide ranking
// ---------------------------------------------------------------------------

export function getWeights(db: Db, projectId: string): FactorWeights {
  const row = db.get<{ weights: string }>(
    "SELECT weights FROM opportunity_weights WHERE project_id = ?", [projectId],
  );
  if (!row) return DEFAULT_WEIGHTS;
  const stored = jsonParse<Partial<FactorWeights>>(row.weights, {});
  return { ...DEFAULT_WEIGHTS, ...stored };
}

export function setWeights(
  db: Db,
  ids: { orgId: string; projectId: string; userId: string },
  weights: Partial<FactorWeights>,
  now = Date.now(),
): Result<FactorWeights, DomainError> {
  for (const [name, value] of Object.entries(weights)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return err(domainError("validation_failed", `Weight for "${name}" must be between 0 and 1.`));
    }
  }
  const merged = { ...DEFAULT_WEIGHTS, ...weights };
  db.run(
    `INSERT INTO opportunity_weights (project_id, org_id, weights, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET weights = excluded.weights,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [ids.projectId, ids.orgId, JSON.stringify(merged), now, ids.userId],
  );
  return ok(merged);
}

export function setEstimate(
  db: Db,
  ids: { orgId: string; projectId: string; userId: string },
  caseId: string,
  estimate: {
    engineeringEffort?: string | null;
    strategicImportance?: string | null;
    hasWorkaround?: boolean | null;
    note?: string | null;
  },
  now = Date.now(),
): Result<true, DomainError> {
  const owned = db.get("SELECT 1 FROM friction_cases WHERE id = ? AND project_id = ?", [caseId, ids.projectId]);
  if (!owned) return err(domainError("not_found", "Friction case not found."));

  const efforts = ["small", "medium", "large", "unknown"];
  const importances = ["low", "medium", "high", "unknown"];
  if (estimate.engineeringEffort && !efforts.includes(estimate.engineeringEffort)) {
    return err(domainError("validation_failed", `Effort must be one of ${efforts.join(", ")}.`));
  }
  if (estimate.strategicImportance && !importances.includes(estimate.strategicImportance)) {
    return err(domainError("validation_failed", `Importance must be one of ${importances.join(", ")}.`));
  }

  db.run(
    `INSERT INTO opportunity_estimates
      (case_id, org_id, engineering_effort, strategic_importance, has_workaround, note, estimated_by, estimated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_id) DO UPDATE SET
       engineering_effort = excluded.engineering_effort,
       strategic_importance = excluded.strategic_importance,
       has_workaround = excluded.has_workaround,
       note = excluded.note, estimated_by = excluded.estimated_by, estimated_at = excluded.estimated_at`,
    [
      caseId, ids.orgId, estimate.engineeringEffort ?? null, estimate.strategicImportance ?? null,
      estimate.hasWorkaround === null || estimate.hasWorkaround === undefined ? null : (estimate.hasWorkaround ? 1 : 0),
      estimate.note ?? null, ids.userId, now,
    ],
  );
  return ok(true);
}

/**
 * Score and rank every open case in a project.
 *
 * Ranked together in one pass, because a rank only means something relative to
 * the other things competing for the same week of engineering time.
 */
export function rankOpportunities(
  db: Db,
  ids: { orgId: string; projectId: string },
  opts: { now?: number } = {},
): OpportunityScore[] {
  const now = opts.now ?? Date.now();
  const weights = getWeights(db, ids.projectId);

  const cases = db.all<{
    id: string; kind: string; affected_users: number; revenue_exposure_minor: number | null;
    evidence_quality: string; detected_at: number;
    effort: string | null; importance: string | null; workaround: number | null;
    evidence_kinds: number;
  }>(
    `SELECT c.id, c.kind, c.affected_users, c.revenue_exposure_minor, c.evidence_quality, c.detected_at,
            e.engineering_effort AS effort, e.strategic_importance AS importance,
            e.has_workaround AS workaround,
            (SELECT COUNT(DISTINCT ev.kind) FROM friction_evidence ev
              WHERE ev.case_id = c.id AND ev.kind != 'release') AS evidence_kinds
       FROM friction_cases c
       LEFT JOIN opportunity_estimates e ON e.case_id = c.id
      WHERE c.project_id = ?
        AND c.status NOT IN ('dismissed','resolved')`,
    [ids.projectId],
  );
  if (cases.length === 0) return [];

  const activeUsers = db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT identity_id) AS n FROM analytics_events
      WHERE project_id = ? AND occurred_at >= ?`,
    [ids.projectId, now - 30 * 86_400_000],
  )?.n ?? 0;

  const totalMrr = db.get<{ total: number | null }>(
    `SELECT SUM(CASE interval WHEN 'year' THEN amount_minor / 12.0
                              WHEN 'quarter' THEN amount_minor / 3.0
                              ELSE amount_minor END) AS total
       FROM customer_subscriptions
      WHERE project_id = ? AND status IN ('active','past_due')`,
    [ids.projectId],
  )?.total ?? 0;

  const context = { activeUsers, totalMrrMinor: Math.round(totalMrr ?? 0), now };

  const scored = cases.map((c) => scoreOpportunity({
    caseId: c.id,
    kind: c.kind,
    affectedUsers: c.affected_users,
    revenueExposureMinor: c.revenue_exposure_minor,
    evidenceQuality: c.evidence_quality,
    // The triggering signal is one of the kinds, so corroboration is the rest.
    independentEvidenceKinds: Math.max(0, c.evidence_kinds - 1),
    detectedAt: c.detected_at,
    estimate: {
      engineeringEffort: c.effort,
      strategicImportance: c.importance,
      hasWorkaround: c.workaround === null ? null : c.workaround === 1,
    },
    context,
  }, weights));

  scored.sort((a, b) => b.score - a.score);

  // Persist, replacing this project's previous ranking.
  db.run(
    `DELETE FROM opportunity_score_factors WHERE score_id IN
      (SELECT id FROM opportunity_scores WHERE project_id = ?)`,
    [ids.projectId],
  );
  db.run("DELETE FROM opportunity_scores WHERE project_id = ?", [ids.projectId]);

  scored.forEach((s, index) => {
    const scoreId = newId("ops");
    db.run(
      `INSERT INTO opportunity_scores
        (id, org_id, project_id, case_id, score, rank, weakest_factor, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [scoreId, ids.orgId, ids.projectId, s.caseId, s.score, index + 1, s.weakestFactor, now],
    );
    for (const f of s.factors) {
      db.run(
        `INSERT INTO opportunity_score_factors
          (id, org_id, score_id, factor, raw_value, raw_unit, normalised, weight, contribution, provenance, explanation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId("osf"), ids.orgId, scoreId, f.factor, f.rawValue, f.rawUnit,
         f.normalised, f.weight, f.contribution, f.provenance, f.explanation],
      );
    }
  });

  return scored;
}

export const SCORE_DISCLAIMER =
  "This score orders a list. It is not a probability, not a confidence level, and not a prediction of " +
  "business impact. Every factor below shows its raw measurement, how it was transformed, its weight, " +
  "and whether it came from data or from a person.";

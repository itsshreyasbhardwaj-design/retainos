import { type Db, jsonParse } from "@retainos/database";
import {
  newId, stableHashFraction, ok, err, domainError, type Result, type DomainError,
} from "@retainos/shared";
import {
  twoProportionTest, welchTTest, sampleRatioMismatch, holmBonferroni,
  requiredSampleSize, mean, variance, type ProportionTest, type MeanTest, type SrmCheck,
} from "./stats.ts";

export type ExperimentVerdict =
  | "improvement_supported" | "no_clear_difference" | "worse_outcome"
  | "inconclusive" | "invalid_experiment";

export interface Variant {
  key: string;
  name: string;
  isControl: boolean;
  weight: number;
}

export interface GuardrailMetric {
  label: string;
  event: string;
  kind: "conversion" | "count_per_user";
  /** Which direction is bad. Guardrails usually must not go down. */
  worseWhen: "decreases" | "increases";
}

export interface ExperimentConfig {
  id: string;
  key: string;
  name: string;
  status: string;
  primaryMetricEvent: string;
  primaryMetricKind: "conversion" | "count_per_user";
  guardrailMetrics: GuardrailMetric[];
  minExposuresPerVariant: number;
  startedAt: number | null;
  stoppedAt: number | null;
}

export function createExperiment(
  db: Db,
  ids: { orgId: string; projectId: string; userId: string },
  input: {
    key: string;
    name: string;
    hypothesis?: string;
    primaryMetricEvent: string;
    primaryMetricKind?: "conversion" | "count_per_user";
    guardrailMetrics?: GuardrailMetric[];
    minExposuresPerVariant?: number;
    variants: Array<{ key: string; name: string; isControl?: boolean; weight?: number }>;
    improvementId?: string | null;
  },
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  if (!/^[a-z0-9][a-z0-9_-]{1,60}$/.test(input.key)) {
    return err(domainError("validation_failed", "The experiment key must be 2-61 lowercase characters."));
  }
  if (input.variants.length < 2) {
    return err(domainError("validation_failed", "An experiment needs at least two variants."));
  }
  if (input.variants.filter((v) => v.isControl).length !== 1) {
    return err(domainError("validation_failed", "Exactly one variant must be marked as the control."));
  }
  const weights = input.variants.map((v) => v.weight ?? 1 / input.variants.length);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    return err(domainError("validation_failed", `Variant weights must sum to 1; they sum to ${weightSum.toFixed(4)}.`));
  }
  if (db.get("SELECT 1 FROM experiments WHERE project_id = ? AND key = ?", [ids.projectId, input.key])) {
    return err(domainError("conflict", `An experiment with key '${input.key}' already exists.`));
  }

  const id = newId("exp");
  return db.tx(() => {
    db.run(
      `INSERT INTO experiments
        (id, org_id, project_id, key, name, hypothesis, improvement_id, status,
         primary_metric_event, primary_metric_kind, guardrail_metrics,
         min_exposures_per_variant, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, ids.orgId, ids.projectId, input.key, input.name, input.hypothesis ?? "",
        input.improvementId ?? null, input.primaryMetricEvent, input.primaryMetricKind ?? "conversion",
        JSON.stringify(input.guardrailMetrics ?? []), input.minExposuresPerVariant ?? 200,
        now, now, ids.userId,
      ],
    );
    input.variants.forEach((v, i) => {
      db.run(
        `INSERT INTO experiment_variants (id, org_id, experiment_id, key, name, is_control, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId("var"), ids.orgId, id, v.key, v.name, v.isControl ? 1 : 0, weights[i]!],
      );
    });
    return ok({ id });
  });
}

export function startExperiment(db: Db, projectId: string, experimentId: string, now = Date.now()): Result<true, DomainError> {
  const r = db.run(
    "UPDATE experiments SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND status = 'draft'",
    [now, now, experimentId, projectId],
  );
  return r.changes === 0
    ? err(domainError("conflict", "Only a draft experiment can be started."))
    : ok(true);
}

export function stopExperiment(db: Db, projectId: string, experimentId: string, now = Date.now()): Result<true, DomainError> {
  const r = db.run(
    "UPDATE experiments SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND status = 'running'",
    [now, now, experimentId, projectId],
  );
  return r.changes === 0
    ? err(domainError("conflict", "Only a running experiment can be stopped."))
    : ok(true);
}

export function getExperiment(db: Db, projectId: string, experimentId: string): (ExperimentConfig & { variants: Variant[] }) | null {
  const row = db.get<Record<string, unknown>>(
    "SELECT * FROM experiments WHERE id = ? AND project_id = ?", [experimentId, projectId],
  );
  if (!row) return null;
  const variants = db.all<{ key: string; name: string; is_control: number; weight: number }>(
    "SELECT key, name, is_control, weight FROM experiment_variants WHERE experiment_id = ? ORDER BY is_control DESC, key",
    [experimentId],
  ).map((v) => ({ key: v.key, name: v.name, isControl: v.is_control === 1, weight: v.weight }));
  return {
    id: row.id as string,
    key: row.key as string,
    name: row.name as string,
    status: row.status as string,
    primaryMetricEvent: row.primary_metric_event as string,
    primaryMetricKind: row.primary_metric_kind as "conversion" | "count_per_user",
    guardrailMetrics: jsonParse<GuardrailMetric[]>(row.guardrail_metrics, []),
    minExposuresPerVariant: row.min_exposures_per_variant as number,
    startedAt: (row.started_at as number) ?? null,
    stoppedAt: (row.stopped_at as number) ?? null,
    variants,
  };
}

export function listExperiments(db: Db, projectId: string) {
  return db.all(
    `SELECT e.*, (SELECT COUNT(*) FROM experiment_exposures x WHERE x.experiment_id = e.id) AS exposure_count
       FROM experiments e WHERE e.project_id = ? ORDER BY e.created_at DESC`,
    [projectId],
  );
}

/**
 * Assign an identity to a variant.
 *
 * Assignment is a pure function of (experiment key, identity id) via a stable
 * hash, so it is reproducible across processes, restarts and re-runs, and a
 * user never flips between variants. The database row is a cache of that
 * decision, not the decision itself.
 */
export function assignVariant(
  db: Db,
  ids: { orgId: string; projectId: string },
  experiment: { id: string; key: string; variants: Variant[] },
  identityId: string,
  now = Date.now(),
): string {
  const existing = db.get<{ variant_key: string }>(
    "SELECT variant_key FROM experiment_assignments WHERE experiment_id = ? AND identity_id = ?",
    [experiment.id, identityId],
  );
  if (existing) return existing.variant_key;

  const variantKey = deterministicVariant(experiment.key, identityId, experiment.variants);
  db.run(
    `INSERT INTO experiment_assignments (id, org_id, project_id, experiment_id, identity_id, variant_key, assigned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId("asn"), ids.orgId, ids.projectId, experiment.id, identityId, variantKey, now],
  );
  return variantKey;
}

/** The pure assignment function. Exported so it can be tested on its own. */
export function deterministicVariant(experimentKey: string, identityId: string, variants: Variant[]): string {
  const fraction = stableHashFraction(`${experimentKey}:${identityId}`);
  let cumulative = 0;
  const ordered = [...variants].sort((a, b) => a.key.localeCompare(b.key));
  for (const v of ordered) {
    cumulative += v.weight;
    if (fraction < cumulative) return v.key;
  }
  return ordered[ordered.length - 1]!.key;
}

/**
 * Record that a user actually saw their variant.
 *
 * Analysis uses exposures, never assignments. A user assigned to the treatment
 * who never reached the changed screen tells you nothing about the change, and
 * including them dilutes any real effect towards zero.
 */
export function recordExposure(
  db: Db,
  ids: { orgId: string; projectId: string },
  experimentId: string,
  identityId: string,
  variantKey: string,
  now = Date.now(),
): void {
  db.run(
    `INSERT INTO experiment_exposures
      (id, org_id, project_id, experiment_id, identity_id, variant_key, first_exposed_at, exposure_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(experiment_id, identity_id)
     DO UPDATE SET exposure_count = exposure_count + 1`,
    [newId("exo"), ids.orgId, ids.projectId, experimentId, identityId, variantKey, now],
  );
}

export interface ValidityCheck {
  id: string;
  passed: boolean;
  severity: "blocking" | "warning";
  detail: string;
}

export interface VariantMetric {
  variantKey: string;
  variantName: string;
  isControl: boolean;
  exposed: number;
  converted: number;
  conversionRate: number;
  /** For count metrics. */
  totalCount: number;
  meanPerUser: number;
}

export interface ExperimentAnalysis {
  experimentId: string;
  computedAt: number;
  metricKind: "conversion" | "count_per_user";
  variants: VariantMetric[];
  primary: {
    test: ProportionTest | MeanTest | null;
    /** True only when every blocking check passed and the test supports it. */
    significant: boolean;
  };
  guardrails: Array<{
    label: string;
    test: ProportionTest | null;
    adjustedThreshold: number;
    significant: boolean;
    direction: "better" | "worse" | "no_change";
  }>;
  srm: SrmCheck | null;
  checks: ValidityCheck[];
  verdict: ExperimentVerdict;
  /** Plain-language account of exactly which evidence drove the verdict. */
  reasoning: string[];
  recommendedSampleSizePerVariant: number | null;
}

/**
 * Analyse an experiment.
 *
 * The order matters: validity checks run first, and a blocking failure forces
 * the verdict to `invalid_experiment` regardless of how good the p-value looks.
 * An experiment with a sample ratio mismatch has not produced a small effect;
 * it has produced no usable information at all.
 */
export function analyseExperiment(
  db: Db,
  projectId: string,
  experimentId: string,
  opts: { now?: number; alpha?: number } = {},
): Result<ExperimentAnalysis, DomainError> {
  const now = opts.now ?? Date.now();
  const alpha = opts.alpha ?? 0.05;
  const exp = getExperiment(db, projectId, experimentId);
  if (!exp) return err(domainError("not_found", "Experiment not found."));

  const exposures = db.all<{ variant_key: string; identity_id: string; first_exposed_at: number }>(
    "SELECT variant_key, identity_id, first_exposed_at FROM experiment_exposures WHERE experiment_id = ?",
    [experimentId],
  );

  const checks: ValidityCheck[] = [];
  const reasoning: string[] = [];

  if (exposures.length === 0) {
    checks.push({
      id: "missing_exposure_data",
      passed: false,
      severity: "blocking",
      detail: "No exposures have been recorded. Without exposure data there is nothing to analyse; " +
              "call the exposure API where the variant is actually shown.",
    });
    return ok({
      experimentId, computedAt: now, metricKind: exp.primaryMetricKind,
      variants: [], primary: { test: null, significant: false }, guardrails: [], srm: null, checks,
      verdict: "invalid_experiment",
      reasoning: ["The experiment recorded no exposures, so no comparison is possible."],
      recommendedSampleSizePerVariant: null,
    });
  }

  // Variant membership comes from exposures: the variant the user actually saw.
  const byVariant = new Map<string, Set<string>>();
  for (const e of exposures) {
    let set = byVariant.get(e.variant_key);
    if (!set) {
      set = new Set();
      byVariant.set(e.variant_key, set);
    }
    set.add(e.identity_id);
  }

  /*
   * Contamination check.
   *
   * The exposure table is unique on (experiment, identity), so one user cannot
   * hold two exposure rows. The failure that *can* happen is an exposure
   * recorded under a different variant than the one assignment chose — a
   * caller passing the wrong variant key, or a client caching a stale variant.
   * Those users saw something other than their assigned arm, so their outcomes
   * cannot be attributed to either.
   */
  const mismatched = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM experiment_exposures x
       JOIN experiment_assignments a
         ON a.experiment_id = x.experiment_id AND a.identity_id = x.identity_id
      WHERE x.experiment_id = ? AND a.variant_key != x.variant_key`,
    [experimentId],
  )?.n ?? 0;
  checks.push({
    id: "contamination",
    passed: mismatched === 0,
    severity: mismatched === 0 ? "warning" : "blocking",
    detail: mismatched === 0
      ? "Every exposure matches the variant the user was assigned to."
      : `${mismatched} users were exposed to a variant other than the one they were assigned. ` +
        "Their outcomes cannot be attributed to either arm, so the comparison is invalid until " +
        "assignment and exposure are brought back into agreement.",
  });

  // Metric outcomes.
  const metricRows = db.all<{ identity_id: string; n: number }>(
    `SELECT identity_id, COUNT(*) AS n FROM analytics_events
      WHERE project_id = ? AND name = ? GROUP BY identity_id`,
    [projectId, exp.primaryMetricEvent],
  );
  const countByIdentity = new Map(metricRows.map((r) => [r.identity_id, r.n]));

  const variants: VariantMetric[] = exp.variants.map((v) => {
    const members = byVariant.get(v.key) ?? new Set<string>();
    let converted = 0;
    let total = 0;
    for (const id of members) {
      const n = countByIdentity.get(id) ?? 0;
      if (n > 0) converted++;
      total += n;
    }
    return {
      variantKey: v.key,
      variantName: v.name,
      isControl: v.isControl,
      exposed: members.size,
      converted,
      conversionRate: members.size === 0 ? 0 : converted / members.size,
      totalCount: total,
      meanPerUser: members.size === 0 ? 0 : total / members.size,
    };
  });

  const control = variants.find((v) => v.isControl);
  const treatment = variants.find((v) => !v.isControl);

  // Sample ratio mismatch.
  const srm = sampleRatioMismatch(
    exp.variants.map((v) => byVariant.get(v.key)?.size ?? 0),
    exp.variants.map((v) => v.weight),
  );
  checks.push({
    id: "sample_ratio_mismatch",
    passed: !srm?.mismatch,
    severity: srm?.mismatch ? "blocking" : "warning",
    detail: srm
      ? srm.mismatch
        ? `The traffic split differs from the configured weights more than chance explains ` +
          `(chi-square ${srm.chiSquare.toFixed(2)}, p = ${srm.pValue.toExponential(2)}). ` +
          "This almost always means a bug in assignment or exposure logging, not a real effect."
        : `The traffic split matches the configured weights (p = ${srm.pValue.toFixed(3)}).`
      : "Not enough data to check the traffic split.",
  });

  // Minimum sample.
  const smallest = Math.min(...variants.map((v) => v.exposed));
  const meetsMinimum = smallest >= exp.minExposuresPerVariant;
  checks.push({
    id: "minimum_sample",
    passed: meetsMinimum,
    severity: "blocking",
    detail: meetsMinimum
      ? `Every variant has at least the pre-registered ${exp.minExposuresPerVariant} exposures.`
      : `The smallest variant has ${smallest} exposures, below the pre-registered minimum of ` +
        `${exp.minExposuresPerVariant}. Reading a result now is premature stopping.`,
  });

  // Schema change during the experiment window would silently change the metric.
  if (exp.startedAt) {
    const schemaChanged = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM event_schemas WHERE project_id = ? AND name = ? AND updated_at > ? AND version > 1",
      [projectId, exp.primaryMetricEvent, exp.startedAt],
    )?.n ?? 0;
    checks.push({
      id: "metric_schema_stable",
      passed: schemaChanged === 0,
      severity: schemaChanged === 0 ? "warning" : "blocking",
      detail: schemaChanged === 0
        ? "The primary metric's event schema did not change while the experiment ran."
        : "The primary metric's event schema changed while the experiment ran, so the metric may not mean " +
          "the same thing in both arms.",
    });
  }

  // Primary test.
  let test: ProportionTest | MeanTest | null = null;
  if (control && treatment) {
    if (exp.primaryMetricKind === "conversion") {
      test = twoProportionTest(
        { successes: control.converted, total: control.exposed },
        { successes: treatment.converted, total: treatment.exposed },
      );
      if (test && !(test as ProportionTest).normalApproximationValid) {
        checks.push({
          id: "normal_approximation",
          passed: false,
          severity: "blocking",
          detail: "There are too few conversions for the normal approximation behind this p-value to hold. " +
                  "The test statistic is not trustworthy at this sample size.",
        });
      }
    } else {
      const valuesFor = (v: VariantMetric) => {
        const members = byVariant.get(v.variantKey) ?? new Set<string>();
        return [...members].map((id) => countByIdentity.get(id) ?? 0);
      };
      const cv = valuesFor(control);
      const tv = valuesFor(treatment);
      const cVar = variance(cv);
      const tVar = variance(tv);
      test = cVar === null || tVar === null ? null : welchTTest(
        { mean: mean(cv)!, variance: cVar, n: cv.length },
        { mean: mean(tv)!, variance: tVar, n: tv.length },
      );
    }
  }

  // Guardrails, with a multiple-comparison correction.
  const guardrailTests = exp.guardrailMetrics.map((g) => {
    const rows = db.all<{ identity_id: string }>(
      "SELECT DISTINCT identity_id FROM analytics_events WHERE project_id = ? AND name = ?",
      [projectId, g.event],
    );
    const did = new Set(rows.map((r) => r.identity_id));
    const count = (v: VariantMetric) => {
      const members = byVariant.get(v.variantKey) ?? new Set<string>();
      let n = 0;
      for (const id of members) if (did.has(id)) n++;
      return n;
    };
    const t = control && treatment
      ? twoProportionTest(
          { successes: count(control), total: control.exposed },
          { successes: count(treatment), total: treatment.exposed },
        )
      : null;
    return { label: g.label, worseWhen: g.worseWhen, test: t };
  });

  const corrections = holmBonferroni(
    guardrailTests.map((g) => ({ label: g.label, pValue: g.test?.pValue ?? 1 })),
    alpha,
  );
  const guardrails = guardrailTests.map((g) => {
    const c = corrections.find((x) => x.label === g.label)!;
    const diff = g.test?.absoluteDiff ?? 0;
    const worse = g.worseWhen === "decreases" ? diff < 0 : diff > 0;
    return {
      label: g.label,
      test: g.test,
      adjustedThreshold: c.adjustedThreshold,
      significant: c.significant,
      direction: (!c.significant ? "no_change" : worse ? "worse" : "better") as "better" | "worse" | "no_change",
    };
  });

  // Verdict.
  const blocking = checks.filter((c) => c.severity === "blocking" && !c.passed);
  let verdict: ExperimentVerdict;
  if (blocking.length > 0) {
    verdict = "invalid_experiment";
    for (const b of blocking) reasoning.push(b.detail);
  } else if (!test) {
    verdict = "inconclusive";
    reasoning.push("The metric could not be computed for both arms, so no comparison was possible.");
  } else if (test.pValue > alpha) {
    verdict = "no_clear_difference";
    reasoning.push(
      `The difference is not distinguishable from chance at the ${(alpha * 100).toFixed(0)}% level ` +
      `(p = ${formatP(test.pValue)}). That is not the same as proving the variants are equal: the 95% ` +
      `interval of ${formatInterval(test, exp.primaryMetricKind)} still contains effects that would matter.`,
    );
  } else if (test.absoluteDiff > 0) {
    verdict = "improvement_supported";
    reasoning.push(
      `The treatment is higher by ${formatDiff(test, exp.primaryMetricKind)}, with p = ${formatP(test.pValue)} ` +
      `and a 95% interval of ${formatInterval(test, exp.primaryMetricKind)}.`,
    );
  } else {
    verdict = "worse_outcome";
    reasoning.push(
      `The treatment is lower by ${formatDiff(test, exp.primaryMetricKind)}, with p = ${formatP(test.pValue)} ` +
      `and a 95% interval of ${formatInterval(test, exp.primaryMetricKind)}.`,
    );
  }

  const worseGuardrails = guardrails.filter((g) => g.direction === "worse");
  if (verdict === "improvement_supported" && worseGuardrails.length > 0) {
    reasoning.push(
      `However, ${worseGuardrails.length} guardrail metric(s) moved the wrong way after correcting for ` +
      `multiple comparisons: ${worseGuardrails.map((g) => g.label).join(", ")}. Weigh that against the primary gain.`,
    );
  }

  const baseline = control?.conversionRate ?? 0;
  return ok({
    experimentId,
    computedAt: now,
    metricKind: exp.primaryMetricKind,
    variants,
    primary: {
      test,
      significant: blocking.length === 0 && test !== null && test.pValue <= alpha,
    },
    guardrails,
    srm,
    checks,
    verdict,
    reasoning,
    recommendedSampleSizePerVariant:
      exp.primaryMetricKind === "conversion" && baseline > 0 && baseline < 1
        ? requiredSampleSize(baseline, 0.1)
        : null,
  });
}

/**
 * Format a difference for the verdict prose.
 *
 * Conversion metrics read in percentage points, because "higher by 0.2444" is
 * a number a reader has to convert in their head before it means anything.
 */
function formatDiff(test: ProportionTest | MeanTest, kind: "conversion" | "count_per_user"): string {
  const abs = Math.abs(test.absoluteDiff);
  const rel = test.relativeDiff === null ? null : Math.abs(test.relativeDiff);
  const magnitude = kind === "conversion" ? `${(abs * 100).toFixed(2)} percentage points` : abs.toFixed(4);
  return rel === null ? magnitude : `${magnitude} (${(rel * 100).toFixed(1)}% relative)`;
}

/** A p-value small enough to round to zero is shown in scientific notation. */
function formatP(p: number): string {
  return p < 0.0001 ? p.toExponential(1) : p.toFixed(4);
}

/** An interval, in the same units as formatDiff. */
function formatInterval(test: ProportionTest | MeanTest, kind: "conversion" | "count_per_user"): string {
  const [lo, hi] = test.confidenceInterval;
  return kind === "conversion"
    ? `${(lo * 100).toFixed(2)} to ${(hi * 100).toFixed(2)} percentage points`
    : `${lo.toFixed(4)} to ${hi.toFixed(4)}`;
}

export function saveAnalysis(
  db: Db,
  orgId: string,
  analysis: ExperimentAnalysis,
  now = Date.now(),
): string {
  const id = newId("exr");
  db.run(
    `INSERT INTO experiment_results (id, org_id, experiment_id, computed_at, analysis, verdict)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, orgId, analysis.experimentId, now, JSON.stringify(analysis), analysis.verdict],
  );
  db.run("UPDATE experiments SET status = 'analysed', updated_at = ? WHERE id = ?", [now, analysis.experimentId]);
  return id;
}

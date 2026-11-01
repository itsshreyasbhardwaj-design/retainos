import { type Db, jsonParse } from "@retainos/database";
import { newId, dayKey, addDays, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";
import { twoProportionTest, wilsonInterval } from "./stats.ts";
import { computeFunnel, type FunnelStep } from "./funnels.ts";

export type ImpactMetricKind = "event_conversion" | "funnel_step" | "activation_rate" | "event_rate";

export interface BeforeAfterResult {
  method: "before_after";
  metricKind: ImpactMetricKind;
  metricLabel: string;
  before: { from: number; to: number; numerator: number; denominator: number; rate: number | null; interval: [number, number] | null };
  after: { from: number; to: number; numerator: number; denominator: number; rate: number | null; interval: [number, number] | null };
  absoluteChange: number | null;
  relativeChange: number | null;
  /** Descriptive comparison only. Explicitly NOT a causal estimate. */
  causalClaim: "none";
  /** Every confounder the system can detect, plus the ones it cannot. */
  confounders: Array<{ id: string; detected: boolean; detail: string }>;
  limitations: string[];
  /** A difference test on the two periods, for scale only — not a causal test. */
  descriptiveTest: ReturnType<typeof twoProportionTest>;
  interpretation: string;
}

export const BEFORE_AFTER_WARNING =
  "This is an observational before-and-after comparison. It shows that a metric changed around a release; " +
  "it does not show that the release caused the change. Only a controlled experiment supports a causal claim.";

/**
 * Before-and-after measurement around a release.
 *
 * The confounder list is the point of this function. A before/after number on
 * its own invites a causal reading, so the result carries the specific reasons
 * this particular comparison might mislead: other releases in the window, a
 * shift in where users came from, a changed tracking schema, seasonality, and
 * a population that simply grew.
 */
export function beforeAfter(
  db: Db,
  projectId: string,
  input: {
    releaseAt: number;
    windowDays: number;
    metricKind: ImpactMetricKind;
    metricLabel: string;
    /** For event_conversion: denominator event then numerator event. */
    denominatorEvent?: string;
    numeratorEvent?: string;
    /** For funnel_step: the funnel and which step to read. */
    funnelSteps?: FunnelStep[];
    funnelStepIndex?: number;
    timezone: string;
    now?: number;
  },
): Result<BeforeAfterResult, DomainError> {
  const now = input.now ?? Date.now();
  const windowMs = input.windowDays * 86_400_000;
  if (input.windowDays < 1 || input.windowDays > 180) {
    return err(domainError("validation_failed", "The measurement window must be between 1 and 180 days."));
  }
  const beforeWindow = { from: input.releaseAt - windowMs, to: input.releaseAt - 1 };
  const afterWindow = { from: input.releaseAt, to: Math.min(input.releaseAt + windowMs, now) };

  if (afterWindow.to - afterWindow.from < windowMs) {
    // Not an error: an early look is legitimate, but the result must say so.
    // Handled in `limitations` below.
  }

  const measure = (window: { from: number; to: number }) => {
    if (input.metricKind === "funnel_step") {
      const steps = input.funnelSteps ?? [];
      const idx = input.funnelStepIndex ?? steps.length - 1;
      const r = computeFunnel(db, projectId, { steps, from: window.from, to: window.to });
      if (!r.ok) return { numerator: 0, denominator: 0 };
      const step = r.value.steps[idx];
      const prev = r.value.steps[Math.max(0, idx - 1)];
      return { numerator: step?.users ?? 0, denominator: prev?.users ?? 0 };
    }
    const denomEvent = input.denominatorEvent ?? "signup_completed";
    const numEvent = input.numeratorEvent ?? denomEvent;
    const denominator = db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT identity_id) AS n FROM analytics_events
        WHERE project_id = ? AND name = ? AND occurred_at >= ? AND occurred_at <= ?`,
      [projectId, denomEvent, window.from, window.to],
    )?.n ?? 0;
    const numerator = db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT identity_id) AS n FROM analytics_events
        WHERE project_id = ? AND name = ? AND occurred_at >= ? AND occurred_at <= ?`,
      [projectId, numEvent, window.from, window.to],
    )?.n ?? 0;
    return { numerator, denominator };
  };

  const b = measure(beforeWindow);
  const a = measure(afterWindow);

  const beforeRate = b.denominator === 0 ? null : b.numerator / b.denominator;
  const afterRate = a.denominator === 0 ? null : a.numerator / a.denominator;

  // --- confounder detection ------------------------------------------------
  const confounders: BeforeAfterResult["confounders"] = [];

  const otherReleases = db.all<{ version: string; released_at: number }>(
    `SELECT version, released_at FROM releases
      WHERE project_id = ? AND released_at > ? AND released_at <= ? AND released_at != ?`,
    [projectId, beforeWindow.from, afterWindow.to, input.releaseAt],
  );
  confounders.push({
    id: "concurrent_releases",
    detected: otherReleases.length > 0,
    detail: otherReleases.length > 0
      ? `${otherReleases.length} other release(s) shipped inside the comparison window (${otherReleases.map((r) => r.version).join(", ")}). ` +
        "Any change could belong to those instead."
      : "No other releases were recorded inside the comparison window.",
  });

  const sourceShift = acquisitionShift(db, projectId, beforeWindow, afterWindow);
  confounders.push({
    id: "acquisition_mix",
    detected: sourceShift.shifted,
    detail: sourceShift.shifted
      ? `The mix of acquisition sources changed materially (largest shift: ${sourceShift.largest}). ` +
        "Different traffic converts differently, independently of the release."
      : "The mix of acquisition sources was broadly stable across both windows.",
  });

  const schemaChanges = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM event_schemas
      WHERE project_id = ? AND updated_at > ? AND updated_at <= ? AND version > 1`,
    [projectId, beforeWindow.from, afterWindow.to],
  )?.n ?? 0;
  confounders.push({
    id: "tracking_changes",
    detected: schemaChanges > 0,
    detail: schemaChanges > 0
      ? `${schemaChanges} event schema version(s) changed inside the window, so the metric may not mean the same thing in both periods.`
      : "No event schema versions changed inside the window.",
  });

  const populationRatio = b.denominator === 0 ? null : a.denominator / b.denominator;
  const populationShift = populationRatio !== null && (populationRatio > 1.5 || populationRatio < 0.67);
  confounders.push({
    id: "population_change",
    detected: populationShift,
    detail: populationShift
      ? `The measured population changed by ${((populationRatio! - 1) * 100).toFixed(0)}% between windows ` +
        `(${b.denominator} then ${a.denominator}). A different population may behave differently for reasons ` +
        "unrelated to the release."
      : `The measured population was comparable (${b.denominator} then ${a.denominator}).`,
  });

  confounders.push({
    id: "seasonality",
    detected: input.windowDays < 14,
    detail: input.windowDays < 14
      ? `A ${input.windowDays}-day window does not cover a full weekly cycle twice, so day-of-week effects are not averaged out.`
      : "The window covers at least two full weeks, which averages out day-of-week effects.",
  });

  confounders.push({
    id: "external_factors",
    detected: false,
    detail: "RetainOS cannot see marketing campaigns, press coverage, outages, pricing changes or competitor " +
            "activity. Check whether anything outside the product changed in this window.",
  });

  const limitations: string[] = [BEFORE_AFTER_WARNING];
  if (afterWindow.to - afterWindow.from < windowMs) {
    const elapsed = Math.round((afterWindow.to - afterWindow.from) / 86_400_000);
    limitations.push(
      `Only ${elapsed} of the ${input.windowDays} days after the release have elapsed, so the 'after' figure is partial.`,
    );
  }
  if (b.denominator < 30 || a.denominator < 30) {
    limitations.push(
      `Small populations (${b.denominator} before, ${a.denominator} after). Rates on samples this size move a lot on their own.`,
    );
  }
  if (beforeRate === null || afterRate === null) {
    limitations.push("One of the windows had no users in the denominator, so no rate could be computed for it.");
  }

  const descriptiveTest = twoProportionTest(
    { successes: b.numerator, total: b.denominator },
    { successes: a.numerator, total: a.denominator },
  );

  const detectedConfounders = confounders.filter((c) => c.detected);
  const interpretation =
    beforeRate === null || afterRate === null
      ? "There is not enough data in both windows to compare."
      : `${input.metricLabel} was ${(beforeRate * 100).toFixed(1)}% before and ${(afterRate * 100).toFixed(1)}% after. ` +
        `That is an observed change of ${((afterRate - beforeRate) * 100).toFixed(1)} percentage points. ` +
        (detectedConfounders.length > 0
          ? `${detectedConfounders.length} potential confounder(s) were detected, so this comparison should not be read as the release's effect. `
          : "No confounders were detected automatically, but absence of detection is not evidence of absence. ") +
        "To support a causal claim, run a controlled experiment in ImpactLab.";

  return ok({
    method: "before_after",
    metricKind: input.metricKind,
    metricLabel: input.metricLabel,
    before: {
      ...beforeWindow, numerator: b.numerator, denominator: b.denominator, rate: beforeRate,
      interval: b.denominator === 0 ? null : wilsonInterval(b.numerator, b.denominator),
    },
    after: {
      ...afterWindow, numerator: a.numerator, denominator: a.denominator, rate: afterRate,
      interval: a.denominator === 0 ? null : wilsonInterval(a.numerator, a.denominator),
    },
    absoluteChange: beforeRate === null || afterRate === null ? null : afterRate - beforeRate,
    relativeChange: beforeRate === null || afterRate === null || beforeRate === 0 ? null : (afterRate - beforeRate) / beforeRate,
    causalClaim: "none",
    confounders,
    limitations,
    descriptiveTest,
    interpretation,
  });
}

function acquisitionShift(
  db: Db,
  projectId: string,
  before: { from: number; to: number },
  after: { from: number; to: number },
): { shifted: boolean; largest: string } {
  const share = (w: { from: number; to: number }) => {
    const rows = db.all<{ acquisition_source: string | null; n: number }>(
      `SELECT acquisition_source, COUNT(DISTINCT identity_id) AS n FROM analytics_events
        WHERE project_id = ? AND occurred_at >= ? AND occurred_at <= ? GROUP BY acquisition_source`,
      [projectId, w.from, w.to],
    );
    const total = rows.reduce((s, r) => s + r.n, 0);
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.acquisition_source ?? "unknown", total === 0 ? 0 : r.n / total);
    return map;
  };
  const b = share(before);
  const a = share(after);
  let largest = "";
  let largestDelta = 0;
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const delta = Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0));
    if (delta > largestDelta) {
      largestDelta = delta;
      largest = `${key} moved by ${(delta * 100).toFixed(0)} points`;
    }
  }
  // A 15-point shift in any single source's share is enough to change a
  // blended conversion rate on its own.
  return { shifted: largestDelta >= 0.15, largest };
}

export function saveImpactMeasurement(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: {
    improvementId?: string | null;
    releaseId?: string | null;
    experimentId?: string | null;
    method: "before_after" | "experiment";
    metricKind: string;
    metricConfig?: Record<string, unknown>;
    windowDays: number;
    result: unknown;
  },
  now = Date.now(),
): string {
  const id = newId("imm");
  db.run(
    `INSERT INTO impact_measurements
      (id, org_id, project_id, improvement_id, release_id, experiment_id, method, metric_kind,
       metric_config, window_days, result, computed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, ids.orgId, ids.projectId, input.improvementId ?? null, input.releaseId ?? null,
      input.experimentId ?? null, input.method, input.metricKind,
      JSON.stringify(input.metricConfig ?? {}), input.windowDays, JSON.stringify(input.result), now, now,
    ],
  );
  return id;
}

export function listImpactMeasurements(db: Db, projectId: string, limit = 50) {
  return db.all<{ id: string; method: string; metric_kind: string; result: string; computed_at: number; improvement_id: string | null; release_id: string | null }>(
    `SELECT id, method, metric_kind, result, computed_at, improvement_id, release_id
       FROM impact_measurements WHERE project_id = ? ORDER BY computed_at DESC LIMIT ?`,
    [projectId, Math.min(limit, 200)],
  ).map((r) => ({ ...r, result: jsonParse<Record<string, unknown>>(r.result, {}) }));
}

/** Metric values in a window around every release, for the release timeline. */
export function releaseTimeline(
  db: Db,
  projectId: string,
  input: { eventName: string; timezone: string; windowDays?: number; limit?: number },
) {
  const windowDays = input.windowDays ?? 7;
  const releases = db.all<{ id: string; name: string; version: string; released_at: number }>(
    "SELECT id, name, version, released_at FROM releases WHERE project_id = ? ORDER BY released_at DESC LIMIT ?",
    [projectId, Math.min(input.limit ?? 20, 100)],
  );
  return releases.map((r) => {
    const windowMs = windowDays * 86_400_000;
    const countIn = (from: number, to: number) =>
      db.get<{ n: number }>(
        `SELECT COUNT(DISTINCT identity_id) AS n FROM analytics_events
          WHERE project_id = ? AND name = ? AND occurred_at >= ? AND occurred_at <= ?`,
        [projectId, input.eventName, from, to],
      )?.n ?? 0;
    return {
      release: r,
      usersBefore: countIn(r.released_at - windowMs, r.released_at - 1),
      usersAfter: countIn(r.released_at, r.released_at + windowMs),
      windowDays,
      caveat: BEFORE_AFTER_WARNING,
    };
  });
}

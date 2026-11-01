import { type Db, jsonParse } from "@retainos/database";
import { dayKey, dayKeyToMillis, addDays, daysBetween, weekKey, type Granularity } from "@retainos/shared";
import { wilsonInterval } from "./stats.ts";
import { segmentPredicate, type SegmentFilter } from "./segments.ts";

export type CohortBasis = "first_seen" | "signup_event" | "activation_event" | "plan" | "release";

export interface RetentionCell {
  period: number;
  /** Users from the cohort active in this period. */
  retained: number;
  rate: number;
  interval: [number, number];
  /** False when the period has not fully elapsed for this cohort. */
  complete: boolean;
}

export interface RetentionCohort {
  cohort: string;
  cohortSize: number;
  cells: RetentionCell[];
  /** Set when the cohort is too small for its percentages to mean much. */
  smallSample: boolean;
}

export interface RetentionResult {
  cohorts: RetentionCohort[];
  periods: number[];
  granularity: "day" | "week" | "month";
  basis: CohortBasis;
  returnEvent: string | null;
  timezone: string;
  /** Weighted average retention per period across cohorts with complete data. */
  averageByPeriod: Array<{ period: number; rate: number | null; cohortsCounted: number; usersCounted: number }>;
  definition: {
    denominator: string;
    returnDefinition: string;
    periodBoundaries: string;
    incompletePeriods: string;
  };
}

const SMALL_COHORT = 20;

/**
 * Cohort retention.
 *
 * The three things most retention charts get wrong, and how this one handles
 * them:
 *
 *  1. The denominator. It is the full cohort, fixed at cohort assignment, and
 *     it never shrinks. Dividing by "users we still have records for" produces
 *     retention curves that trend upward, which is nonsense.
 *  2. Period boundaries. Period N means "N calendar days after the cohort's
 *     own start day", resolved in the project's reporting timezone, not
 *     "N × 86,400,000 milliseconds", which drifts across DST.
 *  3. Incomplete periods. A cohort from two days ago has no day-7 number yet.
 *     Those cells are marked incomplete and excluded from averages instead of
 *     being reported as a fall to zero.
 */
export function computeRetention(
  db: Db,
  projectId: string,
  input: {
    from: number;
    to: number;
    granularity?: "day" | "week" | "month";
    periods?: number[];
    basis?: CohortBasis;
    /** Event that counts as "came back". Defaults to any event. */
    returnEvent?: string | null;
    /** Required when basis is signup_event or activation_event. */
    cohortEvent?: string | null;
    timezone: string;
    segment?: SegmentFilter;
    now?: number;
  },
): RetentionResult {
  const tz = input.timezone;
  const now = input.now ?? Date.now();
  const granularity = input.granularity ?? "day";
  const basis = input.basis ?? "first_seen";
  const periods = (input.periods ?? defaultPeriods(granularity)).slice().sort((a, b) => a - b);
  const periodDays = granularity === "day" ? 1 : granularity === "week" ? 7 : 30;

  // --- cohort assignment ---------------------------------------------------
  const seg = segmentPredicate(input.segment, "e");
  let cohortRows: Array<{ identity_id: string; cohort_at: number }>;

  if (basis === "first_seen") {
    cohortRows = db.all(
      `SELECT e.identity_id, MIN(e.occurred_at) AS cohort_at
         FROM analytics_events e
        WHERE e.project_id = ?${seg.sql}
        GROUP BY e.identity_id
       HAVING MIN(e.occurred_at) >= ? AND MIN(e.occurred_at) <= ?`,
      [projectId, ...seg.params, input.from, input.to],
    );
  } else {
    const cohortEvent = input.cohortEvent ?? "signup_completed";
    cohortRows = db.all(
      `SELECT e.identity_id, MIN(e.occurred_at) AS cohort_at
         FROM analytics_events e
        WHERE e.project_id = ? AND e.name = ?${seg.sql}
        GROUP BY e.identity_id
       HAVING MIN(e.occurred_at) >= ? AND MIN(e.occurred_at) <= ?`,
      [projectId, cohortEvent, ...seg.params, input.from, input.to],
    );
  }

  if (cohortRows.length === 0) {
    return emptyResult(periods, granularity, basis, input.returnEvent ?? null, tz);
  }

  const cohortOf = new Map<string, { key: string; startDay: string }>();
  const cohortMembers = new Map<string, Set<string>>();
  for (const row of cohortRows) {
    const day = dayKey(row.cohort_at, tz);
    const key = granularity === "day" ? day : granularity === "week" ? weekKey(row.cohort_at, tz) : day.slice(0, 7);
    // The cohort's reference day is the member's own cohort day, so day-N for a
    // weekly cohort is measured from that user's start, not the week's start.
    cohortOf.set(row.identity_id, { key, startDay: day });
    let set = cohortMembers.get(key);
    if (!set) {
      set = new Set();
      cohortMembers.set(key, set);
    }
    set.add(row.identity_id);
  }

  // --- return activity -----------------------------------------------------
  const identityIds = [...cohortOf.keys()];
  const returnPredicate = input.returnEvent ? " AND e.name = ?" : "";
  const returnParams = input.returnEvent ? [input.returnEvent] : [];

  // Chunk the IN list so a large cohort cannot exceed SQLite's variable limit.
  const activity = new Map<string, Set<number>>(); // identity -> set of period indexes
  const CHUNK = 400;
  for (let i = 0; i < identityIds.length; i += CHUNK) {
    const chunk = identityIds.slice(i, i + CHUNK);
    const rows = db.all<{ identity_id: string; occurred_at: number }>(
      `SELECT e.identity_id, e.occurred_at FROM analytics_events e
        WHERE e.project_id = ? AND e.identity_id IN (${chunk.map(() => "?").join(",")})${returnPredicate}${seg.sql}`,
      [projectId, ...chunk, ...returnParams, ...seg.params],
    );
    for (const row of rows) {
      const cohort = cohortOf.get(row.identity_id);
      if (!cohort) continue;
      const elapsed = daysBetween(cohort.startDay, dayKey(row.occurred_at, tz), tz);
      if (elapsed < 0) continue;
      const period = Math.floor(elapsed / periodDays);
      let set = activity.get(row.identity_id);
      if (!set) {
        set = new Set();
        activity.set(row.identity_id, set);
      }
      set.add(period);
    }
  }

  // --- assemble ------------------------------------------------------------
  const cohorts: RetentionCohort[] = [];
  for (const [key, members] of [...cohortMembers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const size = members.size;
    // A cohort's completeness is driven by its latest member's start day: the
    // cell is only complete once every member has had the full period.
    let latestStart = "0000-01-01";
    for (const m of members) {
      const s = cohortOf.get(m)!.startDay;
      if (s > latestStart) latestStart = s;
    }
    const cells: RetentionCell[] = periods.map((period) => {
      let retained = 0;
      for (const m of members) if (activity.get(m)?.has(period)) retained++;
      const periodEndDay = addDays(latestStart, (period + 1) * periodDays - 1, tz);
      const complete = periodEndDay < dayKey(now, tz);
      return {
        period,
        retained,
        rate: size === 0 ? 0 : retained / size,
        interval: wilsonInterval(retained, size),
        complete,
      };
    });
    cohorts.push({ cohort: key, cohortSize: size, cells, smallSample: size < SMALL_COHORT });
  }

  const averageByPeriod = periods.map((period) => {
    let retained = 0;
    let total = 0;
    let counted = 0;
    for (const c of cohorts) {
      const cell = c.cells.find((x) => x.period === period);
      if (!cell || !cell.complete) continue;
      retained += cell.retained;
      total += c.cohortSize;
      counted++;
    }
    return {
      period,
      rate: total === 0 ? null : retained / total,
      cohortsCounted: counted,
      usersCounted: total,
    };
  });

  return {
    cohorts,
    periods,
    granularity,
    basis,
    returnEvent: input.returnEvent ?? null,
    timezone: tz,
    averageByPeriod,
    definition: {
      denominator:
        "Every member of the cohort, fixed when the cohort was assigned. The denominator never shrinks over time.",
      returnDefinition: input.returnEvent
        ? `A user is retained in period N if they fired '${input.returnEvent}' during period N.`
        : "A user is retained in period N if they fired any accepted event during period N.",
      periodBoundaries:
        `Period N covers calendar ${granularity}s N×${periodDays} to (N+1)×${periodDays}-1 after the user's own cohort day, ` +
        `resolved in ${tz}.`,
      incompletePeriods:
        "Cells whose period has not fully elapsed for every cohort member are marked incomplete and excluded from averages.",
    },
  };
}

function defaultPeriods(granularity: Granularity): number[] {
  if (granularity === "day") return [0, 1, 3, 7, 14, 30];
  if (granularity === "week") return [0, 1, 2, 3, 4, 8, 12];
  return [0, 1, 2, 3, 6, 12];
}

function emptyResult(
  periods: number[],
  granularity: "day" | "week" | "month",
  basis: CohortBasis,
  returnEvent: string | null,
  tz: string,
): RetentionResult {
  return {
    cohorts: [],
    periods,
    granularity,
    basis,
    returnEvent,
    timezone: tz,
    averageByPeriod: periods.map((period) => ({ period, rate: null, cohortsCounted: 0, usersCounted: 0 })),
    definition: {
      denominator: "No cohorts matched the selected period.",
      returnDefinition: "",
      periodBoundaries: "",
      incompletePeriods: "",
    },
  };
}

/**
 * Retention curve for a single cohort definition, flattened.
 * Convenience wrapper used by the dashboard and the weekly brief.
 */
export function retentionCurve(result: RetentionResult): Array<{ period: number; rate: number | null }> {
  return result.averageByPeriod.map((p) => ({ period: p.period, rate: p.rate }));
}

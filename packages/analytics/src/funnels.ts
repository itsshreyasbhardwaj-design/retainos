import { type Db, jsonParse } from "@retainos/database";
import { ok, err, domainError, newId, type Result, type DomainError } from "@retainos/shared";
import { wilsonInterval } from "./stats.ts";
import { segmentPredicate, propertyPredicate, type SegmentFilter } from "./segments.ts";

export interface FunnelStep {
  event: string;
  /** Optional property equality conditions this occurrence must satisfy. */
  filter?: Record<string, string | number | boolean>;
  label?: string;
}

export interface FunnelStepResult {
  index: number;
  event: string;
  label: string;
  /** Unique users who reached this step. */
  users: number;
  /** Conversion from the previous step. Null for step 0. */
  stepConversion: number | null;
  /** Conversion from step 0. */
  overallConversion: number;
  droppedFromPrevious: number;
  /** Wilson interval for stepConversion, so small samples read honestly. */
  stepConversionInterval: [number, number] | null;
  /** Median time from the previous step, in milliseconds. */
  medianMsFromPrevious: number | null;
}

export interface FunnelResult {
  steps: FunnelStepResult[];
  entered: number;
  completed: number;
  overallConversion: number;
  /** The step with the largest absolute user loss. Null when nobody entered. */
  largestDropOff: { fromIndex: number; toIndex: number; lostUsers: number; conversionRate: number } | null;
  window: { from: number; to: number };
  conversionWindowHours: number;
  /** Stated in the response so a chart can never be read without its definition. */
  definition: {
    countingMethod: string;
    repeatedEvents: string;
    windowSemantics: string;
  };
  /** Set when the result rests on too few users to interpret. */
  sampleWarning: string | null;
}

export const FUNNEL_DEFINITION = {
  countingMethod:
    "Unique users. A user is counted at most once per step, however many times they fired the event.",
  repeatedEvents:
    "The earliest qualifying occurrence after the previous completed step is used. Earlier or repeated occurrences are ignored.",
  windowSemantics:
    "Every step must occur within the conversion window measured from the user's first step, and in the declared order.",
};

const MIN_INTERPRETABLE_SAMPLE = 30;

/**
 * Compute a funnel.
 *
 * Semantics, chosen deliberately and reported in the result:
 *  - Steps must happen in the declared order. An event that fires before the
 *    previous step does not count for the later step.
 *  - The conversion window is measured from the user's *first* step, not from
 *    the previous step, which is what "convert within 7 days" normally means.
 *  - Ordering is deterministic: events are sorted by timestamp and then by id,
 *    so two events in the same millisecond always resolve the same way.
 */
export function computeFunnel(
  db: Db,
  projectId: string,
  input: {
    steps: FunnelStep[];
    from: number;
    to: number;
    conversionWindowHours?: number;
    segment?: SegmentFilter;
  },
): Result<FunnelResult, DomainError> {
  const steps = input.steps;
  if (steps.length < 2) {
    return err(domainError("validation_failed", "A funnel needs at least two steps."));
  }
  if (steps.length > 12) {
    return err(domainError("validation_failed", "A funnel may have at most 12 steps."));
  }
  if (input.to <= input.from) {
    return err(domainError("validation_failed", "The end of the window must be after its start."));
  }
  const windowHours = input.conversionWindowHours ?? 168;
  if (windowHours <= 0 || windowHours > 24 * 365) {
    return err(domainError("validation_failed", "The conversion window must be between 1 hour and 365 days."));
  }
  const windowMs = windowHours * 3_600_000;

  // Fetch only the events that could possibly matter: those naming a funnel
  // step, inside the window, matching the segment.
  const names = [...new Set(steps.map((s) => s.event))];
  const seg = segmentPredicate(input.segment, "e");
  const rows = db.all<{ identity_id: string; name: string; occurred_at: number; id: string; properties: string }>(
    `SELECT e.identity_id, e.name, e.occurred_at, e.id, e.properties
       FROM analytics_events e
      WHERE e.project_id = ?
        AND e.name IN (${names.map(() => "?").join(",")})
        AND e.occurred_at >= ? AND e.occurred_at <= ?${seg.sql}
      ORDER BY e.identity_id, e.occurred_at ASC, e.id ASC`,
    [projectId, ...names, input.from, input.to, ...seg.params],
  );

  const matches = (row: { name: string; properties: string }, step: FunnelStep): boolean => {
    if (row.name !== step.event) return false;
    if (!step.filter) return true;
    const props = jsonParse<Record<string, unknown>>(row.properties, {});
    for (const [k, v] of Object.entries(step.filter)) {
      if (props[k] !== v) return false;
    }
    return true;
  };

  const stepUsers = new Array(steps.length).fill(0) as number[];
  // Per-step durations from the previous step, for the median.
  const durations: number[][] = steps.map(() => []);

  // Walk each user's timeline once.
  let i = 0;
  while (i < rows.length) {
    const identity = rows[i]!.identity_id;
    const start = i;
    while (i < rows.length && rows[i]!.identity_id === identity) i++;
    const timeline = rows.slice(start, i);

    let cursor = 0;
    let firstStepAt: number | null = null;
    let previousAt: number | null = null;

    for (let s = 0; s < steps.length; s++) {
      const step = steps[s]!;
      let found: number | null = null;
      for (let k = cursor; k < timeline.length; k++) {
        const row = timeline[k]!;
        if (!matches(row, step)) continue;
        if (firstStepAt !== null && row.occurred_at > firstStepAt + windowMs) break; // window closed
        found = row.occurred_at;
        cursor = k + 1;
        break;
      }
      if (found === null) break;
      if (s === 0) firstStepAt = found;
      stepUsers[s]!++;
      if (previousAt !== null) durations[s]!.push(found - previousAt);
      previousAt = found;
    }
  }

  const entered = stepUsers[0]!;
  const completed = stepUsers[steps.length - 1]!;

  const stepResults: FunnelStepResult[] = steps.map((step, index) => {
    const users = stepUsers[index]!;
    const prevUsers = index === 0 ? null : stepUsers[index - 1]!;
    const stepConversion = prevUsers === null ? null : prevUsers === 0 ? 0 : users / prevUsers;
    const sorted = durations[index]!.slice().sort((a, b) => a - b);
    const mid = sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
    return {
      index,
      event: step.event,
      label: step.label ?? step.event,
      users,
      stepConversion,
      // Division by a zero denominator yields 0, never NaN or Infinity.
      overallConversion: entered === 0 ? 0 : users / entered,
      droppedFromPrevious: prevUsers === null ? 0 : prevUsers - users,
      stepConversionInterval: prevUsers && prevUsers > 0 ? wilsonInterval(users, prevUsers) : null,
      medianMsFromPrevious: mid,
    };
  });

  let largestDropOff: FunnelResult["largestDropOff"] = null;
  for (let s = 1; s < stepResults.length; s++) {
    const lost = stepResults[s]!.droppedFromPrevious;
    if (lost > 0 && (largestDropOff === null || lost > largestDropOff.lostUsers)) {
      largestDropOff = {
        fromIndex: s - 1,
        toIndex: s,
        lostUsers: lost,
        conversionRate: stepResults[s]!.stepConversion ?? 0,
      };
    }
  }

  return ok({
    steps: stepResults,
    entered,
    completed,
    overallConversion: entered === 0 ? 0 : completed / entered,
    largestDropOff,
    window: { from: input.from, to: input.to },
    conversionWindowHours: windowHours,
    definition: FUNNEL_DEFINITION,
    sampleWarning:
      entered === 0
        ? "No users entered this funnel in the selected period, so there is nothing to interpret."
        : entered < MIN_INTERPRETABLE_SAMPLE
          ? `Only ${entered} users entered this funnel. Percentages on samples this small move a lot; treat them as directional only.`
          : null,
  });
}

/** Compare the same funnel across two segments, without claiming causation. */
export function compareFunnelSegments(
  db: Db,
  projectId: string,
  input: {
    steps: FunnelStep[];
    from: number;
    to: number;
    conversionWindowHours?: number;
    segments: Array<{ label: string; filter: SegmentFilter }>;
  },
): Result<Array<{ label: string; result: FunnelResult }>, DomainError> {
  const out: Array<{ label: string; result: FunnelResult }> = [];
  for (const s of input.segments) {
    const r = computeFunnel(db, projectId, { ...input, segment: s.filter });
    if (!r.ok) return r;
    out.push({ label: s.label, result: r.value });
  }
  return ok(out);
}

export function saveFunnel(
  db: Db,
  ids: { orgId: string; projectId: string; userId: string },
  input: { name: string; steps: FunnelStep[]; conversionWindowHours?: number },
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  if (input.steps.length < 2) return err(domainError("validation_failed", "A funnel needs at least two steps."));
  const id = newId("fnl");
  db.run(
    `INSERT INTO funnel_definitions (id, org_id, project_id, name, steps, conversion_window_hours, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ids.orgId, ids.projectId, input.name.trim().slice(0, 120), JSON.stringify(input.steps),
     input.conversionWindowHours ?? 168, now, now, ids.userId],
  );
  return ok({ id });
}

export function listFunnels(db: Db, projectId: string) {
  return db.all<{ id: string; name: string; steps: string; conversion_window_hours: number }>(
    "SELECT id, name, steps, conversion_window_hours FROM funnel_definitions WHERE project_id = ? ORDER BY created_at DESC",
    [projectId],
  ).map((r) => ({ ...r, steps: jsonParse<FunnelStep[]>(r.steps, []) }));
}

export function getFunnel(db: Db, projectId: string, funnelId: string) {
  const row = db.get<{ id: string; name: string; steps: string; conversion_window_hours: number }>(
    "SELECT id, name, steps, conversion_window_hours FROM funnel_definitions WHERE id = ? AND project_id = ?",
    [funnelId, projectId],
  );
  return row ? { ...row, steps: jsonParse<FunnelStep[]>(row.steps, []) } : null;
}

export function deleteFunnel(db: Db, projectId: string, funnelId: string): Result<true, DomainError> {
  const r = db.run("DELETE FROM funnel_definitions WHERE id = ? AND project_id = ?", [funnelId, projectId]);
  return r.changes === 0 ? err(domainError("not_found", "Funnel not found.")) : ok(true);
}

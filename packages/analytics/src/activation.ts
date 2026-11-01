import { type Db, jsonParse } from "@retainos/database";
import { dayKey, newId, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";
import { percentile, median, wilsonInterval } from "./stats.ts";
import { segmentPredicate, type SegmentFilter } from "./segments.ts";

export interface ActivationDefinition {
  id: string;
  name: string;
  activationEvent: string;
  propertyFilter: Record<string, string | number | boolean>;
  windowDays: number;
  signupEvent: string;
  isPrimary: boolean;
}

export interface ActivationFunnelResult {
  registrations: number;
  onboardingStarted: number;
  onboardingCompleted: number;
  activated: number;
  activationRate: number;
  activationRateInterval: [number, number];
  /** Of those who activated, how long it took. */
  timeToValue: {
    count: number;
    medianMs: number | null;
    p25Ms: number | null;
    p75Ms: number | null;
    p90Ms: number | null;
    /** Users who signed up long enough ago to have had the full window. */
    eligibleForWindow: number;
  };
  steps: Array<{ label: string; users: number; conversionFromStart: number; droppedFromPrevious: number }>;
  windowDays: number;
  definition: string;
  /**
   * Every caveat that applies, not just the first one. A result can be both
   * small-sample *and* still have open activation windows, and suppressing
   * either would overstate how much the number can be trusted.
   */
  warnings: string[];
}

export const ACTIVATION_DEFINITION_TEXT =
  "Activation is the first occurrence of the configured activation event by a user who signed up in the period, " +
  "within the configured window measured from their own signup. Signup alone is never treated as activation.";

export function listActivationDefinitions(db: Db, projectId: string): ActivationDefinition[] {
  return db.all<{
    id: string; name: string; activation_event: string; property_filter: string;
    window_days: number; signup_event: string; is_primary: number;
  }>(
    "SELECT * FROM activation_definitions WHERE project_id = ? ORDER BY is_primary DESC, name",
    [projectId],
  ).map((r) => ({
    id: r.id,
    name: r.name,
    activationEvent: r.activation_event,
    propertyFilter: jsonParse(r.property_filter, {}),
    windowDays: r.window_days,
    signupEvent: r.signup_event,
    isPrimary: r.is_primary === 1,
  }));
}

export function upsertActivationDefinition(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: {
    id?: string;
    name: string;
    activationEvent: string;
    propertyFilter?: Record<string, string | number | boolean>;
    windowDays: number;
    signupEvent?: string;
    isPrimary?: boolean;
  },
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  if (input.windowDays < 1 || input.windowDays > 365) {
    return err(domainError("validation_failed", "The activation window must be between 1 and 365 days."));
  }
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(input.activationEvent)) {
    return err(domainError("validation_failed", "The activation event must be a lower_snake_case event name."));
  }
  const id = input.id ?? newId("act");
  return db.tx(() => {
    if (input.isPrimary) {
      db.run("UPDATE activation_definitions SET is_primary = 0 WHERE project_id = ?", [ids.projectId]);
    }
    if (input.id) {
      const r = db.run(
        `UPDATE activation_definitions SET name = ?, activation_event = ?, property_filter = ?,
           window_days = ?, signup_event = ?, is_primary = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
        [input.name, input.activationEvent, JSON.stringify(input.propertyFilter ?? {}), input.windowDays,
         input.signupEvent ?? "signup_completed", input.isPrimary ? 1 : 0, now, input.id, ids.projectId],
      );
      if (r.changes === 0) return err(domainError("not_found", "Activation definition not found."));
      return ok({ id });
    }
    db.run(
      `INSERT INTO activation_definitions
        (id, org_id, project_id, name, activation_event, property_filter, window_days, signup_event, is_primary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ids.orgId, ids.projectId, input.name, input.activationEvent,
       JSON.stringify(input.propertyFilter ?? {}), input.windowDays,
       input.signupEvent ?? "signup_completed", input.isPrimary ? 1 : 0, now, now],
    );
    return ok({ id });
  });
}

/**
 * Activation funnel and time to value.
 *
 * Only users who signed up inside the selected period are counted, and the
 * activation window is measured from each user's own signup instant. The
 * `eligibleForWindow` figure is the honest denominator for "how many could
 * possibly have activated by now" — someone who signed up yesterday has not
 * failed a 7-day activation window, they simply have not finished it.
 */
export function activationFunnel(
  db: Db,
  projectId: string,
  input: {
    definition: ActivationDefinition;
    from: number;
    to: number;
    segment?: SegmentFilter;
    now?: number;
  },
): ActivationFunnelResult {
  const def = input.definition;
  const now = input.now ?? Date.now();
  const windowMs = def.windowDays * 86_400_000;
  const seg = segmentPredicate(input.segment, "e");

  const signups = db.all<{ identity_id: string; signup_at: number }>(
    `SELECT e.identity_id, MIN(e.occurred_at) AS signup_at FROM analytics_events e
      WHERE e.project_id = ? AND e.name = ?${seg.sql}
      GROUP BY e.identity_id
     HAVING MIN(e.occurred_at) >= ? AND MIN(e.occurred_at) <= ?`,
    [projectId, def.signupEvent, ...seg.params, input.from, input.to],
  );

  const signupAt = new Map(signups.map((s) => [s.identity_id, s.signup_at]));
  const ids = [...signupAt.keys()];
  const registrations = ids.length;

  /*
   * Earliest qualifying occurrence of `eventName` per signed-up user.
   *
   * One query per event name, bounded to the only window that could matter,
   * then filtered in memory against the signup map. Chunking by `identity_id
   * IN (…)` issues dozens of queries that each re-scan the index; this issues
   * one and walks it once.
   */
  const earliestSignup = Math.min(...signups.map((s) => s.signup_at));
  const latestRelevant = Math.max(...signups.map((s) => s.signup_at)) + windowMs;

  const firstOf = (eventName: string, filter?: Record<string, string | number | boolean>) => {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const hasFilter = filter !== undefined && Object.keys(filter).length > 0;

    const rows = db.all<{ identity_id: string; occurred_at: number; properties: string }>(
      `SELECT e.identity_id, e.occurred_at, e.properties FROM analytics_events e
        WHERE e.project_id = ? AND e.name = ?
          AND e.occurred_at >= ? AND e.occurred_at <= ?
        ORDER BY e.occurred_at ASC, e.id ASC`,
      [projectId, eventName, earliestSignup, latestRelevant],
    );

    for (const row of rows) {
      const su = signupAt.get(row.identity_id);
      // Not one of our signups, or earlier than their own signup.
      if (su === undefined || row.occurred_at < su) continue;
      if (out.has(row.identity_id)) continue;
      if (hasFilter) {
        const props = jsonParse<Record<string, unknown>>(row.properties, {});
        let match = true;
        for (const [k, v] of Object.entries(filter!)) if (props[k] !== v) { match = false; break; }
        if (!match) continue;
      }
      out.set(row.identity_id, row.occurred_at);
    }
    return out;
  };

  const started = firstOf("onboarding_started");
  const completed = firstOf("onboarding_completed");
  const activatedAt = firstOf(def.activationEvent, def.propertyFilter);

  // Activation only counts inside the window from that user's signup.
  const durations: number[] = [];
  let activated = 0;
  for (const [identity, at] of activatedAt) {
    const su = signupAt.get(identity)!;
    if (at - su <= windowMs) {
      activated++;
      durations.push(at - su);
    }
  }
  durations.sort((a, b) => a - b);

  const eligibleForWindow = ids.filter((id) => now - signupAt.get(id)! >= windowMs).length;

  const inWindow = (m: Map<string, number>) => {
    let n = 0;
    for (const [identity, at] of m) if (at - signupAt.get(identity)! <= windowMs) n++;
    return n;
  };
  const onboardingStarted = inWindow(started);
  const onboardingCompleted = inWindow(completed);

  const steps = [
    { label: "Registered", users: registrations },
    { label: "Onboarding started", users: onboardingStarted },
    { label: "Onboarding completed", users: onboardingCompleted },
    { label: `Activated (${def.activationEvent})`, users: activated },
  ].map((s, i, arr) => ({
    label: s.label,
    users: s.users,
    conversionFromStart: registrations === 0 ? 0 : s.users / registrations,
    droppedFromPrevious: i === 0 ? 0 : arr[i - 1]!.users - s.users,
  }));

  return {
    registrations,
    onboardingStarted,
    onboardingCompleted,
    activated,
    activationRate: registrations === 0 ? 0 : activated / registrations,
    activationRateInterval: wilsonInterval(activated, registrations),
    timeToValue: {
      count: durations.length,
      medianMs: median(durations),
      p25Ms: percentile(durations, 0.25),
      p75Ms: percentile(durations, 0.75),
      p90Ms: percentile(durations, 0.9),
      eligibleForWindow,
    },
    steps,
    windowDays: def.windowDays,
    definition: ACTIVATION_DEFINITION_TEXT,
    warnings: buildWarnings(registrations, eligibleForWindow, def.windowDays),
  };
}

function buildWarnings(registrations: number, eligibleForWindow: number, windowDays: number): string[] {
  const warnings: string[] = [];
  if (registrations === 0) {
    warnings.push("No signups in the selected period, so there is nothing to interpret.");
    return warnings;
  }
  if (registrations < 30) {
    warnings.push(`Only ${registrations} signups in this period; the activation rate is directional at best.`);
  }
  if (eligibleForWindow < registrations) {
    const open = registrations - eligibleForWindow;
    warnings.push(
      `${open} of these users signed up less than ${windowDays} days ago, so their activation window is ` +
      "still open. The rate shown will rise as those windows close.",
    );
  }
  return warnings;
}

/** Activation rate broken out by a segment dimension, for comparison. */
export function activationBySegment(
  db: Db,
  projectId: string,
  input: {
    definition: ActivationDefinition;
    from: number;
    to: number;
    dimension: "plan" | "country" | "device_category" | "product_version" | "acquisition_source";
    now?: number;
  },
) {
  const values = db.all<{ value: string }>(
    `SELECT DISTINCT ${input.dimension} AS value FROM analytics_events
      WHERE project_id = ? AND ${input.dimension} IS NOT NULL LIMIT 25`,
    [projectId],
  );
  return values.map((v) => {
    const result = activationFunnel(db, projectId, {
      definition: input.definition,
      from: input.from,
      to: input.to,
      segment: { [input.dimension]: v.value },
      now: input.now,
    });
    return {
      dimension: input.dimension,
      value: v.value,
      registrations: result.registrations,
      activated: result.activated,
      activationRate: result.activationRate,
      interval: result.activationRateInterval,
    };
  }).sort((a, b) => b.registrations - a.registrations);
}

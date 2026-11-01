import type { Db } from "@retainos/database";
import { dayKey, dayRange, addDays, daysBetween, bucketKey, type Granularity } from "@retainos/shared";
import { segmentPredicate, type SegmentFilter } from "./segments.ts";

export interface ActivePoint {
  bucket: string;
  activeUsers: number;
  newUsers: number;
  returningUsers: number;
  eventCount: number;
  /** False when the bucket has not fully elapsed, so a dip is not real. */
  complete: boolean;
}

export interface ActiveSummary {
  points: ActivePoint[];
  granularity: Granularity;
  timezone: string;
  /** Rolling windows, computed over the whole requested range. */
  dau: number | null;
  wau: number | null;
  mau: number | null;
  /** DAU/MAU, a standard stickiness proxy. Null when MAU is zero. */
  stickiness: number | null;
  definition: string;
}

export const ACTIVE_DEFINITION =
  "An active user is an identity with at least one accepted event in the bucket, counted once. " +
  "New means the identity's first-ever event in this project falls in the bucket. Returning means it does not. " +
  "Buckets are calendar periods in the project's reporting timezone.";

/**
 * Active users over time, plus new-versus-returning.
 *
 * The `complete` flag matters more than it looks: an incomplete trailing bucket
 * always shows fewer users, and dashboards that ignore this invent a "drop" at
 * the right-hand edge of every chart.
 */
export function activeUsers(
  db: Db,
  projectId: string,
  input: { from: number; to: number; granularity?: Granularity; timezone: string; segment?: SegmentFilter; now?: number },
): ActiveSummary {
  const granularity = input.granularity ?? "day";
  const tz = input.timezone;
  const now = input.now ?? Date.now();
  const seg = segmentPredicate(input.segment, "e");

  // First-ever event per identity, so "new" is a project-lifetime fact rather
  // than an artefact of the selected window.
  const firstSeen = new Map<string, number>();
  for (const r of db.all<{ identity_id: string; first_at: number }>(
    "SELECT identity_id, MIN(occurred_at) AS first_at FROM analytics_events WHERE project_id = ? GROUP BY identity_id",
    [projectId],
  )) {
    firstSeen.set(r.identity_id, r.first_at);
  }

  const rows = db.all<{ identity_id: string; occurred_at: number }>(
    `SELECT e.identity_id, e.occurred_at FROM analytics_events e
      WHERE e.project_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?${seg.sql}`,
    [projectId, input.from, input.to, ...seg.params],
  );

  const buckets = new Map<string, { active: Set<string>; fresh: Set<string>; events: number }>();
  for (const row of rows) {
    const key = bucketKey(row.occurred_at, granularity, tz);
    let b = buckets.get(key);
    if (!b) {
      b = { active: new Set(), fresh: new Set(), events: 0 };
      buckets.set(key, b);
    }
    b.active.add(row.identity_id);
    b.events++;
    const first = firstSeen.get(row.identity_id);
    if (first !== undefined && bucketKey(first, granularity, tz) === key) b.fresh.add(row.identity_id);
  }

  // Emit a point for every bucket in range, including empty ones: a day with
  // zero activity is information, and omitting it distorts the chart.
  const points: ActivePoint[] = [];
  const seen = new Set<string>();
  for (const day of dayRange(dayKey(input.from, tz), dayKey(input.to, tz), tz)) {
    const key = bucketKey(Date.parse(`${day}T12:00:00Z`), granularity, tz);
    if (seen.has(key)) continue;
    seen.add(key);
    const b = buckets.get(key);
    points.push({
      bucket: key,
      activeUsers: b?.active.size ?? 0,
      newUsers: b?.fresh.size ?? 0,
      returningUsers: (b?.active.size ?? 0) - (b?.fresh.size ?? 0),
      eventCount: b?.events ?? 0,
      complete: bucketIsComplete(key, granularity, tz, now),
    });
  }
  points.sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    points,
    granularity,
    timezone: tz,
    dau: rollingUnique(db, projectId, now, 1, tz, input.segment),
    wau: rollingUnique(db, projectId, now, 7, tz, input.segment),
    mau: rollingUnique(db, projectId, now, 30, tz, input.segment),
    stickiness: null, // filled in below
    definition: ACTIVE_DEFINITION,
  };
}

/** Distinct identities active in the last `days` complete-or-current days. */
export function rollingUnique(
  db: Db,
  projectId: string,
  now: number,
  days: number,
  timezone: string,
  segment?: SegmentFilter,
): number {
  const seg = segmentPredicate(segment, "e");
  const from = Date.parse(`${addDays(dayKey(now, timezone), -(days - 1), timezone)}T00:00:00Z`);
  const row = db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT e.identity_id) AS n FROM analytics_events e
      WHERE e.project_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?${seg.sql}`,
    [projectId, from, now, ...seg.params],
  );
  return row?.n ?? 0;
}

export function withStickiness(summary: ActiveSummary): ActiveSummary {
  return {
    ...summary,
    stickiness: summary.mau && summary.mau > 0 && summary.dau !== null ? summary.dau / summary.mau : null,
  };
}

/** Whether a calendar bucket has fully elapsed at `now`. */
export function bucketIsComplete(key: string, granularity: Granularity, timezone: string, now: number): boolean {
  if (granularity === "day") return key < dayKey(now, timezone);
  if (granularity === "month") return key < dayKey(now, timezone).slice(0, 7);
  // ISO week keys compare correctly as strings within a year; compare against
  // the current week key, which is what "has this week finished" means.
  const current = bucketKey(now, "week", timezone);
  return key < current;
}

export interface EventBreakdown {
  name: string;
  eventCount: number;
  uniqueUsers: number;
  eventsPerUser: number;
}

export function eventBreakdown(
  db: Db,
  projectId: string,
  input: { from: number; to: number; segment?: SegmentFilter; limit?: number },
): EventBreakdown[] {
  const seg = segmentPredicate(input.segment, "e");
  return db.all<{ name: string; event_count: number; unique_users: number }>(
    `SELECT e.name, COUNT(*) AS event_count, COUNT(DISTINCT e.identity_id) AS unique_users
       FROM analytics_events e
      WHERE e.project_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?${seg.sql}
      GROUP BY e.name ORDER BY event_count DESC LIMIT ?`,
    [projectId, input.from, input.to, ...seg.params, Math.min(input.limit ?? 50, 200)],
  ).map((r) => ({
    name: r.name,
    eventCount: r.event_count,
    uniqueUsers: r.unique_users,
    eventsPerUser: r.unique_users === 0 ? 0 : r.event_count / r.unique_users,
  }));
}

/**
 * Users with no activity for longer than the project's inactivity threshold.
 *
 * This reports observed inactivity. It is not a churn prediction, and the UI
 * says so: a quiet fortnight in a monthly-use product means nothing.
 */
export function inactiveUsers(
  db: Db,
  projectId: string,
  input: { thresholdDays: number; now?: number; limit?: number },
) {
  const now = input.now ?? Date.now();
  const cutoff = now - input.thresholdDays * 86_400_000;
  const total = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identities WHERE project_id = ? AND deleted_at IS NULL", [projectId],
  )?.n ?? 0;
  const inactive = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identities WHERE project_id = ? AND deleted_at IS NULL AND last_seen_at < ?",
    [projectId, cutoff],
  )?.n ?? 0;
  const sample = db.all<{ id: string; external_id: string | null; last_seen_at: number; plan: string | null }>(
    `SELECT id, external_id, last_seen_at, plan FROM identities
      WHERE project_id = ? AND deleted_at IS NULL AND last_seen_at < ?
      ORDER BY last_seen_at ASC LIMIT ?`,
    [projectId, cutoff, Math.min(input.limit ?? 100, 500)],
  );
  return {
    thresholdDays: input.thresholdDays,
    totalIdentities: total,
    inactiveIdentities: inactive,
    inactiveShare: total === 0 ? null : inactive / total,
    sample,
    caveat:
      "This is observed inactivity against a threshold you configured. It is not a prediction of cancellation, " +
      "and it says nothing about intent.",
  };
}

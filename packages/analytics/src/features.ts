import type { Db } from "@retainos/database";
import { dayKey, addDays, daysBetween } from "@retainos/shared";
import { wilsonInterval } from "./stats.ts";
import { segmentPredicate, type SegmentFilter } from "./segments.ts";

export interface FeatureAdoption {
  feature: string;
  eventName: string;
  /** Users who used it at least once in the period. */
  discoveredBy: number;
  /** Users whose first-ever use fell in the period. */
  firstTimeUsers: number;
  /** Users who used it on two or more distinct days. */
  repeatUsers: number;
  repeatRate: number | null;
  repeatRateInterval: [number, number] | null;
  totalUses: number;
  usesPerUser: number;
  /** Share of all active users in the period who touched this feature. */
  adoptionRate: number | null;
  /** Of users who used it at least once, how many came back to the product at all later. */
  featureRetention: { cohort: number; returned: number; rate: number | null };
}

/**
 * Feature adoption.
 *
 * `discoveredBy` is users, not events, and `repeatUsers` requires two distinct
 * calendar days rather than two events, because firing the same event twice in
 * one session is not repeat usage. Reporting raw event counts as "adoption" is
 * exactly the vanity metric this avoids.
 */
export function featureAdoption(
  db: Db,
  projectId: string,
  input: {
    features: Array<{ key: string; eventName: string; label?: string }>;
    from: number;
    to: number;
    timezone: string;
    segment?: SegmentFilter;
    now?: number;
  },
): FeatureAdoption[] {
  const tz = input.timezone;
  const seg = segmentPredicate(input.segment, "e");

  const activeInPeriod = db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT e.identity_id) AS n FROM analytics_events e
      WHERE e.project_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?${seg.sql}`,
    [projectId, input.from, input.to, ...seg.params],
  )?.n ?? 0;

  return input.features.map((f) => {
    const rows = db.all<{ identity_id: string; occurred_at: number }>(
      `SELECT e.identity_id, e.occurred_at FROM analytics_events e
        WHERE e.project_id = ? AND e.name = ? AND e.occurred_at >= ? AND e.occurred_at <= ?${seg.sql}`,
      [projectId, f.eventName, input.from, input.to, ...seg.params],
    );

    const daysByUser = new Map<string, Set<string>>();
    for (const r of rows) {
      let set = daysByUser.get(r.identity_id);
      if (!set) {
        set = new Set();
        daysByUser.set(r.identity_id, set);
      }
      set.add(dayKey(r.occurred_at, tz));
    }

    const discoveredBy = daysByUser.size;
    let repeatUsers = 0;
    for (const days of daysByUser.values()) if (days.size >= 2) repeatUsers++;

    // First-ever use, across all time, so "first time" is not an artefact of
    // the selected window.
    const firstEver = db.all<{ identity_id: string; first_at: number }>(
      `SELECT identity_id, MIN(occurred_at) AS first_at FROM analytics_events
        WHERE project_id = ? AND name = ? GROUP BY identity_id`,
      [projectId, f.eventName],
    );
    const firstTimeUsers = firstEver.filter((r) => r.first_at >= input.from && r.first_at <= input.to).length;

    // Feature-specific retention: of the users who first used this feature in
    // the window, how many were active in the product at all afterwards.
    const cohortIds = firstEver
      .filter((r) => r.first_at >= input.from && r.first_at <= input.to)
      .map((r) => ({ id: r.identity_id, at: r.first_at }));
    let returned = 0;
    const CHUNK = 400;
    for (let i = 0; i < cohortIds.length; i += CHUNK) {
      const chunk = cohortIds.slice(i, i + CHUNK);
      if (chunk.length === 0) continue;
      const later = db.all<{ identity_id: string; last_at: number }>(
        `SELECT identity_id, MAX(occurred_at) AS last_at FROM analytics_events
          WHERE project_id = ? AND identity_id IN (${chunk.map(() => "?").join(",")})
          GROUP BY identity_id`,
        [projectId, ...chunk.map((c) => c.id)],
      );
      const lastByIdentity = new Map(later.map((l) => [l.identity_id, l.last_at]));
      for (const c of chunk) {
        const last = lastByIdentity.get(c.id);
        // "Returned" means active on a later calendar day than first use.
        if (last !== undefined && dayKey(last, tz) > dayKey(c.at, tz)) returned++;
      }
    }

    return {
      feature: f.label ?? f.key,
      eventName: f.eventName,
      discoveredBy,
      firstTimeUsers,
      repeatUsers,
      repeatRate: discoveredBy === 0 ? null : repeatUsers / discoveredBy,
      repeatRateInterval: discoveredBy === 0 ? null : wilsonInterval(repeatUsers, discoveredBy),
      totalUses: rows.length,
      usesPerUser: discoveredBy === 0 ? 0 : rows.length / discoveredBy,
      adoptionRate: activeInPeriod === 0 ? null : discoveredBy / activeInPeriod,
      featureRetention: {
        cohort: cohortIds.length,
        returned,
        rate: cohortIds.length === 0 ? null : returned / cohortIds.length,
      },
    };
  });
}

/** Adoption trend for one feature, bucketed by day. */
export function featureTrend(
  db: Db,
  projectId: string,
  input: { eventName: string; from: number; to: number; timezone: string; segment?: SegmentFilter },
) {
  const seg = segmentPredicate(input.segment, "e");
  const rows = db.all<{ identity_id: string; occurred_at: number }>(
    `SELECT e.identity_id, e.occurred_at FROM analytics_events e
      WHERE e.project_id = ? AND e.name = ? AND e.occurred_at >= ? AND e.occurred_at <= ?${seg.sql}`,
    [projectId, input.eventName, input.from, input.to, ...seg.params],
  );
  const byDay = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const d = dayKey(r.occurred_at, input.timezone);
    let s = byDay.get(d);
    if (!s) {
      s = new Set();
      byDay.set(d, s);
    }
    s.add(r.identity_id);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const out: Array<{ day: string; users: number; uses: number }> = [];
  let day = dayKey(input.from, input.timezone);
  const last = dayKey(input.to, input.timezone);
  while (day <= last) {
    out.push({ day, users: byDay.get(day)?.size ?? 0, uses: counts.get(day) ?? 0 });
    day = addDays(day, 1, input.timezone);
  }
  return out;
}

export function trackedFeatures(db: Db, projectId: string) {
  return db.all<{ id: string; key: string; label: string; event_name: string }>(
    "SELECT id, key, label, event_name FROM tracked_features WHERE project_id = ? ORDER BY label",
    [projectId],
  );
}

import type { Db } from "@retainos/database";
import { segmentPredicate, type SegmentFilter } from "./segments.ts";

export interface JourneyPath {
  path: string[];
  users: number;
  share: number;
}

export interface JourneyResult {
  paths: JourneyPath[];
  usersAnalysed: number;
  depth: number;
  caveat: string;
}

export const JOURNEY_CAVEAT =
  "These are the most common observed event sequences. A sequence shows what happened in what order; " +
  "it does not show why, and it is not evidence that one step caused the next.";

/**
 * Most common event paths.
 *
 * Deliberately aggregate-only: RetainOS shows the shapes of journeys, not an
 * individual user's session replay. Consecutive repeats of the same event are
 * collapsed, because "viewed, viewed, viewed" is a polling artefact rather than
 * a journey.
 */
export function commonPaths(
  db: Db,
  projectId: string,
  input: {
    from: number;
    to: number;
    depth?: number;
    startEvent?: string | null;
    segment?: SegmentFilter;
    limit?: number;
  },
): JourneyResult {
  const depth = Math.min(Math.max(input.depth ?? 4, 2), 8);
  const seg = segmentPredicate(input.segment, "e");
  const rows = db.allFast<{ identity_id: string; name: string; occurred_at: number }>(
    `SELECT e.identity_id, e.name, e.occurred_at FROM analytics_events e
      WHERE e.project_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?${seg.sql}
      ORDER BY e.identity_id, e.occurred_at ASC, e.id ASC`,
    [projectId, input.from, input.to, ...seg.params],
  );

  const counts = new Map<string, number>();
  let usersAnalysed = 0;

  let i = 0;
  while (i < rows.length) {
    const identity = rows[i]!.identity_id;
    const start = i;
    while (i < rows.length && rows[i]!.identity_id === identity) i++;
    const timeline = rows.slice(start, i);

    // Collapse consecutive duplicates.
    const sequence: string[] = [];
    for (const row of timeline) {
      if (sequence[sequence.length - 1] !== row.name) sequence.push(row.name);
    }

    let offset = 0;
    if (input.startEvent) {
      offset = sequence.indexOf(input.startEvent);
      if (offset === -1) continue;
    }
    const path = sequence.slice(offset, offset + depth);
    if (path.length < 2) continue;
    usersAnalysed++;
    const key = path.join(" → ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const paths = [...counts.entries()]
    .map(([key, users]) => ({
      path: key.split(" → "),
      users,
      share: usersAnalysed === 0 ? 0 : users / usersAnalysed,
    }))
    .sort((a, b) => b.users - a.users)
    .slice(0, Math.min(input.limit ?? 20, 100));

  return { paths, usersAnalysed, depth, caveat: JOURNEY_CAVEAT };
}

/** What users did immediately after a given event, and how often they stopped there. */
export function nextSteps(
  db: Db,
  projectId: string,
  input: { afterEvent: string; from: number; to: number; segment?: SegmentFilter; limit?: number },
) {
  const seg = segmentPredicate(input.segment, "e");
  const rows = db.all<{ identity_id: string; name: string }>(
    `SELECT e.identity_id, e.name FROM analytics_events e
      WHERE e.project_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?${seg.sql}
      ORDER BY e.identity_id, e.occurred_at ASC, e.id ASC`,
    [projectId, input.from, input.to, ...seg.params],
  );
  const counts = new Map<string, number>();
  let occurrences = 0;
  let endedHere = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.name !== input.afterEvent) continue;
    occurrences++;
    const next = rows[i + 1];
    if (!next || next.identity_id !== rows[i]!.identity_id) {
      endedHere++;
      continue;
    }
    counts.set(next.name, (counts.get(next.name) ?? 0) + 1);
  }
  const steps = [...counts.entries()]
    .map(([name, n]) => ({ event: name, occurrences: n, share: occurrences === 0 ? 0 : n / occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, Math.min(input.limit ?? 10, 50));
  return {
    afterEvent: input.afterEvent,
    occurrences,
    endedHere,
    endedHereShare: occurrences === 0 ? 0 : endedHere / occurrences,
    steps,
    caveat: JOURNEY_CAVEAT,
  };
}

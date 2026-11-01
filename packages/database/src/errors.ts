import { newId, ok, err, domainError, scrubProperties, type Result, type DomainError } from "@retainos/shared";
import type { Db } from "./db.ts";
import type { IngestScope, ProjectScope } from "./scope.ts";

/**
 * Error events.
 *
 * RetainOS stores a grouping fingerprint, a short title and the workflow an
 * error belongs to. It deliberately does **not** store stack traces: they
 * routinely contain file paths, query strings, tokens and user data, and
 * RetainOS is not an error monitor. It needs enough to say "this failure
 * cluster overlaps with that funnel drop-off", and no more.
 */

export interface RawError {
  /** Stable grouping key, supplied by the sender. Never inferred here. */
  fingerprint?: unknown;
  title?: unknown;
  culprit?: unknown;
  level?: unknown;
  timestamp?: unknown;
  workflow?: unknown;
  productVersion?: unknown;
  userId?: unknown;
  anonymousId?: unknown;
  sourceEventId?: unknown;
}

const MAX_TITLE = 300;
const LEVELS = new Set(["warning", "error", "fatal"]);

/**
 * Record an error.
 *
 * Returns `duplicate` rather than an error when the same source event id
 * arrives twice, because providers retry and an error counted twice inflates
 * every reliability figure downstream.
 */
export function recordError(
  db: Db,
  ids: { orgId: string; projectId: string },
  raw: RawError,
  opts: { source?: "sdk" | "sentry" | "import" | "manual"; identityId?: string | null } = {},
  now = Date.now(),
): Result<{ id: string; duplicate: boolean }, DomainError> {
  const fingerprint = typeof raw.fingerprint === "string" ? raw.fingerprint.trim() : "";
  if (!fingerprint || fingerprint.length > 200) {
    return err(domainError("validation_failed",
      "An error needs a stable fingerprint of 1-200 characters. RetainOS will not derive one from the " +
      "message, because guessing would merge unrelated failures."));
  }
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, MAX_TITLE) : "";
  if (!title) return err(domainError("validation_failed", "An error needs a title."));

  // The title is free text from a client. Run it through the same denylist that
  // guards event properties so a token in an error message is not persisted.
  const { dropped } = scrubProperties({ title });
  if (dropped.length > 0) {
    return err(domainError("validation_failed",
      "The error title looks like it contains a credential or personal data, so it was not stored."));
  }

  const level = typeof raw.level === "string" && LEVELS.has(raw.level) ? raw.level : "error";
  const occurredAt = typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : now;
  const source = opts.source ?? "sdk";
  const sourceEventId = typeof raw.sourceEventId === "string" ? raw.sourceEventId : null;

  if (sourceEventId) {
    const existing = db.get<{ id: string }>(
      "SELECT id FROM error_events WHERE project_id = ? AND source = ? AND source_event_id = ?",
      [ids.projectId, source, sourceEventId],
    );
    if (existing) return ok({ id: existing.id, duplicate: true });
  }

  const id = newId("erv");
  db.run(
    `INSERT INTO error_events
      (id, org_id, project_id, fingerprint, title, culprit, level, occurred_at, received_at,
       identity_id, workflow, product_version, source, source_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, ids.orgId, ids.projectId, fingerprint, title,
      typeof raw.culprit === "string" ? raw.culprit.slice(0, 200) : null,
      level, occurredAt, now, opts.identityId ?? null,
      typeof raw.workflow === "string" ? raw.workflow.slice(0, 120) : null,
      typeof raw.productVersion === "string" ? raw.productVersion.slice(0, 60) : null,
      source, sourceEventId,
    ],
  );
  return ok({ id, duplicate: false });
}

export interface ErrorGroup {
  fingerprint: string;
  title: string;
  culprit: string | null;
  level: string;
  occurrences: number;
  affectedUsers: number;
  firstSeen: number;
  lastSeen: number;
  workflow: string | null;
  productVersions: string[];
  sources: string[];
}

/** Errors grouped by fingerprint over a window, newest activity first. */
export function errorGroups(
  db: Db,
  projectId: string,
  from: number,
  to: number,
  limit = 50,
): ErrorGroup[] {
  const rows = db.all<{
    fingerprint: string; title: string; culprit: string | null; level: string;
    occurrences: number; affected_users: number; first_seen: number; last_seen: number;
    workflow: string | null; versions: string | null; sources: string;
  }>(
    `SELECT fingerprint,
            MAX(title) AS title,
            MAX(culprit) AS culprit,
            MAX(level) AS level,
            COUNT(*) AS occurrences,
            COUNT(DISTINCT identity_id) AS affected_users,
            MIN(occurred_at) AS first_seen,
            MAX(occurred_at) AS last_seen,
            MAX(workflow) AS workflow,
            GROUP_CONCAT(DISTINCT product_version) AS versions,
            GROUP_CONCAT(DISTINCT source) AS sources
       FROM error_events
      WHERE project_id = ? AND occurred_at >= ? AND occurred_at <= ?
      GROUP BY fingerprint
      ORDER BY occurrences DESC
      LIMIT ?`,
    [projectId, from, to, Math.min(limit, 200)],
  );
  return rows.map((r) => ({
    fingerprint: r.fingerprint,
    title: r.title,
    culprit: r.culprit,
    level: r.level,
    occurrences: r.occurrences,
    affectedUsers: r.affected_users,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    workflow: r.workflow,
    productVersions: (r.versions ?? "").split(",").filter(Boolean),
    sources: (r.sources ?? "").split(",").filter(Boolean),
  }));
}

/** Distinct identities touched by one error fingerprint. */
export function identitiesForFingerprint(
  db: Db, projectId: string, fingerprint: string, from: number, to: number,
): string[] {
  return db.all<{ identity_id: string }>(
    `SELECT DISTINCT identity_id FROM error_events
      WHERE project_id = ? AND fingerprint = ? AND identity_id IS NOT NULL
        AND occurred_at >= ? AND occurred_at <= ?`,
    [projectId, fingerprint, from, to],
  ).map((r) => r.identity_id);
}

/**
 * Compare an error fingerprint's volume across two windows.
 * Used by the alert engine and by regression detection after a release.
 */
export function errorTrend(
  db: Db,
  projectId: string,
  fingerprint: string,
  current: { from: number; to: number },
  prior: { from: number; to: number },
): { current: number; prior: number; change: number | null } {
  const count = (w: { from: number; to: number }) =>
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM error_events WHERE project_id = ? AND fingerprint = ? AND occurred_at >= ? AND occurred_at <= ?",
      [projectId, fingerprint, w.from, w.to],
    )?.n ?? 0;
  const c = count(current);
  const p = count(prior);
  return { current: c, prior: p, change: p === 0 ? null : (c - p) / p };
}

export function recentErrors(db: Db, projectId: string, limit = 50) {
  return db.all(
    `SELECT id, fingerprint, title, level, occurred_at, workflow, product_version, source
       FROM error_events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT ?`,
    [projectId, Math.min(limit, 200)],
  );
}

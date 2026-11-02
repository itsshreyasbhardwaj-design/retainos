import {
  newId, hashSecret, ok, err, domainError, EVENT_NAME_RE, MAX_EVENT_NAME_LENGTH,
  validateProperties, scrubProperties, deviceCategory, dayKey,
  type Result, type DomainError,
} from "@retainos/shared";
import type { Db } from "./db.ts";
import { jsonParse } from "./db.ts";
import type { IngestScope } from "./scope.ts";
import { getEventSpec } from "./schemas.ts";
import { upsertAccount } from "./accounts-b2b.ts";
import { consumeUsage, checkTrackedUsers } from "./entitlements.ts";
import { RateLimiter } from "./ratelimit.ts";

export const MAX_EVENT_BYTES = Number(process.env.RETAINOS_MAX_EVENT_BYTES ?? 16_384);
export const MAX_BATCH_EVENTS = Number(process.env.RETAINOS_MAX_BATCH_EVENTS ?? 100);
export const MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Shared limiter instance for the process. Keyed by project. */
export const ingestLimiter = new RateLimiter(Number(process.env.RETAINOS_INGEST_RATE_PER_MIN ?? 600), 60_000);

export interface RawEvent {
  name?: unknown;
  /** Client event time, epoch millis. Falls back to receipt time if absent. */
  timestamp?: unknown;
  /** Client-generated unique id. Enables exactly-once ingestion across retries. */
  eventId?: unknown;
  anonymousId?: unknown;
  userId?: unknown;
  properties?: unknown;
  /** Consent flag asserted by the SDK for this event. */
  consent?: unknown;
  releaseId?: unknown;
}

export interface IngestRequest {
  events: RawEvent[];
  sdk?: { name?: string; version?: string };
  idempotencyKey?: string;
  origin?: string | null;
  userAgent?: string | null;
  /** Coarse country, from an edge header. Never a precise location. */
  country?: string | null;
}

export type RejectionReason =
  | "invalid_event_name"
  | "missing_event_name"
  | "event_too_large"
  | "schema_validation_failed"
  | "consent_not_granted"
  | "no_identity"
  | "duplicate_event"
  | "timestamp_out_of_range"
  | "event_quota_exceeded"
  | "tracked_user_limit_reached"
  | "deprecated_event"
  | "sensitive_properties_removed";

export interface EventOutcome {
  index: number;
  status: "accepted" | "rejected" | "duplicate";
  eventId?: string;
  reason?: RejectionReason;
  detail?: Record<string, unknown>;
  /** Non-fatal notes, e.g. sensitive properties that were stripped. */
  warnings?: string[];
}

export interface IngestResult {
  batchId: string | null;
  accepted: number;
  rejected: number;
  duplicates: number;
  outcomes: EventOutcome[];
  /** True when a prior batch with the same idempotency key was replayed. */
  replayed: boolean;
  quota?: { used: number; limit: number; remaining: number };
}

/** Clock-skew tolerance. Events outside this window are rejected, not silently moved. */
const MAX_FUTURE_MS = 60 * 60_000; // 1 hour ahead
const MAX_PAST_MS = 30 * 86_400_000; // 30 days behind

/** Authenticate a public write key. Write-only, project-scoped, not a secret. */
export function authenticateWriteKey(db: Db, publicKey: string): Result<IngestScope, DomainError> {
  const row = db.get<{
    id: string; org_id: string; project_id: string; revoked_at: number | null;
    reporting_timezone: string; require_consent: number; strict_schema: number;
    allowed_origins: string; archived_at: number | null;
  }>(
    `SELECT k.id, k.org_id, k.project_id, k.revoked_at,
            p.reporting_timezone, p.require_consent, p.strict_schema, p.allowed_origins, p.archived_at
       FROM project_keys k JOIN projects p ON p.id = k.project_id
      WHERE k.public_key = ? AND k.kind = 'public_write'`,
    [publicKey],
  );
  if (!row || row.revoked_at !== null || row.archived_at !== null) {
    return err(domainError("unauthenticated", "Unknown or revoked project key."));
  }
  return ok({
    orgId: row.org_id,
    projectId: row.project_id,
    keyId: row.id,
    timezone: row.reporting_timezone,
    requireConsent: row.require_consent === 1,
    strictSchema: row.strict_schema === 1,
    allowedOrigins: jsonParse<string[]>(row.allowed_origins, []),
  });
}

/** Authenticate a private admin key by hash. Grants read access to one project. */
export function authenticateSecretKey(
  db: Db,
  secret: string,
  now = Date.now(),
): Result<{ orgId: string; projectId: string; keyId: string }, DomainError> {
  const row = db.get<{ id: string; org_id: string; project_id: string; revoked_at: number | null }>(
    "SELECT id, org_id, project_id, revoked_at FROM project_keys WHERE secret_hash = ? AND kind = 'secret_admin'",
    [hashSecret(secret)],
  );
  if (!row || row.revoked_at !== null) return err(domainError("unauthenticated", "Unknown or revoked API key."));
  db.run("UPDATE project_keys SET last_used_at = ? WHERE id = ?", [now, row.id]);
  return ok({ orgId: row.org_id, projectId: row.project_id, keyId: row.id });
}

/**
 * Origin policy.
 *
 * CORS is a browser convenience, not a security boundary: anyone can post from
 * curl with the public key. The origin allowlist is therefore defence in depth
 * against casual key reuse, and is enforced server-side when configured.
 */
export function originAllowed(scope: IngestScope, origin: string | null | undefined): boolean {
  if (scope.allowedOrigins.length === 0) return true; // not configured: allow
  if (!origin) return false;
  return scope.allowedOrigins.some((allowed) => {
    if (allowed === "*") return true;
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1); // ".example.com"
      try {
        const host = new URL(origin).host;
        return host.endsWith(suffix.slice(1)) || host === suffix.slice(2);
      } catch {
        return false;
      }
    }
    return allowed === origin;
  });
}

/**
 * Identity resolution.
 *
 * Rules:
 *  - An anonymous id is claimed by an external id only on an explicit
 *    identify() call, recorded in identity_links.
 *  - An anonymous id already claimed by a different external id is never
 *    re-pointed: that would merge two real people on a shared device.
 *  - Two identified users are never merged. There is no fingerprinting path.
 */
export function resolveIdentity(
  db: Db,
  scope: IngestScope,
  input: {
    anonymousId?: string | null;
    externalId?: string | null;
    accountKey?: string | null;
    dims?: Record<string, string | null>;
  },
  now = Date.now(),
): string | null {
  const anon = input.anonymousId?.trim() || null;
  const ext = input.externalId?.trim() || null;
  if (!anon && !ext) return null;

  const touch = (id: string) => {
    const d = input.dims ?? {};
    db.run(
      `UPDATE identities SET last_seen_at = ?,
          plan = COALESCE(?, plan), country = COALESCE(?, country),
          device_category = COALESCE(?, device_category),
          acquisition_source = COALESCE(?, acquisition_source),
          product_version = COALESCE(?, product_version),
          account_key = COALESCE(?, account_key)
        WHERE id = ?`,
      [now, d.plan ?? null, d.country ?? null, d.device_category ?? null,
       d.acquisition_source ?? null, d.product_version ?? null, input.accountKey ?? null, id],
    );
    if (input.accountKey) upsertAccount(db, { orgId: scope.orgId, projectId: scope.projectId }, input.accountKey, now);
  };

  if (ext) {
    const existing = db.get<{ id: string }>(
      "SELECT id FROM identities WHERE project_id = ? AND external_id = ?",
      [scope.projectId, ext],
    );
    if (existing) {
      touch(existing.id);
      return existing.id;
    }
    if (anon) {
      // Promote an unclaimed anonymous identity so its history is preserved.
      const unclaimed = db.get<{ id: string }>(
        "SELECT id FROM identities WHERE project_id = ? AND anonymous_id = ? AND external_id IS NULL",
        [scope.projectId, anon],
      );
      if (unclaimed) {
        db.run("UPDATE identities SET external_id = ?, identified_at = ?, last_seen_at = ? WHERE id = ?", [
          ext, now, now, unclaimed.id,
        ]);
        db.run(
          `INSERT INTO identity_links (id, org_id, project_id, identity_id, anonymous_id, external_id, linked_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'explicit_identify')`,
          [newId("lnk"), scope.orgId, scope.projectId, unclaimed.id, anon, ext, now],
        );
        touch(unclaimed.id);
        return unclaimed.id;
      }
    }
    // A new person counts against the month's tracked-user allowance. People
    // already being tracked are never cut off; only new ones wait.
    if (!checkTrackedUsers(db, scope.orgId, now).canTrackNew) return null;
    // New identified user. The anonymous id is intentionally left off when it
    // already belongs to someone else, rather than stolen from them.
    const anonFree = anon
      ? !db.get("SELECT 1 FROM identities WHERE project_id = ? AND anonymous_id = ?", [scope.projectId, anon])
      : false;
    const id = newId("idn");
    const d = input.dims ?? {};
    db.run(
      `INSERT INTO identities
        (id, org_id, project_id, anonymous_id, external_id, first_seen_at, last_seen_at, identified_at,
         plan, country, device_category, acquisition_source, product_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, scope.orgId, scope.projectId, anonFree ? anon : null, ext, now, now, now,
       d.plan ?? null, d.country ?? null, d.device_category ?? null, d.acquisition_source ?? null, d.product_version ?? null],
    );
    if (anonFree && anon) {
      db.run(
        `INSERT INTO identity_links (id, org_id, project_id, identity_id, anonymous_id, external_id, linked_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'explicit_identify')`,
        [newId("lnk"), scope.orgId, scope.projectId, id, anon, ext, now],
      );
    }
    return id;
  }

  // Anonymous-only path.
  const existing = db.get<{ id: string }>(
    "SELECT id FROM identities WHERE project_id = ? AND anonymous_id = ?",
    [scope.projectId, anon],
  );
  if (existing) {
    touch(existing.id);
    return existing.id;
  }
  if (!checkTrackedUsers(db, scope.orgId, now).canTrackNew) return null;
  const id = newId("idn");
  const d = input.dims ?? {};
  db.run(
    `INSERT INTO identities
      (id, org_id, project_id, anonymous_id, first_seen_at, last_seen_at,
       plan, country, device_category, acquisition_source, product_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, scope.orgId, scope.projectId, anon, now, now,
     d.plan ?? null, d.country ?? null, d.device_category ?? null, d.acquisition_source ?? null, d.product_version ?? null],
  );
  return id;
}

function recordRejection(
  db: Db,
  scope: IngestScope,
  eventName: string | null,
  reason: RejectionReason,
  detail: Record<string, unknown>,
  now: number,
): void {
  db.run(
    `INSERT INTO event_rejections (id, org_id, project_id, received_at, event_name, reason, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId("rej"), scope.orgId, scope.projectId, now, eventName, reason, JSON.stringify(detail)],
  );
}

/**
 * Ingest a batch.
 *
 * Every event is judged independently: one malformed event in a batch of fifty
 * does not discard the other forty-nine, and the caller is told exactly which
 * index failed and why. That is what makes the event inspector useful.
 */
export function ingestBatch(
  db: Db,
  scope: IngestScope,
  request: IngestRequest,
  now = Date.now(),
): Result<IngestResult, DomainError> {
  if (!Array.isArray(request.events)) {
    return err(domainError("validation_failed", "`events` must be an array."));
  }
  if (request.events.length === 0) {
    return err(domainError("validation_failed", "`events` must contain at least one event."));
  }
  if (request.events.length > MAX_BATCH_EVENTS) {
    return err(
      domainError("payload_too_large", `A batch may contain at most ${MAX_BATCH_EVENTS} events.`, {
        received: request.events.length, limit: MAX_BATCH_EVENTS,
      }),
    );
  }
  if (!originAllowed(scope, request.origin)) {
    recordRejection(db, scope, null, "no_identity", { origin: request.origin ?? null }, now);
    return err(domainError("forbidden", "This origin is not allowed to send events for this project."));
  }

  // Batch-level idempotency: a replayed batch returns the original outcome
  // rather than double-counting events.
  if (request.idempotencyKey) {
    const prior = db.get<{ id: string; accepted_count: number; rejected_count: number; event_count: number }>(
      "SELECT id, accepted_count, rejected_count, event_count FROM ingest_batches WHERE project_id = ? AND idempotency_key = ?",
      [scope.projectId, request.idempotencyKey],
    );
    if (prior) {
      return ok({
        batchId: prior.id,
        accepted: prior.accepted_count,
        rejected: prior.rejected_count,
        duplicates: prior.event_count - prior.accepted_count - prior.rejected_count,
        outcomes: [],
        replayed: true,
      });
    }
  }

  const rate = ingestLimiter.check(scope.projectId, request.events.length, now);
  if (!rate.allowed) {
    return err(
      domainError("rate_limited", "Ingestion rate limit exceeded for this project.", {
        resetAt: rate.resetAt, remaining: rate.remaining,
      }),
    );
  }

  const device = deviceCategory(request.userAgent);
  const country = request.country?.slice(0, 2).toUpperCase() || null;

  return db.tx(() => {
    const batchId = newId("bat");
    // The batch row is inserted first because analytics_events.batch_id
    // references it; the counts are filled in once every event is judged.
    db.run(
      `INSERT INTO ingest_batches
        (id, org_id, project_id, idempotency_key, received_at, event_count, accepted_count, rejected_count, sdk_name, sdk_version)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [
        batchId, scope.orgId, scope.projectId, request.idempotencyKey ?? null, now,
        request.events.length, request.sdk?.name ?? null, request.sdk?.version ?? null,
      ],
    );
    const outcomes: EventOutcome[] = [];
    let accepted = 0;
    let rejected = 0;
    let duplicates = 0;

    // Reserve monthly event quota up front, then accept only what fits.
    const quota = consumeUsage(db, scope.orgId, "events_ingested", request.events.length, now);
    let quotaBudget = quota.allowed;

    for (let i = 0; i < request.events.length; i++) {
      const raw = request.events[i]!;
      const warnings: string[] = [];

      const reject = (reason: RejectionReason, detail: Record<string, unknown> = {}) => {
        rejected++;
        recordRejection(db, scope, typeof raw.name === "string" ? raw.name : null, reason, detail, now);
        outcomes.push({ index: i, status: "rejected", reason, detail });
      };

      if (typeof raw.name !== "string" || raw.name.length === 0) {
        reject("missing_event_name");
        continue;
      }
      const name = raw.name;
      if (name.length > MAX_EVENT_NAME_LENGTH || !EVENT_NAME_RE.test(name)) {
        reject("invalid_event_name", { name, expected: "lower_snake_case" });
        continue;
      }

      const size = Buffer.byteLength(JSON.stringify(raw), "utf8");
      if (size > MAX_EVENT_BYTES) {
        reject("event_too_large", { bytes: size, limit: MAX_EVENT_BYTES });
        continue;
      }

      // Consent. When the project requires it, an event without an explicit
      // grant is rejected: absence of a signal is not consent.
      if (scope.requireConsent && raw.consent !== true) {
        reject("consent_not_granted", {});
        continue;
      }

      const occurredAt = typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : now;
      if (occurredAt > now + MAX_FUTURE_MS || occurredAt < now - MAX_PAST_MS) {
        // Out-of-range client clocks are rejected rather than clamped, because
        // silently moving an event corrupts every time-bucketed metric.
        reject("timestamp_out_of_range", { occurredAt, now });
        continue;
      }

      const rawProps = (raw.properties && typeof raw.properties === "object" && !Array.isArray(raw.properties)
        ? raw.properties
        : {}) as Record<string, unknown>;

      const { clean, dropped } = scrubProperties(rawProps);
      if (dropped.length > 0) {
        warnings.push(`Removed ${dropped.length} sensitive propert${dropped.length === 1 ? "y" : "ies"}: ${dropped.map((d) => d.key).join(", ")}`);
        recordRejection(db, scope, name, "sensitive_properties_removed", { keys: dropped.map((d) => d.key) }, now);
      }

      const spec = getEventSpec(db, scope.projectId, name);
      if (!spec && scope.strictSchema) {
        reject("schema_validation_failed", { problem: "event is not registered and this project uses a strict schema" });
        continue;
      }
      if (spec?.deprecated) warnings.push(`Event '${name}' is marked deprecated in the schema registry.`);

      const validated = validateProperties(clean, spec);
      if (!validated.ok) {
        reject("schema_validation_failed", validated.error.detail ?? {});
        continue;
      }
      const props = validated.value;

      // The B2B account key comes from an explicit property. RetainOS never
      // infers it from an email domain or any other signal.
      const accountKey = typeof props.account_key === "string" && props.account_key.length <= 200
        ? props.account_key
        : null;

      const identityId = resolveIdentity(db, scope, {
        anonymousId: typeof raw.anonymousId === "string" ? raw.anonymousId : null,
        externalId: typeof raw.userId === "string" ? raw.userId : null,
        accountKey,
        dims: {
          plan: typeof props.plan === "string" ? props.plan : null,
          country,
          device_category: device === "unknown" ? null : device,
          acquisition_source: typeof props.acquisition_source === "string" ? props.acquisition_source : null,
          product_version: typeof props.product_version === "string" ? props.product_version : null,
        },
      }, now);
      if (!identityId) {
        // Two different failures look the same here, and telling them apart
        // is the difference between "fix your SDK call" and "your plan is
        // full". A developer staring at the inspector needs to know which.
        const hadIdentifiers =
          (typeof raw.anonymousId === "string" && raw.anonymousId.trim() !== "")
          || (typeof raw.userId === "string" && raw.userId.trim() !== "");
        if (hadIdentifiers) {
          const tracked = checkTrackedUsers(db, scope.orgId, now);
          reject("tracked_user_limit_reached", {
            problem: tracked.detail, used: tracked.used, limit: tracked.limit,
          });
        } else {
          reject("no_identity", { problem: "every event needs an anonymousId or a userId" });
        }
        continue;
      }

      if (quotaBudget <= 0) {
        reject("event_quota_exceeded", { limit: quota.limit, used: quota.used });
        continue;
      }

      const clientEventId = typeof raw.eventId === "string" && raw.eventId.length > 0 ? raw.eventId : null;
      if (clientEventId) {
        const dup = db.get<{ id: string }>(
          "SELECT id FROM analytics_events WHERE project_id = ? AND client_event_id = ?",
          [scope.projectId, clientEventId],
        );
        if (dup) {
          duplicates++;
          outcomes.push({ index: i, status: "duplicate", eventId: dup.id, reason: "duplicate_event" });
          continue;
        }
      }

      const id = newId("evt");
      db.run(
        `INSERT INTO analytics_events
          (id, org_id, project_id, identity_id, name, occurred_at, received_at, client_event_id, batch_id,
           plan, country, device_category, product_version, acquisition_source, release_id, properties)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, scope.orgId, scope.projectId, identityId, name, occurredAt, now, clientEventId, batchId,
          typeof props.plan === "string" ? props.plan : null,
          country,
          device === "unknown" ? null : device,
          typeof props.product_version === "string" ? props.product_version : null,
          typeof props.acquisition_source === "string" ? props.acquisition_source : null,
          typeof raw.releaseId === "string" ? raw.releaseId : null,
          JSON.stringify(props),
        ],
      );
      quotaBudget--;
      accepted++;
      outcomes.push(warnings.length > 0 ? { index: i, status: "accepted", eventId: id, warnings } : { index: i, status: "accepted", eventId: id });

      // Mark the affected day dirty so the worker recomputes only what changed.
      enqueueJob(db, {
        orgId: scope.orgId,
        projectId: scope.projectId,
        kind: "recompute_day",
        payload: { dayKey: dayKey(occurredAt, scope.timezone) },
        dedupeKey: `recompute_day:${scope.projectId}:${dayKey(occurredAt, scope.timezone)}`,
      }, now);
    }

    db.run(
      "UPDATE ingest_batches SET accepted_count = ?, rejected_count = ? WHERE id = ?",
      [accepted, rejected, batchId],
    );
    db.run("UPDATE project_keys SET last_used_at = ? WHERE id = ?", [now, scope.keyId]);

    return ok({
      batchId, accepted, rejected, duplicates, outcomes, replayed: false,
      quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining },
    });
  });
}

export interface JobInput {
  orgId: string | null;
  projectId: string | null;
  kind: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  runAfter?: number;
}

/**
 * Enqueue idempotently: a pending or running job with the same dedupe key is
 * reused rather than duplicated.
 *
 * `created` is part of the return value because callers need to distinguish
 * "I queued work" from "that work was already queued" — a scheduler that
 * cannot tell the difference reports phantom activity every time it runs.
 */
export function enqueueJob(db: Db, input: JobInput, now = Date.now()): { id: string; created: boolean } {
  if (input.dedupeKey) {
    const existing = db.get<{ id: string }>(
      "SELECT id FROM aggregation_jobs WHERE dedupe_key = ? AND status IN ('pending','running')",
      [input.dedupeKey],
    );
    if (existing) return { id: existing.id, created: false };
  }
  const id = newId("job");
  db.run(
    `INSERT INTO aggregation_jobs (id, org_id, project_id, kind, payload, dedupe_key, created_at, run_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.orgId, input.projectId, input.kind, JSON.stringify(input.payload ?? {}),
     input.dedupeKey ?? null, now, input.runAfter ?? now],
  );
  return { id, created: true };
}

/** Recent events for the live inspector. Read path for a project-scoped reader. */
export function recentEvents(db: Db, projectId: string, limit = 50) {
  return db.all(
    `SELECT e.id, e.name, e.occurred_at, e.received_at, e.properties, e.plan, e.device_category,
            i.external_id, i.anonymous_id
       FROM analytics_events e JOIN identities i ON i.id = e.identity_id
      WHERE e.project_id = ? ORDER BY e.received_at DESC, e.occurred_at DESC LIMIT ?`,
    [projectId, Math.min(limit, 200)],
  );
}

export function recentRejections(db: Db, projectId: string, limit = 50) {
  return db.all(
    "SELECT id, received_at, event_name, reason, detail FROM event_rejections WHERE project_id = ? ORDER BY received_at DESC LIMIT ?",
    [projectId, Math.min(limit, 200)],
  );
}

export function ingestHealth(db: Db, projectId: string, sinceMs: number) {
  const accepted = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ? AND received_at >= ?",
    [projectId, sinceMs],
  )?.n ?? 0;
  const rejections = db.all<{ reason: string; n: number }>(
    "SELECT reason, COUNT(*) AS n FROM event_rejections WHERE project_id = ? AND received_at >= ? GROUP BY reason",
    [projectId, sinceMs],
  );
  const rejected = rejections.reduce((s, r) => s + r.n, 0);
  return {
    accepted,
    rejected,
    byReason: rejections,
    acceptanceRate: accepted + rejected === 0 ? null : accepted / (accepted + rejected),
  };
}

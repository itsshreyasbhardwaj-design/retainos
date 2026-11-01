import { type Db } from "@retainos/database";
import { newId, ok, err, domainError, scrubProperties, EVENT_NAME_RE,
         type Result, type DomainError } from "@retainos/shared";

/**
 * Provider integrations, with provenance.
 *
 * The premise is that most teams who would get value from RetainOS already
 * have PostHog or Amplitude, already have Sentry, and are not going to rip any
 * of it out to try something new. Demanding migration is how a good product
 * never gets used. So RetainOS reads from what is already there.
 *
 * Which creates the problem this module exists to solve: the same action can
 * now arrive twice, once from the SDK and once from PostHog, and a number
 * built by adding them is wrong in a way nobody notices. Three rules:
 *
 *  - Every record carries the system it came from, on the row.
 *  - One source is authoritative per domain and entity; a record from any
 *    other source for the same thing is refused at import, counted, and the
 *    reason recorded. Deduplication at the door beats reconciliation later.
 *  - A connection is "connected" only after a probe has actually succeeded.
 *    RetainOS never shows a live integration it has not verified.
 */

export type Provider =
  | "posthog" | "amplitude" | "sentry" | "csv" | "github" | "razorpay" | "stripe" | "revenuecat";

export type ConnectionStatus = "disconnected" | "connected" | "error" | "revoked";

export interface ProviderCapability {
  label: string;
  /** What RetainOS can read from it. */
  reads: string[];
  /** What it cannot do, said plainly so nobody expects it. */
  cannot: string[];
  /** Whether using it costs the user money at the provider. */
  freeTierSufficient: boolean;
  /** Named environment variables holding credentials. Never values. */
  credentialEnvVars: string[];
}

export const PROVIDER_CAPABILITIES: Record<Provider, ProviderCapability> = {
  posthog: {
    label: "PostHog",
    reads: ["events", "person properties"],
    cannot: [
      "Write anything back to PostHog.",
      "Read session recordings, which RetainOS does not store or want.",
    ],
    freeTierSufficient: true,
    credentialEnvVars: ["RETAINOS_POSTHOG_API_KEY"],
  },
  amplitude: {
    label: "Amplitude",
    reads: ["events", "user properties"],
    cannot: ["Write back.", "Read cohorts, which are definitions rather than data."],
    freeTierSufficient: true,
    credentialEnvVars: ["RETAINOS_AMPLITUDE_API_KEY", "RETAINOS_AMPLITUDE_SECRET_KEY"],
  },
  sentry: {
    label: "Sentry",
    reads: ["error groups", "occurrence counts", "affected user ids"],
    cannot: [
      "Read stack traces. RetainOS stores none, because they routinely contain file paths, " +
      "query strings and user data.",
    ],
    freeTierSufficient: true,
    credentialEnvVars: ["RETAINOS_SENTRY_TOKEN"],
  },
  csv: {
    label: "CSV import",
    reads: ["events", "subscriptions", "feedback"],
    cannot: ["Run on a schedule. A CSV is a one-off by nature."],
    freeTierSufficient: true,
    credentialEnvVars: [],
  },
  github: {
    label: "GitHub",
    reads: ["releases", "tags", "pull request titles"],
    cannot: [
      "Push commits, open pull requests, or change a repository in any way. RetainOS reads releases " +
      "so it can line a metric change up against a deploy.",
    ],
    freeTierSufficient: true,
    credentialEnvVars: ["RETAINOS_GITHUB_TOKEN"],
  },
  razorpay: {
    label: "Razorpay",
    reads: ["subscriptions", "payment outcomes"],
    cannot: ["Take payments, issue refunds, or retry a charge.", "Read card details, which it never receives."],
    freeTierSufficient: true,
    credentialEnvVars: ["RETAINOS_RAZORPAY_KEY_ID", "RETAINOS_RAZORPAY_KEY_SECRET"],
  },
  stripe: {
    label: "Stripe",
    reads: ["subscriptions", "invoices", "payment outcomes"],
    cannot: ["Take payments, issue refunds, or retry a charge.", "Read card details."],
    freeTierSufficient: true,
    credentialEnvVars: ["RETAINOS_STRIPE_SECRET_KEY"],
  },
  revenuecat: {
    label: "RevenueCat",
    reads: ["subscriptions", "entitlements"],
    cannot: ["Write entitlements."],
    freeTierSufficient: true,
    credentialEnvVars: ["RETAINOS_REVENUECAT_KEY"],
  },
};

/** Config keys that look like credentials. Storing one is a bug, so it is refused. */
const SECRET_LOOKING_KEYS = [
  "key", "secret", "token", "password", "passwd", "credential", "auth", "bearer", "cookie",
];

export function secretLookingKeysIn(config: Record<string, unknown>): string[] {
  return Object.keys(config).filter((k) => {
    const lower = k.toLowerCase();
    // "keyName" and "envVar" are fine; the check is for a key that would hold
    // the value itself.
    if (lower.endsWith("envvar") || lower.endsWith("env_var") || lower.endsWith("name")) return false;
    return SECRET_LOOKING_KEYS.some((s) => lower.includes(s));
  });
}

export interface Connection {
  id: string;
  provider: Provider;
  config: Record<string, unknown>;
  status: ConnectionStatus;
  grantedScopes: string[];
  lastSyncAt: number | null;
  lastError: string | null;
  /** What the UI should say about this connection, in one sentence. */
  statusLine: string;
}

/**
 * Register a connection.
 *
 * It starts disconnected, always. A row in this table is a stated intention,
 * not a working integration, and conflating the two is how a dashboard ends up
 * claiming a live feed that has never returned a byte.
 */
export function connectProvider(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: { provider: Provider; config?: Record<string, unknown>; grantedScopes?: string[] },
  now = Date.now(),
): Result<{ id: string; status: ConnectionStatus }, DomainError> {
  if (!(input.provider in PROVIDER_CAPABILITIES)) {
    return err(domainError("validation_failed", `Unknown provider "${input.provider}".`));
  }
  const config = input.config ?? {};
  const secrets = secretLookingKeysIn(config);
  if (secrets.length > 0) {
    return err(domainError(
      "validation_failed",
      `Credentials are never stored in the database. Remove ${secrets.map((s) => `"${s}"`).join(", ")} ` +
      `and set the credential in the environment instead (` +
      `${PROVIDER_CAPABILITIES[input.provider].credentialEnvVars.join(", ") || "no variables needed"}).`,
    ));
  }

  const existing = db.get<{ id: string }>(
    "SELECT id FROM provider_connections WHERE project_id = ? AND provider = ?",
    [ids.projectId, input.provider],
  );
  if (existing) {
    db.run(
      `UPDATE provider_connections SET config = ?, granted_scopes = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(config), JSON.stringify(input.grantedScopes ?? []), now, existing.id],
    );
    return ok({ id: existing.id, status: getConnection(db, ids.projectId, input.provider)!.status });
  }

  const id = newId("pvc");
  db.run(
    `INSERT INTO provider_connections
      (id, org_id, project_id, provider, config, status, granted_scopes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'disconnected', ?, ?, ?)`,
    [id, ids.orgId, ids.projectId, input.provider, JSON.stringify(config),
     JSON.stringify(input.grantedScopes ?? []), now, now],
  );
  return ok({ id, status: "disconnected" });
}

export type Probe = () => Promise<{ ok: true; scopes?: string[] } | { ok: false; error: string }>;

/**
 * Verify a connection by actually talking to the provider.
 *
 * The probe is injected rather than built in, so the caller owns the network
 * call and the tests can exercise both outcomes without one. Nothing else in
 * this module sets `connected`.
 */
export async function verifyConnection(
  db: Db,
  projectId: string,
  provider: Provider,
  probe: Probe,
  now = Date.now(),
): Promise<Result<{ status: ConnectionStatus }, DomainError>> {
  const connection = getConnection(db, projectId, provider);
  if (!connection) return err(domainError("not_found", "No connection for that provider."));

  let outcome: Awaited<ReturnType<Probe>>;
  try {
    outcome = await probe();
  } catch (e) {
    outcome = { ok: false, error: (e as Error).message };
  }

  if (!outcome.ok) {
    db.run(
      "UPDATE provider_connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?",
      [outcome.error, now, connection.id],
    );
    return ok({ status: "error" });
  }
  db.run(
    `UPDATE provider_connections SET status = 'connected', last_error = NULL,
       granted_scopes = COALESCE(?, granted_scopes), updated_at = ? WHERE id = ?`,
    [outcome.scopes ? JSON.stringify(outcome.scopes) : null, now, connection.id],
  );
  return ok({ status: "connected" });
}

export function revokeConnection(db: Db, projectId: string, provider: Provider, now = Date.now()): boolean {
  return db.run(
    "UPDATE provider_connections SET status = 'revoked', updated_at = ? WHERE project_id = ? AND provider = ?",
    [now, projectId, provider],
  ).changes > 0;
}

function statusLineFor(
  provider: Provider, status: ConnectionStatus, lastSyncAt: number | null,
  lastError: string | null, now: number,
): string {
  const label = PROVIDER_CAPABILITIES[provider].label;
  if (status === "revoked") return `${label} access was revoked. Nothing is being read.`;
  if (status === "error") return `${label} is not working: ${lastError ?? "the last check failed"}.`;
  if (status === "disconnected") {
    return `${label} has been set up but never verified. Nothing is being read from it yet.`;
  }
  if (lastSyncAt === null) {
    return `${label} is connected but has never synced, so no data from it has arrived.`;
  }
  const hours = (now - lastSyncAt) / 3_600_000;
  return hours < 1
    ? `${label} is connected and synced in the last hour.`
    : `${label} is connected; last synced ${Math.round(hours)} hour(s) ago.`;
}

export function getConnection(db: Db, projectId: string, provider: Provider, now = Date.now()): Connection | null {
  const r = db.get<Record<string, any>>(
    "SELECT * FROM provider_connections WHERE project_id = ? AND provider = ?", [projectId, provider],
  );
  if (!r) return null;
  return {
    id: r.id, provider: r.provider as Provider,
    config: parseJson(r.config, {}), status: r.status as ConnectionStatus,
    grantedScopes: parseJson<string[]>(r.granted_scopes, []),
    lastSyncAt: r.last_sync_at ?? null, lastError: r.last_error ?? null,
    statusLine: statusLineFor(r.provider, r.status, r.last_sync_at ?? null, r.last_error ?? null, now),
  };
}

export function listConnections(db: Db, projectId: string, now = Date.now()): Connection[] {
  return db.all<{ provider: Provider }>(
    "SELECT provider FROM provider_connections WHERE project_id = ? ORDER BY provider", [projectId],
  ).map((r) => getConnection(db, projectId, r.provider, now)!);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Source authority
// ---------------------------------------------------------------------------

export type SourceDomain = "events" | "errors" | "subscriptions" | "feedback" | "releases";

/**
 * Say which system is authoritative for a domain, optionally per entity.
 *
 * Without this, two systems reporting the same signup produce two signups. The
 * answer has to be a decision rather than a heuristic, because only the team
 * knows which of their systems is the one they trust.
 */
export function setAuthoritativeSource(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: { domain: SourceDomain; entity?: string; source: string; note?: string },
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  const entity = input.entity ?? "*";
  if (!input.source.trim()) {
    return err(domainError("validation_failed", "An authoritative source needs a name."));
  }
  const existing = db.get<{ id: string }>(
    "SELECT id FROM source_mappings WHERE project_id = ? AND domain = ? AND entity = ?",
    [ids.projectId, input.domain, entity],
  );
  if (existing) {
    db.run(
      "UPDATE source_mappings SET authoritative_source = ?, note = ?, updated_at = ? WHERE id = ?",
      [input.source, input.note ?? null, now, existing.id],
    );
    return ok({ id: existing.id });
  }
  const id = newId("srm");
  db.run(
    `INSERT INTO source_mappings
      (id, org_id, project_id, domain, entity, authoritative_source, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ids.orgId, ids.projectId, input.domain, entity, input.source, input.note ?? null, now],
  );
  return ok({ id });
}

/**
 * The authoritative source for a domain and entity, or null when nothing has
 * been decided. Null means "accept everything", because refusing data on the
 * basis of a decision nobody made would be worse than a possible duplicate.
 */
export function authoritativeSourceFor(
  db: Db, projectId: string, domain: SourceDomain, entity: string,
): { source: string; scope: "entity" | "domain" } | null {
  const specific = db.get<{ authoritative_source: string }>(
    "SELECT authoritative_source FROM source_mappings WHERE project_id = ? AND domain = ? AND entity = ?",
    [projectId, domain, entity],
  );
  if (specific) return { source: specific.authoritative_source, scope: "entity" };
  const wildcard = db.get<{ authoritative_source: string }>(
    "SELECT authoritative_source FROM source_mappings WHERE project_id = ? AND domain = ? AND entity = '*'",
    [projectId, domain],
  );
  if (wildcard) return { source: wildcard.authoritative_source, scope: "domain" };
  return null;
}

export function sourceIsAuthoritative(
  db: Db, projectId: string, domain: SourceDomain, entity: string, source: string,
): { accepted: boolean; detail: string } {
  const authority = authoritativeSourceFor(db, projectId, domain, entity);
  if (!authority) {
    return {
      accepted: true,
      detail: `No authoritative source has been chosen for ${domain}/${entity}, so every source is accepted.`,
    };
  }
  if (authority.source === source) {
    return { accepted: true, detail: `${source} is authoritative for ${domain}/${entity}.` };
  }
  return {
    accepted: false,
    detail:
      `${authority.source} is authoritative for ${domain}/${entity} (set at the ${authority.scope} level), ` +
      `so records from ${source} are not counted. This prevents the same action being counted twice.`,
  };
}

// ---------------------------------------------------------------------------
// Sync runs
// ---------------------------------------------------------------------------

export interface SyncCounts {
  seen: number;
  imported: number;
  duplicate: number;
  rejected: number;
}

export function startSyncRun(
  db: Db, ids: { orgId: string }, connectionId: string, now = Date.now(),
): { id: string } {
  const id = newId("psr");
  db.run(
    `INSERT INTO provider_sync_runs (id, org_id, connection_id, started_at, status)
     VALUES (?, ?, ?, ?, 'running')`,
    [id, ids.orgId, connectionId, now],
  );
  return { id };
}

export function finishSyncRun(
  db: Db,
  syncRunId: string,
  counts: SyncCounts,
  input: { error?: string | null; detail?: Record<string, unknown> } = {},
  now = Date.now(),
): void {
  const status = input.error ? "failed" : counts.rejected > 0 ? "partial" : "ok";
  db.run(
    `UPDATE provider_sync_runs SET finished_at = ?, status = ?, records_seen = ?,
       records_imported = ?, records_duplicate = ?, records_rejected = ?, detail = ?, error = ?
     WHERE id = ?`,
    [now, status, counts.seen, counts.imported, counts.duplicate, counts.rejected,
     JSON.stringify(input.detail ?? {}), input.error ?? null, syncRunId],
  );
  const connection = db.get<{ connection_id: string }>(
    "SELECT connection_id FROM provider_sync_runs WHERE id = ?", [syncRunId],
  );
  if (connection && !input.error) {
    db.run(
      "UPDATE provider_connections SET last_sync_at = ?, updated_at = ? WHERE id = ?",
      [now, now, connection.connection_id],
    );
  }
  if (connection && input.error) {
    db.run(
      "UPDATE provider_connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?",
      [input.error, now, connection.connection_id],
    );
  }
}

export function listSyncRuns(db: Db, connectionId: string, limit = 20) {
  return db.all(
    `SELECT * FROM provider_sync_runs WHERE connection_id = ?
      ORDER BY started_at DESC LIMIT ?`,
    [connectionId, limit],
  );
}

// ---------------------------------------------------------------------------
// Event import
// ---------------------------------------------------------------------------

export interface ImportableEvent {
  /** The provider's own id for this record. Required: it is how dedupe works. */
  externalId: string;
  name: string;
  occurredAt: number;
  /** The provider's user id, matched against identities by external id. */
  userId?: string | null;
  anonymousId?: string | null;
  accountKey?: string | null;
  properties?: Record<string, unknown>;
}

export type ImportRejectionReason =
  | "missing_external_id"
  | "invalid_event_name"
  | "invalid_timestamp"
  | "no_identity"
  | "not_authoritative"
  | "duplicate";

export interface ImportResult extends SyncCounts {
  syncRunId: string;
  rejections: Array<{ row: number; reason: ImportRejectionReason; detail: string }>;
  /** Properties stripped by the privacy rules, counted rather than hidden. */
  propertiesScrubbed: number;
}

/**
 * Import events from a provider.
 *
 * Deliberately not routed through live ingestion. Live ingestion rejects
 * timestamps more than thirty days old, which is correct for a client clock
 * and wrong for a historical backfill — so this path takes the same name
 * validation and the same privacy scrubbing, but its own timestamp rule, and
 * it never invents an identity: a record whose user cannot be matched is
 * rejected and counted rather than attached to someone plausible.
 */
export function importEvents(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: { source: Provider; records: ImportableEvent[]; connectionId?: string; now?: number },
): Result<ImportResult, DomainError> {
  const now = input.now ?? Date.now();
  const connectionId = input.connectionId
    ?? db.get<{ id: string }>(
      "SELECT id FROM provider_connections WHERE project_id = ? AND provider = ?",
      [ids.projectId, input.source],
    )?.id;
  if (!connectionId) {
    return err(domainError(
      "not_found",
      `No ${input.source} connection exists on this project. Register the connection first, so the import ` +
      "has somewhere to record its provenance.",
    ));
  }

  const { id: syncRunId } = startSyncRun(db, ids, connectionId, now);
  const result: ImportResult = {
    syncRunId, seen: 0, imported: 0, duplicate: 0, rejected: 0,
    rejections: [], propertiesScrubbed: 0,
  };

  const reject = (row: number, reason: ImportRejectionReason, detail: string) => {
    result.rejected++;
    result.rejections.push({ row, reason, detail });
    db.run(
      `INSERT INTO import_rejections
        (id, org_id, project_id, sync_run_id, row_number, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("imr"), ids.orgId, ids.projectId, syncRunId, row, reason,
       JSON.stringify({ detail }), now],
    );
  };

  // 30 days ahead of the import is as generous as a backfill can honestly be.
  const MAX_FUTURE = now + 30 * 86_400_000;

  input.records.forEach((record, index) => {
    const row = index + 1;
    result.seen++;

    if (!record.externalId || !String(record.externalId).trim()) {
      reject(row, "missing_external_id",
        "Without the provider's own id there is no way to tell a retry from a second event.");
      return;
    }
    if (typeof record.name !== "string" || !EVENT_NAME_RE.test(record.name)) {
      reject(row, "invalid_event_name",
        `"${record.name}" is not a lower_snake_case event name.`);
      return;
    }
    if (!Number.isFinite(record.occurredAt) || record.occurredAt <= 0 || record.occurredAt > MAX_FUTURE) {
      reject(row, "invalid_timestamp",
        "The timestamp is missing, not a number, or in the future. Imported events are never clamped.");
      return;
    }

    const authority = sourceIsAuthoritative(db, ids.projectId, "events", record.name, input.source);
    if (!authority.accepted) {
      reject(row, "not_authoritative", authority.detail);
      return;
    }

    const identityId = matchIdentity(db, ids.projectId, record);
    if (!identityId) {
      reject(row, "no_identity",
        "No identity on this project matches this record's user id, and RetainOS will not attach an " +
        "imported event to a plausible-looking person.");
      return;
    }

    const clientEventId = `${input.source}:${record.externalId}`;
    const existing = db.get<{ id: string }>(
      "SELECT id FROM analytics_events WHERE project_id = ? AND client_event_id = ?",
      [ids.projectId, clientEventId],
    );
    if (existing) {
      result.duplicate++;
      return;
    }

    const scrubbed = scrubProperties(record.properties ?? {});
    if (scrubbed.dropped.length > 0) result.propertiesScrubbed += scrubbed.dropped.length;

    db.run(
      `INSERT INTO analytics_events
        (id, org_id, project_id, identity_id, name, occurred_at, received_at, client_event_id,
         properties, source, sync_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("evt"), ids.orgId, ids.projectId, identityId, record.name, record.occurredAt, now,
       clientEventId, JSON.stringify(scrubbed.clean), input.source, syncRunId],
    );
    db.run(
      `UPDATE identities SET
         first_seen_at = CASE WHEN first_seen_at = 0 OR ? < first_seen_at THEN ? ELSE first_seen_at END,
         last_seen_at = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_at END
       WHERE id = ?`,
      [record.occurredAt, record.occurredAt, record.occurredAt, record.occurredAt, identityId],
    );
    result.imported++;
  });

  finishSyncRun(db, syncRunId, result, {
    detail: { propertiesScrubbed: result.propertiesScrubbed, source: input.source },
  }, now);
  return ok(result);
}

function matchIdentity(db: Db, projectId: string, record: ImportableEvent): string | null {
  if (record.userId) {
    const byUser = db.get<{ id: string }>(
      "SELECT id FROM identities WHERE project_id = ? AND external_id = ? AND deleted_at IS NULL",
      [projectId, record.userId],
    );
    if (byUser) return byUser.id;
  }
  if (record.anonymousId) {
    const byAnon = db.get<{ id: string }>(
      "SELECT id FROM identities WHERE project_id = ? AND anonymous_id = ? AND deleted_at IS NULL",
      [projectId, record.anonymousId],
    );
    if (byAnon) return byAnon.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * A CSV parser, because the alternative is a dependency for something this
 * small. Handles quoted fields, escaped quotes and CRLF, which is all a real
 * export uses.
 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ""));
  const header = nonEmpty.shift() ?? [];
  return { header: header.map((h) => h.trim()), rows: nonEmpty };
}

export const CSV_EVENT_COLUMNS = ["external_id", "event_name", "occurred_at", "user_id"] as const;

/**
 * Turn a CSV into importable events.
 *
 * Column errors are reported per row with the row number, because a person is
 * sitting there trying to fix a file and "import failed" tells them nothing.
 */
export function csvToEvents(text: string): {
  records: ImportableEvent[];
  problems: Array<{ row: number; detail: string }>;
  missingColumns: string[];
} {
  const { header, rows } = parseCsv(text);
  const index = new Map(header.map((h, i) => [h.toLowerCase(), i]));
  const missingColumns = CSV_EVENT_COLUMNS.filter((c) => !index.has(c));
  if (missingColumns.length > 0) return { records: [], problems: [], missingColumns };

  const records: ImportableEvent[] = [];
  const problems: Array<{ row: number; detail: string }> = [];
  const extra = header.filter((h) => !(CSV_EVENT_COLUMNS as readonly string[]).includes(h.toLowerCase())
    && h.toLowerCase() !== "account_key");

  rows.forEach((cells, i) => {
    const row = i + 2; // header is row 1, as a spreadsheet shows it
    const get = (col: string) => {
      const at = index.get(col);
      return at === undefined ? "" : (cells[at] ?? "").trim();
    };
    const rawTime = get("occurred_at");
    const occurredAt = /^\d+$/.test(rawTime) ? Number(rawTime) : Date.parse(rawTime);
    if (!Number.isFinite(occurredAt)) {
      problems.push({ row, detail: `"${rawTime}" is not an epoch millisecond value or an ISO date.` });
      return;
    }
    const properties: Record<string, unknown> = {};
    for (const column of extra) {
      const value = get(column.toLowerCase());
      if (value !== "") properties[column] = value;
    }
    records.push({
      externalId: get("external_id"),
      name: get("event_name"),
      occurredAt,
      userId: get("user_id") || null,
      accountKey: index.has("account_key") ? get("account_key") || null : null,
      properties,
    });
  });

  return { records, problems, missingColumns };
}

export interface ImportProvenance {
  source: string;
  events: number;
  firstAt: number | null;
  lastAt: number | null;
}

/** Where this project's events came from. The answer to "can I trust this number?". */
export function eventProvenance(db: Db, projectId: string, from?: number, to?: number): ImportProvenance[] {
  const where = ["project_id = ?"];
  const params: unknown[] = [projectId];
  if (from !== undefined) { where.push("occurred_at >= ?"); params.push(from); }
  if (to !== undefined) { where.push("occurred_at <= ?"); params.push(to); }
  return db.all<ImportProvenance>(
    `SELECT source, COUNT(*) AS events, MIN(occurred_at) AS firstAt, MAX(occurred_at) AS lastAt
       FROM analytics_events WHERE ${where.join(" AND ")}
      GROUP BY source ORDER BY events DESC`,
    params,
  );
}

/** Undo an import. A backfill that turns out to be wrong must be removable. */
export function revertSyncRun(
  db: Db, projectId: string, syncRunId: string,
): Result<{ removed: number }, DomainError> {
  const run = db.get<{ id: string; status: string }>(
    `SELECT r.id, r.status FROM provider_sync_runs r
      JOIN provider_connections c ON c.id = r.connection_id
     WHERE r.id = ? AND c.project_id = ?`,
    [syncRunId, projectId],
  );
  if (!run) return err(domainError("not_found", "No such sync run on this project."));
  if (run.status === "running") {
    return err(domainError("conflict", "That sync is still running; wait for it to finish."));
  }
  const removed = db.run(
    "DELETE FROM analytics_events WHERE project_id = ? AND sync_run_id = ?",
    [projectId, syncRunId],
  ).changes;
  return ok({ removed });
}

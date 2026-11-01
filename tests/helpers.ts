import { Db, migrate } from "../packages/database/src/db.ts";
import {
  createUser, createOrganization, createProject, resolveOrgScope, resolveProjectScope,
  seedSuggestedSchemas, authenticateWriteKey, ingestLimiter,
} from "../packages/database/src/index.ts";

export const PASSWORD = "Correct-Horse-Battery-9";
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** A complete tenant, built through the same code paths the application uses. */
export function newTenant(opts: { email?: string; plan?: string; timezone?: string } = {}) {
  ingestLimiter.reset();
  const db = new Db(":memory:");
  migrate(db);

  const user = createUser(db, {
    email: opts.email ?? "founder@example.com", name: "Founder", password: PASSWORD,
  });
  if (!user.ok) throw new Error(user.error.message);

  const org = createOrganization(db, { name: "Acme Software", ownerId: user.value.id });
  if (!org.ok) throw new Error(org.error.message);
  db.run("UPDATE org_subscriptions SET plan_id = ? WHERE org_id = ?",
    [opts.plan ?? "growth", org.value.orgId]);

  const orgScope = resolveOrgScope(db, user.value.id, org.value.orgId);
  if (!orgScope.ok) throw new Error(orgScope.error.message);

  const project = createProject(db, orgScope.value, {
    name: "Acme App", timezone: opts.timezone ?? "UTC", currency: "INR",
  });
  if (!project.ok) throw new Error(project.error.message);

  const scope = resolveProjectScope(db, user.value.id, project.value.projectId);
  if (!scope.ok) throw new Error(scope.error.message);
  seedSuggestedSchemas(db, scope.value);

  const ingest = authenticateWriteKey(db, project.value.publicKey);
  if (!ingest.ok) throw new Error(ingest.error.message);

  return {
    db,
    userId: user.value.id,
    orgId: org.value.orgId,
    projectId: project.value.projectId,
    publicKey: project.value.publicKey,
    orgScope: orgScope.value,
    scope: scope.value,
    ingest: ingest.value,
  };
}

export function must<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`);
  return r.value;
}

export function mustFail<E>(r: { ok: true } | { ok: false; error: E }): E {
  if (r.ok) throw new Error("expected an error, got ok");
  return r.error;
}

/**
 * Insert an event directly.
 *
 * The journey test needs timestamps months in the past, which the ingestion
 * endpoint correctly refuses. Ingestion has its own suite; this is for
 * building the history the analytics layer then reads.
 */
let seq = 0;
export function backfill(
  t: ReturnType<typeof newTenant>,
  external: string,
  name: string,
  at: number,
  props: Record<string, unknown> = {},
  dims: { plan?: string; source?: string } = {},
): void {
  let identityId = t.db.get<{ id: string }>(
    "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [t.projectId, external],
  )?.id;
  if (!identityId) {
    identityId = `idn_bf_${seq++}`;
    t.db.run(
      `INSERT INTO identities (id, org_id, project_id, external_id, first_seen_at, last_seen_at, plan, acquisition_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [identityId, t.orgId, t.projectId, external, at, at, dims.plan ?? null, dims.source ?? null],
    );
  }
  t.db.run(
    `INSERT INTO analytics_events
      (id, org_id, project_id, identity_id, name, occurred_at, received_at, plan, acquisition_source, properties)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`evt_bf_${String(seq++).padStart(9, "0")}`, t.orgId, t.projectId, identityId, name, at, at,
     dims.plan ?? null, dims.source ?? null, JSON.stringify(props)],
  );
  t.db.run(
    `UPDATE identities SET
       first_seen_at = CASE WHEN ? < first_seen_at THEN ? ELSE first_seen_at END,
       last_seen_at  = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_at END
     WHERE id = ?`,
    [at, at, at, at, identityId],
  );
}

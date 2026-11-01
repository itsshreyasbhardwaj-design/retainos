import { Db, migrate } from "@retainos/database";
import { newId } from "@retainos/shared";
import { createUser, createOrganization, createProject } from "@retainos/database";
import { resolveOrgScope, resolveProjectScope, type ProjectScope } from "@retainos/database";

export interface Harness {
  db: Db;
  orgId: string;
  projectId: string;
  userId: string;
  timezone: string;
  scope: ProjectScope;
  /** Insert an event directly. Ingestion has its own suite; these tests are
   *  about the maths, and direct insertion lets them use timestamps far in the
   *  past that the ingestion endpoint would (correctly) reject. */
  event: (
    identity: string,
    name: string,
    at: number,
    extra?: {
      properties?: Record<string, unknown>; plan?: string; country?: string; device?: string;
      version?: string; source?: string; releaseId?: string; accountKey?: string;
    },
  ) => void;
}

export function harness(timezone = "UTC"): Harness {
  const db = new Db(":memory:");
  migrate(db);
  const user = createUser(db, { email: "founder@example.com", name: "Founder", password: "Correct-Horse-Battery-9" });
  if (!user.ok) throw new Error(user.error.message);
  const org = createOrganization(db, { name: "Acme Software", ownerId: user.value.id });
  if (!org.ok) throw new Error(org.error.message);
  db.run("UPDATE org_subscriptions SET plan_id = 'agency' WHERE org_id = ?", [org.value.orgId]);
  const orgScope = resolveOrgScope(db, user.value.id, org.value.orgId);
  if (!orgScope.ok) throw new Error(orgScope.error.message);
  const project = createProject(db, orgScope.value, { name: "Acme App", timezone });
  if (!project.ok) throw new Error(project.error.message);

  const scope = resolveProjectScope(db, user.value.id, project.value.projectId);
  if (!scope.ok) throw new Error(scope.error.message);

  const orgId = org.value.orgId;
  const projectId = project.value.projectId;
  const identities = new Map<string, string>();

  const identityFor = (external: string, dims: Record<string, string | undefined> = {}): string => {
    const existing = identities.get(external);
    if (existing) {
      db.run(
        `UPDATE identities SET
           plan = COALESCE(?, plan), country = COALESCE(?, country),
           device_category = COALESCE(?, device_category),
           product_version = COALESCE(?, product_version),
           acquisition_source = COALESCE(?, acquisition_source),
           account_key = COALESCE(?, account_key)
         WHERE id = ?`,
        [dims.plan ?? null, dims.country ?? null, dims.device ?? null,
         dims.version ?? null, dims.source ?? null, dims.accountKey ?? null, existing],
      );
      return existing;
    }
    const id = newId("idn");
    db.run(
      `INSERT INTO identities
        (id, org_id, project_id, external_id, first_seen_at, last_seen_at,
         plan, country, device_category, product_version, acquisition_source, account_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, orgId, projectId, external, 0, 0,
       dims.plan ?? null, dims.country ?? null, dims.device ?? null,
       dims.version ?? null, dims.source ?? null, dims.accountKey ?? null],
    );
    identities.set(external, id);
    return id;
  };

  // Monotonic suffix keeps generated ids ordered, so same-millisecond events
  // resolve deterministically exactly as they would in production.
  let seq = 0;
  const event: Harness["event"] = (identity, name, at, extra = {}) => {
    const identityId = identityFor(identity, extra as Record<string, string | undefined>);
    db.run(
      `INSERT INTO analytics_events
        (id, org_id, project_id, identity_id, name, occurred_at, received_at,
         plan, country, device_category, product_version, acquisition_source, release_id, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `evt_${String(seq++).padStart(10, "0")}`, orgId, projectId, identityId, name, at, at,
        extra.plan ?? null, extra.country ?? null, extra.device ?? null, extra.version ?? null,
        extra.source ?? null, extra.releaseId ?? null, JSON.stringify(extra.properties ?? {}),
      ],
    );
    db.run(
      `UPDATE identities SET
         first_seen_at = CASE WHEN first_seen_at = 0 OR ? < first_seen_at THEN ? ELSE first_seen_at END,
         last_seen_at = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_at END
       WHERE id = ?`,
      [at, at, at, at, identityId],
    );
  };

  return { db, orgId, projectId, userId: user.value.id, timezone, scope: scope.value, event };
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
/** A fixed Saturday noon UTC, so no test depends on the real clock. */
export const T0 = Date.UTC(2026, 2, 14, 12, 0, 0);

export function must<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`);
  return r.value;
}

export function mustFail<E>(r: { ok: true } | { ok: false; error: E }): E {
  if (r.ok) throw new Error("expected an error, got ok");
  return r.error;
}

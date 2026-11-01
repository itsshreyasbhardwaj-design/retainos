import { Db, migrate } from "../src/db.ts";
import { createUser, createOrganization, createProject } from "../src/accounts.ts";
import { resolveOrgScope, resolveProjectScope, type ProjectScope, type OrgScope } from "../src/scope.ts";
import { authenticateWriteKey } from "../src/ingest.ts";
import type { IngestScope } from "../src/scope.ts";

export const PASSWORD = "Correct-Horse-Battery-9";

export function freshDb(): Db {
  const db = new Db(":memory:");
  migrate(db);
  return db;
}

export interface Fixture {
  db: Db;
  userId: string;
  orgId: string;
  projectId: string;
  publicKey: string;
  orgScope: OrgScope;
  scope: ProjectScope;
  ingest: IngestScope;
}

/** A full tenant: one user, one organization, one project, one write key. */
export function fixture(opts: { email?: string; timezone?: string; plan?: string } = {}): Fixture {
  const db = freshDb();
  const user = createUser(db, {
    email: opts.email ?? "founder@example.com",
    name: "Founder",
    password: PASSWORD,
  });
  if (!user.ok) throw new Error(user.error.message);
  const org = createOrganization(db, { name: "Acme Software", ownerId: user.value.id });
  if (!org.ok) throw new Error(org.error.message);
  const orgScope = resolveOrgScope(db, user.value.id, org.value.orgId);
  if (!orgScope.ok) throw new Error(orgScope.error.message);
  const project = createProject(db, orgScope.value, { name: "Acme App", timezone: opts.timezone ?? "UTC" });
  if (!project.ok) throw new Error(project.error.message);
  const scope = resolveProjectScope(db, user.value.id, project.value.projectId);
  if (!scope.ok) throw new Error(scope.error.message);
  const ingest = authenticateWriteKey(db, project.value.publicKey);
  if (!ingest.ok) throw new Error(ingest.error.message);

  // Default fixtures run on a plan with room for a small team, so tests exercise
  // permissions rather than tripping over seat limits. Entitlement behaviour has
  // its own suite that sets plans explicitly.
  db.run("UPDATE org_subscriptions SET plan_id = ? WHERE org_id = ?",
    [opts.plan ?? "growth", org.value.orgId]);

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

/** Raise the org to a plan with generous limits so tests are not quota-bound. */
export function unlimited(f: Fixture): Fixture {
  f.db.run("UPDATE org_subscriptions SET plan_id = 'agency' WHERE org_id = ?", [f.orgId]);
  return f;
}

export function must<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error.message}`);
  return r.value;
}

export function mustFail<E>(r: { ok: true } | { ok: false; error: E }): E {
  if (r.ok) throw new Error("expected an error, got ok");
  return r.error;
}

import {
  newId, newPublicKey, newSecretKey, hashSecret, hashPassword, verifyPassword,
  checkPasswordPolicy, isValidTimezone, ok, err, domainError,
  type Result, type DomainError, type Role,
} from "@retainos/shared";
import type { Db } from "./db.ts";
import { type OrgScope, type ProjectScope, require_ } from "./scope.ts";
import { writeAudit } from "./audit.ts";
import { checkCountLimit } from "./entitlements.ts";

export interface User {
  id: string;
  email: string;
  name: string;
  created_at: number;
}

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60_000;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUser(
  db: Db,
  input: { email: string; name: string; password: string },
  now = Date.now(),
): Result<User, DomainError> {
  const email = normaliseEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return err(domainError("validation_failed", "Enter a valid email address."));
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    return err(domainError("validation_failed", "Name must be between 1 and 120 characters."));
  }
  const policy = checkPasswordPolicy(input.password);
  if (!policy.ok) {
    return err(domainError("validation_failed", policy.problems.join(" "), { problems: policy.problems }));
  }
  if (db.get("SELECT 1 FROM users WHERE email = ?", [email])) {
    return err(domainError("conflict", "An account with that email already exists."));
  }
  const id = newId("usr");
  db.run(
    `INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, email, name, hashPassword(input.password), now, now],
  );
  return ok({ id, email, name, created_at: now });
}

export function authenticate(
  db: Db,
  email: string,
  password: string,
  now = Date.now(),
): Result<User, DomainError> {
  const row = db.get<{
    id: string; email: string; name: string; password_hash: string;
    created_at: number; failed_logins: number; locked_until: number | null;
  }>("SELECT * FROM users WHERE email = ?", [normaliseEmail(email)]);

  // Same error for unknown account and wrong password, so the endpoint cannot
  // be used to enumerate which emails have accounts.
  const generic = domainError("unauthenticated", "Email or password is incorrect.");
  if (!row) {
    // Spend comparable time so timing does not leak account existence.
    verifyPassword(password, hashPassword("decoy-password-value"));
    return err(generic);
  }
  if (row.locked_until && row.locked_until > now) {
    return err(domainError("rate_limited", "Too many failed attempts. Try again shortly."));
  }
  if (!verifyPassword(password, row.password_hash)) {
    const failed = row.failed_logins + 1;
    db.run("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", [
      failed,
      failed >= MAX_FAILED_LOGINS ? now + LOCKOUT_MS : null,
      row.id,
    ]);
    return err(generic);
  }
  db.run("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?", [now, row.id]);
  return ok({ id: row.id, email: row.email, name: row.name, created_at: row.created_at });
}

export function createSession(
  db: Db,
  userId: string,
  token: string,
  opts: { expiresAt: number; deviceCategory?: string },
  now = Date.now(),
): string {
  const id = newId("ses");
  db.run(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent_category)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, hashSecret(token), now, opts.expiresAt, opts.deviceCategory ?? null],
  );
  return id;
}

export function sessionUser(db: Db, token: string, now = Date.now()): User | null {
  const row = db.get<{ id: string; email: string; name: string; created_at: number }>(
    `SELECT u.id, u.email, u.name, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND s.revoked_at IS NULL`,
    [hashSecret(token), now],
  );
  return row ?? null;
}

export function revokeSession(db: Db, token: string, now = Date.now()): void {
  db.run("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", [now, hashSecret(token)]);
}

export function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base.length > 0 ? base : "workspace";
}

export function createOrganization(
  db: Db,
  input: { name: string; ownerId: string; isDemo?: boolean },
  now = Date.now(),
): Result<{ orgId: string; slug: string }, DomainError> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) {
    return err(domainError("validation_failed", "Organization name must be between 2 and 120 characters."));
  }
  let slug = slugify(name);
  let suffix = 1;
  while (db.get("SELECT 1 FROM organizations WHERE slug = ?", [slug])) {
    slug = `${slugify(name)}-${++suffix}`;
  }
  const orgId = newId("org");
  return db.tx(() => {
    db.run(
      "INSERT INTO organizations (id, name, slug, created_at, updated_at, is_demo) VALUES (?, ?, ?, ?, ?, ?)",
      [orgId, name, slug, now, now, input.isDemo ? 1 : 0],
    );
    db.run(
      "INSERT INTO organization_memberships (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      [newId("mem"), orgId, input.ownerId, now],
    );
    // Every organization starts on the free plan with a real period window, so
    // entitlement checks never hit a missing row.
    db.run(
      `INSERT INTO org_subscriptions
        (org_id, plan_id, interval, status, provider, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, 'free', 'month', 'active', 'simulator', ?, ?, ?, ?)`,
      [orgId, now, now + 30 * 86_400_000, now, now],
    );
    writeAudit(db, { orgId, actorUserId: input.ownerId, action: "org.created", targetKind: "organization", targetId: orgId }, now);
    return ok({ orgId, slug });
  });
}

export function listOrganizationsForUser(
  db: Db,
  userId: string,
): Array<{ id: string; name: string; slug: string; role: Role; is_demo: number }> {
  return db.all(
    `SELECT o.id, o.name, o.slug, m.role, o.is_demo
       FROM organizations o
       JOIN organization_memberships m ON m.org_id = o.id
      WHERE m.user_id = ?
      ORDER BY o.created_at ASC`,
    [userId],
  );
}

export function addMember(
  db: Db,
  scope: OrgScope,
  input: { userId: string; role: Role },
  now = Date.now(),
): Result<true, DomainError> {
  const allowed = require_(scope, "member:manage");
  if (!allowed.ok) return allowed;
  if (input.role === "owner" && scope.role !== "owner") {
    return err(domainError("forbidden", "Only an owner can grant the owner role."));
  }
  const withinPlan = checkCountLimit(db, scope, "teamMembers");
  if (!withinPlan.ok) return withinPlan;
  if (db.get("SELECT 1 FROM organization_memberships WHERE org_id = ? AND user_id = ?", [scope.orgId, input.userId])) {
    return err(domainError("conflict", "That user is already a member."));
  }
  db.run(
    "INSERT INTO organization_memberships (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
    [newId("mem"), scope.orgId, input.userId, input.role, now],
  );
  writeAudit(db, {
    orgId: scope.orgId, actorUserId: scope.userId, action: "member.added",
    targetKind: "user", targetId: input.userId, detail: { role: input.role },
  }, now);
  return ok(true);
}

export function createProject(
  db: Db,
  scope: OrgScope,
  input: { name: string; timezone?: string; currency?: string; isDemo?: boolean },
  now = Date.now(),
): Result<{ projectId: string; publicKey: string }, DomainError> {
  const allowed = require_(scope, "project:create");
  if (!allowed.ok) return allowed;
  // Plan caps are enforced here, in the only path that creates a project, so
  // no caller can bypass them by talking to the table directly.
  const withinPlan = checkCountLimit(db, scope, "projects");
  if (!withinPlan.ok) return withinPlan;

  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) {
    return err(domainError("validation_failed", "Project name must be between 2 and 120 characters."));
  }
  const timezone = input.timezone ?? "UTC";
  if (!isValidTimezone(timezone)) {
    return err(domainError("validation_failed", `'${timezone}' is not a valid IANA timezone.`));
  }

  let slug = slugify(name);
  let suffix = 1;
  while (db.get("SELECT 1 FROM projects WHERE org_id = ? AND slug = ?", [scope.orgId, slug])) {
    slug = `${slugify(name)}-${++suffix}`;
  }

  const projectId = newId("prj");
  const publicKey = newPublicKey();
  return db.tx(() => {
    db.run(
      `INSERT INTO projects (id, org_id, name, slug, reporting_timezone, currency, created_at, updated_at, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [projectId, scope.orgId, name, slug, timezone, input.currency ?? "INR", now, now, input.isDemo ? 1 : 0],
    );
    db.run(
      `INSERT INTO project_keys (id, org_id, project_id, kind, name, public_key, created_at, created_by)
       VALUES (?, ?, ?, 'public_write', 'Default web key', ?, ?, ?)`,
      [newId("key"), scope.orgId, projectId, publicKey, now, scope.userId],
    );
    writeAudit(db, {
      orgId: scope.orgId, actorUserId: scope.userId, action: "project.created",
      targetKind: "project", targetId: projectId,
    }, now);
    return ok({ projectId, publicKey });
  });
}

export function listProjects(
  db: Db,
  scope: OrgScope,
): Array<{ id: string; name: string; slug: string; reporting_timezone: string; is_demo: number }> {
  return db.all(
    `SELECT id, name, slug, reporting_timezone, is_demo FROM projects
      WHERE org_id = ? AND archived_at IS NULL ORDER BY created_at ASC`,
    [scope.orgId],
  );
}

export function projectKeys(
  db: Db,
  scope: ProjectScope,
): Result<Array<{ id: string; kind: string; name: string; public_key: string | null; secret_preview: string | null; created_at: number; revoked_at: number | null }>, DomainError> {
  const allowed = require_(scope, "key:read");
  if (!allowed.ok) return allowed;
  return ok(
    db.all(
      `SELECT id, kind, name, public_key, secret_preview, created_at, revoked_at
         FROM project_keys WHERE project_id = ? ORDER BY created_at ASC`,
      [scope.projectId],
    ),
  );
}

/** Issue a private admin key. The plaintext is returned once and never stored. */
export function issueSecretKey(
  db: Db,
  scope: ProjectScope,
  name: string,
  now = Date.now(),
): Result<{ secret: string; preview: string }, DomainError> {
  const allowed = require_(scope, "key:rotate");
  if (!allowed.ok) return allowed;
  const { secret, hash, preview } = newSecretKey();
  db.run(
    `INSERT INTO project_keys (id, org_id, project_id, kind, name, secret_hash, secret_preview, created_at, created_by)
     VALUES (?, ?, ?, 'secret_admin', ?, ?, ?, ?, ?)`,
    [newId("key"), scope.orgId, scope.projectId, name.trim() || "API key", hash, preview, now, scope.userId],
  );
  writeAudit(db, {
    orgId: scope.orgId, actorUserId: scope.userId, action: "key.issued",
    targetKind: "project", targetId: scope.projectId, detail: { kind: "secret_admin" },
  }, now);
  return ok({ secret, preview });
}

export function revokeKey(
  db: Db,
  scope: ProjectScope,
  keyId: string,
  now = Date.now(),
): Result<true, DomainError> {
  const allowed = require_(scope, "key:rotate");
  if (!allowed.ok) return allowed;
  const r = db.run(
    "UPDATE project_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL",
    [now, keyId, scope.projectId],
  );
  if (r.changes === 0) return err(domainError("not_found", "Key not found."));
  writeAudit(db, {
    orgId: scope.orgId, actorUserId: scope.userId, action: "key.revoked",
    targetKind: "project_key", targetId: keyId,
  }, now);
  return ok(true);
}

export function updateProjectSettings(
  db: Db,
  scope: ProjectScope,
  patch: {
    name?: string; timezone?: string; requireConsent?: boolean; strictSchema?: boolean;
    allowedOrigins?: string[]; rawRetentionDays?: number; inactivityDays?: number;
  },
  now = Date.now(),
): Result<true, DomainError> {
  const allowed = require_(scope, "project:manage");
  if (!allowed.ok) return allowed;
  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
    return err(domainError("validation_failed", `'${patch.timezone}' is not a valid IANA timezone.`));
  }
  if (patch.rawRetentionDays !== undefined && (patch.rawRetentionDays < 1 || patch.rawRetentionDays > 1095)) {
    return err(domainError("validation_failed", "Raw event retention must be between 1 and 1095 days."));
  }
  if (patch.inactivityDays !== undefined && (patch.inactivityDays < 1 || patch.inactivityDays > 365)) {
    return err(domainError("validation_failed", "Inactivity threshold must be between 1 and 365 days."));
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  const put = (col: string, value: unknown) => { sets.push(`${col} = ?`); params.push(value); };
  if (patch.name !== undefined) put("name", patch.name.trim());
  if (patch.timezone !== undefined) put("reporting_timezone", patch.timezone);
  if (patch.requireConsent !== undefined) put("require_consent", patch.requireConsent ? 1 : 0);
  if (patch.strictSchema !== undefined) put("strict_schema", patch.strictSchema ? 1 : 0);
  if (patch.allowedOrigins !== undefined) put("allowed_origins", JSON.stringify(patch.allowedOrigins));
  if (patch.rawRetentionDays !== undefined) put("raw_retention_days", patch.rawRetentionDays);
  if (patch.inactivityDays !== undefined) put("inactivity_days", patch.inactivityDays);
  if (sets.length === 0) return ok(true);
  put("updated_at", now);
  params.push(scope.projectId, scope.orgId);
  db.run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`, params);
  writeAudit(db, {
    orgId: scope.orgId, actorUserId: scope.userId, action: "project.settings_updated",
    targetKind: "project", targetId: scope.projectId, detail: { fields: Object.keys(patch) },
  }, now);
  return ok(true);
}

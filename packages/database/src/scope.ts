import { type Result, ok, err, domainError, type DomainError } from "@retainos/shared";
import { can, type Permission, type Role } from "@retainos/shared";
import type { Db } from "./db.ts";

/**
 * Tenancy.
 *
 * Nothing in RetainOS reads tenant data without a scope object, and a scope can
 * only be produced by `resolveProjectScope` / `resolveOrgScope`, which verify
 * membership against the database. That makes the dangerous mistake — querying
 * by project_id straight from a URL parameter — structurally hard to write,
 * because every repository function demands a scope it cannot fabricate.
 */
export interface OrgScope {
  readonly orgId: string;
  readonly userId: string;
  readonly role: Role;
}

export interface ProjectScope extends OrgScope {
  readonly projectId: string;
  /** Reporting timezone of this project. Carried so no query forgets it. */
  readonly timezone: string;
  readonly currency: string;
}

export function resolveOrgScope(db: Db, userId: string, orgId: string): Result<OrgScope, DomainError> {
  const row = db.get<{ role: string }>(
    "SELECT role FROM organization_memberships WHERE org_id = ? AND user_id = ?",
    [orgId, userId],
  );
  if (!row) {
    // Deliberately "not found", not "forbidden": a non-member must not be able
    // to confirm that an organization id exists.
    return err(domainError("not_found", "Organization not found."));
  }
  return ok({ orgId, userId, role: row.role as Role });
}

export function resolveProjectScope(db: Db, userId: string, projectId: string): Result<ProjectScope, DomainError> {
  const row = db.get<{
    org_id: string;
    role: string;
    reporting_timezone: string;
    currency: string;
    archived_at: number | null;
  }>(
    `SELECT p.org_id, m.role, p.reporting_timezone, p.currency, p.archived_at
       FROM projects p
       JOIN organization_memberships m ON m.org_id = p.org_id AND m.user_id = ?
      WHERE p.id = ?`,
    [userId, projectId],
  );
  if (!row) return err(domainError("not_found", "Project not found."));
  return ok({
    orgId: row.org_id,
    userId,
    role: row.role as Role,
    projectId,
    timezone: row.reporting_timezone,
    currency: row.currency,
  });
}

export function require_(scope: OrgScope, permission: Permission): Result<true, DomainError> {
  if (!can(scope.role, permission)) {
    return err(
      domainError("forbidden", `Your role (${scope.role}) cannot ${permission}.`, { permission, role: scope.role }),
    );
  }
  return ok(true);
}

/**
 * Scope for an ingestion request authenticated by a public write key.
 * Write-only and project-bound: it cannot be used to read anything.
 */
export interface IngestScope {
  readonly orgId: string;
  readonly projectId: string;
  readonly keyId: string;
  readonly timezone: string;
  readonly requireConsent: boolean;
  readonly strictSchema: boolean;
  readonly allowedOrigins: string[];
}

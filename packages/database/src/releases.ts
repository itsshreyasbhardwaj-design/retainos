import { newId, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";
import type { Db } from "./db.ts";
import { type ProjectScope, require_ } from "./scope.ts";

export function createRelease(
  db: Db,
  scope: ProjectScope,
  input: { name: string; version: string; releasedAt: number; notes?: string; improvementIds?: string[] },
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  const allowed = require_(scope, "release:manage");
  if (!allowed.ok) return allowed;
  const version = input.version.trim();
  if (!version || version.length > 60) {
    return err(domainError("validation_failed", "Version must be between 1 and 60 characters."));
  }
  if (db.get("SELECT 1 FROM releases WHERE project_id = ? AND version = ?", [scope.projectId, version])) {
    return err(domainError("conflict", `Release '${version}' already exists in this project.`));
  }
  const id = newId("rel");
  return db.tx(() => {
    db.run(
      `INSERT INTO releases (id, org_id, project_id, name, version, released_at, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, scope.orgId, scope.projectId, input.name.trim() || version, version, input.releasedAt,
       input.notes ?? "", now, scope.userId],
    );
    for (const impId of input.improvementIds ?? []) {
      const owned = db.get("SELECT 1 FROM improvement_tasks WHERE id = ? AND project_id = ?", [impId, scope.projectId]);
      if (!owned) continue; // never link an improvement from another project
      db.run("INSERT OR IGNORE INTO release_improvements (release_id, improvement_id) VALUES (?, ?)", [id, impId]);
      db.run("UPDATE improvement_tasks SET release_id = ?, updated_at = ? WHERE id = ?", [id, now, impId]);
    }
    return ok({ id });
  });
}

export function listReleases(db: Db, scope: ProjectScope, limit = 50) {
  return db.all(
    `SELECT r.*, (SELECT COUNT(*) FROM release_improvements ri WHERE ri.release_id = r.id) AS improvement_count
       FROM releases r WHERE r.project_id = ? ORDER BY r.released_at DESC LIMIT ?`,
    [scope.projectId, Math.min(limit, 200)],
  );
}

export function addChangelogEntry(
  db: Db,
  scope: ProjectScope,
  input: {
    releaseId?: string | null;
    category: "new_feature" | "improvement" | "bug_fix" | "performance" | "known_limitation";
    title: string; body?: string; isPublic?: boolean;
  },
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  const allowed = require_(scope, "release:manage");
  if (!allowed.ok) return allowed;
  if (input.releaseId) {
    const owned = db.get("SELECT 1 FROM releases WHERE id = ? AND project_id = ?", [input.releaseId, scope.projectId]);
    if (!owned) return err(domainError("not_found", "Release not found in this project."));
  }
  const id = newId("chg");
  db.run(
    `INSERT INTO changelog_entries (id, org_id, project_id, release_id, category, title, body, is_public, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, scope.orgId, scope.projectId, input.releaseId ?? null, input.category,
     input.title.trim().slice(0, 200), input.body ?? "", input.isPublic ? 1 : 0, now],
  );
  return ok({ id });
}

export function changelog(db: Db, projectId: string, publicOnly: boolean, limit = 100) {
  return db.all(
    `SELECT c.*, r.version, r.released_at FROM changelog_entries c
       LEFT JOIN releases r ON r.id = c.release_id
      WHERE c.project_id = ? ${publicOnly ? "AND c.is_public = 1" : ""}
      ORDER BY COALESCE(r.released_at, c.created_at) DESC LIMIT ?`,
    [projectId, Math.min(limit, 300)],
  );
}

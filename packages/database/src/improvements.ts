import {
  newId, ok, err, domainError, IMPROVEMENT_STATUSES, IMPROVEMENT_TRANSITIONS, canTransition,
  type Result, type DomainError, type ImprovementStatus,
} from "@retainos/shared";

// Re-exported for existing server-side imports; defined in @retainos/shared.
export { IMPROVEMENT_STATUSES, canTransition };
export type { ImprovementStatus };
import type { Db } from "./db.ts";
import { jsonParse } from "./db.ts";
import { type ProjectScope, require_ } from "./scope.ts";
import { writeAudit } from "./audit.ts";

export type EvidenceKind =
  | "funnel_step" | "retention_cohort" | "feedback_item" | "feedback_cluster"
  | "event_metric" | "activation_metric" | "revenue_metric" | "insight" | "note";

export interface CreateImprovementInput {
  title: string;
  description?: string;
  affectedWorkflow?: string;
  hypothesis?: string;
  investigation?: string;
  proposedWork?: string;
  acceptanceCriteria?: string;
  measurementPlan?: string;
  priority?: "low" | "medium" | "high" | "critical";
  priorityRationale?: string;
  primaryMetric?: string;
}

export function createImprovement(
  db: Db,
  scope: ProjectScope,
  input: CreateImprovementInput,
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  const allowed = require_(scope, "improvement:manage");
  if (!allowed.ok) return allowed;
  const title = input.title.trim();
  if (title.length < 5 || title.length > 200) {
    return err(domainError("validation_failed", "Title must be between 5 and 200 characters."));
  }
  const id = newId("imp");
  db.run(
    `INSERT INTO improvement_tasks
      (id, org_id, project_id, title, description, affected_workflow, hypothesis, investigation,
       proposed_work, acceptance_criteria, measurement_plan, priority, priority_rationale,
       primary_metric, status, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detected', ?, ?, ?)`,
    [
      id, scope.orgId, scope.projectId, title, input.description ?? "", input.affectedWorkflow ?? null,
      input.hypothesis ?? null, input.investigation ?? null, input.proposedWork ?? null,
      input.acceptanceCriteria ?? null, input.measurementPlan ?? null, input.priority ?? null,
      input.priorityRationale ?? null, input.primaryMetric ?? null, now, now, scope.userId,
    ],
  );
  db.run(
    `INSERT INTO improvement_status_history (id, org_id, improvement_id, from_status, to_status, note, changed_by, changed_at)
     VALUES (?, ?, ?, NULL, 'detected', 'Created', ?, ?)`,
    [newId("ish"), scope.orgId, id, scope.userId, now],
  );
  return ok({ id });
}

export function attachEvidence(
  db: Db,
  scope: ProjectScope,
  improvementId: string,
  input: { kind: EvidenceKind; referenceId?: string | null; summary: string; snapshot?: Record<string, unknown> },
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  const allowed = require_(scope, "improvement:manage");
  if (!allowed.ok) return allowed;
  const task = db.get("SELECT 1 FROM improvement_tasks WHERE id = ? AND project_id = ?", [improvementId, scope.projectId]);
  if (!task) return err(domainError("not_found", "Improvement task not found."));
  // Referenced feedback must belong to the same project: evidence cannot be
  // borrowed across tenants or even across a customer's own projects.
  if (input.kind === "feedback_item" && input.referenceId) {
    const owned = db.get("SELECT 1 FROM feedback_items WHERE id = ? AND project_id = ?", [input.referenceId, scope.projectId]);
    if (!owned) return err(domainError("not_found", "Referenced feedback item is not in this project."));
  }
  const id = newId("evd");
  db.run(
    `INSERT INTO improvement_evidence (id, org_id, improvement_id, kind, reference_id, snapshot, summary, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, scope.orgId, improvementId, input.kind, input.referenceId ?? null,
     JSON.stringify(input.snapshot ?? {}), input.summary.trim().slice(0, 2000), now, scope.userId],
  );
  db.run("UPDATE improvement_tasks SET updated_at = ? WHERE id = ?", [now, improvementId]);
  return ok({ id });
}

export function listEvidence(db: Db, scope: ProjectScope, improvementId: string) {
  return db.all(
    `SELECT e.* FROM improvement_evidence e
       JOIN improvement_tasks t ON t.id = e.improvement_id
      WHERE e.improvement_id = ? AND t.project_id = ? ORDER BY e.created_at ASC`,
    [improvementId, scope.projectId],
  );
}

export function transitionImprovement(
  db: Db,
  scope: ProjectScope,
  improvementId: string,
  to: ImprovementStatus,
  note?: string,
  now = Date.now(),
): Result<true, DomainError> {
  const needsApproval = to === "approved";
  const allowed = require_(scope, needsApproval ? "improvement:approve" : "improvement:manage");
  if (!allowed.ok) return allowed;
  if (!IMPROVEMENT_STATUSES.includes(to)) return err(domainError("validation_failed", "Unknown status."));

  const row = db.get<{ status: ImprovementStatus }>(
    "SELECT status FROM improvement_tasks WHERE id = ? AND project_id = ?", [improvementId, scope.projectId],
  );
  if (!row) return err(domainError("not_found", "Improvement task not found."));
  if (row.status === to) return ok(true);
  if (!canTransition(row.status, to)) {
    return err(
      domainError("conflict", `Cannot move from '${row.status}' to '${to}'.`, {
        from: row.status, to, allowed: IMPROVEMENT_TRANSITIONS[row.status],
      }),
    );
  }
  return db.tx(() => {
    db.run(
      `UPDATE improvement_tasks SET status = ?, updated_at = ?,
         approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
         approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END
       WHERE id = ?`,
      [to, now, to, scope.userId, to, now, improvementId],
    );
    db.run(
      `INSERT INTO improvement_status_history (id, org_id, improvement_id, from_status, to_status, note, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("ish"), scope.orgId, improvementId, row.status, to, note ?? null, scope.userId, now],
    );
    writeAudit(db, {
      orgId: scope.orgId, actorUserId: scope.userId, action: `improvement.${to}`,
      targetKind: "improvement_task", targetId: improvementId, detail: { from: row.status, to },
    }, now);
    return ok(true);
  });
}

export function setOutcome(
  db: Db,
  scope: ProjectScope,
  improvementId: string,
  outcome: "improvement_supported" | "no_clear_difference" | "worse_outcome" | "inconclusive" | "invalid_experiment",
  now = Date.now(),
): Result<true, DomainError> {
  const allowed = require_(scope, "improvement:manage");
  if (!allowed.ok) return allowed;
  const r = db.run(
    "UPDATE improvement_tasks SET outcome = ?, updated_at = ? WHERE id = ? AND project_id = ?",
    [outcome, now, improvementId, scope.projectId],
  );
  if (r.changes === 0) return err(domainError("not_found", "Improvement task not found."));
  return ok(true);
}

export function listImprovements(
  db: Db,
  scope: ProjectScope,
  filter: { status?: ImprovementStatus[]; limit?: number } = {},
) {
  const where = ["project_id = ?"];
  const params: unknown[] = [scope.projectId];
  if (filter.status?.length) {
    where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
    params.push(...filter.status);
  }
  params.push(Math.min(filter.limit ?? 100, 300));
  return db.all(
    `SELECT t.*,
            (SELECT COUNT(*) FROM improvement_evidence e WHERE e.improvement_id = t.id) AS evidence_count,
            (SELECT issue_url FROM github_issue_links g WHERE g.improvement_id = t.id
               AND g.dispatch_state = 'dispatched' ORDER BY g.created_at DESC LIMIT 1) AS issue_url
       FROM improvement_tasks t
      WHERE ${where.join(" AND ")}
      ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               t.updated_at DESC
      LIMIT ?`,
    params,
  );
}

export function getImprovement(db: Db, scope: ProjectScope, id: string) {
  const task = db.get("SELECT * FROM improvement_tasks WHERE id = ? AND project_id = ?", [id, scope.projectId]);
  if (!task) return null;
  return {
    task,
    evidence: listEvidence(db, scope, id),
    history: db.all(
      "SELECT * FROM improvement_status_history WHERE improvement_id = ? ORDER BY changed_at ASC", [id],
    ),
    githubLinks: db.all("SELECT * FROM github_issue_links WHERE improvement_id = ? ORDER BY created_at DESC", [id]),
  };
}

/** The impact timeline: problem -> investigation -> approval -> issue -> release -> measurement. */
export function impactTimeline(db: Db, scope: ProjectScope, improvementId: string) {
  const history = db.all<{ to_status: string; changed_at: number; note: string | null }>(
    "SELECT to_status, changed_at, note FROM improvement_status_history WHERE improvement_id = ? ORDER BY changed_at ASC",
    [improvementId],
  );
  const links = db.all<{ issue_url: string | null; dispatched_at: number | null; repository: string; issue_number: number | null }>(
    "SELECT issue_url, dispatched_at, repository, issue_number FROM github_issue_links WHERE improvement_id = ? AND dispatch_state = 'dispatched'",
    [improvementId],
  );
  const releases = db.all<{ name: string; version: string; released_at: number }>(
    `SELECT r.name, r.version, r.released_at FROM releases r
       JOIN release_improvements ri ON ri.release_id = r.id
      WHERE ri.improvement_id = ? ORDER BY r.released_at ASC`,
    [improvementId],
  );
  const measurements = db.all<{ id: string; method: string; computed_at: number; result: string }>(
    "SELECT id, method, computed_at, result FROM impact_measurements WHERE improvement_id = ? ORDER BY computed_at ASC",
    [improvementId],
  );
  return {
    history,
    githubIssues: links,
    releases,
    measurements: measurements.map((m) => ({ ...m, result: jsonParse<Record<string, unknown>>(m.result, {}) })),
  };
}

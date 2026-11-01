import { type Db, jsonParse } from "@retainos/database";
import { newId, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
}

/**
 * Draft a GitHub-ready issue from an improvement task and its evidence.
 *
 * Rules this function will not break:
 *  - It never invents reproduction steps or a technical cause. Sections with no
 *    recorded content say so explicitly rather than being filled with plausible
 *    text, because a fabricated repro wastes a developer's afternoon.
 *  - Evidence is rendered from the frozen snapshots attached to the task, so the
 *    issue says what was true when the decision was made.
 *  - Nothing is sent anywhere. This produces text for a human to approve.
 */
export function draftIssue(
  db: Db,
  projectId: string,
  improvementId: string,
): Result<IssueDraft, DomainError> {
  const task = db.get<{
    id: string; title: string; description: string; affected_workflow: string | null;
    hypothesis: string | null; investigation: string | null; proposed_work: string | null;
    acceptance_criteria: string | null; measurement_plan: string | null;
    priority: string | null; priority_rationale: string | null; primary_metric: string | null;
    status: string;
  }>(
    "SELECT * FROM improvement_tasks WHERE id = ? AND project_id = ?", [improvementId, projectId],
  );
  if (!task) return err(domainError("not_found", "Improvement task not found."));

  const evidence = db.all<{ kind: string; summary: string; snapshot: string }>(
    "SELECT kind, summary, snapshot FROM improvement_evidence WHERE improvement_id = ? ORDER BY created_at ASC",
    [improvementId],
  );

  const section = (heading: string, content: string | null | undefined, absent: string): string =>
    `## ${heading}\n\n${content && content.trim().length > 0 ? content.trim() : `_${absent}_`}\n`;

  const evidenceBlock = evidence.length === 0
    ? "_No evidence has been attached to this task yet._\n"
    : evidence.map((e) => {
        const snap = jsonParse<Record<string, unknown>>(e.snapshot, {});
        const details = Object.entries(snap)
          .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
          .map(([k, v]) => `  - \`${k}\`: ${formatValue(v)}`)
          .join("\n");
        return `- **${labelFor(e.kind)}** — ${e.summary}${details ? `\n${details}` : ""}`;
      }).join("\n");

  const body = [
    section("Problem", task.description, "No description was recorded."),
    task.affected_workflow ? section("Affected workflow", task.affected_workflow, "") : "",
    `## Evidence\n\n${evidenceBlock}\n`,
    section(
      "Hypothesised cause",
      task.hypothesis,
      "No hypothesis recorded. The evidence above shows what was observed, not why.",
    ),
    "> The section above is a hypothesis, not a diagnosis. It has not been confirmed.\n",
    section(
      "Investigation",
      task.investigation,
      "No investigation steps recorded yet.",
    ),
    section(
      "Reproduction steps",
      null,
      "RetainOS does not have reproduction steps for this issue. They were not recorded, and RetainOS " +
      "will not invent them from telemetry. Add them here if you can reproduce the problem.",
    ),
    section("Proposed work", task.proposed_work, "No proposed work recorded."),
    section("Acceptance criteria", task.acceptance_criteria, "No acceptance criteria recorded."),
    section(
      "How the impact will be measured",
      task.measurement_plan ?? (task.primary_metric ? `Primary metric: \`${task.primary_metric}\`.` : null),
      "No measurement plan recorded. Decide before merging how you will tell whether this worked.",
    ),
    task.priority_rationale ? section("Priority rationale", task.priority_rationale, "") : "",
    `---\n\n_Drafted by RetainOS from improvement task \`${task.id}\`. ` +
    `Evidence snapshots are frozen at the time they were attached._\n`,
  ].filter(Boolean).join("\n");

  const labels = ["retainos"];
  if (task.priority) labels.push(`priority:${task.priority}`);
  const kinds = new Set(evidence.map((e) => e.kind));
  if (kinds.has("feedback_item") || kinds.has("feedback_cluster")) labels.push("customer-reported");
  if (kinds.has("funnel_step") || kinds.has("activation_metric")) labels.push("activation");
  if (kinds.has("retention_cohort")) labels.push("retention");
  if (kinds.has("revenue_metric")) labels.push("revenue");

  return ok({ title: task.title, body, labels });
}

function labelFor(kind: string): string {
  const map: Record<string, string> = {
    funnel_step: "Funnel step",
    retention_cohort: "Retention cohort",
    feedback_item: "Customer feedback",
    feedback_cluster: "Feedback theme",
    event_metric: "Event metric",
    activation_metric: "Activation metric",
    revenue_metric: "Revenue metric",
    insight: "RetainOS insight",
    note: "Note",
  };
  return map[kind] ?? kind;
}

function formatValue(v: unknown): string {
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(4);
  }
  return String(v);
}

export interface GithubLink {
  id: string;
  repository: string;
  dispatchState: string;
  issueNumber: number | null;
  issueUrl: string | null;
}

/** Store a draft. Nothing reaches GitHub until a human approves it. */
export function createIssueDraft(
  db: Db,
  ids: { orgId: string; projectId: string; userId: string },
  input: { improvementId: string; repository: string; draft: IssueDraft },
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    return err(domainError("validation_failed", "Repository must be in 'owner/name' form."));
  }
  const owned = db.get("SELECT 1 FROM improvement_tasks WHERE id = ? AND project_id = ?",
    [input.improvementId, ids.projectId]);
  if (!owned) return err(domainError("not_found", "Improvement task not found."));

  const existingDraft = db.get<{ id: string }>(
    `SELECT id FROM github_issue_links
      WHERE improvement_id = ? AND repository = ? AND dispatch_state IN ('draft','approved')`,
    [input.improvementId, input.repository],
  );
  if (existingDraft) {
    db.run(
      "UPDATE github_issue_links SET draft_title = ?, draft_body = ?, labels = ? WHERE id = ?",
      [input.draft.title, input.draft.body, JSON.stringify(input.draft.labels), existingDraft.id],
    );
    return ok({ id: existingDraft.id });
  }

  // Refuse to draft a second issue for a task that already has one on GitHub.
  const dispatched = db.get<{ issue_number: number | null }>(
    "SELECT issue_number FROM github_issue_links WHERE improvement_id = ? AND repository = ? AND dispatch_state = 'dispatched'",
    [input.improvementId, input.repository],
  );
  if (dispatched) {
    return err(
      domainError("conflict", `This task already has issue #${dispatched.issue_number} in ${input.repository}.`, {
        issueNumber: dispatched.issue_number,
      }),
    );
  }

  const id = newId("ghl");
  db.run(
    `INSERT INTO github_issue_links
      (id, org_id, improvement_id, repository, dispatch_state, draft_title, draft_body, labels, created_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [id, ids.orgId, input.improvementId, input.repository, input.draft.title, input.draft.body,
     JSON.stringify(input.draft.labels), now],
  );
  return ok({ id });
}

/**
 * Approve a draft for dispatch.
 *
 * This is the gate the whole integration turns on: a draft moves to 'approved'
 * only through an explicit call by a user with the approve permission, and only
 * an approved draft can ever be sent.
 */
export function approveIssueDraft(
  db: Db,
  ids: { orgId: string; projectId: string; userId: string },
  linkId: string,
  now = Date.now(),
): Result<true, DomainError> {
  const link = db.get<{ id: string; dispatch_state: string }>(
    `SELECT g.id, g.dispatch_state FROM github_issue_links g
       JOIN improvement_tasks t ON t.id = g.improvement_id
      WHERE g.id = ? AND t.project_id = ?`,
    [linkId, ids.projectId],
  );
  if (!link) return err(domainError("not_found", "Issue draft not found."));
  if (link.dispatch_state === "dispatched") {
    return err(domainError("conflict", "This issue has already been created on GitHub."));
  }
  if (link.dispatch_state !== "draft") {
    return err(domainError("conflict", `A draft in state '${link.dispatch_state}' cannot be approved.`));
  }
  db.run(
    "UPDATE github_issue_links SET dispatch_state = 'approved', approved_by = ?, approved_at = ? WHERE id = ?",
    [ids.userId, now, linkId],
  );
  return ok(true);
}

export function getIssueLink(db: Db, projectId: string, linkId: string) {
  return db.get<Record<string, unknown>>(
    `SELECT g.* FROM github_issue_links g JOIN improvement_tasks t ON t.id = g.improvement_id
      WHERE g.id = ? AND t.project_id = ?`,
    [linkId, projectId],
  ) ?? null;
}

export function recordDispatchResult(
  db: Db,
  linkId: string,
  result: { issueNumber: number; issueUrl: string; state: string } | { error: string },
  now = Date.now(),
): void {
  if ("error" in result) {
    db.run(
      "UPDATE github_issue_links SET dispatch_state = 'failed', last_error = ?, last_synced_at = ? WHERE id = ?",
      [result.error.slice(0, 500), now, linkId],
    );
    return;
  }
  db.run(
    `UPDATE github_issue_links
        SET dispatch_state = 'dispatched', issue_number = ?, issue_url = ?, issue_state = ?,
            dispatched_at = ?, last_synced_at = ?, last_error = NULL
      WHERE id = ?`,
    [result.issueNumber, result.issueUrl, result.state, now, now, linkId],
  );
}

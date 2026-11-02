import { newId, ok, err, domainError, dayKey, type Result, type DomainError } from "@retainos/shared";
import type { Db } from "./db.ts";
import { type ProjectScope, require_ } from "./scope.ts";
import { enqueueJob } from "./ingest.ts";
import { writeAudit } from "./audit.ts";

export interface ErasureReport {
  identitiesDeleted: number;
  eventsDeleted: number;
  feedbackAnonymised: number;
  identityLinksDeleted: number;
  experimentRecordsDeleted: number;
  onboardingRecordsDeleted: number;
  subscriptionsDetached: number;
}

/**
 * Erase one end user's data from a project.
 *
 * Deletes raw events and the identity, detaches subscription rows (the billing
 * facts are the customer's own financial records and are kept, minus the link),
 * and anonymises their feedback rather than destroying the product signal.
 * Aggregated counts are recomputed afterwards, so the numbers stay consistent
 * instead of silently disagreeing with the raw store.
 */
export function eraseSubject(
  db: Db,
  scope: ProjectScope,
  subject: { kind: "external_id" | "anonymous_id"; value: string },
  now = Date.now(),
): Result<{ requestId: string; report: ErasureReport }, DomainError> {
  const allowed = require_(scope, "privacy:erase");
  if (!allowed.ok) return allowed;

  const column = subject.kind === "external_id" ? "external_id" : "anonymous_id";
  const identities = db.all<{ id: string }>(
    `SELECT id FROM identities WHERE project_id = ? AND ${column} = ?`,
    [scope.projectId, subject.value],
  );

  const requestId = newId("del");
  db.run(
    `INSERT INTO data_deletion_requests
      (id, org_id, project_id, subject_kind, subject_value, requested_by, requested_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [requestId, scope.orgId, scope.projectId, subject.kind, subject.value, scope.userId, now],
  );

  if (identities.length === 0) {
    const empty: ErasureReport = {
      identitiesDeleted: 0, eventsDeleted: 0, feedbackAnonymised: 0, identityLinksDeleted: 0,
      experimentRecordsDeleted: 0, onboardingRecordsDeleted: 0, subscriptionsDetached: 0,
    };
    db.run("UPDATE data_deletion_requests SET status = 'completed', completed_at = ?, report = ? WHERE id = ?",
      [now, JSON.stringify(empty), requestId]);
    return ok({ requestId, report: empty });
  }

  const ids = identities.map((i) => i.id);
  const ph = ids.map(() => "?").join(",");

  return db.tx(() => {
    const affectedDays = db.all<{ d: string }>(
      `SELECT DISTINCT occurred_at AS d FROM analytics_events WHERE project_id = ? AND identity_id IN (${ph})`,
      [scope.projectId, ...ids],
    ).map((r) => dayKey(Number(r.d), scope.timezone));

    const eventsDeleted = db.run(
      `DELETE FROM analytics_events WHERE project_id = ? AND identity_id IN (${ph})`, [scope.projectId, ...ids],
    ).changes;
    const identityLinksDeleted = db.run(
      `DELETE FROM identity_links WHERE project_id = ? AND identity_id IN (${ph})`, [scope.projectId, ...ids],
    ).changes;
    const experimentRecordsDeleted =
      db.run(`DELETE FROM experiment_assignments WHERE project_id = ? AND identity_id IN (${ph})`, [scope.projectId, ...ids]).changes +
      db.run(`DELETE FROM experiment_exposures WHERE project_id = ? AND identity_id IN (${ph})`, [scope.projectId, ...ids]).changes;
    const onboardingRecordsDeleted = db.run(
      `DELETE FROM onboarding_progress WHERE project_id = ? AND identity_id IN (${ph})`, [scope.projectId, ...ids],
    ).changes;
    const subscriptionsDetached = db.run(
      `UPDATE customer_subscriptions SET identity_id = NULL, updated_at = ?
        WHERE project_id = ? AND identity_id IN (${ph})`, [now, scope.projectId, ...ids],
    ).changes;
    const feedbackAnonymised = db.run(
      `UPDATE feedback_items SET identity_id = NULL, contact_email = NULL, consent_to_contact = 0, updated_at = ?
        WHERE project_id = ? AND identity_id IN (${ph})`, [now, scope.projectId, ...ids],
    ).changes;
    const identitiesDeleted = db.run(
      `DELETE FROM identities WHERE project_id = ? AND id IN (${ph})`, [scope.projectId, ...ids],
    ).changes;

    // Mark the touched days for recomputation so aggregates match the raw store.
    for (const day of new Set(affectedDays)) {
      enqueueJob(db, {
        orgId: scope.orgId,
        projectId: scope.projectId,
        kind: "recompute_day",
        payload: { dayKey: day },
        dedupeKey: `recompute_day:${scope.projectId}:${day}`,
      }, now);
    }

    const report: ErasureReport = {
      identitiesDeleted, eventsDeleted, feedbackAnonymised, identityLinksDeleted,
      experimentRecordsDeleted, onboardingRecordsDeleted, subscriptionsDetached,
    };
    db.run("UPDATE data_deletion_requests SET status = 'completed', completed_at = ?, report = ? WHERE id = ?",
      [now, JSON.stringify(report), requestId]);
    writeAudit(db, {
      orgId: scope.orgId, actorUserId: scope.userId, action: "privacy.subject_erased",
      targetKind: "project", targetId: scope.projectId,
      detail: { subjectKind: subject.kind, report },
    }, now);
    return ok({ requestId, report });
  });
}

/** Enforce the project's raw-event retention window. Aggregates are preserved. */
export function applyRetention(db: Db, projectId: string, now = Date.now()): { eventsDeleted: number; rejectionsDeleted: number } {
  const row = db.get<{ raw_retention_days: number }>("SELECT raw_retention_days FROM projects WHERE id = ?", [projectId]);
  const days = row?.raw_retention_days ?? 90;
  const cutoff = now - days * 86_400_000;
  const eventsDeleted = db.run("DELETE FROM analytics_events WHERE project_id = ? AND occurred_at < ?", [projectId, cutoff]).changes;
  const rejectionsDeleted = db.run("DELETE FROM event_rejections WHERE project_id = ? AND received_at < ?", [projectId, cutoff]).changes;
  return { eventsDeleted, rejectionsDeleted };
}

export interface ExportBundle {
  exportedAt: number;
  project: Record<string, unknown>;
  counts: Record<string, number>;
  tables: Record<string, Array<Record<string, unknown>>>;
}

/** Full project data export. Requires an explicit export permission. */
export function exportProject(
  db: Db,
  scope: ProjectScope,
  opts: { includeRawEvents?: boolean; maxRows?: number } = {},
): Result<ExportBundle, DomainError> {
  const allowed = require_(scope, "analytics:export");
  if (!allowed.ok) return allowed;
  const max = Math.min(opts.maxRows ?? 50_000, 200_000);
  const project = db.get("SELECT * FROM projects WHERE id = ?", [scope.projectId]) ?? {};

  /**
   * Each table is exported through an explicit, project-scoped query. Tables
   * that have no project_id of their own are reached through their parent, so
   * the scoping is never accidentally dropped. The SQL comes from this literal
   * map only — never from user input.
   */
  const SCOPED_QUERIES: Record<string, string> = {
    event_schemas: "SELECT * FROM event_schemas WHERE project_id = ? LIMIT ?",
    activation_definitions: "SELECT * FROM activation_definitions WHERE project_id = ? LIMIT ?",
    tracked_features: "SELECT * FROM tracked_features WHERE project_id = ? LIMIT ?",
    funnel_definitions: "SELECT * FROM funnel_definitions WHERE project_id = ? LIMIT ?",
    user_segments: "SELECT * FROM user_segments WHERE project_id = ? LIMIT ?",
    identities: "SELECT * FROM identities WHERE project_id = ? LIMIT ?",
    feedback_items: "SELECT * FROM feedback_items WHERE project_id = ? LIMIT ?",
    feedback_tags: "SELECT * FROM feedback_tags WHERE project_id = ? LIMIT ?",
    feedback_clusters: "SELECT * FROM feedback_clusters WHERE project_id = ? LIMIT ?",
    feedback_comments:
      `SELECT c.* FROM feedback_comments c JOIN feedback_items f ON f.id = c.feedback_id
        WHERE f.project_id = ? LIMIT ?`,
    improvement_tasks: "SELECT * FROM improvement_tasks WHERE project_id = ? LIMIT ?",
    improvement_evidence:
      `SELECT e.* FROM improvement_evidence e JOIN improvement_tasks t ON t.id = e.improvement_id
        WHERE t.project_id = ? LIMIT ?`,
    improvement_status_history:
      `SELECT h.* FROM improvement_status_history h JOIN improvement_tasks t ON t.id = h.improvement_id
        WHERE t.project_id = ? LIMIT ?`,
    github_issue_links:
      `SELECT g.* FROM github_issue_links g JOIN improvement_tasks t ON t.id = g.improvement_id
        WHERE t.project_id = ? LIMIT ?`,
    releases: "SELECT * FROM releases WHERE project_id = ? LIMIT ?",
    changelog_entries: "SELECT * FROM changelog_entries WHERE project_id = ? LIMIT ?",
    customer_subscriptions: "SELECT * FROM customer_subscriptions WHERE project_id = ? LIMIT ?",
    subscription_events: "SELECT * FROM subscription_events WHERE project_id = ? LIMIT ?",
    experiments: "SELECT * FROM experiments WHERE project_id = ? LIMIT ?",
    experiment_variants:
      `SELECT v.* FROM experiment_variants v JOIN experiments x ON x.id = v.experiment_id
        WHERE x.project_id = ? LIMIT ?`,
    experiment_results:
      `SELECT r.* FROM experiment_results r JOIN experiments x ON x.id = r.experiment_id
        WHERE x.project_id = ? LIMIT ?`,
    impact_measurements: "SELECT * FROM impact_measurements WHERE project_id = ? LIMIT ?",
    insights: "SELECT * FROM insights WHERE project_id = ? LIMIT ?",
    insight_evidence:
      `SELECT ie.* FROM insight_evidence ie JOIN insights i ON i.id = ie.insight_id
        WHERE i.project_id = ? LIMIT ?`,
    onboarding_flows: "SELECT * FROM onboarding_flows WHERE project_id = ? LIMIT ?",
    onboarding_steps:
      `SELECT s.* FROM onboarding_steps s JOIN onboarding_flows fl ON fl.id = s.flow_id
        WHERE fl.project_id = ? LIMIT ?`,
    reports: "SELECT * FROM reports WHERE project_id = ? LIMIT ?",
    onboarding_progress: "SELECT * FROM onboarding_progress WHERE project_id = ? LIMIT ?",

    // Everything the product-intelligence layer stores is exportable too. An
    // export that quietly omits the newest half of the product is not an
    // export, and "your data is yours" has to keep being true as the product
    // grows rather than only on the day the promise was made.
    error_events: "SELECT * FROM error_events WHERE project_id = ? LIMIT ?",
    accounts: "SELECT * FROM accounts WHERE project_id = ? LIMIT ?",
    friction_cases: "SELECT * FROM friction_cases WHERE project_id = ? LIMIT ?",
    friction_evidence:
      `SELECT e.* FROM friction_evidence e JOIN friction_cases c ON c.id = e.case_id
        WHERE c.project_id = ? LIMIT ?`,
    friction_relationships:
      `SELECT r.* FROM friction_relationships r JOIN friction_cases c ON c.id = r.case_id
        WHERE c.project_id = ? LIMIT ?`,
    friction_status_history:
      `SELECT h.* FROM friction_status_history h JOIN friction_cases c ON c.id = h.case_id
        WHERE c.project_id = ? LIMIT ?`,
    friction_case_users: "SELECT * FROM friction_case_users WHERE project_id = ? LIMIT ?",
    opportunity_weights: "SELECT * FROM opportunity_weights WHERE project_id = ? LIMIT ?",
    opportunity_scores: "SELECT * FROM opportunity_scores WHERE project_id = ? LIMIT ?",
    opportunity_score_factors:
      `SELECT f.* FROM opportunity_score_factors f JOIN opportunity_scores s ON s.id = f.score_id
        WHERE s.project_id = ? LIMIT ?`,
    opportunity_estimates:
      `SELECT e.* FROM opportunity_estimates e JOIN friction_cases c ON c.id = e.case_id
        WHERE c.project_id = ? LIMIT ?`,
    retention_playbooks: "SELECT * FROM retention_playbooks WHERE project_id = ? LIMIT ?",
    playbook_enrollments: "SELECT * FROM playbook_enrollments WHERE project_id = ? LIMIT ?",
    messaging_consent: "SELECT * FROM messaging_consent WHERE project_id = ? LIMIT ?",
    health_definitions: "SELECT * FROM health_definitions WHERE project_id = ? LIMIT ?",
    health_observations: "SELECT * FROM health_observations WHERE project_id = ? LIMIT ?",
    revenue_impact_records: "SELECT * FROM revenue_impact_records WHERE project_id = ? LIMIT ?",
    instrumentation_findings: "SELECT * FROM instrumentation_findings WHERE project_id = ? LIMIT ?",
    provider_connections: "SELECT * FROM provider_connections WHERE project_id = ? LIMIT ?",
    provider_sync_runs:
      `SELECT r.* FROM provider_sync_runs r JOIN provider_connections c ON c.id = r.connection_id
        WHERE c.project_id = ? LIMIT ?`,
    import_rejections: "SELECT * FROM import_rejections WHERE project_id = ? LIMIT ?",
    source_mappings: "SELECT * FROM source_mappings WHERE project_id = ? LIMIT ?",
    alert_rules: "SELECT * FROM alert_rules WHERE project_id = ? LIMIT ?",
    alert_events: "SELECT * FROM alert_events WHERE project_id = ? LIMIT ?",
    executive_briefs: "SELECT * FROM executive_briefs WHERE project_id = ? LIMIT ?",
  };

  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const counts: Record<string, number> = {};
  for (const [name, sql] of Object.entries(SCOPED_QUERIES)) {
    const rows = db.all(sql, [scope.projectId, max]);
    tables[name] = rows;
    counts[name] = rows.length;
  }

  if (opts.includeRawEvents) {
    tables.analytics_events = db.all(
      "SELECT * FROM analytics_events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT ?",
      [scope.projectId, max],
    );
    counts.analytics_events = tables.analytics_events.length;
  }
  return ok({ exportedAt: Date.now(), project, counts, tables });
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    // Guard against CSV formula injection when the file is opened in a spreadsheet.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

import { type Db } from "@retainos/database";
import { newId, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";
import { twoProportionTest } from "./stats.ts";
import { listActivationDefinitions, activationFunnel } from "./activation.ts";
import { runInstrumentationDoctor } from "./instrumentation.ts";

/**
 * The alert quality engine.
 *
 * An alerting system is judged by the alerts it does not send. Once a team
 * learns that most notifications are noise, the useful ones stop working too,
 * and no amount of better detection recovers that. So the rules here are about
 * restraint: a floor on affected users, a cooldown, deduplication, and a
 * refusal to fire when the data underneath the alert is known to be unreliable.
 *
 * Every alert carries five things, and the columns are NOT NULL so one cannot
 * be written without them: which rule fired, what the metric did, what it is
 * being compared against, what is known about the data quality, and what the
 * reader might do next.
 */

export type AlertKind =
  | "activation_regression"
  | "error_spike"
  | "retention_change"
  | "feedback_theme"
  | "cancellation_increase"
  | "ingestion_failure"
  | "experiment_guardrail";

export type AlertSeverity = "critical" | "high" | "medium" | "low";

export interface AlertRule {
  id: string;
  kind: AlertKind;
  enabled: boolean;
  threshold: number;
  minAffectedUsers: number;
  comparisonDays: number;
  cooldownHours: number;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
}

export const DEFAULT_ALERT_RULES: Record<AlertKind, Omit<AlertRule, "id" | "kind" | "enabled">> = {
  // A relative fall of a tenth in activation is worth a look; smaller moves on
  // a weekly comparison are usually noise.
  activation_regression: {
    threshold: 0.1, minAffectedUsers: 50, comparisonDays: 7, cooldownHours: 48,
    quietHoursStart: 21, quietHoursEnd: 8,
  },
  error_spike: {
    threshold: 2.0, minAffectedUsers: 10, comparisonDays: 7, cooldownHours: 12,
    quietHoursStart: null, quietHoursEnd: null,
  },
  retention_change: {
    threshold: 0.1, minAffectedUsers: 100, comparisonDays: 28, cooldownHours: 168,
    quietHoursStart: 21, quietHoursEnd: 8,
  },
  feedback_theme: {
    threshold: 3.0, minAffectedUsers: 5, comparisonDays: 7, cooldownHours: 72,
    quietHoursStart: 21, quietHoursEnd: 8,
  },
  cancellation_increase: {
    threshold: 0.5, minAffectedUsers: 5, comparisonDays: 30, cooldownHours: 72,
    quietHoursStart: 21, quietHoursEnd: 8,
  },
  ingestion_failure: {
    threshold: 0.05, minAffectedUsers: 0, comparisonDays: 1, cooldownHours: 6,
    quietHoursStart: null, quietHoursEnd: null,
  },
  experiment_guardrail: {
    threshold: 0.05, minAffectedUsers: 100, comparisonDays: 7, cooldownHours: 24,
    quietHoursStart: null, quietHoursEnd: null,
  },
};

/** Below this, a change in a rate is not reportable whatever the threshold says. */
export const ABSOLUTE_MIN_AFFECTED_USERS = 5;

export function upsertAlertRule(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: { kind: AlertKind; enabled?: boolean } & Partial<Omit<AlertRule, "id" | "kind" | "enabled">>,
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  if (!(input.kind in DEFAULT_ALERT_RULES)) {
    return err(domainError("validation_failed", `Unknown alert kind "${input.kind}".`));
  }
  const defaults = DEFAULT_ALERT_RULES[input.kind];
  const rule = { ...defaults, ...input };

  if (rule.threshold <= 0) {
    return err(domainError(
      "validation_failed",
      "A threshold of zero would fire on every fluctuation, which trains people to ignore alerts.",
    ));
  }
  if (rule.minAffectedUsers < ABSOLUTE_MIN_AFFECTED_USERS && input.kind !== "ingestion_failure") {
    return err(domainError(
      "validation_failed",
      `An alert needs at least ${ABSOLUTE_MIN_AFFECTED_USERS} affected users behind it. Below that a ` +
      "change in a rate is arithmetic on a handful of people.",
    ));
  }
  if (rule.cooldownHours < 1) {
    return err(domainError(
      "validation_failed",
      "A cooldown of under an hour means the same problem can alert repeatedly while nobody is fixing it.",
    ));
  }
  if (rule.comparisonDays < 1) {
    return err(domainError("validation_failed", "A comparison needs at least one day of history."));
  }

  const existing = db.get<{ id: string }>(
    "SELECT id FROM alert_rules WHERE project_id = ? AND kind = ?", [ids.projectId, input.kind],
  );
  const enabled = input.enabled === undefined ? 1 : input.enabled ? 1 : 0;
  if (existing) {
    db.run(
      `UPDATE alert_rules SET enabled = ?, threshold = ?, min_affected_users = ?, comparison_days = ?,
         cooldown_hours = ?, quiet_hours_start = ?, quiet_hours_end = ?, updated_at = ?
       WHERE id = ?`,
      [enabled, rule.threshold, rule.minAffectedUsers, rule.comparisonDays, rule.cooldownHours,
       rule.quietHoursStart, rule.quietHoursEnd, now, existing.id],
    );
    return ok({ id: existing.id });
  }
  const id = newId("alr");
  db.run(
    `INSERT INTO alert_rules
      (id, org_id, project_id, kind, enabled, threshold, min_affected_users, comparison_days,
       cooldown_hours, quiet_hours_start, quiet_hours_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ids.orgId, ids.projectId, input.kind, enabled, rule.threshold, rule.minAffectedUsers,
     rule.comparisonDays, rule.cooldownHours, rule.quietHoursStart, rule.quietHoursEnd, now, now],
  );
  return ok({ id });
}

export function listAlertRules(db: Db, projectId: string): AlertRule[] {
  return db.all<Record<string, any>>(
    "SELECT * FROM alert_rules WHERE project_id = ? ORDER BY kind", [projectId],
  ).map((r) => ({
    id: r.id, kind: r.kind as AlertKind, enabled: r.enabled === 1, threshold: r.threshold,
    minAffectedUsers: r.min_affected_users, comparisonDays: r.comparison_days,
    cooldownHours: r.cooldown_hours,
    quietHoursStart: r.quiet_hours_start ?? null, quietHoursEnd: r.quiet_hours_end ?? null,
  }));
}

/** Install the default rules for a project that has none. */
export function ensureDefaultAlertRules(
  db: Db, ids: { orgId: string; projectId: string }, now = Date.now(),
): number {
  let created = 0;
  for (const kind of Object.keys(DEFAULT_ALERT_RULES) as AlertKind[]) {
    const existing = db.get<{ id: string }>(
      "SELECT id FROM alert_rules WHERE project_id = ? AND kind = ?", [ids.projectId, kind],
    );
    if (existing) continue;
    const r = upsertAlertRule(db, ids, { kind }, now);
    if (r.ok) created++;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * An alert before it has been allowed to fire.
 *
 * The five evidence fields are required by the type as well as by the schema,
 * so a detector cannot produce something that would be rejected at write time.
 */
export interface AlertCandidate {
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  triggeringRule: string;
  metricDetail: string;
  comparisonDetail: string;
  suggestedAction: string;
  affectedUsers: number | null;
  dedupeKey: string;
  caseId?: string | null;
}

export type AlertSuppressionReason =
  | "rule_disabled" | "no_rule" | "below_threshold" | "too_few_users"
  | "cooldown" | "duplicate" | "data_unreliable";

export interface FireResult {
  fired: boolean;
  alertId: string | null;
  reason: AlertSuppressionReason | "fired";
  detail: string;
}

/**
 * Describe what is known about the data behind an alert.
 *
 * This is computed rather than written by the detector, because the detector
 * does not know whether the project's instrumentation is sound, and an alert
 * built on broken tracking is worse than no alert.
 */
export function dataQualityNote(
  db: Db, projectId: string, timezone: string, now: number,
): { note: string; blocking: number } {
  const report = runInstrumentationDoctor(db, projectId, { timezone, now });
  const blocking = report.findings.filter((f) => f.severity === "blocking");
  const warnings = report.findings.filter((f) => f.severity === "warning");
  if (blocking.length > 0) {
    return {
      note:
        `${blocking.length} blocking instrumentation issue(s) are open (` +
        blocking.map((f) => f.checkId).join(", ") +
        "). A change in this metric may reflect broken tracking rather than changed behaviour.",
      blocking: blocking.length,
    };
  }
  if (warnings.length > 0) {
    return {
      note:
        `${warnings.length} instrumentation warning(s) are open (` +
        warnings.map((f) => f.checkId).join(", ") +
        "). The metric is usable but less reliable than it looks.",
      blocking: 0,
    };
  }
  return { note: "All instrumentation checks passed, so the underlying data is sound.", blocking: 0 };
}

function inQuietHours(rule: AlertRule, hourOfDay: number): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = rule;
  if (start === null || end === null) return false;
  return start <= end ? hourOfDay >= start && hourOfDay < end : hourOfDay >= start || hourOfDay < end;
}

/**
 * Fire an alert, or explain why not.
 *
 * Quiet hours are checked by the caller against `shouldDeferForQuietHours`,
 * because a deferral is not a suppression: the alert still matters, it just
 * does not need to wake anyone.
 */
export function fireAlert(
  db: Db,
  ids: { orgId: string; projectId: string },
  candidate: AlertCandidate,
  input: { timezone: string; now?: number },
): FireResult {
  const now = input.now ?? Date.now();
  const rule = listAlertRules(db, ids.projectId).find((r) => r.kind === candidate.kind);

  if (!rule) {
    return { fired: false, alertId: null, reason: "no_rule", detail: `No rule configured for ${candidate.kind}.` };
  }
  if (!rule.enabled) {
    return { fired: false, alertId: null, reason: "rule_disabled", detail: `The ${candidate.kind} rule is turned off.` };
  }
  if (candidate.affectedUsers !== null && candidate.affectedUsers < rule.minAffectedUsers) {
    return {
      fired: false, alertId: null, reason: "too_few_users",
      detail: `${candidate.affectedUsers} affected user(s) is below this rule's floor of ${rule.minAffectedUsers}.`,
    };
  }

  const duplicate = db.get<{ id: string }>(
    "SELECT id FROM alert_events WHERE project_id = ? AND dedupe_key = ?",
    [ids.projectId, candidate.dedupeKey],
  );
  if (duplicate) {
    return {
      fired: false, alertId: duplicate.id, reason: "duplicate",
      detail: "An alert with this dedupe key already exists; the same problem is not reported twice.",
    };
  }

  const lastOfKind = db.get<{ fired_at: number }>(
    `SELECT a.fired_at FROM alert_events a
      WHERE a.project_id = ? AND a.rule_id = ? ORDER BY a.fired_at DESC LIMIT 1`,
    [ids.projectId, rule.id],
  );
  if (lastOfKind && now - lastOfKind.fired_at < rule.cooldownHours * 3_600_000) {
    const hours = ((now - lastOfKind.fired_at) / 3_600_000).toFixed(1);
    return {
      fired: false, alertId: null, reason: "cooldown",
      detail: `The last ${candidate.kind} alert fired ${hours} hours ago, inside the ${rule.cooldownHours}-hour cooldown.`,
    };
  }

  const quality = dataQualityNote(db, ids.projectId, input.timezone, now);
  // A blocking instrumentation problem makes the metric untrustworthy, and an
  // alert nobody can act on is worse than silence.
  if (quality.blocking > 0 && candidate.kind !== "ingestion_failure") {
    return {
      fired: false, alertId: null, reason: "data_unreliable",
      detail: quality.note + " The alert was withheld; fix the instrumentation first.",
    };
  }

  const id = newId("ale");
  db.run(
    `INSERT INTO alert_events
      (id, org_id, project_id, rule_id, severity, title, triggering_rule, metric_detail,
       comparison_detail, data_quality, suggested_action, affected_users, case_id, fired_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ids.orgId, ids.projectId, rule.id, candidate.severity, candidate.title,
     candidate.triggeringRule, candidate.metricDetail, candidate.comparisonDetail,
     quality.note, candidate.suggestedAction, candidate.affectedUsers,
     candidate.caseId ?? null, now, candidate.dedupeKey],
  );
  return { fired: true, alertId: id, reason: "fired", detail: "Alert recorded." };
}

export function shouldDeferForQuietHours(
  db: Db, projectId: string, kind: AlertKind, hourOfDay: number,
): boolean {
  const rule = listAlertRules(db, projectId).find((r) => r.kind === kind);
  return rule ? inQuietHours(rule, hourOfDay) : false;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Activation regression.
 *
 * The significance test is the gate, not the threshold. A 12% relative fall on
 * sixty signups is a coin flip, and reporting it as a regression is how an
 * alerting channel becomes something people mute.
 */
export function detectActivationRegression(
  db: Db,
  projectId: string,
  input: { timezone: string; now?: number; comparisonDays?: number; threshold?: number },
): AlertCandidate | null {
  const now = input.now ?? Date.now();
  const days = input.comparisonDays ?? 7;
  const threshold = input.threshold ?? 0.1;
  const span = days * 86_400_000;

  const definition = listActivationDefinitions(db, projectId).find((d) => d.isPrimary);
  if (!definition) return null;

  const current = activationFunnel(db, projectId, {
    definition, from: now - span, to: now, now,
  });
  const prior = activationFunnel(db, projectId, {
    definition, from: now - 2 * span, to: now - span, now,
  });
  if (current.registrations === 0 || prior.registrations === 0) return null;

  const relative = (current.activationRate - prior.activationRate) / (prior.activationRate || 1);
  if (relative > -threshold) return null;

  const test = twoProportionTest(
    { successes: prior.activated, total: prior.registrations },
    { successes: current.activated, total: current.registrations },
  );
  if (!test || test.pValue >= 0.05) return null;

  return {
    kind: "activation_regression",
    severity: relative <= -0.25 ? "high" : "medium",
    title: `Activation fell ${Math.abs(relative * 100).toFixed(0)}% week on week`,
    triggeringRule:
      `activation_regression: a relative fall of more than ${(threshold * 100).toFixed(0)}% over ` +
      `${days} days, confirmed by a two-proportion test at p < 0.05.`,
    metricDetail:
      `${(current.activationRate * 100).toFixed(1)}% of ${current.registrations} signups activated ` +
      `in the last ${days} days.`,
    comparisonDetail:
      `The previous ${days} days: ${(prior.activationRate * 100).toFixed(1)}% of ${prior.registrations} ` +
      `signups. p = ${test.pValue.toFixed(4)}, 95% interval for the difference ` +
      `[${(test.confidenceInterval[0] * 100).toFixed(1)}, ${(test.confidenceInterval[1] * 100).toFixed(1)}] ` +
      "percentage points." +
      (current.warnings.length > 0 ? ` Caveats on the current figure: ${current.warnings.join(" ")}` : ""),
    suggestedAction:
      "Compare the activation funnel's steps between the two periods to find which step moved, then check " +
      "whether a release landed in the window.",
    affectedUsers: current.registrations,
    dedupeKey: `activation_regression:${Math.floor(now / 86_400_000)}`,
  };
}

/** Error spike, measured as a ratio against the prior window. */
export function detectErrorSpike(
  db: Db,
  projectId: string,
  input: { now?: number; comparisonDays?: number; threshold?: number },
): AlertCandidate | null {
  const now = input.now ?? Date.now();
  const days = input.comparisonDays ?? 7;
  const threshold = input.threshold ?? 2.0;
  const span = days * 86_400_000;

  const rows = db.all<{ fingerprint: string; title: string; n: number; users: number }>(
    `SELECT fingerprint, title, COUNT(*) AS n, COUNT(DISTINCT identity_id) AS users
       FROM error_events
      WHERE project_id = ? AND occurred_at >= ? AND occurred_at <= ?
      GROUP BY fingerprint ORDER BY n DESC LIMIT 20`,
    [projectId, now - span, now],
  );

  for (const row of rows) {
    const prior = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM error_events
        WHERE project_id = ? AND fingerprint = ? AND occurred_at >= ? AND occurred_at < ?`,
      [projectId, row.fingerprint, now - 2 * span, now - span],
    )?.n ?? 0;

    // A brand-new error is a spike only if it is big enough to matter on its
    // own; otherwise every one-off exception would page someone.
    const ratio = prior === 0 ? (row.n >= 20 ? Infinity : 0) : row.n / prior;
    if (ratio < threshold) continue;

    return {
      kind: "error_spike",
      severity: row.users >= 50 ? "critical" : "high",
      title: prior === 0
        ? `New error affecting ${row.users} user(s): ${row.title}`
        : `Error up ${ratio === Infinity ? "sharply" : `${ratio.toFixed(1)}×`}: ${row.title}`,
      triggeringRule:
        `error_spike: occurrences at least ${threshold}× the previous ${days} days, or a new ` +
        "fingerprint with at least 20 occurrences.",
      metricDetail: `${row.n} occurrence(s) across ${row.users} user(s) in the last ${days} days.`,
      comparisonDetail: prior === 0
        ? `This fingerprint had never been seen before this window.`
        : `${prior} occurrence(s) in the previous ${days} days.`,
      suggestedAction:
        "Open the error group to see which users and which product versions are affected, and whether it " +
        "started with a release.",
      affectedUsers: row.users,
      dedupeKey: `error_spike:${row.fingerprint}:${Math.floor(now / 86_400_000)}`,
    };
  }
  return null;
}

/** Cancellations above their own recent baseline. */
export function detectCancellationIncrease(
  db: Db,
  projectId: string,
  input: { now?: number; comparisonDays?: number; threshold?: number },
): AlertCandidate | null {
  const now = input.now ?? Date.now();
  const days = input.comparisonDays ?? 30;
  const threshold = input.threshold ?? 0.5;
  const span = days * 86_400_000;

  const count = (from: number, to: number) => db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT subscription_id) AS n FROM subscription_events
      WHERE project_id = ? AND type = 'cancelled' AND occurred_at >= ? AND occurred_at < ?`,
    [projectId, from, to],
  )?.n ?? 0;

  const current = count(now - span, now);
  const prior = count(now - 2 * span, now - span);
  if (prior < 5 || current <= prior) return null;

  const relative = (current - prior) / prior;
  if (relative < threshold) return null;

  return {
    kind: "cancellation_increase",
    severity: relative >= 1 ? "high" : "medium",
    title: `Cancellations up ${(relative * 100).toFixed(0)}% over ${days} days`,
    triggeringRule:
      `cancellation_increase: a relative rise of more than ${(threshold * 100).toFixed(0)}% against the ` +
      `previous ${days} days, with at least 5 cancellations in the baseline.`,
    metricDetail: `${current} subscription(s) cancelled in the last ${days} days.`,
    comparisonDetail: `${prior} in the previous ${days} days.`,
    suggestedAction:
      "Read the cancellation feedback for this period before drawing a conclusion. A rise in cancellations " +
      "a month after a pricing change or a cohort of annual renewals is not the same problem as a product fault.",
    affectedUsers: current,
    dedupeKey: `cancellation_increase:${Math.floor(now / (7 * 86_400_000))}`,
  };
}

/** Events being refused at ingestion. The one alert that fires on bad data. */
export function detectIngestionFailure(
  db: Db,
  projectId: string,
  input: { now?: number; comparisonDays?: number; threshold?: number },
): AlertCandidate | null {
  const now = input.now ?? Date.now();
  const span = (input.comparisonDays ?? 1) * 86_400_000;
  const threshold = input.threshold ?? 0.05;

  const accepted = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ? AND received_at >= ?",
    [projectId, now - span],
  )?.n ?? 0;
  const rejections = db.all<{ reason: string; n: number }>(
    `SELECT reason, COUNT(*) AS n FROM event_rejections
      WHERE project_id = ? AND received_at >= ? GROUP BY reason ORDER BY n DESC`,
    [projectId, now - span],
  );
  const rejected = rejections.reduce((s, r) => s + r.n, 0);
  const total = accepted + rejected;
  if (total < 50 || rejected === 0) return null;

  const rate = rejected / total;
  if (rate < threshold) return null;

  return {
    kind: "ingestion_failure",
    severity: rate >= 0.5 ? "critical" : rate >= 0.2 ? "high" : "medium",
    title: `${(rate * 100).toFixed(0)}% of events are being rejected`,
    triggeringRule: `ingestion_failure: a rejection rate above ${(threshold * 100).toFixed(0)}%.`,
    metricDetail:
      `${rejected} of ${total} events sent in the last ${input.comparisonDays ?? 1} day(s) were refused. ` +
      `Most common reason: ${rejections[0]!.reason} (${rejections[0]!.n}).`,
    comparisonDetail: `${accepted} events were accepted over the same period.`,
    suggestedAction:
      "Open the event inspector and read the rejection reasons. Until this is fixed, every metric covering " +
      "this period is computed on incomplete data.",
    affectedUsers: null,
    dedupeKey: `ingestion_failure:${rejections[0]!.reason}:${Math.floor(now / 86_400_000)}`,
  };
}

/** Run every enabled detector and fire what survives the quality rules. */
export function runAlertChecks(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: { timezone: string; now?: number },
): { fired: FireResult[]; suppressed: FireResult[]; candidates: number } {
  const now = input.now ?? Date.now();
  const rules = listAlertRules(db, ids.projectId);
  const candidates: AlertCandidate[] = [];

  for (const rule of rules.filter((r) => r.enabled)) {
    const opts = { now, comparisonDays: rule.comparisonDays, threshold: rule.threshold };
    let candidate: AlertCandidate | null = null;
    if (rule.kind === "activation_regression") {
      candidate = detectActivationRegression(db, ids.projectId, { ...opts, timezone: input.timezone });
    } else if (rule.kind === "error_spike") {
      candidate = detectErrorSpike(db, ids.projectId, opts);
    } else if (rule.kind === "cancellation_increase") {
      candidate = detectCancellationIncrease(db, ids.projectId, opts);
    } else if (rule.kind === "ingestion_failure") {
      candidate = detectIngestionFailure(db, ids.projectId, opts);
    }
    if (candidate) candidates.push(candidate);
  }

  const fired: FireResult[] = [];
  const suppressed: FireResult[] = [];
  for (const candidate of candidates) {
    const result = fireAlert(db, ids, candidate, input);
    (result.fired ? fired : suppressed).push(result);
  }
  return { fired, suppressed, candidates: candidates.length };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  triggeringRule: string;
  metricDetail: string;
  comparisonDetail: string;
  dataQuality: string;
  suggestedAction: string;
  affectedUsers: number | null;
  firedAt: number;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
  snoozedUntil: number | null;
}

export function listAlerts(
  db: Db,
  projectId: string,
  filter: { includeResolved?: boolean; now?: number; limit?: number } = {},
): Alert[] {
  const now = filter.now ?? Date.now();
  const where = ["a.project_id = ?"];
  const params: unknown[] = [projectId];
  if (!filter.includeResolved) where.push("a.resolved_at IS NULL");
  const rows = db.all<Record<string, any>>(
    `SELECT a.*, r.kind FROM alert_events a JOIN alert_rules r ON r.id = a.rule_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.fired_at DESC LIMIT ?`,
    [...params, filter.limit ?? 100],
  );
  return rows
    .filter((r) => !r.snoozed_until || r.snoozed_until <= now || filter.includeResolved)
    .map((r) => ({
      id: r.id, kind: r.kind as AlertKind, severity: r.severity as AlertSeverity, title: r.title,
      triggeringRule: r.triggering_rule, metricDetail: r.metric_detail,
      comparisonDetail: r.comparison_detail, dataQuality: r.data_quality,
      suggestedAction: r.suggested_action, affectedUsers: r.affected_users ?? null,
      firedAt: r.fired_at, acknowledgedAt: r.acknowledged_at ?? null,
      resolvedAt: r.resolved_at ?? null, snoozedUntil: r.snoozed_until ?? null,
    }));
}

export function acknowledgeAlert(db: Db, projectId: string, alertId: string, now = Date.now()): boolean {
  return db.run(
    "UPDATE alert_events SET acknowledged_at = ? WHERE id = ? AND project_id = ? AND acknowledged_at IS NULL",
    [now, alertId, projectId],
  ).changes > 0;
}

export function resolveAlert(db: Db, projectId: string, alertId: string, now = Date.now()): boolean {
  return db.run(
    "UPDATE alert_events SET resolved_at = ?, acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ? AND project_id = ? AND resolved_at IS NULL",
    [now, now, alertId, projectId],
  ).changes > 0;
}

export function snoozeAlert(
  db: Db, projectId: string, alertId: string, until: number, now = Date.now(),
): Result<true, DomainError> {
  if (until <= now) {
    return err(domainError("validation_failed", "A snooze must end in the future."));
  }
  const changed = db.run(
    "UPDATE alert_events SET snoozed_until = ? WHERE id = ? AND project_id = ?",
    [until, alertId, projectId],
  ).changes;
  return changed > 0 ? ok(true) : err(domainError("not_found", "Alert not found."));
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export interface RuleQuality {
  kind: AlertKind;
  fired: number;
  acknowledged: number;
  resolved: number;
  ignored: number;
  acknowledgementRate: number | null;
  /** Said plainly, including when the honest answer is that nobody acted. */
  assessment: string;
  recommendation: string | null;
}

export interface AlertQualityReport {
  windowDays: number;
  rules: RuleQuality[];
  totalFired: number;
  overallAcknowledgementRate: number | null;
  summary: string;
}

/**
 * How good this project's alerts have been.
 *
 * The measure is whether anyone acted, not whether the detection was clever.
 * A rule that fires regularly and is never acknowledged is noise by
 * definition, and the recommendation says so rather than suggesting a more
 * sensitive threshold.
 */
export function alertQuality(
  db: Db, projectId: string, input: { windowDays?: number; now?: number } = {},
): AlertQualityReport {
  const now = input.now ?? Date.now();
  const windowDays = input.windowDays ?? 30;
  const since = now - windowDays * 86_400_000;

  const rows = db.all<{
    kind: AlertKind; fired: number; acknowledged: number; resolved: number;
  }>(
    `SELECT r.kind AS kind, COUNT(*) AS fired,
            SUM(CASE WHEN a.acknowledged_at IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged,
            SUM(CASE WHEN a.resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved
       FROM alert_events a JOIN alert_rules r ON r.id = a.rule_id
      WHERE a.project_id = ? AND a.fired_at >= ?
      GROUP BY r.kind ORDER BY fired DESC`,
    [projectId, since],
  );

  const rules: RuleQuality[] = rows.map((r) => {
    const ignored = r.fired - r.acknowledged;
    const rate = r.fired > 0 ? r.acknowledged / r.fired : null;
    let assessment: string;
    let recommendation: string | null = null;

    if (r.fired < 3) {
      assessment = `Only ${r.fired} alert(s) in ${windowDays} days — too few to judge this rule.`;
    } else if (rate !== null && rate >= 0.7) {
      assessment = `${(rate * 100).toFixed(0)}% of these alerts were acknowledged. This rule is earning its place.`;
    } else if (rate !== null && rate <= 0.2) {
      assessment =
        `${ignored} of ${r.fired} alerts were never acknowledged. By the only measure that matters — ` +
        "whether anyone acted — this rule is producing noise.";
      recommendation =
        "Raise this rule's threshold or its minimum affected users, or turn it off. A more sensitive " +
        "threshold would make this worse, not better.";
    } else {
      assessment = `${(rate! * 100).toFixed(0)}% of these alerts were acknowledged.`;
      recommendation = "Worth reviewing the unacknowledged ones to see what they had in common.";
    }
    return {
      kind: r.kind, fired: r.fired, acknowledged: r.acknowledged, resolved: r.resolved,
      ignored, acknowledgementRate: rate, assessment, recommendation,
    };
  });

  const totalFired = rules.reduce((s, r) => s + r.fired, 0);
  const totalAcked = rules.reduce((s, r) => s + r.acknowledged, 0);
  return {
    windowDays,
    rules,
    totalFired,
    overallAcknowledgementRate: totalFired > 0 ? totalAcked / totalFired : null,
    summary: totalFired === 0
      ? `No alerts fired in the last ${windowDays} days. That is a fact about the period, not evidence that the rules work.`
      : `${totalFired} alert(s) fired and ${totalAcked} were acknowledged over ${windowDays} days.`,
  };
}

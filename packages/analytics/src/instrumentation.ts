import { type Db, ingestHealth, undeclaredEvents } from "@retainos/database";
import { newId } from "@retainos/shared";
import { listActivationDefinitions } from "./activation.ts";

/**
 * The Instrumentation Doctor.
 *
 * Every metric in RetainOS silently depends on the data underneath it being
 * right. A missing activation event does not produce an error — it produces a
 * confident activation rate of zero. A duplicated event name does not fail —
 * it halves a funnel. These failures are invisible precisely because they look
 * like answers.
 *
 * This runs the checks a data-literate person would run by hand, and every
 * finding says what is wrong, what it does to the numbers, how to fix it, and
 * how to confirm the fix worked.
 *
 * Deliberately available on the free tier: unreliable data makes every other
 * part of the product worse, including for people who never pay.
 */

export type Severity = "blocking" | "warning" | "advisory";

export interface Finding {
  checkId: string;
  severity: Severity;
  title: string;
  detail: string;
  whyItMatters: string;
  suggestedFix: string;
  howToVerify: string;
  evidence: Record<string, unknown>;
}

export interface DoctorReport {
  findings: Finding[];
  checksRun: number;
  /** A project can be healthy; the report says so rather than inventing problems. */
  healthy: boolean;
  summary: string;
}

export interface DoctorInput {
  timezone: string;
  now?: number;
  windowDays?: number;
}

export function runInstrumentationDoctor(db: Db, projectId: string, input: DoctorInput): DoctorReport {
  const now = input.now ?? Date.now();
  const windowDays = input.windowDays ?? 14;
  const from = now - windowDays * 86_400_000;
  const ctx = { db, projectId, now, from, windowDays, timezone: input.timezone };

  const checks: Array<(c: Ctx) => Finding | Finding[] | null> = [
    checkAnyEvents, checkActivationInstrumented, checkRejectionRate, checkCaseVariants,
    checkIdentityLinking, checkAnonymousOnly, checkSchemaCoverage, checkSchemaDrift,
    checkVolumeCollapse, checkClockSkew, checkExperimentExposure, checkRevenueConsistency,
    checkSdkVersions,
  ];

  const findings: Finding[] = [];
  for (const check of checks) {
    const result = check(ctx);
    if (result) findings.push(...(Array.isArray(result) ? result : [result]));
  }

  const blocking = findings.filter((f) => f.severity === "blocking").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;

  const advisories = findings.length - blocking - warnings;
  return {
    findings: findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    checksRun: checks.length,
    healthy: blocking === 0 && warnings === 0,
    summary: summarise(checks.length, windowDays, blocking, warnings, advisories),
  };
}

function summarise(
  checksRun: number, windowDays: number, blocking: number, warnings: number, advisories: number,
): string {
  if (blocking + warnings + advisories === 0) {
    return `All ${checksRun} instrumentation checks passed over the last ${windowDays} days.`;
  }
  if (blocking === 0 && warnings === 0) {
    // Advisories alone are not a data-quality problem; saying otherwise would
    // train people to ignore this page.
    return `All ${checksRun} instrumentation checks passed over the last ${windowDays} days. ` +
      `${advisories} advisory note(s) are worth reading but do not affect the accuracy of any metric.`;
  }
  const lead = `${blocking} blocking issue(s) and ${warnings} warning(s) across ${checksRun} checks. `;
  return lead + (blocking > 0
    ? "Blocking issues mean some metrics on this project are currently wrong, not just incomplete."
    : "Warnings mean some metrics are less reliable than they appear.");
}

function severityRank(s: Severity): number {
  return s === "blocking" ? 0 : s === "warning" ? 1 : 2;
}

interface Ctx {
  db: Db; projectId: string; now: number; from: number; windowDays: number; timezone: string;
}

// --- checks ----------------------------------------------------------------

function checkAnyEvents(ctx: Ctx): Finding | null {
  const n = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ?", [ctx.projectId],
  )?.n ?? 0;
  if (n > 0) return null;
  return {
    checkId: "no_events",
    severity: "blocking",
    title: "No events have ever arrived",
    detail: "This project has never received an accepted event.",
    whyItMatters:
      "Every metric in RetainOS is computed from events. Without them the dashboard is not showing you a " +
      "quiet product; it is showing you nothing at all.",
    suggestedFix: "Install the SDK, grant consent, and fire one event. The event inspector shows arrivals and rejections.",
    howToVerify: "Open the event inspector and confirm an accepted event appears.",
    evidence: { totalEvents: 0 },
  };
}

/** The single most damaging gap: activation configured but never instrumented. */
function checkActivationInstrumented(ctx: Ctx): Finding | Finding[] | null {
  const defs = listActivationDefinitions(ctx.db, ctx.projectId);
  const def = defs.find((d) => d.isPrimary) ?? defs[0];
  if (!def) {
    const hasEvents = (ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ?", [ctx.projectId],
    )?.n ?? 0) > 0;
    if (!hasEvents) return null;
    return {
      checkId: "activation_undefined",
      severity: "blocking",
      title: "No activation event is defined",
      detail: "Events are arriving, but nothing tells RetainOS which one means a user reached real value.",
      whyItMatters:
        "Activation is the metric most of the product hangs off: the activation funnel, time to value, " +
        "activation cohorts and most friction detection. Without it they are all unavailable.",
      suggestedFix:
        "Pick the single event that means a user got real value from your product. Signup is never it.",
      howToVerify: "The activation page shows a rate instead of a setup prompt.",
      evidence: {},
    };
  }

  const missing: Finding[] = [];
  for (const [label, eventName] of [["activation", def.activationEvent], ["signup", def.signupEvent]] as const) {
    const count = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ? AND name = ?",
      [ctx.projectId, eventName],
    )?.n ?? 0;
    if (count === 0) {
      missing.push({
        checkId: `${label}_event_never_seen`,
        severity: "blocking",
        title: `The ${label} event "${eventName}" has never arrived`,
        detail: `Activation is configured to use "${eventName}", but no event with that name has ever been received.`,
        whyItMatters:
          label === "activation"
            ? "Your activation rate is currently 0%, and that figure is an instrumentation gap rather than a " +
              "product problem. Acting on it would mean fixing something that is not broken."
            : "Nobody enters the activation funnel, so the rate has no denominator and reads as zero.",
        suggestedFix:
          `Either instrument "${eventName}" in your application, or change the activation definition to an ` +
          "event you already send. The event inspector lists what is actually arriving.",
        howToVerify: `Fire the event, then confirm it appears in the inspector and the activation rate changes.`,
        evidence: { expectedEvent: eventName, occurrences: 0 },
      });
    }
  }
  return missing.length > 0 ? missing : null;
}

function checkRejectionRate(ctx: Ctx): Finding | null {
  const health = ingestHealth(ctx.db, ctx.projectId, ctx.from);
  if (health.acceptanceRate === null || health.rejected < 10) return null;
  if (health.acceptanceRate >= 0.95) return null;
  const top = [...health.byReason].sort((a, b) => b.n - a.n)[0];
  return {
    checkId: "high_rejection_rate",
    severity: health.acceptanceRate < 0.8 ? "blocking" : "warning",
    title: `${((1 - health.acceptanceRate) * 100).toFixed(0)}% of events are being rejected`,
    detail:
      `${health.rejected} of ${health.accepted + health.rejected} events sent in the last ${ctx.windowDays} ` +
      `days were refused. The most common reason was "${top?.reason}" (${top?.n} events).`,
    whyItMatters:
      "Rejected events are never stored, so every metric covering this window is computed on incomplete " +
      "data. The numbers are not wrong in an obvious way; they are quietly low.",
    suggestedFix:
      "Open the event inspector, read the rejection reasons, and fix them at the source. The most common " +
      "causes are event names that are not lower_snake_case, properties outside a closed schema, and a " +
      "consent flag that is never set.",
    howToVerify: "The acceptance rate in the inspector returns above 95%.",
    evidence: { acceptanceRate: health.acceptanceRate, byReason: health.byReason },
  };
}

/** Case and separator variants of the same event silently split a funnel. */
function checkCaseVariants(ctx: Ctx): Finding | null {
  const names = ctx.db.all<{ name: string; n: number }>(
    `SELECT name, COUNT(*) AS n FROM analytics_events WHERE project_id = ? GROUP BY name`,
    [ctx.projectId],
  );
  const canonical = new Map<string, Array<{ name: string; n: number }>>();
  for (const row of names) {
    const key = row.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const list = canonical.get(key) ?? [];
    list.push(row);
    canonical.set(key, list);
  }
  const collisions = [...canonical.values()].filter((v) => v.length > 1);
  if (collisions.length === 0) return null;
  return {
    checkId: "event_name_variants",
    severity: "warning",
    title: `${collisions.length} event name(s) arriving in more than one spelling`,
    detail:
      collisions.map((group) => group.map((g) => `"${g.name}" (${g.n})`).join(" and ")).join("; ") + ".",
    whyItMatters:
      "RetainOS treats these as different events, so a funnel step matching one spelling silently misses " +
      "everyone who sent the other. The funnel does not look broken; it looks like a drop-off.",
    suggestedFix: "Standardise on one lower_snake_case name and deploy the change everywhere.",
    howToVerify: "Only one spelling appears in the event inspector after the deploy.",
    evidence: { collisions: collisions.map((g) => g.map((x) => x.name)) },
  };
}

/** Events that never get an identify() call cannot be joined to anything. */
function checkIdentityLinking(ctx: Ctx): Finding | null {
  const total = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identities WHERE project_id = ? AND deleted_at IS NULL", [ctx.projectId],
  )?.n ?? 0;
  if (total < 20) return null;
  const identified = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identities WHERE project_id = ? AND external_id IS NOT NULL", [ctx.projectId],
  )?.n ?? 0;
  const share = identified / total;
  if (share >= 0.3) return null;
  return {
    checkId: "low_identity_linking",
    severity: "warning",
    title: `Only ${(share * 100).toFixed(0)}% of identities are ever identified`,
    detail: `${identified} of ${total} identities have a user id from your application.`,
    whyItMatters:
      "Anonymous identities cannot be joined to subscriptions, feedback or accounts. Retention looks worse " +
      "than it is, because a returning user on a new device counts as a new person, and revenue cannot be " +
      "attached to any product behaviour.",
    suggestedFix:
      "Call identify() with your own pseudonymous user id as soon as a user authenticates, and call reset() " +
      "on logout.",
    howToVerify: "The share of identified identities rises on this check.",
    evidence: { identified, total, share },
  };
}

function checkAnonymousOnly(ctx: Ctx): Finding | null {
  const links = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identity_links WHERE project_id = ?", [ctx.projectId],
  )?.n ?? 0;
  const identified = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identities WHERE project_id = ? AND external_id IS NOT NULL", [ctx.projectId],
  )?.n ?? 0;
  if (identified < 10 || links > identified * 0.2) return null;
  return {
    checkId: "identify_without_anonymous_history",
    severity: "advisory",
    title: "identify() is being called without any prior anonymous activity",
    detail: `${identified} identified users but only ${links} anonymous-to-identified links recorded.`,
    whyItMatters:
      "Pre-signup behaviour is being lost. Anything a user did before authenticating — the landing page, " +
      "the signup funnel itself — cannot be attributed to them afterwards.",
    suggestedFix:
      "Initialise the SDK on first page load rather than after login, so an anonymous id exists to link.",
    howToVerify: "Identity links rise towards the number of identified users.",
    evidence: { identifiedUsers: identified, anonymousLinks: links },
  };
}

function checkSchemaCoverage(ctx: Ctx): Finding | null {
  const undeclared = undeclaredEvents(ctx.db, ctx.projectId, 20);
  if (undeclared.length === 0) return null;
  const totalUndeclared = undeclared.reduce((s, u) => s + u.event_count, 0);
  return {
    checkId: "events_without_schema",
    severity: "advisory",
    title: `${undeclared.length} event name(s) arriving with no registered schema`,
    detail:
      undeclared.slice(0, 5).map((u) => `"${u.name}" (${u.event_count})`).join(", ") +
      (undeclared.length > 5 ? `, and ${undeclared.length - 5} more.` : "."),
    whyItMatters:
      "These events are accepted, but nothing validates their properties. A property that silently changes " +
      "type or disappears will not be caught, and any metric built on it will drift without warning.",
    suggestedFix: "Register these events with their expected properties in the schema registry.",
    howToVerify: "The undeclared list in SDK settings empties.",
    evidence: { undeclared: undeclared.slice(0, 10), totalOccurrences: totalUndeclared },
  };
}

/** A schema version bump mid-window means a metric changed meaning. */
function checkSchemaDrift(ctx: Ctx): Finding | null {
  const drifted = ctx.db.all<{ name: string; version: number; updated_at: number }>(
    `SELECT name, version, updated_at FROM event_schemas
      WHERE project_id = ? AND version > 1 AND updated_at >= ?`,
    [ctx.projectId, ctx.from],
  );
  if (drifted.length === 0) return null;
  return {
    checkId: "schema_drift",
    severity: "warning",
    title: `${drifted.length} event schema(s) changed inside the reporting window`,
    detail: drifted.map((d) => `"${d.name}" is now at version ${d.version}`).join(", ") + ".",
    whyItMatters:
      "A metric built on a changed event may not mean the same thing before and after the change. Any " +
      "comparison spanning this window — a before-and-after, a cohort trend, a running experiment — is " +
      "comparing two different definitions.",
    suggestedFix:
      "Check whether the change affects any metric you are currently comparing across this window. " +
      "If an experiment is running on one of these events, treat its result as invalid.",
    howToVerify: "Compare the metric's definition before and after the version bump.",
    evidence: { changed: drifted },
  };
}

/** A sharp fall in volume usually means a deploy broke tracking, not churn. */
function checkVolumeCollapse(ctx: Ctx): Finding | null {
  const span = ctx.windowDays * 86_400_000;
  const current = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ? AND occurred_at >= ? AND occurred_at <= ?",
    [ctx.projectId, ctx.from, ctx.now],
  )?.n ?? 0;
  const prior = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ? AND occurred_at >= ? AND occurred_at < ?",
    [ctx.projectId, ctx.from - span, ctx.from],
  )?.n ?? 0;
  if (prior < 100) return null;
  const change = (current - prior) / prior;
  if (change > -0.5) return null;
  return {
    checkId: "volume_collapse",
    severity: "blocking",
    title: `Event volume fell by ${Math.abs(change * 100).toFixed(0)}%`,
    detail: `${prior} events in the previous ${ctx.windowDays} days, ${current} in the most recent ${ctx.windowDays}.`,
    whyItMatters:
      "A fall this sharp is far more often a broken deploy, a removed SDK call or a consent banner change " +
      "than a real collapse in usage. Reading it as churn would send you chasing a problem that does not exist.",
    suggestedFix:
      "Confirm the SDK is still initialised and consent is still being granted in your current build, then " +
      "check the inspector for a rise in rejections over the same period.",
    howToVerify: "Volume returns to its previous level, or you confirm the fall is genuine.",
    evidence: { priorEvents: prior, currentEvents: current, change },
  };
}

function checkClockSkew(ctx: Ctx): Finding | null {
  const skewed = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM event_rejections
      WHERE project_id = ? AND reason = 'timestamp_out_of_range' AND received_at >= ?`,
    [ctx.projectId, ctx.from],
  )?.n ?? 0;
  if (skewed < 5) return null;
  return {
    checkId: "clock_skew",
    severity: "warning",
    title: `${skewed} events rejected for an out-of-range timestamp`,
    detail: `Their client clock was more than an hour ahead or more than 30 days behind.`,
    whyItMatters:
      "RetainOS rejects these rather than clamping them, because silently moving an event corrupts every " +
      "time-bucketed metric it touches. The events are lost rather than misplaced.",
    suggestedFix:
      "Send the server's time, or omit the timestamp entirely and let the ingestion endpoint use receipt " +
      "time. Batched offline events should carry the time they were queued.",
    howToVerify: "The timestamp_out_of_range count in the inspector falls to zero.",
    evidence: { rejectedEvents: skewed },
  };
}

/** A running experiment with no exposures produces nothing analysable. */
function checkExperimentExposure(ctx: Ctx): Finding | null {
  const broken = ctx.db.all<{ id: string; name: string; key: string; exposures: number }>(
    `SELECT e.id, e.name, e.key,
            (SELECT COUNT(*) FROM experiment_exposures x WHERE x.experiment_id = e.id) AS exposures
       FROM experiments e
      WHERE e.project_id = ? AND e.status = 'running'`,
    [ctx.projectId],
  ).filter((e) => e.exposures === 0);
  if (broken.length === 0) return null;
  return {
    checkId: "experiment_without_exposure",
    severity: "blocking",
    title: `${broken.length} running experiment(s) have recorded no exposures`,
    detail: broken.map((b) => `"${b.name}" (${b.key})`).join(", ") + ".",
    whyItMatters:
      "Analysis counts exposures, not assignments. With none recorded, these experiments are collecting no " +
      "usable data at all, and every day they run is wasted.",
    suggestedFix:
      "Call the exposure endpoint where the variant is actually rendered, not where it is assigned.",
    howToVerify: "The experiment page shows a rising exposure count for both variants.",
    evidence: { experiments: broken.map((b) => ({ key: b.key, name: b.name })) },
  };
}

/** Subscriptions that cannot be joined to a person are revenue in the dark. */
function checkRevenueConsistency(ctx: Ctx): Finding | null {
  const total = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM customer_subscriptions WHERE project_id = ?", [ctx.projectId],
  )?.n ?? 0;
  if (total === 0) return null;
  const unlinked = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM customer_subscriptions WHERE project_id = ? AND identity_id IS NULL",
    [ctx.projectId],
  )?.n ?? 0;
  if (unlinked === 0 || unlinked / total < 0.2) return null;
  return {
    checkId: "unlinked_subscriptions",
    severity: "warning",
    title: `${unlinked} of ${total} subscriptions are not linked to a user`,
    detail: "These subscriptions have no matching identity in the event store.",
    whyItMatters:
      "Unlinked revenue cannot be connected to product behaviour. Revenue-at-risk, account health and the " +
      "revenue exposure on every friction case all understate the true figure.",
    suggestedFix:
      "Include your own user id in the subscription metadata your billing provider sends, using the same " +
      "value you pass to identify().",
    howToVerify: "The unlinked count falls as new provider events arrive.",
    evidence: { unlinked, total },
  };
}

function checkSdkVersions(ctx: Ctx): Finding | null {
  const versions = ctx.db.all<{ sdk_version: string | null; n: number }>(
    `SELECT sdk_version, COUNT(*) AS n FROM ingest_batches
      WHERE project_id = ? AND received_at >= ? GROUP BY sdk_version`,
    [ctx.projectId, ctx.from],
  ).filter((v) => v.sdk_version);
  if (versions.length <= 1) return null;
  return {
    checkId: "multiple_sdk_versions",
    severity: "advisory",
    title: `${versions.length} SDK versions are sending events`,
    detail: versions.map((v) => `${v.sdk_version} (${v.n} batches)`).join(", ") + ".",
    whyItMatters:
      "Older SDK versions may validate or batch differently. This is usually just a rollout in progress, " +
      "but it is worth knowing when a metric looks inconsistent across clients.",
    suggestedFix: "Roll the older clients forward if the spread persists.",
    howToVerify: "Only one version appears here.",
    evidence: { versions },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Store findings, resolving any that no longer apply.
 *
 * Resolution matters: a check that stops firing should visibly clear rather
 * than linger, so the list stays a to-do rather than an archive.
 */
export function persistFindings(
  db: Db,
  ids: { orgId: string; projectId: string },
  report: DoctorReport,
  now = Date.now(),
): { created: number; resolved: number } {
  const seen = new Set(report.findings.map((f) => f.checkId));
  let created = 0;

  for (const f of report.findings) {
    const existing = db.get<{ id: string }>(
      "SELECT id FROM instrumentation_findings WHERE project_id = ? AND check_id = ?",
      [ids.projectId, f.checkId],
    );
    if (existing) {
      db.run(
        `UPDATE instrumentation_findings SET severity = ?, title = ?, detail = ?, why_it_matters = ?,
           suggested_fix = ?, how_to_verify = ?, evidence = ?, detected_at = ?, resolved_at = NULL
         WHERE id = ?`,
        [f.severity, f.title, f.detail, f.whyItMatters, f.suggestedFix, f.howToVerify,
         JSON.stringify(f.evidence), now, existing.id],
      );
    } else {
      db.run(
        `INSERT INTO instrumentation_findings
          (id, org_id, project_id, check_id, severity, title, detail, why_it_matters,
           suggested_fix, how_to_verify, evidence, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId("ifd"), ids.orgId, ids.projectId, f.checkId, f.severity, f.title, f.detail,
         f.whyItMatters, f.suggestedFix, f.howToVerify, JSON.stringify(f.evidence), now],
      );
      created++;
    }
  }

  const open = db.all<{ id: string; check_id: string }>(
    "SELECT id, check_id FROM instrumentation_findings WHERE project_id = ? AND resolved_at IS NULL",
    [ids.projectId],
  );
  let resolved = 0;
  for (const row of open) {
    if (seen.has(row.check_id)) continue;
    db.run("UPDATE instrumentation_findings SET resolved_at = ? WHERE id = ?", [now, row.id]);
    resolved++;
  }
  return { created, resolved };
}

export function listFindings(db: Db, projectId: string, includeResolved = false) {
  return db.all(
    `SELECT * FROM instrumentation_findings
      WHERE project_id = ? ${includeResolved ? "" : "AND resolved_at IS NULL"}
      ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, detected_at DESC`,
    [projectId],
  );
}

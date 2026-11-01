import { type Db, jsonParse } from "@retainos/database";
import { newId, dayKey, addDays } from "@retainos/shared";
import { activationFunnel, listActivationDefinitions } from "./activation.ts";
import { computeRetention } from "./retention.ts";
import { activeUsers, withStickiness, eventBreakdown } from "./actives.ts";
import { mrrMovement, currenciesInUse } from "./revenue.ts";
import { listInsights } from "./insights.ts";
import { listImpactMeasurements } from "./impact.ts";

export interface WeeklyBrief {
  periodStart: number;
  periodEnd: number;
  timezone: string;
  activity: { activeUsers: number | null; newUsers: number; stickiness: number | null };
  activation: { rate: number | null; priorRate: number | null; registrations: number; warnings: string[] } | null;
  retention: { day7: number | null; priorDay7: number | null; usersCounted: number } | null;
  revenue: Array<{ currency: string; mrrMinor: number; netRevenueRetention: number | null; churnMinor: number; caveats: string[] }>;
  topEvents: Array<{ name: string; uniqueUsers: number }>;
  feedback: { newItems: number; byKind: Record<string, number>; topThemes: Array<{ label: string; count: number }> };
  newInsights: Array<{ id: string; title: string; confidence: string; severity: number }>;
  releasedImprovements: Array<{ id: string; title: string; version: string | null }>;
  experiments: Array<{ key: string; name: string; verdict: string | null }>;
  recommendedInvestigations: string[];
  /** Everything in this brief that could not be computed, and why. */
  gaps: string[];
}

/**
 * The weekly retention brief.
 *
 * Where a figure cannot be computed it is null and the reason is listed in
 * `gaps`. Nothing is filled in with a plausible-looking substitute, because a
 * report a founder cannot trust is worse than a report with holes in it.
 */
export function weeklyBrief(
  db: Db,
  projectId: string,
  input: { timezone: string; now?: number },
): WeeklyBrief {
  const now = input.now ?? Date.now();
  const tz = input.timezone;
  const periodEnd = now;
  const periodStart = now - 7 * 86_400_000;
  const priorStart = periodStart - 7 * 86_400_000;
  const gaps: string[] = [];

  // --- activity ---
  const actives = withStickiness(activeUsers(db, projectId, {
    from: periodStart, to: periodEnd, granularity: "day", timezone: tz, now,
  }));
  const newUsers = actives.points.reduce((s, p) => s + p.newUsers, 0);

  // --- activation ---
  const defs = listActivationDefinitions(db, projectId);
  const def = defs.find((d) => d.isPrimary) ?? defs[0];
  let activation: WeeklyBrief["activation"] = null;
  if (!def) {
    gaps.push("No activation definition is configured, so activation could not be reported. Set one in Activation settings.");
  } else {
    const current = activationFunnel(db, projectId, { definition: def, from: periodStart, to: periodEnd, now });
    const prior = activationFunnel(db, projectId, { definition: def, from: priorStart, to: periodStart - 1, now });
    activation = {
      rate: current.registrations === 0 ? null : current.activationRate,
      priorRate: prior.registrations === 0 ? null : prior.activationRate,
      registrations: current.registrations,
      warnings: current.warnings,
    };
    if (current.registrations === 0) gaps.push("No signups in the last seven days, so there is no activation rate to report.");
  }

  // --- retention ---
  const currentRet = computeRetention(db, projectId, {
    from: periodStart - 14 * 86_400_000, to: periodEnd, timezone: tz, periods: [7], now,
  });
  const priorRet = computeRetention(db, projectId, {
    from: priorStart - 14 * 86_400_000, to: periodStart - 1, timezone: tz, periods: [7], now,
  });
  const d7 = currentRet.averageByPeriod.find((p) => p.period === 7);
  const priorD7 = priorRet.averageByPeriod.find((p) => p.period === 7);
  const retention = d7 ? { day7: d7.rate, priorDay7: priorD7?.rate ?? null, usersCounted: d7.usersCounted } : null;
  if (d7 && d7.rate === null) {
    gaps.push("No cohort has a complete day-7 window in this period, so day-7 retention is not yet knowable.");
  }

  // --- revenue ---
  const currencies = currenciesInUse(db, projectId);
  const revenue = currencies.map((currency) => {
    const m = mrrMovement(db, projectId, { periodStart, periodEnd, currency });
    return {
      currency,
      mrrMinor: m.endMrrMinor,
      netRevenueRetention: m.netRevenueRetention,
      churnMinor: m.churnMinor,
      caveats: m.caveats,
    };
  });
  if (currencies.length === 0) {
    gaps.push("No subscription data is connected, so revenue figures are unavailable. Connect a billing provider or import subscriptions.");
  }

  // --- feedback ---
  const feedbackRows = db.all<{ kind: string; n: number }>(
    "SELECT kind, COUNT(*) AS n FROM feedback_items WHERE project_id = ? AND created_at >= ? AND deleted_at IS NULL GROUP BY kind",
    [projectId, periodStart],
  );
  const byKind: Record<string, number> = {};
  for (const r of feedbackRows) byKind[r.kind] = r.n;
  const topThemes = db.all<{ label: string; count: number }>(
    `SELECT c.label, COUNT(f.id) AS count FROM feedback_clusters c
       JOIN feedback_items f ON f.cluster_id = c.id AND f.created_at >= ? AND f.deleted_at IS NULL
      WHERE c.project_id = ? GROUP BY c.id ORDER BY count DESC LIMIT 5`,
    [periodStart, projectId],
  );

  // --- improvements and experiments ---
  const released = db.all<{ id: string; title: string; version: string | null }>(
    `SELECT t.id, t.title, r.version FROM improvement_tasks t
       LEFT JOIN releases r ON r.id = t.release_id
      WHERE t.project_id = ? AND t.status IN ('released','measuring','resolved') AND t.updated_at >= ?
      ORDER BY t.updated_at DESC LIMIT 10`,
    [projectId, periodStart],
  );
  const experiments = db.all<{ key: string; name: string; verdict: string | null }>(
    `SELECT e.key, e.name,
            (SELECT verdict FROM experiment_results r WHERE r.experiment_id = e.id ORDER BY computed_at DESC LIMIT 1) AS verdict
       FROM experiments e WHERE e.project_id = ? AND e.updated_at >= ? ORDER BY e.updated_at DESC LIMIT 10`,
    [projectId, periodStart],
  );

  const insightRows = db.all<{ id: string; title: string; confidence: string; severity: number; suggested_investigation: string }>(
    `SELECT id, title, confidence, severity, suggested_investigation FROM insights
      WHERE project_id = ? AND created_at >= ? AND dismissed_at IS NULL
      ORDER BY severity DESC LIMIT 10`,
    [projectId, periodStart],
  );

  const recommended: string[] = [];
  for (const row of insightRows.slice(0, 3)) {
    const steps = jsonParse<string[]>(row.suggested_investigation, []);
    if (steps[0]) recommended.push(`${row.title}: ${steps[0]}`);
  }
  if (recommended.length === 0) {
    recommended.push("No high-severity findings this week. Nothing here is a recommendation to act.");
  }

  return {
    periodStart,
    periodEnd,
    timezone: tz,
    activity: { activeUsers: actives.wau, newUsers, stickiness: actives.stickiness },
    activation,
    retention,
    revenue,
    topEvents: eventBreakdown(db, projectId, { from: periodStart, to: periodEnd, limit: 8 })
      .map((e) => ({ name: e.name, uniqueUsers: e.uniqueUsers })),
    feedback: {
      newItems: feedbackRows.reduce((s, r) => s + r.n, 0),
      byKind,
      topThemes: topThemes.map((t) => ({ label: t.label, count: t.count })),
    },
    newInsights: insightRows.map((r) => ({
      id: r.id, title: r.title, confidence: r.confidence, severity: r.severity,
    })),
    releasedImprovements: released,
    experiments,
    recommendedInvestigations: recommended,
    gaps,
  };
}

export function saveReport(
  db: Db,
  ids: { orgId: string; projectId: string; userId?: string },
  kind: string,
  payload: unknown,
  period: { start: number; end: number },
  now = Date.now(),
): string {
  const id = newId("rep");
  db.run(
    `INSERT INTO reports (id, org_id, project_id, kind, period_start, period_end, payload, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ids.orgId, ids.projectId, kind, period.start, period.end, JSON.stringify(payload), now, ids.userId ?? null],
  );
  return id;
}

/** Render a brief as Markdown. Nulls become an explicit "not available". */
export function briefToMarkdown(brief: WeeklyBrief, projectName: string): string {
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "not available" : `${(v * 100).toFixed(1)}%`);
  const money = (minor: number, currency: string) => `${(minor / 100).toLocaleString("en-IN")} ${currency}`;
  const arrow = (a: number | null, b: number | null) => {
    if (a === null || b === null) return "";
    const d = a - b;
    if (Math.abs(d) < 0.001) return " (flat)";
    return ` (${d > 0 ? "+" : ""}${(d * 100).toFixed(1)} pts vs previous week)`;
  };

  const lines: string[] = [
    `# Weekly retention brief — ${projectName}`,
    "",
    `Period: ${new Date(brief.periodStart).toISOString().slice(0, 10)} to ${new Date(brief.periodEnd).toISOString().slice(0, 10)} (${brief.timezone})`,
    "",
    "## Activity",
    "",
    `- Weekly active users: ${brief.activity.activeUsers ?? "not available"}`,
    `- New users: ${brief.activity.newUsers}`,
    `- Stickiness (DAU/MAU): ${pct(brief.activity.stickiness)}`,
    "",
    "## Activation",
    "",
  ];

  if (brief.activation) {
    lines.push(
      `- Activation rate: ${pct(brief.activation.rate)}${arrow(brief.activation.rate, brief.activation.priorRate)}`,
      `- Signups in period: ${brief.activation.registrations}`,
    );
    for (const w of brief.activation.warnings) lines.push(`- Caveat: ${w}`);
  } else {
    lines.push("- Not configured.");
  }

  lines.push("", "## Retention", "");
  if (brief.retention) {
    lines.push(
      `- Day-7 retention: ${pct(brief.retention.day7)}${arrow(brief.retention.day7, brief.retention.priorDay7)}`,
      `- Users in complete cohorts: ${brief.retention.usersCounted}`,
    );
  } else {
    lines.push("- Not available.");
  }

  lines.push("", "## Revenue", "");
  if (brief.revenue.length === 0) {
    lines.push("- No subscription data connected.");
  } else {
    for (const r of brief.revenue) {
      lines.push(
        `- ${r.currency}: MRR ${money(r.mrrMinor, r.currency)}, net revenue retention ${pct(r.netRevenueRetention)}, churned ${money(r.churnMinor, r.currency)}`,
      );
      for (const c of r.caveats) lines.push(`  - Caveat: ${c}`);
    }
  }

  lines.push("", "## Customer feedback", "", `- New items: ${brief.feedback.newItems}`);
  for (const [kind, n] of Object.entries(brief.feedback.byKind)) lines.push(`  - ${kind}: ${n}`);
  for (const t of brief.feedback.topThemes) lines.push(`- Theme "${t.label}": ${t.count} items`);

  lines.push("", "## Findings", "");
  if (brief.newInsights.length === 0) {
    lines.push("- No new findings this week.");
  } else {
    for (const i of brief.newInsights) {
      lines.push(`- [${i.confidence.replace(/_/g, " ")}] ${i.title}`);
    }
  }

  lines.push("", "## Shipped and measured", "");
  if (brief.releasedImprovements.length === 0) lines.push("- No improvements moved to released this week.");
  for (const r of brief.releasedImprovements) lines.push(`- ${r.title}${r.version ? ` (${r.version})` : ""}`);
  for (const e of brief.experiments) {
    lines.push(`- Experiment "${e.name}": ${e.verdict ? e.verdict.replace(/_/g, " ") : "no result yet"}`);
  }

  lines.push("", "## Suggested next investigations", "");
  for (const r of brief.recommendedInvestigations) lines.push(`- ${r}`);

  if (brief.gaps.length > 0) {
    lines.push("", "## What this report could not compute", "");
    for (const g of brief.gaps) lines.push(`- ${g}`);
  }

  lines.push("", "---", "",
    "_Generated by RetainOS from your own project data. Figures are observational unless a controlled " +
    "experiment is named. Nothing in this report establishes a cause._");

  return lines.join("\n");
}

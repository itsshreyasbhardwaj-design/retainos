import { type Db } from "@retainos/database";
import { newId } from "@retainos/shared";
import { weeklyBrief, type WeeklyBrief } from "./reports.ts";
import { runInstrumentationDoctor } from "./instrumentation.ts";
import { rankOpportunities, SCORE_DISCLAIMER } from "./opportunity.ts";
import { listFrictionCases } from "./friction.ts";
import { listAlerts, alertQuality } from "./alerts.ts";
import { impactSummary, REVENUE_IMPACT_DISCLAIMER } from "./revenue-impact.ts";
import { accountHealthRoster, HEALTH_DISCLAIMER, type HealthConfig } from "./health.ts";

/**
 * The founder copilot.
 *
 * What a founder actually needs on a Monday is not a dashboard, it is four
 * answers: what changed, what it probably means, what is not known, and what
 * to do first. This assembles exactly that from the engines that already exist,
 * and the rule throughout is that a section with nothing to say says so.
 *
 * It runs entirely on local rules — no model, no API key, no network. That is
 * partly a cost decision and mostly an honesty one: a generated paragraph
 * reads as confident whether or not the data behind it supports the claim, and
 * every sentence here can be traced to a query.
 */

export type Confidence = "measured" | "qualified" | "uncertain";

export interface BriefFinding {
  /** One sentence. No hedging adverbs; the confidence field carries that. */
  statement: string;
  confidence: Confidence;
  /** The specific figures behind the statement. */
  evidence: string[];
  /** What a reader could do about it, when there is something to do. */
  nextStep: string | null;
}

export interface BriefSection {
  id: string;
  title: string;
  findings: BriefFinding[];
  /** Said when the section is empty, instead of leaving a blank panel. */
  emptyNote: string | null;
}

export interface ExecutiveBrief {
  periodStart: number;
  periodEnd: number;
  generator: "rules_v1";
  headline: string;
  sections: BriefSection[];
  /** Everything the brief could not establish, carried rather than dropped. */
  unknowns: string[];
  disclaimers: string[];
}

export interface BriefInput {
  timezone: string;
  now?: number;
  activationEvent?: string;
  coreEvents?: string[];
}

function section(id: string, title: string, findings: BriefFinding[], emptyNote: string): BriefSection {
  return { id, title, findings, emptyNote: findings.length === 0 ? emptyNote : null };
}

/**
 * Build the brief.
 *
 * Order is deliberate: data quality comes before the numbers it would
 * undermine, because reading a 12% activation fall before learning that the
 * activation event stopped arriving is how people act on nothing.
 */
export function generateBrief(db: Db, projectId: string, input: BriefInput): ExecutiveBrief {
  const now = input.now ?? Date.now();
  const unknowns: string[] = [];
  const sections: BriefSection[] = [];

  // --- data quality first --------------------------------------------------
  const doctor = runInstrumentationDoctor(db, projectId, { timezone: input.timezone, now });
  const blocking = doctor.findings.filter((f) => f.severity === "blocking");
  const qualityFindings: BriefFinding[] = blocking.map((f) => ({
    statement: f.title,
    confidence: "measured",
    evidence: [f.detail, f.whyItMatters],
    nextStep: f.suggestedFix,
  }));
  if (blocking.length === 0) {
    const warnings = doctor.findings.filter((f) => f.severity === "warning");
    for (const f of warnings.slice(0, 3)) {
      qualityFindings.push({
        statement: f.title,
        confidence: "qualified",
        evidence: [f.detail],
        nextStep: f.suggestedFix,
      });
    }
  }
  sections.push(section(
    "data_quality", "Can these numbers be trusted?", qualityFindings,
    `All ${doctor.checksRun} instrumentation checks passed, so nothing below is undermined by the data itself.`,
  ));

  // --- what changed --------------------------------------------------------
  const report = weeklyBrief(db, projectId, { timezone: input.timezone, now });
  const changeFindings: BriefFinding[] = [];

  if (report.activation) {
    const a = report.activation;
    if (a.rate !== null && a.priorRate !== null && a.registrations >= 30) {
      const relative = a.priorRate === 0 ? null : (a.rate - a.priorRate) / a.priorRate;
      if (relative !== null && Math.abs(relative) >= 0.1) {
        changeFindings.push({
          statement: `Activation ${relative > 0 ? "rose" : "fell"} ${Math.abs(relative * 100).toFixed(0)}% week on week.`,
          confidence: a.warnings.length > 0 ? "qualified" : "measured",
          evidence: [
            `${(a.rate * 100).toFixed(1)}% of ${a.registrations} signups activated this week, against ` +
            `${(a.priorRate * 100).toFixed(1)}% last week.`,
            ...a.warnings,
          ],
          nextStep: "Compare the funnel's steps between the two weeks to find which one moved.",
        });
      }
    } else if (a.rate !== null && a.registrations < 30) {
      unknowns.push(
        `Activation moved, but on only ${a.registrations} signups — too few to tell a change from noise.`,
      );
    }
  } else {
    unknowns.push("Activation is not configured, so this brief cannot say whether users are reaching value.");
  }

  for (const r of report.revenue) {
    if (r.netRevenueRetention !== null) {
      changeFindings.push({
        statement:
          `Net revenue retention is ${(r.netRevenueRetention * 100).toFixed(0)}% in ${r.currency}.`,
        confidence: r.caveats.length > 0 ? "qualified" : "measured",
        evidence: [
          `MRR ${r.mrrMinor} minor units; ${r.churnMinor} lost to churn this period.`,
          ...r.caveats,
        ],
        nextStep: r.netRevenueRetention < 1
          ? "Look at which accounts contracted or churned, and whether they share a product problem."
          : null,
      });
    }
  }

  if (report.retention && report.retention.day7 !== null && report.retention.priorDay7 !== null) {
    const change = report.retention.day7 - report.retention.priorDay7;
    if (Math.abs(change) >= 0.05) {
      changeFindings.push({
        statement: `Day-7 retention ${change > 0 ? "improved" : "worsened"} by ` +
          `${Math.abs(change * 100).toFixed(1)} percentage points.`,
        confidence: report.retention.usersCounted >= 100 ? "measured" : "uncertain",
        evidence: [
          `${(report.retention.day7 * 100).toFixed(1)}% against ` +
          `${(report.retention.priorDay7 * 100).toFixed(1)}%, on ${report.retention.usersCounted} users.`,
        ],
        nextStep: null,
      });
    }
  }

  sections.push(section(
    "what_changed", "What changed", changeFindings,
    "No metric moved far enough this week to be worth reporting. A quiet week is a result, not a gap.",
  ));

  // --- what is worth doing -------------------------------------------------
  const ranked = rankOpportunities(db, { orgId: "", projectId }, { now }).slice(0, 3);
  const cases = listFrictionCases(db, projectId, { limit: 50 });
  const byId = new Map(cases.map((c) => [c["id"] as string, c]));
  const opportunityFindings: BriefFinding[] = ranked.map((score) => {
    const record = byId.get(score.caseId);
    const title = (record?.["title"] as string) ?? score.caseId;
    const top = [...score.factors].sort((a, b) => b.contribution - a.contribution)[0];
    return {
      statement: title,
      confidence: (record?.["confidence"] as string) === "strong_supporting_evidence"
        ? "measured"
        : (record?.["confidence"] as string) === "insufficient_data" ? "uncertain" : "qualified",
      evidence: [
        `Ranked ${score.score.toFixed(1)} out of 100, driven mostly by ${top?.label ?? "no single factor"}.`,
        `${record?.["affected_users"] ?? 0} affected user(s); ` +
        `${record?.["evidence_count"] ?? 0} piece(s) of evidence.`,
      ],
      nextStep: score.howToImprove,
    };
  });
  sections.push(section(
    "what_to_do", "What is worth doing next", opportunityFindings,
    "No friction cases are open. Either the detectors found nothing, or they have not run yet.",
  ));

  // --- what needs attention now -------------------------------------------
  const alerts = listAlerts(db, projectId, { now, limit: 10 });
  const alertFindings: BriefFinding[] = alerts
    .filter((a) => a.severity === "critical" || a.severity === "high")
    .map((a) => ({
      statement: a.title,
      confidence: "measured",
      evidence: [a.metricDetail, a.comparisonDetail, a.dataQuality],
      nextStep: a.suggestedAction,
    }));
  sections.push(section(
    "attention", "Anything on fire", alertFindings,
    "No high-severity alerts are open.",
  ));

  // --- customers worth a conversation -------------------------------------
  const healthConfig: HealthConfig = {
    now, activationEvent: input.activationEvent, coreEvents: input.coreEvents,
  };
  const roster = accountHealthRoster(db, projectId, { ...healthConfig, limit: 50 })
    .filter((r) => r.state === "attention_suggested")
    .slice(0, 3);
  const healthFindings: BriefFinding[] = roster.map((r) => ({
    statement: `${r.subjectId} is worth a conversation.`,
    confidence: "qualified",
    evidence: [
      `${r.subjects} known user(s) on the account.`,
      r.topConcern ? `Heaviest concern: ${r.topConcern}.` : "No single concern dominates.",
      r.mrrMinor !== null ? `${r.mrrMinor} ${r.currency ?? ""} minor units of MRR.` : "No linked subscription.",
    ],
    nextStep: "Talk to them before acting on the signals.",
  }));
  sections.push(section(
    "customers", "Customers worth a conversation", healthFindings,
    "No account's signals suggest it needs attention this week.",
  ));

  // --- what we learned about our own work ---------------------------------
  const impact = impactSummary(db, projectId);
  const impactFindings: BriefFinding[] = impact.buckets.map((b) => ({
    statement:
      `${b.records} record(s) of ${b.classification.replace(/_/g, " ")} revenue impact, ` +
      `totalling ${b.totalMinor} ${b.currency} minor units.`,
    confidence: b.classification === "observed" || b.classification === "experiment_supported"
      ? "measured"
      : b.classification === "estimated" ? "qualified" : "uncertain",
    evidence: [b.meaning],
    nextStep: null,
  }));
  if (impact.recordsWithoutAmount > 0) {
    unknowns.push(
      `${impact.recordsWithoutAmount} impact record(s) carry no figure, because the evidence did not support one.`,
    );
  }
  sections.push(section(
    "impact", "What our work was worth", impactFindings,
    "No revenue impact has been recorded yet. Nothing is claimed in its absence.",
  ));

  // --- unknowns ------------------------------------------------------------
  unknowns.push(...report.gaps);
  const quality = alertQuality(db, projectId, { now });
  if (quality.totalFired >= 3 && (quality.overallAcknowledgementRate ?? 1) <= 0.2) {
    unknowns.push(
      `${quality.totalFired} alerts fired in the last ${quality.windowDays} days and almost none were ` +
      "acknowledged, which usually means the thresholds are wrong rather than that nothing matters.",
    );
  }

  const headline = headlineFor(blocking.length, changeFindings, alertFindings);

  return {
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    generator: "rules_v1",
    headline,
    sections,
    unknowns: [...new Set(unknowns)],
    disclaimers: [SCORE_DISCLAIMER, REVENUE_IMPACT_DISCLAIMER, HEALTH_DISCLAIMER],
  };
}

function headlineFor(
  blocking: number, changes: BriefFinding[], alerts: BriefFinding[],
): string {
  if (blocking > 0) {
    return `Start with the data: ${blocking} blocking instrumentation issue(s) make some of this week's ` +
      "numbers unreliable.";
  }
  if (alerts.length > 0) return `${alerts.length} high-severity alert(s) are open.`;
  if (changes.length > 0) return `${changes.length} metric(s) moved enough to be worth reading.`;
  return "Nothing moved far enough to report, and nothing is on fire. That is the finding.";
}

export function saveBrief(
  db: Db,
  ids: { orgId: string; projectId: string; userId?: string },
  brief: ExecutiveBrief,
  now = Date.now(),
): { id: string } {
  const id = newId("ebf");
  db.run(
    `INSERT INTO executive_briefs
      (id, org_id, project_id, period_start, period_end, payload, generator, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ids.orgId, ids.projectId, brief.periodStart, brief.periodEnd,
     JSON.stringify(brief), brief.generator, now, ids.userId ?? null],
  );
  return { id };
}

export function listBriefs(db: Db, projectId: string, limit = 20) {
  return db.all<{ id: string; period_start: number; period_end: number; created_at: number }>(
    `SELECT id, period_start, period_end, created_at FROM executive_briefs
      WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
    [projectId, limit],
  );
}

export function getBrief(db: Db, projectId: string, briefId: string): ExecutiveBrief | null {
  const row = db.get<{ payload: string }>(
    "SELECT payload FROM executive_briefs WHERE project_id = ? AND id = ?", [projectId, briefId],
  );
  if (!row) return null;
  try { return JSON.parse(row.payload) as ExecutiveBrief; } catch { return null; }
}

/** The brief as Markdown, for the people who would rather read an email. */
export function executiveBriefToMarkdown(brief: ExecutiveBrief, projectName: string): string {
  const lines: string[] = [];
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  lines.push(`# ${projectName} — ${date(brief.periodStart)} to ${date(brief.periodEnd)}`);
  lines.push("");
  lines.push(brief.headline);
  lines.push("");

  for (const s of brief.sections) {
    lines.push(`## ${s.title}`);
    if (s.findings.length === 0) {
      lines.push(s.emptyNote ?? "Nothing to report.");
      lines.push("");
      continue;
    }
    for (const f of s.findings) {
      lines.push(`- **${f.statement}** _(${f.confidence})_`);
      for (const e of f.evidence) lines.push(`  - ${e}`);
      if (f.nextStep) lines.push(`  - Next: ${f.nextStep}`);
    }
    lines.push("");
  }

  if (brief.unknowns.length > 0) {
    lines.push("## What this brief cannot tell you");
    for (const u of brief.unknowns) lines.push(`- ${u}`);
    lines.push("");
  }
  lines.push("---");
  for (const d of brief.disclaimers) lines.push(`_${d}_`);
  return lines.join("\n");
}

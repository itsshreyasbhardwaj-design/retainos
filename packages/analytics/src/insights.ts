import { type Db } from "@retainos/database";
import { newId, dayKey, addDays, type Result, ok } from "@retainos/shared";
import { assessConfidence, type ConfidenceLabel } from "./confidence.ts";
import { computeFunnel, type FunnelStep } from "./funnels.ts";
import { activationFunnel, listActivationDefinitions } from "./activation.ts";
import { computeRetention } from "./retention.ts";
import { revenueAtRisk, currenciesInUse } from "./revenue.ts";
import { ingestHealth } from "@retainos/database";

export interface GeneratedInsight {
  kind: string;
  title: string;
  /** What was measured. A fact. */
  observation: string;
  /** What might explain it. Explicitly labelled guesses. */
  hypotheses: string[];
  suggestedInvestigation: string[];
  limitations: string[];
  confidence: ConfidenceLabel;
  confidenceBasis: string;
  /** 0-100. Drives ordering only; it is not a probability. */
  severity: number;
  affectedUsers: number | null;
  metricDefinition: string;
  period: { start: number; end: number };
  comparison: { start: number; end: number } | null;
  evidence: Array<{ kind: string; referenceId?: string | null; summary: string; snapshot: Record<string, unknown> }>;
  dedupeKey: string;
  /** Always truthful about what produced this text. */
  generator: "rules_v1";
}

/**
 * RetainAI's analysis engine.
 *
 * This is a deterministic rule engine, not a language model, and it says so in
 * every record it writes. It runs with no API key, no network access and no
 * per-query cost. An optional language-model adapter can rephrase these
 * findings for readability, but it never computes the numbers and never
 * invents a finding — see docs/RETAIN_AI.md.
 *
 * Every rule below follows the same discipline: state the measurement, keep
 * hypotheses separate from it, say what would settle the question, and state
 * what the measurement cannot tell you.
 */
export function generateInsights(
  db: Db,
  projectId: string,
  input: { timezone: string; now?: number; lookbackDays?: number },
): GeneratedInsight[] {
  const now = input.now ?? Date.now();
  const lookback = input.lookbackDays ?? 28;
  const tz = input.timezone;
  const periodEnd = now;
  const periodStart = now - lookback * 86_400_000;
  const comparisonEnd = periodStart - 1;
  const comparisonStart = periodStart - lookback * 86_400_000;

  const insights: GeneratedInsight[] = [];
  const period = { start: periodStart, end: periodEnd };
  const comparison = { start: comparisonStart, end: comparisonEnd };

  insights.push(...activationDropOffRule(db, projectId, { tz, now, period, comparison }));
  insights.push(...activationTrendRule(db, projectId, { tz, now, period, comparison }));
  insights.push(...retentionTrendRule(db, projectId, { tz, now, period, comparison }));
  insights.push(...feedbackClusterRule(db, projectId, { period }));
  insights.push(...instrumentationHealthRule(db, projectId, { period }));
  insights.push(...revenueRiskRule(db, projectId, { now, period }));
  insights.push(...featureAdoptionRule(db, projectId, { tz, period }));

  return insights.sort((a, b) => b.severity - a.severity);
}

// ---------------------------------------------------------------------------

function activationDropOffRule(
  db: Db,
  projectId: string,
  ctx: { tz: string; now: number; period: { start: number; end: number }; comparison: { start: number; end: number } },
): GeneratedInsight[] {
  const defs = listActivationDefinitions(db, projectId);
  const def = defs.find((d) => d.isPrimary) ?? defs[0];
  if (!def) return [];

  const steps: FunnelStep[] = [
    { event: def.signupEvent, label: "Registered" },
    { event: "onboarding_started", label: "Onboarding started" },
    { event: "onboarding_completed", label: "Onboarding completed" },
    { event: def.activationEvent, label: `Activated (${def.activationEvent})` },
  ];
  const funnel = computeFunnel(db, projectId, {
    steps, from: ctx.period.start, to: ctx.period.end, conversionWindowHours: def.windowDays * 24,
  });
  if (!funnel.ok || !funnel.value.largestDropOff) return [];

  const drop = funnel.value.largestDropOff;
  const fromStep = funnel.value.steps[drop.fromIndex]!;
  const toStep = funnel.value.steps[drop.toIndex]!;
  const lossRate = fromStep.users === 0 ? 0 : drop.lostUsers / fromStep.users;

  const conf = assessConfidence({
    affectedUsers: drop.lostUsers,
    population: fromStep.users,
    effectSize: lossRate,
    periodComplete: true,
  });

  return [{
    kind: "activation_drop_off",
    title: `Largest onboarding drop-off: ${fromStep.label} → ${toStep.label}`,
    observation:
      `${drop.lostUsers} of ${fromStep.users} users who reached "${fromStep.label}" did not reach ` +
      `"${toStep.label}" within ${def.windowDays} days. That is a step conversion of ` +
      `${(drop.conversionRate * 100).toFixed(1)}%, the largest absolute loss in the activation funnel.`,
    hypotheses: [
      `The "${toStep.label}" step may be harder or less obvious than intended.`,
      "Users may be hitting an error, a slow response, or a required field they cannot satisfy.",
      "The step may not be where users expect it, so they leave to look elsewhere.",
      `Some of these users may simply not have needed "${toStep.label}" yet.`,
    ],
    suggestedInvestigation: [
      `Check whether any error or failure events accompany "${fromStep.event}" for the users who stopped.`,
      `Compare this step's conversion across plan, device and acquisition source to see whether the loss is concentrated.`,
      `Read the feedback items that mention this part of the product.`,
      `Look at the median time from "${fromStep.label}" to "${toStep.label}" for the users who did convert.`,
    ],
    limitations: [
      "A funnel drop-off shows where users stopped, not why. Nothing here establishes a cause.",
      "Users who have not yet had the full window still count as not converted.",
      ...(funnel.value.sampleWarning ? [funnel.value.sampleWarning] : []),
    ],
    confidence: conf.label,
    confidenceBasis: conf.basis,
    severity: Math.min(100, Math.round(lossRate * 70 + Math.min(30, drop.lostUsers / 10))),
    affectedUsers: drop.lostUsers,
    metricDefinition: funnel.value.definition.countingMethod,
    period: ctx.period,
    comparison: null,
    evidence: [{
      kind: "funnel_step",
      summary: `${fromStep.label} → ${toStep.label}: ${toStep.users}/${fromStep.users} users (${(drop.conversionRate * 100).toFixed(1)}%)`,
      snapshot: {
        fromEvent: fromStep.event, toEvent: toStep.event,
        fromUsers: fromStep.users, toUsers: toStep.users,
        conversionRate: drop.conversionRate, lostUsers: drop.lostUsers,
        conversionWindowHours: def.windowDays * 24,
      },
    }],
    dedupeKey: `activation_drop_off:${fromStep.event}:${toStep.event}`,
    generator: "rules_v1",
  }];
}

function activationTrendRule(
  db: Db,
  projectId: string,
  ctx: { tz: string; now: number; period: { start: number; end: number }; comparison: { start: number; end: number } },
): GeneratedInsight[] {
  const defs = listActivationDefinitions(db, projectId);
  const def = defs.find((d) => d.isPrimary) ?? defs[0];
  if (!def) return [];

  const current = activationFunnel(db, projectId, { definition: def, from: ctx.period.start, to: ctx.period.end, now: ctx.now });
  const prior = activationFunnel(db, projectId, { definition: def, from: ctx.comparison.start, to: ctx.comparison.end, now: ctx.now });
  if (prior.registrations < 10 || current.registrations < 10) return [];

  const delta = current.activationRate - prior.activationRate;
  // Only report a move worth a founder's attention.
  if (Math.abs(delta) < 0.05) return [];

  const worse = delta < 0;
  const conf = assessConfidence({
    affectedUsers: current.registrations,
    population: current.registrations + prior.registrations,
    effectSize: Math.abs(delta),
    periodComplete: current.warnings.every((w) => !/window is still open/.test(w)),
  });

  const releases = db.all<{ version: string; released_at: number }>(
    "SELECT version, released_at FROM releases WHERE project_id = ? AND released_at >= ? AND released_at <= ?",
    [projectId, ctx.period.start, ctx.period.end],
  );

  return [{
    kind: worse ? "activation_declined" : "activation_improved",
    title: worse
      ? `Activation fell by ${(Math.abs(delta) * 100).toFixed(1)} points`
      : `Activation rose by ${(delta * 100).toFixed(1)} points`,
    observation:
      `Activation was ${(prior.activationRate * 100).toFixed(1)}% for the ${prior.registrations} users who signed up in ` +
      `the previous period and ${(current.activationRate * 100).toFixed(1)}% for the ${current.registrations} users who ` +
      `signed up in this one, measured as "${def.activationEvent}" within ${def.windowDays} days of signup.`,
    hypotheses: worse
      ? [
          "A recent change may have made the activation path harder.",
          "The mix of users arriving may have shifted towards people less likely to activate.",
          "An error or performance regression may be blocking part of the path.",
          "This may be ordinary period-to-period variation rather than a real change.",
        ]
      : [
          "A recent change may have made the activation path easier.",
          "The mix of users arriving may have shifted towards people more likely to activate.",
          "This may be ordinary period-to-period variation rather than a real change.",
        ],
    suggestedInvestigation: [
      "Break the rate down by acquisition source to see whether the traffic mix changed.",
      releases.length > 0
        ? `Check the ${releases.length} release(s) in this window (${releases.map((r) => r.version).join(", ")}) against the change.`
        : "No releases were recorded in this window; check whether anything shipped without being logged.",
      "Compare the step-by-step activation funnel between the two periods to locate where the change happened.",
      "If you want a causal answer rather than a correlation, run a controlled experiment.",
    ],
    limitations: [
      "This is a period-over-period comparison, not a controlled experiment. It cannot attribute the change to any cause.",
      "Two adjacent periods differ in many ways at once: traffic mix, seasonality and concurrent releases among them.",
      ...current.warnings,
    ],
    confidence: conf.label,
    confidenceBasis: conf.basis,
    severity: worse ? Math.min(100, Math.round(Math.abs(delta) * 200)) : Math.min(40, Math.round(delta * 100)),
    affectedUsers: current.registrations,
    metricDefinition: current.definition,
    period: ctx.period,
    comparison: ctx.comparison,
    evidence: [{
      kind: "activation_metric",
      summary: `Activation ${(prior.activationRate * 100).toFixed(1)}% → ${(current.activationRate * 100).toFixed(1)}%`,
      snapshot: {
        priorRate: prior.activationRate, currentRate: current.activationRate,
        priorRegistrations: prior.registrations, currentRegistrations: current.registrations,
        priorActivated: prior.activated, currentActivated: current.activated,
        activationEvent: def.activationEvent, windowDays: def.windowDays,
      },
    }],
    dedupeKey: `activation_trend:${def.activationEvent}:${dayKey(ctx.period.start, ctx.tz)}`,
    generator: "rules_v1",
  }];
}

function retentionTrendRule(
  db: Db,
  projectId: string,
  ctx: { tz: string; now: number; period: { start: number; end: number }; comparison: { start: number; end: number } },
): GeneratedInsight[] {
  const current = computeRetention(db, projectId, {
    from: ctx.period.start, to: ctx.period.end, timezone: ctx.tz, periods: [7], now: ctx.now,
  });
  const prior = computeRetention(db, projectId, {
    from: ctx.comparison.start, to: ctx.comparison.end, timezone: ctx.tz, periods: [7], now: ctx.now,
  });

  const c = current.averageByPeriod.find((p) => p.period === 7);
  const p = prior.averageByPeriod.find((p) => p.period === 7);
  if (!c?.rate || !p?.rate || c.usersCounted < 20 || p.usersCounted < 20) return [];

  const delta = c.rate - p.rate;
  if (Math.abs(delta) < 0.05) return [];

  const worse = delta < 0;
  const conf = assessConfidence({
    affectedUsers: c.usersCounted,
    population: c.usersCounted + p.usersCounted,
    effectSize: Math.abs(delta),
    periodComplete: true,
  });

  return [{
    kind: worse ? "retention_declined" : "retention_improved",
    title: worse
      ? `Day-7 retention fell by ${(Math.abs(delta) * 100).toFixed(1)} points`
      : `Day-7 retention rose by ${(delta * 100).toFixed(1)} points`,
    observation:
      `Day-7 retention was ${(p.rate * 100).toFixed(1)}% across ${p.usersCounted} users in the previous period and ` +
      `${(c.rate * 100).toFixed(1)}% across ${c.usersCounted} users in this one. Only cohorts whose day-7 window has ` +
      `fully elapsed are included.`,
    hypotheses: worse
      ? [
          "Users may be reaching the product's value later, or not at all.",
          "A change may have broken or complicated a routine task users return for.",
          "The cohorts may be made up of different kinds of user.",
          "This may be normal cohort-to-cohort variation.",
        ]
      : [
          "Users may be reaching value sooner, or finding more reason to return.",
          "The cohorts may be made up of different kinds of user.",
          "This may be normal cohort-to-cohort variation.",
        ],
    suggestedInvestigation: [
      "Compare the two cohorts' activation rates: retention usually follows activation.",
      "Check which features the retained users adopted that the lapsed ones did not.",
      "Read feedback submitted by users in the weaker cohort.",
      "Compare retention by acquisition source to rule out a traffic-mix change.",
    ],
    limitations: [
      "Cohort comparisons are observational. A difference between cohorts is not an effect of anything in particular.",
      "Day-7 retention says nothing about products used less often than weekly.",
      current.definition.denominator,
    ],
    confidence: conf.label,
    confidenceBasis: conf.basis,
    severity: worse ? Math.min(100, Math.round(Math.abs(delta) * 180)) : Math.min(35, Math.round(delta * 100)),
    affectedUsers: c.usersCounted,
    metricDefinition: current.definition.returnDefinition,
    period: ctx.period,
    comparison: ctx.comparison,
    evidence: [{
      kind: "retention_cohort",
      summary: `Day-7 retention ${(p.rate * 100).toFixed(1)}% → ${(c.rate * 100).toFixed(1)}%`,
      snapshot: {
        priorRate: p.rate, currentRate: c.rate,
        priorUsers: p.usersCounted, currentUsers: c.usersCounted,
        priorCohorts: p.cohortsCounted, currentCohorts: c.cohortsCounted,
      },
    }],
    dedupeKey: `retention_trend:d7:${dayKey(ctx.period.start, ctx.tz)}`,
    generator: "rules_v1",
  }];
}

function feedbackClusterRule(
  db: Db,
  projectId: string,
  ctx: { period: { start: number; end: number } },
): GeneratedInsight[] {
  const clusters = db.all<{ id: string; label: string; keywords: string; live_count: number }>(
    `SELECT c.id, c.label, c.keywords,
            (SELECT COUNT(*) FROM feedback_items f
               WHERE f.cluster_id = c.id AND f.deleted_at IS NULL
                 AND f.created_at >= ? AND f.created_at <= ?) AS live_count
       FROM feedback_clusters c WHERE c.project_id = ?
      ORDER BY live_count DESC LIMIT 5`,
    [ctx.period.start, ctx.period.end, projectId],
  ).filter((c) => c.live_count >= 3);

  return clusters.map((c) => {
    const items = db.all<{ id: string; title: string; kind: string }>(
      `SELECT id, title, kind FROM feedback_items
        WHERE cluster_id = ? AND deleted_at IS NULL AND created_at >= ? AND created_at <= ?
        ORDER BY created_at DESC LIMIT 5`,
      [c.id, ctx.period.start, ctx.period.end],
    );
    const conf = assessConfidence({ affectedUsers: c.live_count, effectSize: undefined, periodComplete: true });
    return {
      kind: "feedback_theme",
      title: `${c.live_count} reports about: ${c.label}`,
      observation:
        `${c.live_count} feedback items submitted in this period share the terms "${c.label}". ` +
        `Examples: ${items.slice(0, 3).map((i) => `"${i.title}"`).join("; ")}.`,
      hypotheses: [
        "These reports may all describe one underlying problem.",
        "They may be separate problems that happen to share vocabulary.",
        "The grouping itself may be wrong; it is based on shared words, not meaning.",
      ],
      suggestedInvestigation: [
        "Read the grouped items and decide whether they are genuinely the same issue.",
        "Check whether telemetry shows a matching failure or drop-off in that part of the product.",
        "Count how many distinct users these reports come from, not just how many reports there are.",
      ],
      limitations: [
        "Clustering is by shared terms, not by meaning, and it is a suggestion a human should correct.",
        "Report volume reflects who chose to write in. It is not a measure of how many users are affected.",
        "Feedback volume is not evidence of verified demand or of imminent cancellation.",
      ],
      confidence: conf.label,
      confidenceBasis: conf.basis,
      severity: Math.min(80, 20 + c.live_count * 4),
      affectedUsers: c.live_count,
      metricDefinition: "Count of feedback items grouped by term overlap, submitted inside the period.",
      period: ctx.period,
      comparison: null,
      evidence: [
        {
          kind: "feedback_cluster",
          referenceId: c.id,
          summary: `${c.live_count} items in cluster "${c.label}"`,
          snapshot: { label: c.label, keywords: c.keywords, count: c.live_count },
        },
        ...items.map((i) => ({
          kind: "feedback_item",
          referenceId: i.id,
          summary: i.title,
          snapshot: { kind: i.kind },
        })),
      ],
      dedupeKey: `feedback_theme:${c.id}`,
      generator: "rules_v1" as const,
    };
  });
}

function instrumentationHealthRule(
  db: Db,
  projectId: string,
  ctx: { period: { start: number; end: number } },
): GeneratedInsight[] {
  const health = ingestHealth(db, projectId, ctx.period.start);
  if (health.acceptanceRate === null || health.acceptanceRate >= 0.95) return [];
  const rejected = health.rejected;
  if (rejected < 10) return [];

  const top = [...health.byReason].sort((a, b) => b.n - a.n)[0];
  return [{
    kind: "instrumentation_health",
    title: `${(100 - health.acceptanceRate * 100).toFixed(1)}% of events were rejected`,
    observation:
      `${rejected} of ${health.accepted + rejected} events sent in this period were rejected. ` +
      `The most common reason was "${top?.reason}" (${top?.n} events).`,
    hypotheses: [
      "The SDK integration may be sending event names or properties that do not match the schema registry.",
      "A consent gate may not be granting consent before events are sent.",
      "A deploy may have introduced a malformed event.",
    ],
    suggestedInvestigation: [
      "Open the event inspector and read the rejection reasons directly.",
      "Compare the rejected event names against the schema registry.",
      "Check the SDK's own diagnostics in the failing client.",
    ],
    limitations: [
      "Rejected events are not stored, so any metric covering this period is computed on incomplete data.",
      "This affects the reliability of every other number in this report for the same window.",
    ],
    confidence: assessConfidence({ affectedUsers: rejected, effectSize: 1 - health.acceptanceRate, periodComplete: true }).label,
    confidenceBasis: `Based on ${rejected} rejected events out of ${health.accepted + rejected} received, which is a direct count rather than a sample.`,
    severity: Math.min(95, Math.round((1 - health.acceptanceRate) * 150)),
    affectedUsers: null,
    metricDefinition: "Accepted events divided by accepted plus rejected events, over the period.",
    period: ctx.period,
    comparison: null,
    evidence: [{
      kind: "event_metric",
      summary: `Acceptance rate ${(health.acceptanceRate * 100).toFixed(1)}%`,
      snapshot: { accepted: health.accepted, rejected, byReason: health.byReason },
    }],
    dedupeKey: `instrumentation_health:${top?.reason ?? "unknown"}`,
    generator: "rules_v1",
  }];
}

function revenueRiskRule(
  db: Db,
  projectId: string,
  ctx: { now: number; period: { start: number; end: number } },
): GeneratedInsight[] {
  const currencies = currenciesInUse(db, projectId);
  if (currencies.length === 0) return [];
  const out: GeneratedInsight[] = [];

  // Format money the way the rest of the product does, rather than printing
  // raw minor units into a sentence a founder has to decode.
  const amount = (minor: number, currency: string) => {
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency", currency, maximumFractionDigits: 0,
      }).format(minor / 100);
    } catch {
      return `${(minor / 100).toLocaleString("en-IN")} ${currency}`;
    }
  };

  for (const currency of currencies) {
    const risk = revenueAtRisk(db, projectId, { thresholdDays: 14, currency, now: ctx.now });
    if (risk.inactivePaidCount === 0 && risk.paymentFailureCount === 0) continue;
    const total = risk.inactivePaidMrrMinor + risk.paymentFailureMrrMinor;
    if (total === 0) continue;

    const conf = assessConfidence({
      affectedUsers: risk.inactivePaidCount + risk.paymentFailureCount,
      periodComplete: true,
    });

    out.push({
      kind: "revenue_at_risk",
      title: `${amount(total, currency)} of MRR is attached to at-risk subscriptions`,
      observation:
        `${risk.inactivePaidCount} paying subscription${risk.inactivePaidCount === 1 ? "" : "s"} ` +
        `(${amount(risk.inactivePaidMrrMinor, currency)} MRR) belong to users with no product activity for ` +
        `over ${risk.thresholdDays} days. ${risk.paymentFailureCount} subscription` +
        `${risk.paymentFailureCount === 1 ? " is" : "s are"} in a failed-payment state ` +
        `(${amount(risk.paymentFailureMrrMinor, currency)} MRR).`,
      hypotheses: [
        "Some of these customers may have stopped getting value from the product.",
        "Some may use the product seasonally or through a teammate's account.",
        "Failed payments are often an expired card rather than a decision to leave.",
      ],
      suggestedInvestigation: [
        "Check whether the inactive accounts ever activated, or whether they never got started.",
        "For failed payments, confirm the provider's dunning process is actually running.",
        "Look at what the active paying accounts do that these ones do not.",
      ],
      limitations: [
        risk.label,
        "Inactivity is measured against a threshold you configured. It does not predict cancellation.",
        "No amount here is promised recoverable.",
      ],
      confidence: conf.label,
      confidenceBasis: conf.basis,
      severity: Math.min(90, 30 + risk.inactivePaidCount * 3 + risk.paymentFailureCount * 6),
      affectedUsers: risk.inactivePaidCount + risk.paymentFailureCount,
      metricDefinition:
        "Normalised monthly amounts on subscriptions in active or past_due status, grouped by observed state. " +
        "Annual plans divided by 12, quarterly by 3.",
      period: ctx.period,
      comparison: null,
      evidence: [{
        kind: "revenue_metric",
        summary: `${amount(total, currency)} MRR at risk`,
        snapshot: { ...risk },
      }],
      dedupeKey: `revenue_at_risk:${currency}`,
      generator: "rules_v1",
    });
  }
  return out;
}

function featureAdoptionRule(
  db: Db,
  projectId: string,
  ctx: { tz: string; period: { start: number; end: number } },
): GeneratedInsight[] {
  const recentReleases = db.all<{ id: string; version: string; released_at: number }>(
    "SELECT id, version, released_at FROM releases WHERE project_id = ? AND released_at >= ? ORDER BY released_at DESC LIMIT 3",
    [projectId, ctx.period.start],
  );
  if (recentReleases.length === 0) return [];

  const features = db.all<{ key: string; label: string; event_name: string }>(
    "SELECT key, label, event_name FROM tracked_features WHERE project_id = ?", [projectId],
  );
  if (features.length === 0) return [];

  const activeUsers = db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT identity_id) AS n FROM analytics_events
      WHERE project_id = ? AND occurred_at >= ? AND occurred_at <= ?`,
    [projectId, ctx.period.start, ctx.period.end],
  )?.n ?? 0;
  if (activeUsers < 20) return [];

  const out: GeneratedInsight[] = [];
  for (const f of features) {
    const users = db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT identity_id) AS n FROM analytics_events
        WHERE project_id = ? AND name = ? AND occurred_at >= ? AND occurred_at <= ?`,
      [projectId, f.event_name, ctx.period.start, ctx.period.end],
    )?.n ?? 0;
    const adoption = users / activeUsers;
    if (adoption >= 0.05) continue; // only flag genuinely low adoption

    out.push({
      kind: "low_feature_adoption",
      title: `"${f.label}" was used by ${(adoption * 100).toFixed(1)}% of active users`,
      observation:
        `${users} of ${activeUsers} active users fired "${f.event_name}" in this period, which is ` +
        `${(adoption * 100).toFixed(1)}% adoption.`,
      hypotheses: [
        "Users may not be able to find the feature.",
        "The feature may not solve a problem this audience has.",
        "The feature may be for a narrow segment, in which case low overall adoption is expected and fine.",
        "The event may not be instrumented everywhere the feature is used.",
      ],
      suggestedInvestigation: [
        "Confirm the event fires on every path into the feature before concluding anything about usage.",
        "Check adoption within the segment the feature was built for, rather than across everyone.",
        "Look at whether the users who did adopt it came back to it.",
      ],
      limitations: [
        "Low adoption of a deliberately niche feature is not a problem. Context decides.",
        "Adoption measured against all active users understates adoption within a target segment.",
        "This is not evidence that the feature should be removed.",
      ],
      confidence: assessConfidence({ affectedUsers: activeUsers, effectSize: undefined, periodComplete: true }).label,
      confidenceBasis: `Based on ${activeUsers} active users in the period; the adoption count itself is a direct count.`,
      severity: 25,
      affectedUsers: users,
      metricDefinition: "Distinct users firing the feature's event, divided by distinct active users, over the period.",
      period: ctx.period,
      comparison: null,
      evidence: [{
        kind: "event_metric",
        summary: `${users}/${activeUsers} active users used ${f.label}`,
        snapshot: { feature: f.key, eventName: f.event_name, users, activeUsers, adoption },
      }],
      dedupeKey: `low_feature_adoption:${f.key}`,
      generator: "rules_v1",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Persist generated insights, deduplicated, and record the run honestly. */
export function persistInsights(
  db: Db,
  ids: { orgId: string; projectId: string },
  insights: GeneratedInsight[],
  now = Date.now(),
): { created: number; skipped: number; runId: string } {
  const runId = newId("anr");
  db.run(
    `INSERT INTO analysis_runs (id, org_id, project_id, kind, started_at, generator)
     VALUES (?, ?, ?, 'insight_generation', ?, 'rules_v1')`,
    [runId, ids.orgId, ids.projectId, now],
  );

  let created = 0;
  let skipped = 0;
  for (const insight of insights) {
    const existing = db.get<{ id: string }>(
      "SELECT id FROM insights WHERE project_id = ? AND dedupe_key = ?", [ids.projectId, insight.dedupeKey],
    );
    if (existing) {
      skipped++;
      continue;
    }
    const id = newId("ins");
    db.run(
      `INSERT INTO insights
        (id, org_id, project_id, kind, title, observation, hypotheses, suggested_investigation, limitations,
         confidence, confidence_basis, severity, affected_users, metric_definition,
         period_start, period_end, comparison_start, comparison_end, generator, created_at, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, ids.orgId, ids.projectId, insight.kind, insight.title, insight.observation,
        JSON.stringify(insight.hypotheses), JSON.stringify(insight.suggestedInvestigation),
        JSON.stringify(insight.limitations), insight.confidence, insight.confidenceBasis,
        insight.severity, insight.affectedUsers, insight.metricDefinition,
        insight.period.start, insight.period.end,
        insight.comparison?.start ?? null, insight.comparison?.end ?? null,
        insight.generator, now, insight.dedupeKey,
      ],
    );
    for (const e of insight.evidence) {
      db.run(
        `INSERT INTO insight_evidence (id, org_id, insight_id, kind, reference_id, snapshot, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId("ie"), ids.orgId, id, e.kind, e.referenceId ?? null, JSON.stringify(e.snapshot), e.summary],
      );
    }
    created++;
  }

  db.run(
    "UPDATE analysis_runs SET finished_at = ?, insights_created = ? WHERE id = ?",
    [Date.now(), created, runId],
  );
  return { created, skipped, runId };
}

export function listInsights(db: Db, projectId: string, opts: { limit?: number; includeDismissed?: boolean } = {}) {
  return db.all(
    `SELECT i.*, (SELECT COUNT(*) FROM insight_evidence e WHERE e.insight_id = i.id) AS evidence_count
       FROM insights i
      WHERE i.project_id = ? ${opts.includeDismissed ? "" : "AND i.dismissed_at IS NULL"}
      ORDER BY i.severity DESC, i.created_at DESC LIMIT ?`,
    [projectId, Math.min(opts.limit ?? 50, 200)],
  );
}

export function getInsight(db: Db, projectId: string, insightId: string) {
  const insight = db.get("SELECT * FROM insights WHERE id = ? AND project_id = ?", [insightId, projectId]);
  if (!insight) return null;
  return {
    insight,
    evidence: db.all("SELECT * FROM insight_evidence WHERE insight_id = ?", [insightId]),
  };
}

export function dismissInsight(db: Db, projectId: string, insightId: string, now = Date.now()): boolean {
  return db.run(
    "UPDATE insights SET dismissed_at = ? WHERE id = ? AND project_id = ? AND dismissed_at IS NULL",
    [now, insightId, projectId],
  ).changes > 0;
}

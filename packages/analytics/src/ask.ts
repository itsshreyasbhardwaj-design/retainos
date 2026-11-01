import { type Db } from "@retainos/database";
import { dayKey } from "@retainos/shared";
import { activationFunnel, listActivationDefinitions } from "./activation.ts";
import { computeRetention } from "./retention.ts";
import { activeUsers, withStickiness, eventBreakdown } from "./actives.ts";
import { computeFunnel } from "./funnels.ts";
import { mrrMovement, currenciesInUse, churnBreakdown } from "./revenue.ts";
import { listInsights } from "./insights.ts";
import { featureAdoption } from "./features.ts";

/**
 * RetainAI's question interface.
 *
 * Architecture, and the reason for it:
 *   1. Intent parsing          — this file, pattern matching over the question.
 *   2. Authorization           — the caller supplies an already-verified scope.
 *   3. Data retrieval          — the deterministic engines, nothing else.
 *   4. Metric calculation      — the engines, never a model.
 *   5. Answer composition      — templates over computed values.
 *
 * The model, if one is configured at all, only ever gets step 5, and only to
 * rephrase. It never sees step 4's job. That boundary is what stops an
 * "AI analyst" from confidently reporting a number nobody computed.
 */

export type Intent =
  | "activation_rate" | "activation_dropoff" | "retention" | "active_users"
  | "feedback_summary" | "feature_adoption" | "revenue_churn" | "revenue_mrr"
  | "release_impact" | "priority_findings" | "unknown";

export interface ParsedQuestion {
  intent: Intent;
  /** Tokens that drove the match, so the UI can show why it answered this way. */
  matchedOn: string[];
  periodDays: number;
}

const PATTERNS: Array<{ intent: Intent; any: RegExp[] }> = [
  { intent: "activation_dropoff", any: [/drop[- ]?off/i, /where.*(abandon|leave|stop|lose)/i, /biggest.*step/i, /onboarding step/i] },
  { intent: "activation_rate", any: [/activat/i, /time to value/i, /first value/i] },
  { intent: "retention", any: [/retention/i, /come back/i, /returning/i, /cohort/i, /churn.*user/i] },
  { intent: "revenue_churn", any: [/cancel/i, /churn.*(revenue|subscription|paid|customer)/i, /lost.*(revenue|customer)/i] },
  { intent: "revenue_mrr", any: [/\bmrr\b/i, /\barr\b/i, /recurring revenue/i, /revenue.*(this|last) month/i, /at risk/i] },
  { intent: "feedback_summary", any: [
    /feedback/i,
    /\breport(s|ing|ed)?\b/i,
    /users? (say|saying|said|complain|asking|ask for|request)/i,
    /most (often|common|requested)/i,
    /\bcomplaints?\b/i,
  ] },
  { intent: "feature_adoption", any: [/feature.*(adopt|usage|used)/i, /low adoption/i, /which features/i] },
  { intent: "release_impact", any: [/after.*releas/i, /releas.*(impact|change)/i, /since we shipped/i, /what changed/i] },
  { intent: "active_users", any: [/active users/i, /\bdau\b/i, /\bwau\b/i, /\bmau\b/i, /how many.*using/i, /sign(ed)? up/i] },
  { intent: "priority_findings", any: [/what should/i, /priorit/i, /investigate first/i, /biggest problem/i, /going wrong/i] },
];

export function parseQuestion(question: string): ParsedQuestion {
  const matchedOn: string[] = [];
  let intent: Intent = "unknown";
  for (const p of PATTERNS) {
    for (const re of p.any) {
      const m = question.match(re);
      if (m) {
        matchedOn.push(m[0]);
        if (intent === "unknown") intent = p.intent;
        break;
      }
    }
    if (intent !== "unknown") break;
  }
  // Period extraction: "last 30 days", "this week", "this month".
  let periodDays = 28;
  const explicit = question.match(/last\s+(\d{1,3})\s*(day|week|month)/i);
  if (explicit) {
    const n = Number(explicit[1]);
    const unit = explicit[2]!.toLowerCase();
    periodDays = unit.startsWith("day") ? n : unit.startsWith("week") ? n * 7 : n * 30;
    matchedOn.push(explicit[0]);
  } else if (/this week|last week|past week|7 days/i.test(question)) {
    periodDays = 7;
    matchedOn.push("week");
  } else if (/this month|last month|past month|30 days/i.test(question)) {
    periodDays = 30;
    matchedOn.push("month");
  }
  return { intent, matchedOn, periodDays: Math.min(Math.max(periodDays, 1), 365) };
}

export interface GroundedAnswer {
  question: string;
  intent: Intent;
  /** The answer text. Composed from computed values, never from a model. */
  answer: string;
  /** Every figure quoted in `answer`, with how it was computed. */
  figures: Array<{ label: string; value: string; definition: string }>;
  evidence: Array<{ kind: string; summary: string; referenceId?: string }>;
  limitations: string[];
  period: { start: number; end: number };
  /** What produced the answer text. Always truthful. */
  generator: "deterministic_templates";
  /** Follow-up actions the user could take. Never performed automatically. */
  suggestedActions: Array<{ label: string; kind: string; payload?: Record<string, unknown> }>;
}

/**
 * Answer a question from the project's own data.
 *
 * Every figure comes from a deterministic engine. When the data cannot answer
 * the question, the answer says exactly that rather than guessing.
 */
export function ask(
  db: Db,
  projectId: string,
  input: { question: string; timezone: string; now?: number; projectName?: string },
): GroundedAnswer {
  const now = input.now ?? Date.now();
  const parsed = parseQuestion(input.question);
  const period = { start: now - parsed.periodDays * 86_400_000, end: now };
  const tz = input.timezone;

  const base = {
    question: input.question,
    intent: parsed.intent,
    period,
    generator: "deterministic_templates" as const,
  };

  switch (parsed.intent) {
    case "activation_rate": {
      const defs = listActivationDefinitions(db, projectId);
      const def = defs.find((d) => d.isPrimary) ?? defs[0];
      if (!def) {
        return {
          ...base,
          answer:
            "No activation definition is configured for this project, so activation cannot be measured. " +
            "Activation means different things in different products, so RetainOS will not guess one: define " +
            "the single event that means a user reached real value.",
          figures: [],
          evidence: [],
          limitations: ["No activation definition exists."],
          suggestedActions: [{ label: "Define activation", kind: "configure_activation" }],
        };
      }
      const r = activationFunnel(db, projectId, { definition: def, from: period.start, to: period.end, now });
      const prior = activationFunnel(db, projectId, {
        definition: def, from: period.start - parsed.periodDays * 86_400_000, to: period.start - 1, now,
      });
      const ttv = r.timeToValue.medianMs === null ? "not available" : formatDuration(r.timeToValue.medianMs);
      return {
        ...base,
        answer:
          `${r.activated} of ${r.registrations} users who signed up in the last ${parsed.periodDays} days activated, ` +
          `which is ${(r.activationRate * 100).toFixed(1)}%. ` +
          (prior.registrations > 0
            ? `The previous ${parsed.periodDays} days were ${(prior.activationRate * 100).toFixed(1)}%. `
            : "There is no comparable previous period. ") +
          `Activation here means firing "${def.activationEvent}" within ${def.windowDays} days of signup. ` +
          `Median time to activation was ${ttv}.`,
        figures: [
          { label: "Activation rate", value: `${(r.activationRate * 100).toFixed(1)}%`, definition: r.definition },
          { label: "Signups", value: String(r.registrations), definition: `Distinct users whose first "${def.signupEvent}" fell in the period.` },
          { label: "Median time to value", value: ttv, definition: "Median elapsed time from signup to activation, over activated users only." },
        ],
        evidence: [{ kind: "activation_metric", summary: `${r.activated}/${r.registrations} activated` }],
        limitations: [
          ...r.warnings,
          "A period-over-period change is not evidence that anything in particular caused it.",
        ],
        suggestedActions: [
          { label: "See the activation funnel", kind: "open_activation" },
          { label: "Compare by acquisition source", kind: "segment_activation", payload: { dimension: "acquisition_source" } },
        ],
      };
    }

    case "activation_dropoff": {
      const defs = listActivationDefinitions(db, projectId);
      const def = defs.find((d) => d.isPrimary) ?? defs[0];
      const steps = [
        { event: def?.signupEvent ?? "signup_completed", label: "Registered" },
        { event: "onboarding_started", label: "Onboarding started" },
        { event: "onboarding_completed", label: "Onboarding completed" },
        { event: def?.activationEvent ?? "core_action_completed", label: "Activated" },
      ];
      const f = computeFunnel(db, projectId, { steps, from: period.start, to: period.end });
      if (!f.ok || !f.value.largestDropOff) {
        return {
          ...base,
          answer: "There is not enough funnel data in this period to identify a drop-off.",
          figures: [], evidence: [],
          limitations: [f.ok ? (f.value.sampleWarning ?? "No drop-off found.") : f.error.message],
          suggestedActions: [{ label: "Check event instrumentation", kind: "open_inspector" }],
        };
      }
      const d = f.value.largestDropOff;
      const from = f.value.steps[d.fromIndex]!;
      const to = f.value.steps[d.toIndex]!;
      return {
        ...base,
        answer:
          `The largest drop-off is between "${from.label}" and "${to.label}": ${d.lostUsers} of ${from.users} users ` +
          `did not continue, a step conversion of ${(d.conversionRate * 100).toFixed(1)}%. ` +
          "That tells you where users stop, not why. Possible explanations include the step being harder than " +
          "intended, an error on that path, or users not needing it yet — none of which this number distinguishes.",
        figures: [
          { label: "Step conversion", value: `${(d.conversionRate * 100).toFixed(1)}%`, definition: f.value.definition.countingMethod },
          { label: "Users lost", value: String(d.lostUsers), definition: "Users who reached the earlier step but not the later one inside the conversion window." },
        ],
        evidence: [{ kind: "funnel_step", summary: `${from.label} → ${to.label}: ${to.users}/${from.users}` }],
        limitations: [
          "A funnel drop-off is a location, not a cause.",
          f.value.definition.windowSemantics,
          ...(f.value.sampleWarning ? [f.value.sampleWarning] : []),
        ],
        suggestedActions: [
          { label: "Create an improvement task from this", kind: "create_improvement", payload: { fromEvent: from.event, toEvent: to.event } },
          { label: "Read related feedback", kind: "open_feedback" },
        ],
      };
    }

    case "retention": {
      const r = computeRetention(db, projectId, {
        from: period.start, to: period.end, timezone: tz, periods: [1, 7, 30], now,
      });
      const d1 = r.averageByPeriod.find((p) => p.period === 1);
      const d7 = r.averageByPeriod.find((p) => p.period === 7);
      const d30 = r.averageByPeriod.find((p) => p.period === 30);
      const fmt = (p?: { rate: number | null; usersCounted: number }) =>
        !p || p.rate === null ? "not yet knowable" : `${(p.rate * 100).toFixed(1)}% (${p.usersCounted} users)`;
      return {
        ...base,
        answer:
          `For cohorts formed in the last ${parsed.periodDays} days: day 1 is ${fmt(d1)}, day 7 is ${fmt(d7)}, ` +
          `day 30 is ${fmt(d30)}. Periods marked "not yet knowable" have cohorts whose window has not fully ` +
          "elapsed; reporting them as zero would invent a decline that has not happened.",
        figures: [
          { label: "Day-1 retention", value: fmt(d1), definition: r.definition.returnDefinition },
          { label: "Day-7 retention", value: fmt(d7), definition: r.definition.denominator },
          { label: "Day-30 retention", value: fmt(d30), definition: r.definition.periodBoundaries },
        ],
        evidence: r.cohorts.slice(0, 5).map((c) => ({
          kind: "retention_cohort",
          summary: `Cohort ${c.cohort}: ${c.cohortSize} users`,
        })),
        limitations: [
          r.definition.incompletePeriods,
          "Cohorts smaller than 20 users are flagged; their percentages move a great deal on single users.",
        ],
        suggestedActions: [{ label: "Open the cohort heatmap", kind: "open_retention" }],
      };
    }

    case "active_users": {
      const a = withStickiness(activeUsers(db, projectId, {
        from: period.start, to: period.end, granularity: "day", timezone: tz, now,
      }));
      const newUsers = a.points.reduce((s, p) => s + p.newUsers, 0);
      return {
        ...base,
        answer:
          `Over the last ${parsed.periodDays} days: ${a.dau ?? 0} daily, ${a.wau ?? 0} weekly and ${a.mau ?? 0} monthly ` +
          `active users, with ${newUsers} users seen for the first time. ` +
          (a.stickiness !== null ? `DAU/MAU is ${(a.stickiness * 100).toFixed(1)}%.` : ""),
        figures: [
          { label: "DAU", value: String(a.dau ?? 0), definition: a.definition },
          { label: "WAU", value: String(a.wau ?? 0), definition: "Distinct identities with an accepted event in the last 7 days." },
          { label: "MAU", value: String(a.mau ?? 0), definition: "Distinct identities with an accepted event in the last 30 days." },
        ],
        evidence: [{ kind: "event_metric", summary: `${a.points.length} daily buckets analysed` }],
        limitations: [
          "The most recent bucket has not fully elapsed and will read low until it does.",
          "An 'active user' here is anyone firing any event; it is not a measure of value received.",
        ],
        suggestedActions: [{ label: "Open analytics", kind: "open_analytics" }],
      };
    }

    case "feedback_summary": {
      const items = db.all<{ kind: string; n: number }>(
        "SELECT kind, COUNT(*) AS n FROM feedback_items WHERE project_id = ? AND created_at >= ? AND deleted_at IS NULL GROUP BY kind ORDER BY n DESC",
        [projectId, period.start],
      );
      const themes = db.all<{ label: string; count: number; id: string }>(
        `SELECT c.id, c.label, COUNT(f.id) AS count FROM feedback_clusters c
           JOIN feedback_items f ON f.cluster_id = c.id AND f.created_at >= ? AND f.deleted_at IS NULL
          WHERE c.project_id = ? GROUP BY c.id ORDER BY count DESC LIMIT 5`,
        [period.start, projectId],
      );
      const total = items.reduce((s, i) => s + i.n, 0);
      if (total === 0) {
        return {
          ...base,
          answer: `No feedback was submitted in the last ${parsed.periodDays} days.`,
          figures: [], evidence: [],
          limitations: ["Absence of feedback is not evidence that users are satisfied; most users never write in."],
          suggestedActions: [{ label: "Install the feedback widget", kind: "open_feedback_setup" }],
        };
      }
      return {
        ...base,
        answer:
          `${total} feedback items arrived in the last ${parsed.periodDays} days: ` +
          `${items.map((i) => `${i.n} ${i.kind.replace(/_/g, " ")}`).join(", ")}. ` +
          (themes.length > 0
            ? `The most common themes by shared terms are: ${themes.map((t) => `"${t.label}" (${t.count})`).join(", ")}.`
            : "No themes have been grouped yet."),
        figures: [
          { label: "Feedback items", value: String(total), definition: "Count of non-deleted feedback items created in the period." },
        ],
        evidence: themes.map((t) => ({ kind: "feedback_cluster", referenceId: t.id, summary: `"${t.label}": ${t.count} items` })),
        limitations: [
          "Feedback volume reflects who chose to write in, not how many users are affected.",
          "Themes are grouped by shared terms rather than meaning, and should be reviewed by a human.",
          "Sentiment in feedback is not evidence of dissatisfaction across the base, or of future cancellation.",
        ],
        suggestedActions: [{ label: "Open the feedback inbox", kind: "open_feedback" }],
      };
    }

    case "feature_adoption": {
      const features = db.all<{ key: string; label: string; event_name: string }>(
        "SELECT key, label, event_name FROM tracked_features WHERE project_id = ?", [projectId],
      );
      if (features.length === 0) {
        return {
          ...base,
          answer: "No features are configured for adoption tracking in this project.",
          figures: [], evidence: [],
          limitations: ["Nothing to measure until features are registered."],
          suggestedActions: [{ label: "Configure tracked features", kind: "configure_features" }],
        };
      }
      const rows = featureAdoption(db, projectId, {
        features: features.map((f) => ({ key: f.key, eventName: f.event_name, label: f.label })),
        from: period.start, to: period.end, timezone: tz, now,
      }).sort((a, b) => (a.adoptionRate ?? 0) - (b.adoptionRate ?? 0));
      const lowest = rows.slice(0, 3);
      return {
        ...base,
        answer:
          `Over the last ${parsed.periodDays} days, the least-adopted tracked features are ` +
          lowest.map((r) => `"${r.feature}" (${r.adoptionRate === null ? "no active users" : `${(r.adoptionRate * 100).toFixed(1)}% of active users`})`).join(", ") +
          ". Low adoption of a deliberately narrow feature is expected and not a problem by itself.",
        figures: rows.map((r) => ({
          label: r.feature,
          value: r.adoptionRate === null ? "not available" : `${(r.adoptionRate * 100).toFixed(1)}%`,
          definition: "Distinct users firing the feature's event, divided by distinct active users in the period.",
        })),
        evidence: rows.map((r) => ({ kind: "event_metric", summary: `${r.feature}: ${r.discoveredBy} users, ${r.repeatUsers} repeat` })),
        limitations: [
          "Adoption measured against all active users understates adoption within a target segment.",
          "A missing event is indistinguishable from an unused feature; confirm instrumentation first.",
        ],
        suggestedActions: [{ label: "Open feature adoption", kind: "open_features" }],
      };
    }

    case "revenue_mrr":
    case "revenue_churn": {
      const currencies = currenciesInUse(db, projectId);
      if (currencies.length === 0) {
        return {
          ...base,
          answer:
            "No subscription data is connected to this project, so revenue questions cannot be answered. " +
            "RetainOS will not estimate revenue from product usage.",
          figures: [], evidence: [],
          limitations: ["No billing connection or imported subscriptions exist."],
          suggestedActions: [{ label: "Connect billing", kind: "open_integrations" }],
        };
      }
      const parts: string[] = [];
      const figures: GroundedAnswer["figures"] = [];
      const limitations = new Set<string>();
      for (const currency of currencies) {
        const m = mrrMovement(db, projectId, { periodStart: period.start, periodEnd: period.end, currency });
        const churn = churnBreakdown(db, projectId, period.start, period.end);
        parts.push(
          `${currency}: MRR is ${(m.endMrrMinor / 100).toLocaleString("en-IN")} (was ` +
          `${(m.startMrrMinor / 100).toLocaleString("en-IN")} at the start of the period). ` +
          `New ${(m.newMinor / 100).toFixed(0)}, expansion ${(m.expansionMinor / 100).toFixed(0)}, ` +
          `contraction ${(m.contractionMinor / 100).toFixed(0)}, churn ${(m.churnMinor / 100).toFixed(0)}. ` +
          `${m.churnedCustomers} subscriptions stopped paying` +
          (churn.total > 0
            ? `, of which ${churn.voluntary} cancelled voluntarily and ${churn.paymentFailure} were payment failures` +
              (churn.unknown > 0 ? `, with ${churn.unknown} of unrecorded cause` : "")
            : "") + ".",
        );
        figures.push(
          { label: `MRR (${currency})`, value: (m.endMrrMinor / 100).toFixed(2), definition: m.definitions.mrr },
          { label: `Net revenue retention (${currency})`, value: m.netRevenueRetention === null ? "not available" : `${(m.netRevenueRetention * 100).toFixed(1)}%`, definition: m.definitions.netRevenueRetention },
          { label: `Gross revenue retention (${currency})`, value: m.grossRevenueRetention === null ? "not available" : `${(m.grossRevenueRetention * 100).toFixed(1)}%`, definition: m.definitions.grossRevenueRetention },
        );
        for (const c of m.caveats) limitations.add(c);
        limitations.add(churn.note);
      }
      return {
        ...base,
        answer: parts.join(" "),
        figures,
        evidence: [{ kind: "revenue_metric", summary: `${currencies.length} currency/currencies analysed` }],
        limitations: [...limitations],
        suggestedActions: [{ label: "Open revenue intelligence", kind: "open_revenue" }],
      };
    }

    case "release_impact": {
      const releases = db.all<{ id: string; name: string; version: string; released_at: number }>(
        "SELECT id, name, version, released_at FROM releases WHERE project_id = ? ORDER BY released_at DESC LIMIT 3",
        [projectId],
      );
      if (releases.length === 0) {
        return {
          ...base,
          answer: "No releases have been recorded for this project, so there is nothing to measure against.",
          figures: [], evidence: [],
          limitations: ["Release tracking is empty."],
          suggestedActions: [{ label: "Record a release", kind: "open_releases" }],
        };
      }
      const latest = releases[0]!;
      return {
        ...base,
        answer:
          `The most recent release is ${latest.version} (${latest.name}), shipped on ` +
          `${dayKey(latest.released_at, tz)}. RetainOS can compare a metric before and after it, but a ` +
          "before-and-after comparison around a release is observational: it cannot separate the release from " +
          "anything else that changed in the same window. Open ImpactLab to run the comparison with its " +
          "confounder checks, or set up a controlled experiment if you need a causal answer.",
        figures: [{ label: "Latest release", value: latest.version, definition: "Most recent recorded release by release date." }],
        evidence: releases.map((r) => ({ kind: "note", referenceId: r.id, summary: `${r.version} on ${dayKey(r.released_at, tz)}` })),
        limitations: [
          "Before-and-after comparisons around a release do not establish causation.",
          "Only a controlled experiment supports a causal claim about a change.",
        ],
        suggestedActions: [{ label: "Measure in ImpactLab", kind: "open_impact", payload: { releaseId: latest.id } }],
      };
    }

    case "priority_findings": {
      const insights = listInsights(db, projectId, { limit: 5 }) as Array<Record<string, unknown>>;
      if (insights.length === 0) {
        return {
          ...base,
          answer:
            "There are no open findings for this project. That may mean nothing is wrong, or that there is not " +
            "yet enough data to detect anything — those two look identical from here.",
          figures: [], evidence: [],
          limitations: ["No findings is not evidence of no problems."],
          suggestedActions: [{ label: "Run analysis", kind: "run_analysis" }],
        };
      }
      return {
        ...base,
        answer:
          `The ${insights.length} highest-severity open findings, strongest evidence first: ` +
          insights.map((i) => `"${i.title}" (${String(i.confidence).replace(/_/g, " ")})`).join("; ") +
          ". Severity orders the list; it is not a probability and not a measure of business impact.",
        figures: insights.map((i) => ({
          label: String(i.title),
          value: String(i.confidence).replace(/_/g, " "),
          definition: String(i.metric_definition ?? ""),
        })),
        evidence: insights.map((i) => ({ kind: "insight", referenceId: String(i.id), summary: String(i.observation).slice(0, 200) })),
        limitations: [
          "These are detected by deterministic rules over your own data; they are not a complete list of problems.",
          "Each finding separates what was observed from what might explain it. The explanations are unverified.",
        ],
        suggestedActions: [{ label: "Open findings", kind: "open_ai" }],
      };
    }

    default:
      return {
        ...base,
        answer:
          "RetainOS could not match that question to a metric it knows how to compute. It answers questions " +
          "about activation, onboarding drop-off, retention and cohorts, active users, customer feedback, " +
          "feature adoption, subscription revenue and churn, release impact, and which findings to investigate " +
          "first. It will not answer a question by guessing at numbers it has not computed.",
        figures: [],
        evidence: [],
        limitations: ["The question was not recognised. Nothing was computed."],
        suggestedActions: [
          { label: "Where do users drop off during onboarding?", kind: "ask", payload: { question: "Where do users drop off during onboarding?" } },
          { label: "What is our activation rate this month?", kind: "ask", payload: { question: "What is our activation rate this month?" } },
          { label: "What should we investigate first?", kind: "ask", payload: { question: "What should we investigate first?" } },
        ],
      };
  }
}

function formatDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

export const EXAMPLE_QUESTIONS = [
  "Why did activation decrease this week?",
  "Which onboarding step has the largest drop-off?",
  "What are users reporting most often?",
  "Which released features have low adoption?",
  "What changed after our last release?",
  "Which product issues should we investigate first?",
  "How many paid users cancelled this month?",
  "What is our day-7 retention?",
  "How many active users do we have?",
];

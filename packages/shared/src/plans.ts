/**
 * Pricing plans and entitlements.
 *
 * These prices are commercial hypotheses, not validated willingness to pay.
 * They are defined as data so they can be changed without touching enforcement,
 * and every limit is enforced server-side in packages/database/entitlements.
 *
 * The pricing axis is deliberately *tracked users*, not events. Pricing on
 * event volume punishes exactly the behaviour the product needs: a team that
 * instruments carefully, adds the events an analysis requires, and backfills
 * history gets a larger bill for doing the work properly, so they instrument
 * less and the product becomes useless to them. Tracked users scale with the
 * customer's own revenue, which is the only axis where paying more happens
 * because the product is working.
 *
 * Events still have a ceiling, because an unbounded one would let a single
 * runaway loop cost the host real money. It is set far above what careful
 * instrumentation needs, so it functions as abuse protection rather than as a
 * price lever.
 */
export type PlanId = "free" | "starter" | "growth" | "agency";
export type BillingInterval = "month" | "year";

export interface PlanLimits {
  projects: number;
  /** The pricing axis: distinct identities seen in a calendar month. */
  trackedUsersPerMonth: number;
  /**
   * Fair-use ceiling, not a price lever. Set high enough that instrumenting
   * thoroughly never costs more; it exists to stop a runaway loop.
   */
  eventsPerMonth: number;
  /** Days of raw event retention. Aggregates outlive raw events. */
  rawEventRetentionDays: number;
  savedFunnels: number;
  teamMembers: number;
  aiQueriesPerMonth: number;
  reportsPerMonth: number;
  integrationSyncsPerMonth: number;
}

export interface PlanFeatures {
  funnels: boolean;
  /** Joins unconnected signals into cases. The product's centre of gravity. */
  frictionGraph: boolean;
  /** Explainable prioritisation across those cases. */
  opportunityEngine: boolean;
  /** Holdout-controlled retention playbooks. */
  playbooks: boolean;
  /** Explainable customer and account health. */
  customerHealth: boolean;
  /** Revenue impact with evidence classification. */
  revenueImpactStudio: boolean;
  /** Reading from PostHog, Amplitude, Sentry and the rest. */
  providerIntegrations: boolean;
  /** The founder brief and the command centre. */
  commandCenter: boolean;
  /** Alert rules and the alert quality report. */
  alerting: boolean;
  retentionCohorts: boolean;
  advancedSegmentation: boolean;
  feedbackOs: boolean;
  fixFlow: boolean;
  githubIntegration: boolean;
  impactLab: boolean;
  experiments: boolean;
  revenueIntelligence: boolean;
  releaseHub: boolean;
  onboardOs: boolean;
  weeklyBrief: boolean;
  multiWorkspace: boolean;
  dataExport: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in paise (INR minor units). 0 for the free plan. */
  monthlyPaise: number;
  /** Annual price in paise. Discount is explicit, not implied. */
  annualPaise: number;
  currency: "INR";
  audience: string;
  limits: PlanLimits;
  features: PlanFeatures;
}

const noFeatures: PlanFeatures = {
  funnels: false,
  frictionGraph: false,
  opportunityEngine: false,
  playbooks: false,
  customerHealth: false,
  revenueImpactStudio: false,
  providerIntegrations: false,
  commandCenter: false,
  alerting: false,
  retentionCohorts: false,
  advancedSegmentation: false,
  feedbackOs: false,
  fixFlow: false,
  githubIntegration: false,
  impactLab: false,
  experiments: false,
  revenueIntelligence: false,
  releaseHub: false,
  onboardOs: false,
  weeklyBrief: false,
  multiWorkspace: false,
  dataExport: false,
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    monthlyPaise: 0,
    annualPaise: 0,
    currency: "INR",
    audience: "Individual developers instrumenting a first project.",
    limits: {
      projects: 1,
      trackedUsersPerMonth: 1_000,
      eventsPerMonth: 1_000_000,
      rawEventRetentionDays: 30,
      savedFunnels: 1,
      teamMembers: 1,
      aiQueriesPerMonth: 20,
      reportsPerMonth: 2,
      integrationSyncsPerMonth: 0,
    },
    features: {
      ...noFeatures,
      funnels: true,
      feedbackOs: true,
      dataExport: true,
      // Reliable data makes every other part of the product work, including
      // for people who never pay, so the Instrumentation Doctor and the
      // friction graph's read-only view are not held back.
      frictionGraph: true,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    monthlyPaise: 99_900,
    annualPaise: 999_000, // ~2 months free; stated explicitly in the UI
    currency: "INR",
    audience: "Early SaaS founders with paying users.",
    limits: {
      projects: 3,
      trackedUsersPerMonth: 10_000,
      eventsPerMonth: 10_000_000,
      rawEventRetentionDays: 90,
      savedFunnels: 10,
      teamMembers: 3,
      aiQueriesPerMonth: 200,
      reportsPerMonth: 20,
      integrationSyncsPerMonth: 200,
    },
    features: {
      ...noFeatures,
      funnels: true,
      retentionCohorts: true,
      feedbackOs: true,
      fixFlow: true,
      githubIntegration: true,
      weeklyBrief: true,
      onboardOs: true,
      dataExport: true,
      frictionGraph: true,
      opportunityEngine: true,
      customerHealth: true,
      commandCenter: true,
      alerting: true,
      providerIntegrations: true,
    },
  },
  growth: {
    id: "growth",
    name: "Growth",
    monthlyPaise: 249_900,
    annualPaise: 2_499_000,
    currency: "INR",
    audience: "Growing software companies running releases and experiments.",
    limits: {
      projects: 10,
      trackedUsersPerMonth: 50_000,
      eventsPerMonth: 50_000_000,
      rawEventRetentionDays: 180,
      savedFunnels: 50,
      teamMembers: 15,
      aiQueriesPerMonth: 1_000,
      reportsPerMonth: 100,
      integrationSyncsPerMonth: 2_000,
    },
    features: {
      ...noFeatures,
      funnels: true,
      retentionCohorts: true,
      advancedSegmentation: true,
      feedbackOs: true,
      fixFlow: true,
      githubIntegration: true,
      impactLab: true,
      experiments: true,
      revenueIntelligence: true,
      releaseHub: true,
      onboardOs: true,
      weeklyBrief: true,
      dataExport: true,
      frictionGraph: true,
      opportunityEngine: true,
      customerHealth: true,
      commandCenter: true,
      alerting: true,
      providerIntegrations: true,
      playbooks: true,
      revenueImpactStudio: true,
    },
  },
  agency: {
    id: "agency",
    name: "Agency",
    monthlyPaise: 499_900,
    annualPaise: 4_999_000,
    currency: "INR",
    audience: "Agencies running retention for multiple client products.",
    limits: {
      projects: 40,
      trackedUsersPerMonth: 250_000,
      eventsPerMonth: 250_000_000,
      rawEventRetentionDays: 365,
      savedFunnels: 200,
      teamMembers: 40,
      aiQueriesPerMonth: 4_000,
      reportsPerMonth: 500,
      integrationSyncsPerMonth: 10_000,
    },
    features: {
      funnels: true,
      retentionCohorts: true,
      advancedSegmentation: true,
      feedbackOs: true,
      fixFlow: true,
      githubIntegration: true,
      impactLab: true,
      experiments: true,
      revenueIntelligence: true,
      releaseHub: true,
      onboardOs: true,
      weeklyBrief: true,
      multiWorkspace: true,
      dataExport: true,
      frictionGraph: true,
      opportunityEngine: true,
      customerHealth: true,
      commandCenter: true,
      alerting: true,
      providerIntegrations: true,
      playbooks: true,
      revenueImpactStudio: true,
    },
  },
};

/**
 * What the price scales with, and what it deliberately does not.
 *
 * Stated as data so the pricing page cannot drift from the enforcement, and
 * so the claim is checkable: the event ceiling on every plan is at least a
 * hundred times its tracked-user allowance, which is what makes "events are
 * not the price lever" true rather than merely said.
 */
export const PRICING_AXIS = {
  axis: "trackedUsersPerMonth" as keyof PlanLimits,
  axisLabel: "Monthly tracked users",
  explanation:
    "RetainOS prices on the number of people you track in a month, not on how many events you send. " +
    "Pricing on events punishes careful instrumentation: a team that adds the events an analysis needs, " +
    "or backfills their history, would pay more for doing the work properly and would instrument less " +
    "instead. Tracked users grow when your product grows.",
  eventCeilingNote:
    "Every plan has an event ceiling far above what thorough instrumentation needs. It exists so a runaway " +
    "loop cannot run up a bill, not to charge you for being thorough.",
  neverCharged: [
    "Exporting your own data.",
    "Deleting a user's data, or responding to a privacy request.",
    "Seeing why your instrumentation is broken.",
    "Adding another event name or another property.",
  ],
} as const;

/** The ratio that makes the "not priced on events" claim checkable. */
export function eventHeadroomRatio(plan: Plan): number {
  return plan.limits.eventsPerMonth / plan.limits.trackedUsersPerMonth;
}

export const PLAN_ORDER: PlanId[] = ["free", "starter", "growth", "agency"];

export function priceFor(plan: Plan, interval: BillingInterval): number {
  return interval === "month" ? plan.monthlyPaise : plan.annualPaise;
}

/** Annual discount as a percentage, derived rather than hardcoded in copy. */
export function annualDiscountPercent(plan: Plan): number {
  if (plan.monthlyPaise === 0) return 0;
  const full = plan.monthlyPaise * 12;
  return Math.round(((full - plan.annualPaise) / full) * 100);
}

export function formatPaise(paise: number, currency = "INR"): string {
  const major = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: major % 1 === 0 ? 0 : 2,
  }).format(major);
}

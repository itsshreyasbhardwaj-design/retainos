/**
 * Pricing plans and entitlements.
 *
 * These prices are commercial hypotheses, not validated willingness to pay.
 * They are defined as data so they can be changed without touching enforcement,
 * and every limit is enforced server-side in packages/database/entitlements.
 */
export type PlanId = "free" | "starter" | "growth" | "agency";
export type BillingInterval = "month" | "year";

export interface PlanLimits {
  projects: number;
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
      eventsPerMonth: 10_000,
      rawEventRetentionDays: 30,
      savedFunnels: 1,
      teamMembers: 1,
      aiQueriesPerMonth: 20,
      reportsPerMonth: 2,
      integrationSyncsPerMonth: 0,
    },
    features: { ...noFeatures, funnels: true, feedbackOs: true, dataExport: true },
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
      eventsPerMonth: 100_000,
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
      eventsPerMonth: 500_000,
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
      eventsPerMonth: 2_000_000,
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
    },
  },
};

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

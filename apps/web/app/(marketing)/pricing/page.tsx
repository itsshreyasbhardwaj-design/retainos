import type { Metadata } from "next";
import Link from "next/link";
import {
  PLANS, PLAN_ORDER, formatPaise, annualDiscountPercent, eventHeadroomRatio, PRICING_AXIS,
} from "@retainos/shared";

export const metadata: Metadata = { title: "Pricing" };

const FEATURE_ROWS: Array<{ key: keyof typeof PLANS.free.features; label: string }> = [
  { key: "funnels", label: "Funnel analysis" },
  { key: "retentionCohorts", label: "Retention cohorts" },
  { key: "advancedSegmentation", label: "Advanced segmentation" },
  { key: "feedbackOs", label: "FeedbackOS" },
  { key: "fixFlow", label: "FixFlow improvements" },
  { key: "githubIntegration", label: "GitHub issue integration" },
  { key: "impactLab", label: "ImpactLab measurement" },
  { key: "experiments", label: "A/B experiments" },
  { key: "revenueIntelligence", label: "Revenue intelligence" },
  { key: "releaseHub", label: "Release tracking" },
  { key: "onboardOs", label: "Onboarding builder" },
  { key: "weeklyBrief", label: "Weekly brief" },
  { key: "multiWorkspace", label: "Multiple client workspaces" },
  { key: "frictionGraph", label: "FrictionGraph" },
  { key: "opportunityEngine", label: "Opportunity engine" },
  { key: "customerHealth", label: "Customer health" },
  { key: "commandCenter", label: "Command centre" },
  { key: "alerting", label: "Alerting" },
  { key: "providerIntegrations", label: "Read from PostHog, Amplitude, Sentry" },
  { key: "playbooks", label: "Retention playbooks (holdout-controlled)" },
  { key: "revenueImpactStudio", label: "Revenue Impact Studio" },
  { key: "dataExport", label: "Data export" },
];

export default function Pricing() {
  return (
    <div className="mx-auto max-w-5xl px-5 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-offwhite">Pricing</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
        Every limit below is enforced on the server. Data export stays available on every plan, including when a
        subscription lapses: your product data is yours, and holding it hostage would be a dark pattern.
      </p>

      <div className="mt-6 rounded-xl border border-navy-700/70 bg-navy-900/50 px-5 py-4">
        <p className="text-sm font-medium text-offwhite">{PRICING_AXIS.axisLabel} is the only thing you pay for</p>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">{PRICING_AXIS.explanation}</p>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-500">{PRICING_AXIS.eventCeilingNote}</p>
        <ul className="mt-3 space-y-1">
          {PRICING_AXIS.neverCharged.map((item) => (
            <li key={item} className="flex gap-2 text-xs text-slate-400">
              <span aria-hidden className="text-emerald-400">Never charged:</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-8 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="w-56 px-3 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">Plan</th>
              {PLAN_ORDER.map((id) => (
                <th key={id} className="px-3 py-3 text-left">
                  <div className="text-sm font-semibold text-offwhite">{PLANS[id].name}</div>
                  <div className="mt-1 text-lg font-semibold tnum text-offwhite">
                    {formatPaise(PLANS[id].monthlyPaise)}
                    <span className="text-[11px] font-normal text-slate-500">{PLANS[id].monthlyPaise > 0 ? "/mo" : ""}</span>
                  </div>
                  {PLANS[id].annualPaise > 0 ? (
                    <div className="text-[10px] text-slate-500">
                      {formatPaise(PLANS[id].annualPaise)}/yr · {annualDiscountPercent(PLANS[id])}% less
                    </div>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-navy-800">
              <td className="px-3 py-2.5 text-slate-400">Projects</td>
              {PLAN_ORDER.map((id) => <td key={id} className="px-3 py-2.5 tnum text-slate-300">{PLANS[id].limits.projects}</td>)}
            </tr>
            <tr className="border-t border-navy-800">
              <td className="px-3 py-2.5 text-slate-400">
                Tracked users per month
                <span className="mt-0.5 block text-[11px] text-slate-500">What the price scales with.</span>
              </td>
              {PLAN_ORDER.map((id) => (
                <td key={id} className="px-3 py-2.5 tnum text-slate-300">
                  {PLANS[id].limits.trackedUsersPerMonth.toLocaleString("en-IN")}
                </td>
              ))}
            </tr>
            <tr className="border-t border-navy-800">
              <td className="px-3 py-2.5 text-slate-400">
                Event ceiling
                <span className="mt-0.5 block text-[11px] text-slate-500">
                  Abuse protection, not a price lever — {eventHeadroomRatio(PLANS.free)}+ events per tracked
                  user on every plan.
                </span>
              </td>
              {PLAN_ORDER.map((id) => (
                <td key={id} className="px-3 py-2.5 tnum text-slate-300">
                  {PLANS[id].limits.eventsPerMonth.toLocaleString("en-IN")}
                </td>
              ))}
            </tr>
            <tr className="border-t border-navy-800">
              <td className="px-3 py-2.5 text-slate-400">Team members</td>
              {PLAN_ORDER.map((id) => <td key={id} className="px-3 py-2.5 tnum text-slate-300">{PLANS[id].limits.teamMembers}</td>)}
            </tr>
            <tr className="border-t border-navy-800">
              <td className="px-3 py-2.5 text-slate-400">Raw event history</td>
              {PLAN_ORDER.map((id) => (
                <td key={id} className="px-3 py-2.5 tnum text-slate-300">{PLANS[id].limits.rawEventRetentionDays} days</td>
              ))}
            </tr>
            <tr className="border-t border-navy-800">
              <td className="px-3 py-2.5 text-slate-400">RetainAI questions per month</td>
              {PLAN_ORDER.map((id) => (
                <td key={id} className="px-3 py-2.5 tnum text-slate-300">{PLANS[id].limits.aiQueriesPerMonth.toLocaleString("en-IN")}</td>
              ))}
            </tr>
            {FEATURE_ROWS.map((row) => (
              <tr key={row.key} className="border-t border-navy-800">
                <td className="px-3 py-2.5 text-slate-400">{row.label}</td>
                {PLAN_ORDER.map((id) => (
                  <td key={id} className="px-3 py-2.5">
                    {PLANS[id].features[row.key]
                      ? <span className="text-emerald-400" aria-label="included">✓</span>
                      : <span className="text-slate-600" aria-label="not included">—</span>}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-navy-800">
              <td className="px-3 py-3" />
              {PLAN_ORDER.map((id) => (
                <td key={id} className="px-3 py-3">
                  <Link href="/signup" className="inline-block rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500">
                    {PLANS[id].monthlyPaise === 0 ? "Start free" : "Choose"}
                  </Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-navy-700/70 bg-navy-900/50 p-5">
          <h2 className="text-sm font-semibold text-offwhite">What happens at the limit</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            When a batch of events crosses your monthly allowance, RetainOS accepts what fits and tells the SDK
            exactly how many were rejected and why. It does not silently drop events, and it does not bill you
            past your plan.
          </p>
        </div>
        <div className="rounded-xl border border-navy-700/70 bg-navy-900/50 p-5">
          <h2 className="text-sm font-semibold text-offwhite">Cancelling</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            Cancellation is a normal setting in your billing page. There is no retention flow, no exit survey you
            must complete, and no countdown. If a subscription lapses, you keep read and export access to your
            own data on free-plan limits.
          </p>
        </div>
      </div>
    </div>
  );
}

import Link from "next/link";
import { PLANS, PLAN_ORDER, formatPaise, annualDiscountPercent } from "@retainos/shared";

const SYSTEMS = [
  { name: "Product analytics", body: "Active users, events, funnels, segments and journeys, with every metric stating what it counted." },
  { name: "Activation intelligence", body: "Define what first value means in your product, then see who reaches it and how long it takes." },
  { name: "Retention intelligence", body: "Cohort retention with a fixed denominator and incomplete periods marked, not reported as zero." },
  { name: "FeedbackOS", body: "A widget, a portal and an inbox, with related reports grouped and editable by a human." },
  { name: "FixFlow", body: "Turn a measured problem into a developer-ready issue, with the evidence frozen alongside it." },
  { name: "ImpactLab", body: "Before-and-after measurement with confounders listed, and controlled experiments when you need a cause." },
  { name: "RetainAI", body: "Deterministic analysis that separates what was measured from what might explain it. No API key required." },
  { name: "Revenue intelligence", body: "MRR, net and gross revenue retention and churn by verified cause, from real billing events." },
];

const PROMISES = [
  "Every number shows the rule that produced it.",
  "A funnel drop-off is reported as a location, never as a cause.",
  "An incomplete period is marked incomplete, not shown as a decline.",
  "No GitHub issue is created without an explicit approval.",
  "The SDK refuses to collect passwords, tokens, card numbers or precise location.",
  "There is no session recording, keystroke capture or fingerprinting, and no setting that enables one.",
];

export default function Home() {
  return (
    <>
      <section className="relative overflow-hidden px-5 pt-20 pb-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-40 h-[28rem] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(37,99,235,0.22),transparent_70%)]"
        />
        <div className="relative mx-auto max-w-3xl text-center">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-navy-600 bg-navy-900/70 px-3 py-1 text-[11px] text-slate-400">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
            Product intelligence for people who ship
          </p>
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-offwhite sm:text-5xl">
            Stop Guessing Why Users Leave.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-slate-400">
            Understand where customers struggle, turn evidence into product improvements, and measure what
            changes after every release.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500">
              Start Free
            </Link>
            <Link href="/demo" className="rounded-lg border border-navy-600 bg-navy-900 px-5 py-2.5 text-sm font-medium text-offwhite hover:bg-navy-800">
              Explore Demo
            </Link>
          </div>
          <p className="mt-4 text-[11px] text-slate-500">
            Free plan, no card required. Self-host it for nothing, or run it locally with no external service at all.
          </p>
        </div>
      </section>

      <section className="px-5 pb-16">
        <div className="mx-auto max-w-5xl">
          <div className="rounded-2xl border border-navy-700/70 bg-navy-900/50 p-6 sm:p-8">
            <h2 className="text-center text-sm font-semibold uppercase tracking-wider text-slate-500">
              One workflow, end to end
            </h2>
            <ol className="mt-6 grid gap-3 text-xs sm:grid-cols-4">
              {[
                { step: "Measure", body: "Events arrive from your app. Funnels, activation and retention are computed from them." },
                { step: "Investigate", body: "The largest drop-off is surfaced with the feedback and errors that sit alongside it." },
                { step: "Fix", body: "Approve an improvement and RetainOS drafts a GitHub issue with the evidence attached." },
                { step: "Prove", body: "After the release, compare the metric — with confounders named, or an experiment to settle it." },
              ].map((s, i) => (
                <li key={s.step} className="rounded-xl border border-navy-700/60 bg-navy-950/40 p-4">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
                    Step {i + 1}
                  </span>
                  <p className="mt-1.5 text-sm font-medium text-offwhite">{s.step}</p>
                  <p className="mt-1.5 leading-relaxed text-slate-400">{s.body}</p>
                </li>
              ))}
            </ol>
            <p className="mt-5 text-center text-[11px] leading-relaxed text-slate-500">
              This is one connected workflow, not separate modules sharing a dashboard. The improvement you
              approve carries the measurement that found it all the way through to the result.
            </p>
          </div>
        </div>
      </section>

      <section className="px-5 pb-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-semibold tracking-tight text-offwhite">What is inside</h2>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SYSTEMS.map((s) => (
              <div key={s.name} className="rounded-xl border border-navy-700/70 bg-navy-900/50 p-4">
                <h3 className="text-sm font-medium text-offwhite">{s.name}</h3>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 pb-16">
        <div className="mx-auto max-w-3xl rounded-2xl border border-navy-700/70 bg-navy-900/50 p-6 sm:p-8">
          <h2 className="text-xl font-semibold tracking-tight text-offwhite">What RetainOS will not do</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            Most of the value in a retention tool is in refusing to overstate what the data says. These are
            commitments enforced in the code, with tests, not aspirations.
          </p>
          <ul className="mt-5 space-y-2.5">
            {PROMISES.map((p) => (
              <li key={p} className="flex gap-2.5 text-sm leading-relaxed text-slate-300">
                <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                {p}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-xs leading-relaxed text-slate-500">
            RetainOS also has gaps. It has no session replay, no mobile SDK, and no marketing attribution. Where
            a specialised tool goes deeper, RetainOS says so rather than claiming parity. See{" "}
            <Link href="/features" className="text-blue-400 underline decoration-blue-400/40 hover:decoration-blue-400">
              the honest comparison
            </Link>.
          </p>
        </div>
      </section>

      <section className="px-5 pb-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-semibold tracking-tight text-offwhite">Pricing</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            These prices are an opening hypothesis, not validated willingness to pay. They are configuration, and
            they will change as we learn.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {PLAN_ORDER.map((id) => {
              const plan = PLANS[id];
              return (
                <div key={id} className="flex flex-col rounded-xl border border-navy-700/70 bg-navy-900/50 p-4">
                  <h3 className="text-sm font-semibold text-offwhite">{plan.name}</h3>
                  <p className="mt-1 text-xs text-slate-500">{plan.audience}</p>
                  <p className="mt-3 text-2xl font-semibold tnum text-offwhite">
                    {formatPaise(plan.monthlyPaise)}
                    <span className="text-xs font-normal text-slate-500">{plan.monthlyPaise > 0 ? "/mo" : ""}</span>
                  </p>
                  {plan.annualPaise > 0 ? (
                    <p className="mt-1 text-[11px] text-slate-500">
                      or {formatPaise(plan.annualPaise)}/year — {annualDiscountPercent(plan)}% less
                    </p>
                  ) : null}
                  <ul className="mt-3 space-y-1 text-[11px] text-slate-400">
                    <li>{plan.limits.projects} project{plan.limits.projects === 1 ? "" : "s"}</li>
                    <li>{plan.limits.eventsPerMonth.toLocaleString("en-IN")} events/month</li>
                    <li>{plan.limits.teamMembers} team member{plan.limits.teamMembers === 1 ? "" : "s"}</li>
                    <li>{plan.limits.rawEventRetentionDays} days raw event history</li>
                  </ul>
                  <Link
                    href="/signup"
                    className="mt-4 rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-center text-xs font-medium text-offwhite hover:bg-navy-700"
                  >
                    {plan.monthlyPaise === 0 ? "Start free" : "Start a trial"}
                  </Link>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-[11px] text-slate-500">
            Prices in Indian rupees. India-first launch; other currencies will follow. Payment runs through
            Razorpay in production; local development uses a billing simulator and never charges anyone.
          </p>
        </div>
      </section>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Demo" };

/**
 * The demo walkthrough.
 *
 * Deliberately not a fake dashboard with invented numbers. It explains the
 * workflow and tells you how to generate a real demo project locally, whose
 * figures actually reconcile because they are computed from seeded events.
 */
const STEPS = [
  {
    title: "A funnel shows where people stop",
    body:
      "1,000 users register. 700 start onboarding, 350 finish it, 200 reach the core action. The largest " +
      "single loss is 350 users between starting and finishing onboarding — a 50% step conversion.",
    note: "RetainOS reports this as a location, not a cause.",
  },
  {
    title: "Feedback sits alongside the measurement",
    body:
      "Eleven reports in the same period share the terms \"project\", \"template\" and \"confusing\". They were " +
      "grouped automatically by shared terms, and the grouping is editable because shared vocabulary is not " +
      "shared meaning.",
    note: "Report volume is not a measure of how many users are affected.",
  },
  {
    title: "A finding separates fact from guess",
    body:
      "The observation is the measurement. The hypotheses — the step may be harder than intended, there may be " +
      "an error on that path, some users may not need it yet — are listed separately and marked unconfirmed, " +
      "with the sample-size rule that produced the confidence label shown next to it.",
    note: "Confidence is a qualitative label from explicit rules, never an invented percentage.",
  },
  {
    title: "An improvement carries its evidence",
    body:
      "Approving the task drafts a GitHub issue containing the funnel numbers, the linked feedback, the " +
      "hypothesis marked as a hypothesis, acceptance criteria, and an explicit note that RetainOS has no " +
      "reproduction steps rather than inventing plausible ones.",
    note: "Nothing reaches GitHub without an explicit approval.",
  },
  {
    title: "The release gets measured",
    body:
      "After shipping, before-and-after shows the step conversion moving from 50% to 68%. The result also lists " +
      "that two other releases shipped in the same window and that the acquisition mix shifted — so the change " +
      "cannot be attributed to this fix.",
    note: "This is correlation. The result says so in its own output.",
  },
  {
    title: "An experiment settles it",
    body:
      "A 50/50 experiment on 2,000 exposed users per arm shows 50.2% against 67.8%, p below 0.0001, interval " +
      "+14.1 to +21.1 points. The sample ratio check passes, no user was exposed to both arms, and the " +
      "pre-registered minimum was met before anyone looked.",
    note: "This is the only method here that supports a causal claim.",
  },
];

export default function Demo() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-offwhite">How RetainOS works</h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">
        One worked example, from a drop-off nobody noticed to an improvement with evidence behind it. The numbers
        below are the figures RetainOS produces from a seeded demonstration project; they describe no real
        company.
      </p>

      <ol className="mt-8 space-y-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-xl border border-navy-700/70 bg-navy-900/50 p-5">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-600/20 text-xs font-medium text-blue-400">
                {i + 1}
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-offwhite">{s.title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{s.body}</p>
                <p className="mt-2 text-[11px] leading-relaxed text-cyan-400/90">{s.note}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-8 rounded-xl border border-navy-700/70 bg-navy-900/50 p-6">
        <h2 className="text-base font-semibold text-offwhite">Run the real thing locally</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Rather than a canned screenshot, RetainOS ships a reproducible seed that generates a fictional SaaS
          project with a full year of events, subscriptions, feedback, releases and an experiment. Every figure
          in the dashboard is then computed from those events, so the numbers reconcile with each other.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg border border-navy-700/70 bg-navy-950 px-4 py-3 text-[12px] leading-relaxed font-mono text-slate-300">
{`pnpm install
pnpm db:migrate
pnpm db:seed      # creates the demo project
pnpm dev          # then log in with the printed credentials`}
        </pre>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          The demo project is marked as demo data in the database and is banner-labelled everywhere it appears,
          so fictional figures can never be mistaken for a customer&apos;s real ones.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/signup" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">
            Start free
          </Link>
          <Link href="/docs" className="rounded-lg border border-navy-600 bg-navy-900 px-4 py-2 text-sm font-medium text-offwhite hover:bg-navy-800">
            Read the docs
          </Link>
        </div>
      </div>
    </div>
  );
}

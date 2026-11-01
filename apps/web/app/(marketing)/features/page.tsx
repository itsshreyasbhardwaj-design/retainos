import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Features" };

/**
 * Capability matrix.
 *
 * Written from the publicly documented capabilities of each category of tool,
 * described in general terms. No competitor's interface, copy or implementation
 * is reproduced, and where a specialised tool is deeper, this page says so.
 */
const MATRIX: Array<{ capability: string; retainos: "full" | "partial" | "none"; note: string }> = [
  { capability: "Event capture and product analytics", retainos: "full", note: "Events, active users, segmentation on six approved dimensions, journeys." },
  { capability: "Funnel analysis", retainos: "full", note: "Ordered steps, conversion windows, per-step intervals, segment comparison." },
  { capability: "Cohort retention", retainos: "full", note: "Fixed denominator, timezone-correct periods, incomplete cells excluded from averages." },
  { capability: "Activation and time-to-value", retainos: "full", note: "Customer-defined activation event with an explicit window." },
  { capability: "Customer feedback and portal", retainos: "full", note: "Widget, public portal, inbox, clustering, duplicate merging, voting." },
  { capability: "Evidence-to-issue workflow", retainos: "full", note: "The core differentiator. Frozen evidence snapshots, approval gate, GitHub dispatch." },
  { capability: "A/B experimentation", retainos: "full", note: "Stable assignment, exposure-based analysis, SRM and contamination checks, Holm correction." },
  { capability: "Subscription and revenue analytics", retainos: "full", note: "MRR movement that reconciles, NRR, GRR, churn by verified cause." },
  { capability: "Onboarding checklists", retainos: "partial", note: "Flows, steps and completion tracking exist. There are no tooltip overlays or product tours." },
  { capability: "Release tracking and changelog", retainos: "full", note: "Releases, linked improvements, public or private changelog." },
  { capability: "Feature flags", retainos: "partial", note: "Experiment variant assignment works as a flag. There is no standalone flag management UI." },
  { capability: "Session replay", retainos: "none", note: "Deliberately absent. Replay records what people type and see; RetainOS will not collect it. Use a dedicated tool if you need it." },
  { capability: "Error and exception monitoring", retainos: "none", note: "RetainOS reads error events you send it, but it is not an error monitor. Sentry and its peers are far deeper here." },
  { capability: "Heatmaps and click maps", retainos: "none", note: "Not built. Requires page-level capture RetainOS avoids by design." },
  { capability: "Marketing attribution", retainos: "partial", note: "An acquisition_source dimension only. No multi-touch attribution, no ad platform integrations." },
  { capability: "Mobile SDKs", retainos: "none", note: "The HTTP ingestion API is documented and usable from any platform, but only a JavaScript SDK ships today." },
  { capability: "Data warehouse export", retainos: "partial", note: "Full JSON and CSV export of a project. No streaming sync to a warehouse." },
  { capability: "AI analysis", retainos: "full", note: "Deterministic rule-based analysis that runs with no API key. An LLM adapter is optional and never computes a number." },
];

const TONE = {
  full: { label: "Built", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40" },
  partial: { label: "Partial", className: "bg-amber-500/15 text-amber-500 border-amber-500/40" },
  none: { label: "Not built", className: "bg-navy-800 text-slate-400 border-navy-600" },
};

export default function Features() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-offwhite">Features, honestly</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
        RetainOS brings together the parts of product analytics, feedback and product operations that feed each
        other. It is not the deepest tool in any single one of those categories, and this page is where it says
        so. Capabilities below reflect what is implemented and tested, not what is planned.
      </p>

      <div className="mt-8 overflow-hidden rounded-xl border border-navy-700/70">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-navy-900/60">
              <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">Capability</th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">Status</th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">What that means</th>
            </tr>
          </thead>
          <tbody>
            {MATRIX.map((row) => (
              <tr key={row.capability} className="border-t border-navy-800/70">
                <td className="px-4 py-3 align-top text-slate-300">{row.capability}</td>
                <td className="px-4 py-3 align-top">
                  <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium ${TONE[row.retainos].className}`}>
                    {TONE[row.retainos].label}
                  </span>
                </td>
                <td className="px-4 py-3 align-top text-xs leading-relaxed text-slate-400">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 rounded-xl border border-navy-700/70 bg-navy-900/50 p-6">
        <h2 className="text-base font-semibold text-offwhite">Where we would not recommend RetainOS</h2>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-slate-400">
          <li>You need session replay or heatmaps as your primary tool.</li>
          <li>You need production error monitoring with stack traces and alerting.</li>
          <li>You are a mobile-first product and need a native SDK today.</li>
          <li>You have no real users yet. A retention tool has nothing to tell you until people are using the product.</li>
          <li>You need multi-touch marketing attribution across ad platforms.</li>
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          RetainOS has not been compared against other products in controlled testing, so it makes no claim to be
          better than them. What it claims is a specific workflow: moving from a measured problem to a verified
          improvement without changing tools.
        </p>
      </div>

      <div className="mt-8 flex gap-3">
        <Link href="/signup" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">
          Start free
        </Link>
        <Link href="/docs" className="rounded-lg border border-navy-600 bg-navy-900 px-4 py-2 text-sm font-medium text-offwhite hover:bg-navy-800">
          Read the docs
        </Link>
      </div>
    </div>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Integrations" };

const INTEGRATIONS = [
  {
    name: "GitHub",
    status: "Implemented, opt-in",
    body: "Turn an approved improvement into a real issue. RetainOS drafts the title, body and labels from the " +
      "evidence attached to the task; a human approves it; only then is anything sent.",
    detail: [
      "Requires a fine-grained token with Issues: write on the target repository only.",
      "The token lives in the server environment and is never exposed to the browser.",
      "No issue is created without an explicit approval, and a task that already has an issue cannot get a second one.",
      "RetainOS never pushes code, opens pull requests or modifies a repository.",
    ],
  },
  {
    name: "Razorpay",
    status: "Adapter implemented, signature verification implemented, not tested against live traffic",
    body: "India-first subscription billing. Verified webhook events map to subscription state so revenue " +
      "figures come from the provider rather than from guesses about usage.",
    detail: [
      "Webhook signatures are verified before any event is applied.",
      "Repeat delivery is expected and idempotent on the provider's own event id.",
      "Only mapped fields are stored. The raw payload is not retained, so it cannot carry customer PII into RetainOS.",
      "Local development uses a billing simulator instead, and never charges anyone.",
    ],
  },
  {
    name: "Stripe",
    status: "Adapter implemented, signature verification implemented, not tested against live traffic",
    body: "The same subscription event model, for products billing internationally.",
    detail: ["Identical guarantees to the Razorpay adapter."],
  },
  {
    name: "Language model providers",
    status: "Optional, off by default",
    body: "RetainAI's analysis is deterministic and runs with no API key. An optional adapter can rephrase a " +
      "finding more fluently.",
    detail: [
      "A model never computes a metric and never invents a finding.",
      "Where a finding is template-generated, the record says so. RetainOS will not imply a model wrote text it did not.",
      "With no provider configured, every feature still works.",
    ],
  },
  {
    name: "CSV import",
    status: "Implemented",
    body: "Bring existing feedback or subscription records in without an API.",
    detail: ["Imported rows are validated the same way as live ones and marked with their source."],
  },
];

export default function Integrations() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-offwhite">Integrations</h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">
        Every integration is optional. RetainOS is fully functional with none of them connected, and the status
        below says exactly how far each one has been verified rather than implying all of them are battle-tested.
      </p>

      <div className="mt-8 space-y-4">
        {INTEGRATIONS.map((i) => (
          <div key={i.name} className="rounded-xl border border-navy-700/70 bg-navy-900/50 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-offwhite">{i.name}</h2>
              <span className="rounded-md border border-navy-600 bg-navy-800 px-2 py-0.5 text-[11px] text-slate-400">
                {i.status}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{i.body}</p>
            <ul className="mt-3 space-y-1.5">
              {i.detail.map((d) => (
                <li key={d} className="flex gap-2 text-xs leading-relaxed text-slate-500">
                  <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-600" />
                  {d}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

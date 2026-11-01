"use client";

import { useActionState } from "react";
import { runAnalysisAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, ErrorBanner, SuccessBanner } from "@/components/ui";

export function AiTools({
  question, examples, quotaError,
}: { question: string; examples: string[]; quotaError: string | null }) {
  const [state, run, running] = useActionState(runAnalysisAction, {} as { error?: string; ok?: string });

  return (
    <Card>
      <CardHeader
        title="Ask about your product"
        subtitle="Answers are composed from figures RetainOS computed. It refuses questions it cannot compute."
        action={
          <form action={run}>
            <Button type="submit" variant="secondary" size="sm" disabled={running}>
              {running ? "Analysing…" : "Run analysis"}
            </Button>
          </form>
        }
      />
      <CardBody>
        <ErrorBanner message={state?.error ?? quotaError} />
        <SuccessBanner message={state?.ok} />

        <form method="get" className="flex flex-wrap gap-2">
          <input
            name="q"
            defaultValue={question}
            placeholder="Which onboarding step has the largest drop-off?"
            className="min-w-0 flex-1 rounded-lg border border-navy-600 bg-navy-950/60 px-3 py-2 text-sm text-offwhite placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
          />
          <Button type="submit">Ask</Button>
        </form>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {examples.map((e) => (
            <a
              key={e}
              href={`/ai?q=${encodeURIComponent(e)}`}
              className="rounded-md border border-navy-700 bg-navy-900/60 px-2 py-1 text-[11px] text-slate-400 transition-colors hover:border-navy-600 hover:text-offwhite"
            >
              {e}
            </a>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

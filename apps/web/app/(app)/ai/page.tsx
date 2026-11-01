import type { Metadata } from "next";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { listInsights, getInsight, ask, EXAMPLE_QUESTIONS } from "@retainos/analytics";
import { jsonParse, consumeUsage, entitlementFor } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Badge, Empty, Caveats, Button, Confidence, Table, Th, Td } from "@/components/ui";
import { num, when, relative, titleCase } from "@/lib/format";
import { AiTools } from "./tools";

export const metadata: Metadata = { title: "RetainAI" };
export const dynamic = "force-dynamic";

export default async function Ai({
  searchParams,
}: { searchParams: Promise<{ q?: string; insight?: string }> }) {
  const params = await searchParams;
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();
  const entitlement = entitlementFor(handle, ctx.org.id);

  const insights = listInsights(handle, ctx.project.id, { limit: 30 }) as Array<Record<string, unknown>>;
  const selected = params.insight ? getInsight(handle, ctx.project.id, params.insight) : null;

  // A question is metered, because answering one runs real queries.
  let answer = null;
  let quotaError: string | null = null;
  if (params.q) {
    const quota = consumeUsage(handle, ctx.org.id, "ai_queries", 1);
    if (quota.allowed === 0) {
      quotaError = `Your ${entitlement.planId} plan allows ${quota.limit} questions per month and you have used ${quota.used}.`;
    } else {
      answer = ask(handle, ctx.project.id, {
        question: params.q, timezone: ctx.projectScope.timezone, now, projectName: ctx.project.name,
      });
    }
  }

  const lastRun = handle.get<{ started_at: number; insights_created: number; generator: string }>(
    "SELECT started_at, insights_created, generator FROM analysis_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1",
    [ctx.project.id],
  );

  return (
    <>
      <PageHeader
        title="RetainAI"
        description="Deterministic analysis over your own data. It runs with no API key, and never invents a number."
      />

      <div className="mb-5">
        <Caveats tone="info" items={[
          "Every figure here is computed by RetainOS's own engines, not by a language model. The analysis is a rule engine, and each record says so.",
          "Findings separate what was measured from what might explain it. The explanations are unverified hypotheses.",
          "Severity orders the list. It is not a probability and not a measure of business impact.",
        ]} />
      </div>

      <AiTools question={params.q ?? ""} examples={EXAMPLE_QUESTIONS} quotaError={quotaError} />

      {answer ? (
        <Card className="mt-5">
          <CardHeader
            title="Answer"
            subtitle={`Matched intent: ${titleCase(answer.intent)} · composed from computed values, not generated prose`}
            action={<Badge tone="neutral">{answer.generator.replace(/_/g, " ")}</Badge>}
          />
          <CardBody>
            <p className="text-sm leading-relaxed text-slate-300">{answer.answer}</p>

            {answer.figures.length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium text-slate-400">Every figure quoted above, and how it was computed</p>
                <Table>
                  <thead><tr><Th>Figure</Th><Th align="right">Value</Th><Th>Definition</Th></tr></thead>
                  <tbody>
                    {answer.figures.map((f, i) => (
                      <tr key={`${f.label}-${i}`}>
                        <Td>{f.label}</Td>
                        <Td align="right">{f.value}</Td>
                        <Td className="max-w-md text-[11px] leading-snug text-slate-500">{f.definition}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : null}

            {answer.limitations.length > 0 ? (
              <div className="mt-4"><Caveats items={answer.limitations} /></div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-offwhite">
              Findings {insights.length > 0 ? <span className="text-slate-500">({num(insights.length)})</span> : null}
            </h2>
            {lastRun ? (
              <span className="text-[11px] text-slate-500">
                Last run {relative(lastRun.started_at, now)} by {lastRun.generator}
              </span>
            ) : null}
          </div>

          {insights.length === 0 ? (
            <Empty
              title="No open findings"
              body={
                "That may mean nothing is wrong, or that there is not yet enough data to detect anything — those " +
                "two look identical from here. Run the analysis to check."
              }
            />
          ) : (
            insights.map((i) => {
              const hypotheses = jsonParse<string[]>(i.hypotheses, []);
              const investigation = jsonParse<string[]>(i.suggested_investigation, []);
              const limitations = jsonParse<string[]>(i.limitations, []);
              return (
                <Card key={String(i.id)}>
                  <CardHeader
                    title={String(i.title)}
                    subtitle={`${titleCase(String(i.kind))} · severity ${String(i.severity)}${i.affected_users ? ` · ${num(Number(i.affected_users))} users affected` : ""}`}
                    action={<Confidence label={String(i.confidence)} basis={String(i.confidence_basis ?? "")} />}
                  />
                  <CardBody>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">Observed</p>
                      <p className="mt-1 text-sm leading-relaxed text-slate-300">{String(i.observation)}</p>
                    </div>

                    {hypotheses.length > 0 ? (
                      <div className="mt-4">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">
                          Possible explanations — none of these is confirmed
                        </p>
                        <ul className="mt-1.5 space-y-1">
                          {hypotheses.map((h, n) => (
                            <li key={n} className="flex gap-2 text-xs leading-relaxed text-slate-400">
                              <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-amber-500/60" />
                              {h}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {investigation.length > 0 ? (
                      <div className="mt-4">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          What would settle it
                        </p>
                        <ul className="mt-1.5 space-y-1">
                          {investigation.map((s, n) => (
                            <li key={n} className="flex gap-2 text-xs leading-relaxed text-slate-400">
                              <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-600" />
                              {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
                      <span className="font-medium">How this was measured:</span> {String(i.metric_definition)}
                      {i.period_start ? ` Period ${when(Number(i.period_start))} to ${when(Number(i.period_end))}.` : ""}
                      {i.comparison_start ? ` Compared with ${when(Number(i.comparison_start))} to ${when(Number(i.comparison_end))}.` : ""}
                    </p>

                    {limitations.length > 0 ? (
                      <div className="mt-3"><Caveats items={limitations} /></div>
                    ) : null}
                  </CardBody>
                </Card>
              );
            })
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="How RetainAI works" />
            <CardBody>
              <ol className="space-y-2.5 text-xs leading-relaxed text-slate-400">
                {[
                  "Intent parsing — pattern matching over your question. The tokens it matched are reported.",
                  "Authorization — the scope is verified against the database before anything is read.",
                  "Data retrieval and metric calculation — RetainOS's own deterministic engines. A model is never the calculator.",
                  "Evidence retrieval — the records behind the figure, with a frozen snapshot.",
                  "Answer composition — templates over computed values.",
                  "Action — suggested, never performed. Nothing is created without your approval.",
                ].map((step, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-navy-800 text-[10px] text-slate-400">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
              <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
                An optional language-model adapter can rephrase a finding more fluently. It is off by default,
                it never computes a metric, and where text is template-generated the record says so rather than
                implying a model wrote it.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

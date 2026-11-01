import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { computeFunnel, listFunnels, eventBreakdown, FUNNEL_DEFINITION } from "@retainos/analytics";
import { PageHeader, Card, CardHeader, CardBody, Table, Th, Td, Bar, Badge, Empty, Caveats, Button, Metric } from "@/components/ui";
import { pct, num, duration } from "@/lib/format";
import { FunnelForms } from "./forms";

export const metadata: Metadata = { title: "Funnels" };
export const dynamic = "force-dynamic";

export default async function Funnels({ searchParams }: { searchParams: Promise<{ id?: string; days?: string }> }) {
  const params = await searchParams;
  const days = Math.min(Math.max(Number(params.days ?? 30) || 30, 1), 365);
  const ctx = await requireProject();
  const handle = db();
  const { projectId } = ctx.projectScope;
  const now = Date.now();
  const from = now - days * 86_400_000;

  const saved = listFunnels(handle, projectId);
  const selected = params.id ? saved.find((f) => f.id === params.id) : saved[0];
  const knownEvents = eventBreakdown(handle, projectId, { from: now - 90 * 86_400_000, to: now, limit: 40 });

  const result = selected
    ? computeFunnel(handle, projectId, {
        steps: selected.steps, from, to: now, conversionWindowHours: selected.conversion_window_hours,
      })
    : null;

  return (
    <>
      <PageHeader
        title="Funnels"
        description="Ordered steps, unique users, and a conversion window measured from each user's first step."
        action={
          <div className="flex gap-1.5">
            {[7, 30, 90].map((d) => (
              <Link key={d} href={`/analytics/funnels?days=${d}${selected ? `&id=${selected.id}` : ""}`}>
                <Button variant={d === days ? "primary" : "secondary"} size="sm">{d}d</Button>
              </Link>
            ))}
          </div>
        }
      />

      {saved.length === 0 ? (
        <>
          <Empty
            title="No funnels saved yet"
            body="Build one from the events your application already sends. Steps must be in the order you expect users to perform them."
          />
          <div className="mt-5">
            <FunnelForms knownEvents={knownEvents.map((e) => e.name)} saved={[]} />
          </div>
        </>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-1.5">
            {saved.map((f) => (
              <Link key={f.id} href={`/analytics/funnels?id=${f.id}&days=${days}`}>
                <Button variant={selected?.id === f.id ? "primary" : "secondary"} size="sm">{f.name}</Button>
              </Link>
            ))}
          </div>

          {result?.ok && selected ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric label="Entered" value={num(result.value.entered)}
                  definition={`Unique users who performed "${selected.steps[0]!.event}" in this period.`} />
                <Metric label="Completed" value={num(result.value.completed)}
                  definition="Unique users who performed every step in order, inside the conversion window." />
                <Metric label="Overall conversion" value={pct(result.value.overallConversion)}
                  definition="Completed divided by entered."
                  caveat={result.value.sampleWarning} />
              </div>

              <Card className="mt-5">
                <CardHeader
                  title={selected.name}
                  subtitle={`Conversion window: ${selected.conversion_window_hours} hours from the first step.`}
                  action={
                    result.value.largestDropOff ? (
                      <Badge tone="bad">
                        Biggest loss: step {result.value.largestDropOff.fromIndex + 1} → {result.value.largestDropOff.toIndex + 1}
                      </Badge>
                    ) : null
                  }
                />
                <CardBody>
                  <ol className="space-y-4">
                    {result.value.steps.map((step) => {
                      const isWorst = result.value.largestDropOff?.toIndex === step.index;
                      return (
                        <li key={step.index}>
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="text-sm text-offwhite">
                              <span className="mr-2 text-xs text-slate-500">{step.index + 1}.</span>
                              <code className="font-mono text-[12px]">{step.event}</code>
                            </span>
                            <span className="text-xs tnum text-slate-400">
                              {num(step.users)} users
                              {step.stepConversion !== null ? (
                                <span className={isWorst ? "ml-2 text-rose-500" : "ml-2 text-slate-500"}>
                                  {pct(step.stepConversion)} from previous
                                </span>
                              ) : null}
                            </span>
                          </div>
                          <div className="mt-1.5">
                            <Bar fraction={step.overallConversion} tone={isWorst ? "rose" : "blue"} />
                          </div>
                          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-500">
                            <span>{pct(step.overallConversion)} of everyone who entered</span>
                            {step.droppedFromPrevious > 0 ? <span>{num(step.droppedFromPrevious)} lost here</span> : null}
                            {step.medianMsFromPrevious !== null ? (
                              <span>median {duration(step.medianMsFromPrevious)} from previous step</span>
                            ) : null}
                            {step.stepConversionInterval ? (
                              <span className="tnum">
                                95% interval {pct(step.stepConversionInterval[0])}–{pct(step.stepConversionInterval[1])}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </CardBody>
              </Card>

              <div className="mt-5">
                <Caveats tone="info" items={[
                  FUNNEL_DEFINITION.countingMethod,
                  FUNNEL_DEFINITION.repeatedEvents,
                  FUNNEL_DEFINITION.windowSemantics,
                  "A drop-off tells you where users stopped. It does not tell you why, and it is not evidence that the step is at fault.",
                ]} />
              </div>

              {result.value.largestDropOff ? (
                <Card className="mt-5">
                  <CardHeader
                    title="Act on this"
                    subtitle="Carry the measurement into an improvement task, with the numbers frozen as evidence."
                  />
                  <CardBody>
                    <form action="/improvements" method="get">
                      <input type="hidden" name="fromEvent" value={result.value.steps[result.value.largestDropOff.fromIndex]!.event} />
                      <input type="hidden" name="toEvent" value={result.value.steps[result.value.largestDropOff.toIndex]!.event} />
                      <input type="hidden" name="lost" value={String(result.value.largestDropOff.lostUsers)} />
                      <input type="hidden" name="rate" value={String(result.value.largestDropOff.conversionRate)} />
                      <input type="hidden" name="entered" value={String(result.value.steps[result.value.largestDropOff.fromIndex]!.users)} />
                      <Button type="submit" variant="secondary" size="sm">
                        Create an improvement from this drop-off
                      </Button>
                    </form>
                  </CardBody>
                </Card>
              ) : null}
            </>
          ) : result && !result.ok ? (
            <Card><CardBody><p className="text-xs text-rose-500">{result.error.message}</p></CardBody></Card>
          ) : null}

          <div className="mt-5">
            <FunnelForms knownEvents={knownEvents.map((e) => e.name)} saved={saved.map((f) => ({ id: f.id, name: f.name }))} />
          </div>
        </>
      )}
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { computeRetention, retentionCurve, eventBreakdown } from "@retainos/analytics";
import { PageHeader, Card, CardHeader, CardBody, Metric, Table, Th, Td, Empty, Caveats, Badge, Button, cx } from "@/components/ui";
import { RetentionCurve } from "@/components/charts";
import { pct, num } from "@/lib/format";

export const metadata: Metadata = { title: "Retention" };
export const dynamic = "force-dynamic";

/** Heatmap cell colour by retention rate. Incomplete cells are never coloured. */
function cellClass(rate: number | null, complete: boolean): string {
  if (!complete || rate === null) return "bg-navy-800/40 text-slate-600";
  if (rate >= 0.6) return "bg-emerald-500/30 text-emerald-300";
  if (rate >= 0.4) return "bg-emerald-500/20 text-emerald-400";
  if (rate >= 0.25) return "bg-cyan-500/20 text-cyan-400";
  if (rate >= 0.1) return "bg-amber-500/20 text-amber-400";
  if (rate > 0) return "bg-rose-500/20 text-rose-400";
  return "bg-navy-800 text-slate-500";
}

export default async function Retention({
  searchParams,
}: { searchParams: Promise<{ granularity?: string; returnEvent?: string; days?: string }> }) {
  const params = await searchParams;
  const granularity = (params.granularity === "week" || params.granularity === "month" ? params.granularity : "day") as "day" | "week" | "month";
  const days = Math.min(Math.max(Number(params.days ?? 60) || 60, 7), 365);
  const ctx = await requireProject();
  const handle = db();
  const { projectId, timezone } = ctx.projectScope;
  const now = Date.now();

  const knownEvents = eventBreakdown(handle, projectId, { from: now - 90 * 86_400_000, to: now, limit: 30 })
    .map((e) => e.name);

  const result = computeRetention(handle, projectId, {
    from: now - days * 86_400_000,
    to: now,
    granularity,
    timezone,
    returnEvent: params.returnEvent || null,
    now,
  });

  const d1 = result.averageByPeriod.find((p) => p.period === 1);
  const d7 = result.averageByPeriod.find((p) => p.period === 7);
  const d30 = result.averageByPeriod.find((p) => p.period === 30);

  const link = (extra: Record<string, string>) => {
    const sp = new URLSearchParams({ granularity, days: String(days) });
    if (params.returnEvent) sp.set("returnEvent", params.returnEvent);
    for (const [k, v] of Object.entries(extra)) v ? sp.set(k, v) : sp.delete(k);
    return `/retention?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Retention"
        description={`Cohorts formed in the last ${days} days, bucketed by ${granularity} in ${timezone}.`}
        action={
          <div className="flex flex-wrap gap-1.5">
            {(["day", "week", "month"] as const).map((g) => (
              <Link key={g} href={link({ granularity: g })}>
                <Button variant={g === granularity ? "primary" : "secondary"} size="sm">{g}</Button>
              </Link>
            ))}
          </div>
        }
      />

      {result.cohorts.length === 0 ? (
        <Empty
          title="No cohorts in this period"
          body="A cohort needs at least one user whose first event falls inside the window. Widen the period, or send some events."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Day-1 retention" value={pct(d1?.rate ?? null)}
              definition={d1?.rate !== null && d1 ? `Across ${num(d1.usersCounted)} users in complete cohorts.` : "No cohort has a complete day-1 window yet."} />
            <Metric label="Day-7 retention" value={pct(d7?.rate ?? null)}
              definition={d7?.rate !== null && d7 ? `Across ${num(d7.usersCounted)} users in complete cohorts.` : "No cohort has a complete day-7 window yet."} />
            <Metric label="Day-30 retention" value={pct(d30?.rate ?? null)}
              definition={d30?.rate !== null && d30 ? `Across ${num(d30.usersCounted)} users in complete cohorts.` : "No cohort has a complete day-30 window yet."} />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-500">Return event:</span>
            <Link href={link({ returnEvent: "" })}>
              <Button variant={params.returnEvent ? "ghost" : "secondary"} size="sm">Any event</Button>
            </Link>
            {knownEvents.slice(0, 6).map((e) => (
              <Link key={e} href={link({ returnEvent: e })}>
                <Button variant={params.returnEvent === e ? "primary" : "ghost"} size="sm">{e}</Button>
              </Link>
            ))}
          </div>

          <Card className="mt-5">
            <CardHeader title="Cohort heatmap" subtitle={result.definition.denominator} />
            <CardBody>
              <div className="-mx-5 overflow-x-auto px-5">
                <table className="border-collapse text-xs">
                  <thead>
                    <tr>
                      <Th className="pr-3">Cohort</Th>
                      <Th align="right" className="px-3">Size</Th>
                      {result.periods.map((p) => <Th key={p} align="right" className="px-3">{granularity[0]!.toUpperCase()}{p}</Th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {result.cohorts.map((c) => (
                      <tr key={c.cohort}>
                        <Td className="whitespace-nowrap pr-3 font-mono text-[11px]">
                          {c.cohort}
                          {c.smallSample ? <span className="ml-1.5 text-[10px] text-amber-500">small</span> : null}
                        </Td>
                        <Td align="right" className="px-3">{num(c.cohortSize)}</Td>
                        {c.cells.map((cell) => (
                          <td key={cell.period} className="border-b border-navy-800/60 px-1 py-1">
                            <div
                              className={cx("rounded px-2 py-1.5 text-center tnum", cellClass(cell.rate, cell.complete))}
                              title={
                                cell.complete
                                  ? `${cell.retained} of ${c.cohortSize} retained. 95% interval ${pct(cell.interval[0])}–${pct(cell.interval[1])}.`
                                  : "This period has not fully elapsed for every member of this cohort, so it is not yet knowable."
                              }
                            >
                              {cell.complete ? pct(cell.rate, 0) : "—"}
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                A dash means the period has not finished for every member of that cohort. Showing it as 0% would
                invent a decline that has not happened.
              </p>
            </CardBody>
          </Card>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Retention curve" subtitle="Weighted average across cohorts with a complete window." />
              <CardBody className="px-2">
                <RetentionCurve data={retentionCurve(result)} />
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="How this is computed" />
              <CardBody>
                <dl className="space-y-3 text-xs leading-relaxed">
                  {[
                    ["Denominator", result.definition.denominator],
                    ["Retained means", result.definition.returnDefinition],
                    ["Period boundaries", result.definition.periodBoundaries],
                    ["Incomplete periods", result.definition.incompletePeriods],
                  ].map(([term, def]) => (
                    <div key={term}>
                      <dt className="font-medium text-slate-300">{term}</dt>
                      <dd className="mt-0.5 text-slate-400">{def}</dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            </Card>
          </div>

          <div className="mt-5">
            <Caveats items={[
              "Cohorts marked small have fewer than 20 users. A single person moves those percentages a long way.",
              "Day-7 retention says nothing useful about a product people are meant to use monthly. Pick a window that matches your product.",
              "A difference between two cohorts is not an effect of anything in particular: the cohorts differ in many ways at once.",
            ]} />
          </div>
        </>
      )}
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { listImpactMeasurements, releaseTimeline, BEFORE_AFTER_WARNING, eventBreakdown } from "@retainos/analytics";
import { listReleases, listImprovements, entitlementFor } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Metric, Badge, Empty, Caveats, Button, Table, Th, Td } from "@/components/ui";
import { pct, num, when, titleCase } from "@/lib/format";
import { MeasureForm } from "./form";

export const metadata: Metadata = { title: "ImpactLab" };
export const dynamic = "force-dynamic";

export default async function Impact() {
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();
  const entitlement = entitlementFor(handle, ctx.org.id);

  if (!entitlement.features.impactLab) {
    return (
      <>
        <PageHeader title="ImpactLab" />
        <Empty
          title="Not included on your plan"
          body={`ImpactLab is part of the Growth plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  const releases = listReleases(handle, ctx.projectScope, 20) as Array<Record<string, unknown>>;
  const improvements = listImprovements(handle, ctx.projectScope, {
    status: ["released", "measuring", "resolved", "not_effective"], limit: 50,
  }) as Array<Record<string, unknown>>;
  const measurements = listImpactMeasurements(handle, ctx.project.id, 20);
  const events = eventBreakdown(handle, ctx.project.id, { from: now - 90 * 86_400_000, to: now, limit: 30 })
    .map((e) => e.name);

  return (
    <>
      <PageHeader
        title="ImpactLab"
        description="Did the change help? Before-and-after shows whether a metric moved. Only an experiment shows why."
        action={<Link href="/experiments"><Button variant="secondary" size="sm">Experiments</Button></Link>}
      />

      <div className="mb-5">
        <Caveats items={[BEFORE_AFTER_WARNING]} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {measurements.length === 0 ? (
            <Empty
              title="Nothing measured yet"
              body={
                releases.length === 0
                  ? "Record a release first. ImpactLab needs a point in time to compare across."
                  : "Pick a release and a metric, and RetainOS will compare the window before it with the window after — listing every confounder it can detect."
              }
              action={releases.length === 0 ? <Link href="/releases"><Button>Record a release</Button></Link> : undefined}
            />
          ) : (
            measurements.map((m) => {
              const r = m.result as Record<string, unknown>;
              const before = r.before as Record<string, unknown> | undefined;
              const after = r.after as Record<string, unknown> | undefined;
              const confounders = (r.confounders ?? []) as Array<{ id: string; detected: boolean; detail: string }>;
              const detected = confounders.filter((c) => c.detected);
              return (
                <Card key={m.id}>
                  <CardHeader
                    title={String(r.metricLabel ?? titleCase(m.metric_kind))}
                    subtitle={`Measured ${when(m.computed_at)} · ${m.method === "experiment" ? "controlled experiment" : "observational before-and-after"}`}
                    action={
                      <Badge tone={m.method === "experiment" ? "good" : "warn"}>
                        {m.method === "experiment" ? "causal evidence" : "correlation only"}
                      </Badge>
                    }
                  />
                  <CardBody>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Metric label="Before" value={pct(before?.rate as number | null)}
                        definition={`${num(before?.numerator as number)} of ${num(before?.denominator as number)} users.`} />
                      <Metric label="After" value={pct(after?.rate as number | null)}
                        definition={`${num(after?.numerator as number)} of ${num(after?.denominator as number)} users.`} />
                      <Metric
                        label="Observed change"
                        value={r.absoluteChange === null || r.absoluteChange === undefined
                          ? "—"
                          : `${(r.absoluteChange as number) > 0 ? "+" : ""}${((r.absoluteChange as number) * 100).toFixed(1)} pts`}
                        definition="The difference between the two windows. Not an estimate of the release's effect."
                        tone={(r.absoluteChange as number) > 0 ? "good" : (r.absoluteChange as number) < 0 ? "bad" : undefined}
                      />
                    </div>

                    <p className="mt-4 text-xs leading-relaxed text-slate-400">{String(r.interpretation ?? "")}</p>

                    <div className="mt-4">
                      <p className="mb-2 text-xs font-medium text-slate-400">
                        Confounders checked ({detected.length} detected of {confounders.length})
                      </p>
                      <ul className="space-y-1.5">
                        {confounders.map((c) => (
                          <li key={c.id} className="flex gap-2 text-[11px] leading-relaxed">
                            <Badge tone={c.detected ? "warn" : "neutral"}>{c.detected ? "detected" : "clear"}</Badge>
                            <span className={c.detected ? "text-amber-500/90" : "text-slate-500"}>{c.detail}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {Array.isArray(r.limitations) && r.limitations.length > 0 ? (
                      <div className="mt-4"><Caveats items={r.limitations as string[]} /></div>
                    ) : null}
                  </CardBody>
                </Card>
              );
            })
          )}

          {releases.length > 0 ? (
            <Card>
              <CardHeader
                title="Release timeline"
                subtitle="Users firing a core event in the week either side of each release. Descriptive only."
              />
              <CardBody>
                <Table>
                  <thead>
                    <tr><Th>Release</Th><Th align="right">Week before</Th><Th align="right">Week after</Th><Th align="right">Shipped</Th></tr>
                  </thead>
                  <tbody>
                    {releaseTimeline(handle, ctx.project.id, {
                      eventName: events.includes("core_action_completed") ? "core_action_completed" : (events[0] ?? "signup_completed"),
                      timezone: ctx.projectScope.timezone, windowDays: 7, limit: 10,
                    }).map((row) => (
                      <tr key={row.release.id}>
                        <Td>{row.release.version} <span className="text-slate-500">{row.release.name}</span></Td>
                        <Td align="right">{num(row.usersBefore)}</Td>
                        <Td align="right">{num(row.usersAfter)}</Td>
                        <Td align="right">{when(row.release.released_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                  Two numbers either side of a date is the weakest form of evidence there is. It is shown because
                  it is sometimes the only thing available, not because it supports a conclusion.
                </p>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div>
          <MeasureForm
            releases={releases.map((r) => ({ id: String(r.id), label: `${String(r.version)} — ${String(r.name)}` }))}
            improvements={improvements.map((i) => ({ id: String(i.id), label: String(i.title) }))}
            events={events}
          />
        </div>
      </div>
    </>
  );
}

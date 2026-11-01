import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { listImprovements, IMPROVEMENT_STATUSES, entitlementFor } from "@retainos/database";
import { PageHeader, Card, CardBody, Badge, Empty, Caveats, Button, Table, Th, Td } from "@/components/ui";
import { num, relative, titleCase, pct } from "@/lib/format";
import { NewImprovementForm } from "./form";

export const metadata: Metadata = { title: "Improvements" };
export const dynamic = "force-dynamic";

const OPEN_STATUSES = [
  "detected", "investigating", "validated", "planned", "approved", "in_development", "in_review",
] as const;

export default async function Improvements({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string; fromEvent?: string; toEvent?: string; lost?: string; rate?: string; entered?: string;
  }>;
}) {
  const params = await searchParams;
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();
  const entitlement = entitlementFor(handle, ctx.org.id);

  const tasks = listImprovements(handle, ctx.projectScope, {
    status: params.status ? [params.status as never] : undefined,
    limit: 100,
  }) as Array<Record<string, unknown>>;

  // Pre-filled from a funnel drop-off, so the evidence travels with the task.
  const prefill = params.fromEvent && params.toEvent
    ? {
        title: `Reduce drop-off between ${params.fromEvent} and ${params.toEvent}`,
        affectedWorkflow: `${params.fromEvent} → ${params.toEvent}`,
        description:
          `${params.lost ?? "Some"} of ${params.entered ?? "the"} users who reached "${params.fromEvent}" did not ` +
          `reach "${params.toEvent}". Step conversion was ${params.rate ? pct(Number(params.rate)) : "unknown"}.`,
        evidenceKind: "funnel_step",
        evidenceSummary:
          `${params.fromEvent} → ${params.toEvent}: ${params.rate ? pct(Number(params.rate)) : "?"} step conversion, ` +
          `${params.lost ?? "?"} users lost`,
        evidenceSnapshot: JSON.stringify({
          fromEvent: params.fromEvent, toEvent: params.toEvent,
          lostUsers: Number(params.lost ?? 0), conversionRate: Number(params.rate ?? 0),
          enteredUsers: Number(params.entered ?? 0),
        }),
      }
    : null;

  return (
    <>
      <PageHeader
        title="Improvements"
        description="FixFlow: a measured problem, the evidence for it, and the work to address it in one record."
      />

      {!entitlement.features.fixFlow ? (
        <Empty
          title="Not included on your plan"
          body={`FixFlow is part of the Starter plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-1.5">
            <Link href="/improvements">
              <Button variant={params.status ? "ghost" : "secondary"} size="sm">All</Button>
            </Link>
            {IMPROVEMENT_STATUSES.map((s) => (
              <Link key={s} href={`/improvements?status=${s}`}>
                <Button variant={params.status === s ? "primary" : "ghost"} size="sm">{titleCase(s)}</Button>
              </Link>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2">
              {tasks.length === 0 ? (
                <Empty
                  title={params.status ? "Nothing in that state" : "No improvement tasks yet"}
                  body={
                    "An improvement starts from a measurement. Open a funnel, find the largest drop-off, and " +
                    "create a task from it — the numbers travel with it as frozen evidence."
                  }
                  action={<Link href="/analytics/funnels"><Button>Open funnels</Button></Link>}
                />
              ) : (
                <Card>
                  <CardBody>
                    <Table>
                      <thead>
                        <tr>
                          <Th>Task</Th><Th>Status</Th><Th>Priority</Th>
                          <Th align="right">Evidence</Th><Th align="right">Updated</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {tasks.map((t) => (
                          <tr key={String(t.id)}>
                            <Td>
                              <Link href={`/improvements/${String(t.id)}`} className="text-slate-300 hover:text-blue-400">
                                {String(t.title)}
                              </Link>
                              {t.issue_url ? (
                                <a
                                  href={String(t.issue_url)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="ml-2 text-[11px] text-cyan-400 hover:underline"
                                >
                                  issue ↗
                                </a>
                              ) : null}
                              {t.outcome ? (
                                <div className="mt-1">
                                  <Badge tone={
                                    t.outcome === "improvement_supported" ? "good"
                                    : t.outcome === "worse_outcome" ? "bad" : "warn"
                                  }>
                                    {titleCase(String(t.outcome))}
                                  </Badge>
                                </div>
                              ) : null}
                            </Td>
                            <Td><Badge>{titleCase(String(t.status))}</Badge></Td>
                            <Td>
                              {t.priority ? (
                                <Badge tone={
                                  t.priority === "critical" ? "bad" : t.priority === "high" ? "warn" : "neutral"
                                }>
                                  {String(t.priority)}
                                </Badge>
                              ) : <span className="text-[11px] text-slate-500">unset</span>}
                            </Td>
                            <Td align="right">
                              {Number(t.evidence_count) > 0
                                ? num(Number(t.evidence_count))
                                : <span className="text-amber-500/80">none</span>}
                            </Td>
                            <Td align="right">{relative(Number(t.updated_at), now)}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </CardBody>
                </Card>
              )}

              <div className="mt-5">
                <Caveats tone="info" items={[
                  "A task's hypothesis is a guess that has not been confirmed. It is stored separately from the evidence for exactly that reason.",
                  "Evidence snapshots are frozen when attached, so a task still makes sense after the underlying data moves on.",
                  "Moving a task to Released records that work shipped. Whether it helped is a separate question, answered in ImpactLab.",
                ]} />
              </div>
            </div>

            <div>
              <NewImprovementForm prefill={prefill} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { getImprovement, impactTimeline, canTransition, IMPROVEMENT_STATUSES, type ImprovementStatus } from "@retainos/database";
import { draftIssue } from "@retainos/analytics";
import { PageHeader, Card, CardHeader, CardBody, Badge, Caveats, Button, Table, Th, Td } from "@/components/ui";
import { num, when, relative, titleCase } from "@/lib/format";
import { ImprovementTools } from "./tools";

export const metadata: Metadata = { title: "Improvement" };
export const dynamic = "force-dynamic";

export default async function Improvement({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();

  const record = getImprovement(handle, ctx.projectScope, id);
  if (!record) notFound();

  const task = record.task as Record<string, unknown>;
  const timeline = impactTimeline(handle, ctx.projectScope, id);
  const preview = draftIssue(handle, ctx.project.id, id);
  const status = String(task.status) as ImprovementStatus;
  const allowedNext = IMPROVEMENT_STATUSES.filter((s) => canTransition(status, s));

  return (
    <>
      <PageHeader
        title={String(task.title)}
        description={`Status: ${titleCase(status)}. Created ${when(Number(task.created_at))}.`}
        action={<Link href="/improvements"><Button variant="ghost" size="sm">← All improvements</Button></Link>}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="The record" subtitle="Observation, hypothesis and proposed work are kept apart on purpose." />
            <CardBody>
              <dl className="space-y-4 text-sm">
                {([
                  ["What was observed", task.description, "A measurement."],
                  ["Affected workflow", task.affected_workflow, null],
                  ["Hypothesised cause", task.hypothesis, "A guess. Not confirmed."],
                  ["How to investigate", task.investigation, null],
                  ["Proposed work", task.proposed_work, null],
                  ["Acceptance criteria", task.acceptance_criteria, null],
                  ["Measurement plan", task.measurement_plan, null],
                  ["Priority rationale", task.priority_rationale, null],
                ] as const).map(([label, value, note]) => (
                  <div key={label}>
                    <dt className="flex items-center gap-2 text-xs font-medium text-slate-400">
                      {label}
                      {note ? <span className="text-[10px] font-normal text-slate-600">— {note}</span> : null}
                    </dt>
                    <dd className="mt-1 whitespace-pre-wrap text-slate-300">
                      {value ? String(value) : <span className="text-xs italic text-slate-600">Not recorded.</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Evidence"
              subtitle="Snapshots frozen when attached, so this record still means what it meant at the time."
            />
            <CardBody>
              {record.evidence.length === 0 ? (
                <p className="text-xs leading-relaxed text-amber-500/90">
                  No evidence attached. A task without evidence is an opinion, and the drafted GitHub issue will
                  say so rather than filling the gap.
                </p>
              ) : (
                <ul className="space-y-3">
                  {record.evidence.map((e) => {
                    const ev = e as Record<string, unknown>;
                    let snapshot: Record<string, unknown> = {};
                    try { snapshot = JSON.parse(String(ev.snapshot ?? "{}")); } catch { snapshot = {}; }
                    return (
                      <li key={String(ev.id)} className="rounded-lg border border-navy-700/60 bg-navy-950/40 p-3.5">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <span className="text-sm text-slate-300">{String(ev.summary)}</span>
                          <Badge tone="accent">{titleCase(String(ev.kind))}</Badge>
                        </div>
                        {Object.keys(snapshot).length > 0 ? (
                          <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                            {Object.entries(snapshot)
                              .filter(([, v]) => v !== null && typeof v !== "object")
                              .map(([k, v]) => (
                                <div key={k} className="flex justify-between gap-2">
                                  <dt className="font-mono text-slate-500">{k}</dt>
                                  <dd className="tnum text-slate-400">
                                    {typeof v === "number" && !Number.isInteger(v) ? v.toFixed(4) : String(v)}
                                  </dd>
                                </div>
                              ))}
                          </dl>
                        ) : null}
                        <p className="mt-1.5 text-[10px] text-slate-600">
                          Attached {relative(Number(ev.created_at), now)}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Impact timeline"
              subtitle="Problem → investigation → approval → issue → release → measurement."
            />
            <CardBody>
              <ol className="space-y-2.5">
                {timeline.history.map((h, i) => (
                  <li key={i} className="flex items-baseline gap-3 text-xs">
                    <Badge>{titleCase(h.to_status)}</Badge>
                    <span className="text-slate-400">{h.note ?? ""}</span>
                    <span className="ml-auto shrink-0 text-slate-500">{when(h.changed_at)}</span>
                  </li>
                ))}
                {timeline.githubIssues.map((g) => (
                  <li key={g.issue_url ?? g.repository} className="flex items-baseline gap-3 text-xs">
                    <Badge tone="info">GitHub issue</Badge>
                    <a href={g.issue_url ?? "#"} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">
                      {g.repository}#{g.issue_number}
                    </a>
                    <span className="ml-auto shrink-0 text-slate-500">{when(g.dispatched_at)}</span>
                  </li>
                ))}
                {timeline.releases.map((r) => (
                  <li key={r.version} className="flex items-baseline gap-3 text-xs">
                    <Badge tone="good">Released</Badge>
                    <span className="text-slate-400">{r.version} — {r.name}</span>
                    <span className="ml-auto shrink-0 text-slate-500">{when(r.released_at)}</span>
                  </li>
                ))}
                {timeline.measurements.map((m) => (
                  <li key={m.id} className="flex items-baseline gap-3 text-xs">
                    <Badge tone={m.method === "experiment" ? "good" : "warn"}>
                      {m.method === "experiment" ? "Experiment" : "Observational measurement"}
                    </Badge>
                    <span className="text-slate-400">
                      {m.method === "before_after" ? "Correlation only — confounders listed in ImpactLab." : "Causal evidence."}
                    </span>
                    <span className="ml-auto shrink-0 text-slate-500">{when(m.computed_at)}</span>
                  </li>
                ))}
              </ol>
              {timeline.measurements.length === 0 && status === "released" ? (
                <div className="mt-4">
                  <Caveats items={[
                    "This shipped but has not been measured. Shipping is not the same as improving — measure it in ImpactLab.",
                  ]} />
                </div>
              ) : null}
            </CardBody>
          </Card>

          {preview.ok ? (
            <Card>
              <CardHeader
                title="Drafted GitHub issue"
                subtitle="Generated from this record. Nothing is sent until you approve it."
              />
              <CardBody>
                <p className="mb-2 text-sm font-medium text-offwhite">{preview.value.title}</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {preview.value.labels.map((l) => <Badge key={l} tone="neutral">{l}</Badge>)}
                </div>
                <pre className="max-h-96 overflow-auto rounded-lg border border-navy-700/70 bg-navy-950 px-4 py-3 text-[11px] leading-relaxed whitespace-pre-wrap font-mono text-slate-400">
                  {preview.value.body}
                </pre>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div>
          <ImprovementTools
            improvementId={id}
            status={status}
            allowedNext={allowedNext}
            links={record.githubLinks as Array<Record<string, unknown>>}
          />
        </div>
      </div>
    </>
  );
}

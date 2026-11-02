import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  getFrictionCase, canTransitionCase, FRICTION_STATUSES, SCORE_DISCLAIMER,
  listImpactRecords, type FrictionStatus,
} from "@retainos/analytics";
import { listImprovements } from "@retainos/database";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Button, Caveats, Metric, Bar,
  Confidence, Table, Th, Td, Empty,
} from "@/components/ui";
import { num, money, when, relative, titleCase, pct } from "@/lib/format";
import { CaseWorkflow, EstimateForm, ObservedImpactForm } from "./forms";

export const metadata: Metadata = { title: "Friction case" };
export const dynamic = "force-dynamic";

function parse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export default async function FrictionCase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireProject();
  const handle = db();
  const detail = getFrictionCase(handle, ctx.project.id, id);
  if (!detail) notFound();

  const c = detail.record as Record<string, any>;
  const hypotheses = parse<string[]>(c.hypotheses, []);
  const investigations = parse<string[]>(c.recommended_investigations, []);
  const limitations = parse<string[]>(c.limitations, []);
  const segments = parse<Array<{ dimension: string; value: string; users: number; share: number }>>(
    c.affected_segments, []);
  const factors = detail.factors as Array<Record<string, any>>;
  const status = c.status as FrictionStatus;
  const allowed = FRICTION_STATUSES.filter((s) => canTransitionCase(status, s));
  const improvements = listImprovements(handle, ctx.projectScope, { limit: 50 }) as Array<Record<string, any>>;
  const impact = listImpactRecords(handle, ctx.project.id, { caseId: id });

  // Evidence ids are opaque; the relationship list reads better with summaries.
  const summaryFor = new Map(
    (detail.evidence as Array<Record<string, any>>).map((e) => [e.id as string, e.summary as string]),
  );

  return (
    <>
      <PageHeader
        title={String(c.title)}
        description={String(c.observation)}
        action={
          <Link href="/friction"><Button variant="secondary" size="sm">All cases</Button></Link>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{titleCase(String(c.kind))}</Badge>
        <Badge tone="info">{titleCase(status)}</Badge>
        <Confidence label={String(c.evidence_quality)} basis={String(c.evidence_basis ?? "")} />
        <span className="text-xs text-slate-500">detected {relative(c.detected_at)}</span>
        {c.detector ? <span className="text-xs text-slate-600">by {String(c.detector)}</span> : null}
      </div>

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Metric
          label="Affected users"
          value={num(c.affected_users)}
          definition="Distinct users the attached evidence actually covers. Never an extrapolation from a sample."
        />
        <Metric
          label="Revenue exposure"
          value={c.revenue_exposure_minor ? money(c.revenue_exposure_minor, String(c.revenue_currency ?? "INR")) : "—"}
          definition="Monthly recurring revenue of the accounts these users belong to."
          caveat="Exposure, not predicted loss. These accounts pay this much and were affected; neither implies they will leave."
        />
        <Metric
          label="Opportunity score"
          value={detail.score ? Number((detail.score as any).score).toFixed(1) : "not ranked"}
          definition="Where this sits in the ranked list. It orders a list; it is not a probability."
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="What was observed"
              subtitle="Measurements only. Anything explanatory is below, under hypotheses."
            />
            <CardBody>
              <p className="text-sm leading-relaxed text-slate-300">{String(c.observation)}</p>
              {segments.length > 0 ? (
                <div className="mt-4 space-y-2.5">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                    Where it concentrates
                  </p>
                  {segments.map((s, i) => (
                    <div key={i}>
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-slate-300">{s.dimension}: {s.value}</span>
                        <span className="tnum text-slate-500">{num(s.users)} users · {pct(s.share)}</span>
                      </div>
                      <Bar fraction={s.share} tone="cyan" />
                    </div>
                  ))}
                </div>
              ) : null}
            </CardBody>
          </Card>

          {hypotheses.length > 0 ? (
            <Card>
              <CardHeader
                title="Hypotheses"
                subtitle="Explanations consistent with the evidence. None of them is a finding."
              />
              <CardBody>
                <ul className="space-y-2">
                  {hypotheses.map((h, i) => (
                    <li key={i} className="flex gap-2 text-sm leading-relaxed text-slate-300">
                      <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-slate-600" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Evidence"
              subtitle={`${detail.evidence.length} item(s), with the numbers frozen as they were when attached.`}
            />
            <CardBody>
              {detail.evidence.length === 0 ? (
                <p className="text-xs text-slate-400">No evidence is attached to this case.</p>
              ) : (
                <ul className="space-y-3">
                  {(detail.evidence as Array<Record<string, any>>).map((e) => (
                    <li key={e.id} className="border-b border-navy-800/80 pb-3 last:border-0 last:pb-0">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="min-w-0 text-sm leading-snug text-slate-300">{String(e.summary)}</p>
                        <div className="flex shrink-0 gap-1.5">
                          <Badge tone="neutral">{titleCase(String(e.kind))}</Badge>
                          <Badge tone={e.source === "retainos" ? "info" : "accent"}>{String(e.source)}</Badge>
                        </div>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">observed {when(e.observed_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Why these signals are linked"
              subtitle="Each link names the rule and the shared value that produced it. No link exists without one."
            />
            <CardBody>
              {detail.relationships.length === 0 ? (
                <p className="text-xs leading-relaxed text-slate-400">
                  Nothing is linked. The signals on this case do not share a key, and RetainOS does not
                  invent a connection from two things happening at a similar time.
                </p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Link</Th>
                      <Th>Between</Th>
                      <Th>Shared value</Th>
                      <Th align="right">Strength</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.relationships as Array<Record<string, any>>).map((r) => (
                      <tr key={r.id}>
                        <Td>
                          <span className="font-medium text-offwhite">
                            {titleCase(String(r.relationship))}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                            {String(r.basis)}
                          </span>
                        </Td>
                        <Td>
                          <span className="block max-w-[18rem] truncate text-xs text-slate-400">
                            {summaryFor.get(String(r.from_evidence_id)) ?? "—"}
                          </span>
                          <span className="block max-w-[18rem] truncate text-xs text-slate-500">
                            {summaryFor.get(String(r.to_evidence_id)) ?? "—"}
                          </span>
                        </Td>
                        <Td><span className="text-xs text-slate-400">{r.shared_key ?? "—"}</span></Td>
                        <Td align="right"><span className="tnum">{Number(r.strength).toFixed(2)}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          {factors.length > 0 ? (
            <Card>
              <CardHeader
                title="How this case was scored"
                subtitle="Nine factors, each showing its raw measurement, the transform applied, its weight and what it contributed."
              />
              <CardBody>
                <Table>
                  <thead>
                    <tr>
                      <Th>Factor</Th>
                      <Th>Measured</Th>
                      <Th align="right">Weight</Th>
                      <Th align="right">Contribution</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {factors.map((f) => (
                      <tr key={String(f.factor)}>
                        <Td>
                          <span className="font-medium text-offwhite">{titleCase(String(f.factor))}</span>
                          <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                            {String(f.explanation)}
                          </span>
                        </Td>
                        <Td>
                          {f.provenance === "absent" ? (
                            <Badge tone="neutral">not answered</Badge>
                          ) : (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="tnum text-slate-300">
                                {f.raw_value === null
                                  ? String(f.raw_unit)
                                  : `${num(Number(f.raw_value))} ${String(f.raw_unit)}`}
                              </span>
                              <Badge tone={f.provenance === "measured" ? "good" : "warn"}>
                                {String(f.provenance).replace(/_/g, " ")}
                              </Badge>
                            </span>
                          )}
                        </Td>
                        <Td align="right">
                          <span className={f.provenance === "absent" ? "tnum text-slate-600" : "tnum"}>
                            {Number(f.weight).toFixed(2)}
                          </span>
                        </Td>
                        <Td align="right"><span className="tnum">{Number(f.contribution).toFixed(2)}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="mt-4">
                  <Caveats
                    items={[
                      SCORE_DISCLAIMER,
                      "A factor nobody has answered contributes nothing and has its weight removed from the " +
                      "denominator, so a case is not punished for an unanswered question.",
                    ]}
                    tone="info"
                  />
                </div>
              </CardBody>
            </Card>
          ) : null}

          {impact.length > 0 ? (
            <Card>
              <CardHeader title="Revenue impact recorded against this case" />
              <CardBody>
                <Table>
                  <thead>
                    <tr>
                      <Th>Record</Th>
                      <Th>Evidence class</Th>
                      <Th align="right">Amount</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.map((r) => (
                      <tr key={r.id}>
                        <Td>
                          <span className="text-slate-300">{r.label}</span>
                          <span className="mt-0.5 block text-[11px] text-slate-500">{r.method}</span>
                        </Td>
                        <Td>
                          <Badge tone={r.classification === "observed" || r.classification === "experiment_supported" ? "good" : r.classification === "estimated" ? "info" : "neutral"}>
                            {r.classification.replace(/_/g, " ")}
                          </Badge>
                        </Td>
                        <Td align="right">
                          {r.amountMinor === null
                            ? <span className="text-slate-600">no figure</span>
                            : money(r.amountMinor, r.currency ?? "INR")}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-5">
          <CaseWorkflow
            caseId={id}
            status={status}
            allowed={allowed}
            improvements={improvements.map((i) => ({ id: String(i.id), label: String(i.title) }))}
            improvementId={c.improvement_id ? String(c.improvement_id) : null}
          />

          {investigations.length > 0 ? (
            <Card>
              <CardHeader title="What would settle it" />
              <CardBody>
                <ul className="space-y-2">
                  {investigations.map((inv, i) => (
                    <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-400">
                      <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-cyan-500/60" />
                      <span>{inv}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          {limitations.length > 0 ? (
            <Card>
              <CardHeader title="Limitations" />
              <CardBody><Caveats items={limitations} /></CardBody>
            </Card>
          ) : null}

          <EstimateForm
            caseId={id}
            estimate={detail.estimate as Record<string, any> | null}
          />

          <ObservedImpactForm caseId={id} />

          {detail.history.length > 0 ? (
            <Card>
              <CardHeader title="History" />
              <CardBody>
                <ul className="space-y-2">
                  {(detail.history as Array<Record<string, any>>).map((h) => (
                    <li key={h.id} className="text-xs text-slate-400">
                      <span className="text-slate-300">
                        {h.from_status ? `${titleCase(String(h.from_status))} → ` : ""}
                        {titleCase(String(h.to_status))}
                      </span>
                      <span className="ml-1 text-slate-600">{relative(h.changed_at)}</span>
                      {h.note ? <span className="mt-0.5 block text-slate-500">{String(h.note)}</span> : null}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

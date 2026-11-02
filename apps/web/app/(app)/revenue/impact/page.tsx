import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  impactSummary, listImpactRecords, listFrictionCases,
  CLASSIFICATION_MEANING, CLASSIFICATION_STRENGTH, REVENUE_IMPACT_DISCLAIMER,
  type ImpactClassification,
} from "@retainos/analytics";
import { entitlementFor } from "@retainos/database";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Empty, Button, Caveats, Table, Th, Td,
} from "@/components/ui";
import { money, when } from "@/lib/format";
import { EstimateImpactForm } from "./forms";

export const metadata: Metadata = { title: "Revenue impact" };
export const dynamic = "force-dynamic";

const TONE: Record<ImpactClassification, "good" | "info" | "warn" | "neutral" | "accent"> = {
  experiment_supported: "good",
  observed: "accent",
  estimated: "info",
  associated: "warn",
  insufficient_evidence: "neutral",
};

export default async function RevenueImpact() {
  const ctx = await requireProject();
  const handle = db();
  const entitlement = entitlementFor(handle, ctx.org.id);

  if (!entitlement.features.revenueImpactStudio) {
    return (
      <>
        <PageHeader title="Revenue impact" />
        <Empty
          title="Not included on your plan"
          body={`The Revenue Impact Studio is part of the Growth plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  const summary = impactSummary(handle, ctx.project.id);
  const records = listImpactRecords(handle, ctx.project.id, { limit: 100 });
  const cases = listFrictionCases(handle, ctx.project.id, { limit: 100 }) as Array<Record<string, any>>;

  return (
    <>
      <PageHeader
        title="Revenue impact"
        description="Every figure carries the kind of evidence behind it. There is no grand total, because the only way to produce one is to add a measured amount to a modelled one."
        action={<Link href="/revenue"><Button variant="secondary" size="sm">Revenue</Button></Link>}
      />

      <div className="mb-5">
        <Caveats items={[REVENUE_IMPACT_DISCLAIMER]} tone="info" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Totals by evidence class"
              subtitle="One bucket per class and currency, strongest evidence first. Deliberately never summed together."
            />
            <CardBody>
              {summary.buckets.length === 0 ? (
                <Empty
                  title="Nothing recorded yet"
                  body="Record observed movement from a friction case, or an explicit estimate below. Nothing is claimed in the absence of either."
                  action={<Link href="/friction"><Button>Open FrictionGraph</Button></Link>}
                />
              ) : (
                <ul className="space-y-4">
                  {summary.buckets.map((b) => (
                    <li key={`${b.classification}:${b.currency}`}
                        className="rounded-xl border border-navy-700/70 bg-navy-900/40 px-4 py-3.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <Badge tone={TONE[b.classification]}>
                          {b.classification.replace(/_/g, " ")}
                        </Badge>
                        <span className="tnum text-lg font-semibold text-offwhite">
                          {money(b.totalMinor, b.currency)}
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{b.meaning}</p>
                      <p className="mt-1 text-[11px] text-slate-600">
                        {b.records} record(s) in {b.currency}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {summary.recordsWithoutAmount > 0 ? (
                <p className="mt-4 text-xs leading-relaxed text-slate-400">
                  {summary.recordsWithoutAmount} record(s) carry no figure at all, because the evidence did
                  not support one. They are kept rather than dropped.
                </p>
              ) : null}
            </CardBody>
          </Card>

          {records.length > 0 ? (
            <Card>
              <CardHeader title="Every record" subtitle="With the method that produced it, so the arithmetic can be checked." />
              <CardBody>
                <Table>
                  <thead>
                    <tr>
                      <Th>Record</Th>
                      <Th>Class</Th>
                      <Th align="right">Amount</Th>
                      <Th align="right">Recorded</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id}>
                        <Td>
                          <span className="font-medium text-offwhite">{r.label}</span>
                          <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                            {r.method}
                          </span>
                          {r.assumptions.length > 0 ? (
                            <span className="mt-1 block text-[11px] leading-snug text-slate-400">
                              Assumptions:{" "}
                              {r.assumptions.map((a) => `${a.name} = ${a.value} (${a.source.replace(/_/g, " ")})`).join("; ")}
                            </span>
                          ) : null}
                          {r.limitations.length > 0 ? (
                            <span className="mt-1 block text-[11px] leading-snug text-amber-500/80">
                              {r.limitations.join(" ")}
                            </span>
                          ) : null}
                        </Td>
                        <Td><Badge tone={TONE[r.classification]}>{r.classification.replace(/_/g, " ")}</Badge></Td>
                        <Td align="right">
                          {r.amountMinor === null
                            ? <span className="text-slate-600">no figure</span>
                            : money(r.amountMinor, r.currency ?? "INR")}
                        </Td>
                        <Td align="right"><span className="text-slate-500">{when(r.computedAt)}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-5">
          <EstimateImpactForm
            cases={cases.map((c) => ({ id: String(c.id), label: String(c.title) }))}
          />

          <Card>
            <CardHeader title="What each class means" />
            <CardBody>
              <dl className="space-y-3">
                {(Object.keys(CLASSIFICATION_MEANING) as ImpactClassification[])
                  .sort((a, b) => CLASSIFICATION_STRENGTH[b] - CLASSIFICATION_STRENGTH[a])
                  .map((c) => (
                    <div key={c}>
                      <dt className="mb-1"><Badge tone={TONE[c]}>{c.replace(/_/g, " ")}</Badge></dt>
                      <dd className="text-[11px] leading-relaxed text-slate-400">
                        {CLASSIFICATION_MEANING[c]}
                      </dd>
                    </div>
                  ))}
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

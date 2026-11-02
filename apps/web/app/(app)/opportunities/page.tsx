import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  rankOpportunities, getWeights, listFrictionCases, DEFAULT_WEIGHTS, SCORE_DISCLAIMER,
} from "@retainos/analytics";
import { entitlementFor } from "@retainos/database";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Empty, Button, Caveats, Bar, Table, Th, Td, Confidence,
} from "@/components/ui";
import { num, money, titleCase } from "@/lib/format";
import { WeightsForm, RerankButton } from "./forms";

export const metadata: Metadata = { title: "Opportunities" };
export const dynamic = "force-dynamic";

export default async function Opportunities() {
  const ctx = await requireProject();
  const handle = db();
  const entitlement = entitlementFor(handle, ctx.org.id);

  if (!entitlement.features.opportunityEngine) {
    return (
      <>
        <PageHeader title="Opportunities" />
        <Empty
          title="Not included on your plan"
          body={`The opportunity engine is part of the Starter plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  const ids = { orgId: ctx.org.id, projectId: ctx.project.id };
  const ranked = rankOpportunities(handle, ids);
  const weights = getWeights(handle, ctx.project.id);
  const cases = listFrictionCases(handle, ctx.project.id, { limit: 200 }) as Array<Record<string, any>>;
  const byId = new Map(cases.map((c) => [String(c.id), c]));

  return (
    <>
      <PageHeader
        title="Opportunities"
        description="A defensible order of work. Every score shows the nine factors behind it, what each one measured, and what it contributed — so you can disagree with it specifically rather than in general."
        action={<RerankButton />}
      />

      <div className="mb-5">
        <Caveats items={[SCORE_DISCLAIMER]} tone="info" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {ranked.length === 0 ? (
            <Empty
              title="Nothing to rank yet"
              body="The opportunity engine ranks friction cases. Run the detectors first and they will appear here in order."
              action={<Link href="/friction"><Button>Go to FrictionGraph</Button></Link>}
            />
          ) : (
            ranked.map((score, index) => {
              const record = byId.get(score.caseId);
              const sorted = [...score.factors].sort((a, b) => b.contribution - a.contribution);
              const absent = score.factors.filter((f) => f.provenance === "absent");
              return (
                <Card key={score.caseId}>
                  <CardHeader
                    title={
                      <span className="flex items-baseline gap-2">
                        <span className="tnum text-slate-500">#{index + 1}</span>
                        <Link
                          href={`/friction/${score.caseId}`}
                          className="hover:text-cyan-400"
                        >
                          {record ? String(record.title) : score.caseId}
                        </Link>
                      </span>
                    }
                    subtitle={
                      record
                        ? `${num(record.affected_users)} affected user(s)` +
                          (record.revenue_exposure_minor
                            ? ` · ${money(record.revenue_exposure_minor, String(record.revenue_currency ?? "INR"))} exposure`
                            : "")
                        : undefined
                    }
                    action={
                      <span className="flex items-center gap-2">
                        {record ? (
                          <Confidence
                            label={String(record.evidence_quality)}
                            basis={String(record.evidence_basis ?? "")}
                          />
                        ) : null}
                        <span className="tnum text-lg font-semibold text-offwhite">
                          {score.score.toFixed(1)}
                        </span>
                      </span>
                    }
                  />
                  <CardBody>
                    <div className="space-y-2">
                      {sorted.filter((f) => f.provenance !== "absent").map((f) => (
                        <div key={f.factor}>
                          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                            <span className="text-slate-300">{f.label}</span>
                            <span className="tnum shrink-0 text-slate-500">
                              {f.rawValue === null ? f.rawUnit : `${num(f.rawValue)} ${f.rawUnit}`}
                              {" · "}
                              <span className="text-slate-400">+{f.contribution.toFixed(1)}</span>
                            </span>
                          </div>
                          <Bar
                            fraction={f.normalised}
                            tone={f.provenance === "user_estimate" ? "cyan" : "blue"}
                          />
                          <p className="mt-1 text-[11px] leading-snug text-slate-500">{f.explanation}</p>
                        </div>
                      ))}
                    </div>

                    {absent.length > 0 ? (
                      <div className="mt-4 rounded-lg border border-navy-700/60 bg-navy-900/40 px-3 py-2.5">
                        <p className="text-[11px] leading-relaxed text-slate-400">
                          <span className="font-medium text-slate-300">
                            {absent.length} factor(s) not answered:
                          </span>{" "}
                          {absent.map((f) => f.label).join(", ")}. They contribute nothing, and their
                          weight has been removed from the denominator rather than counted as a zero.
                        </p>
                      </div>
                    ) : null}

                    <p className="mt-3 text-xs leading-relaxed text-cyan-400/90">
                      <span className="font-medium">To make this ranking more trustworthy:</span>{" "}
                      {score.howToImprove}
                    </p>
                  </CardBody>
                </Card>
              );
            })
          )}
        </div>

        <div className="space-y-5">
          <WeightsForm
            rows={(Object.keys(DEFAULT_WEIGHTS) as Array<keyof typeof DEFAULT_WEIGHTS>).map((factor) => ({
              factor,
              weight: weights[factor],
            }))}
          />

          <Card>
            <CardHeader title="What the factors mean" />
            <CardBody>
              <Table>
                <thead>
                  <tr>
                    <Th>Factor</Th>
                    <Th align="right">Default</Th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(DEFAULT_WEIGHTS).map(([factor, weight]) => (
                    <tr key={factor}>
                      <Td>{titleCase(factor)}</Td>
                      <Td align="right"><span className="tnum">{weight.toFixed(2)}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                The defaults favour reach and evidence quality over effort, on the grounds that a cheap
                fix to a problem nobody has is still not worth doing. Your business may disagree, which
                is why they are editable.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

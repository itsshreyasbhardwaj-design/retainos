import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { listExperiments, getExperiment, analyseExperiment, eventBreakdown } from "@retainos/analytics";
import { listImprovements, entitlementFor, jsonParse } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Metric, Badge, Empty, Caveats, Button, Table, Th, Td } from "@/components/ui";
import { pct, num, when, titleCase } from "@/lib/format";
import { ExperimentForms, ExperimentControls } from "./forms";

export const metadata: Metadata = { title: "Experiments" };
export const dynamic = "force-dynamic";

const VERDICT_TONE = {
  improvement_supported: "good",
  no_clear_difference: "neutral",
  worse_outcome: "bad",
  inconclusive: "warn",
  invalid_experiment: "bad",
} as const;

export default async function Experiments({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const params = await searchParams;
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();
  const entitlement = entitlementFor(handle, ctx.org.id);

  if (!entitlement.features.experiments) {
    return (
      <>
        <PageHeader title="Experiments" />
        <Empty
          title="Not included on your plan"
          body={`Controlled experiments are part of the Growth plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  const experiments = listExperiments(handle, ctx.project.id) as Array<Record<string, unknown>>;
  const selectedId = params.id ?? (experiments[0] ? String(experiments[0].id) : null);
  const config = selectedId ? getExperiment(handle, ctx.project.id, selectedId) : null;
  const analysis = selectedId ? analyseExperiment(handle, ctx.project.id, selectedId, { now }) : null;

  const events = eventBreakdown(handle, ctx.project.id, { from: now - 90 * 86_400_000, to: now, limit: 30 })
    .map((e) => e.name);
  const improvements = listImprovements(handle, ctx.projectScope, { limit: 50 }) as Array<Record<string, unknown>>;

  return (
    <>
      <PageHeader
        title="Experiments"
        description="The only method here that supports a causal claim about a change you shipped."
      />

      {experiments.length === 0 ? (
        <>
          <Empty
            title="No experiments yet"
            body={
              "An experiment needs three things in your code: ask RetainOS for the variant, record an exposure " +
              "where the variant is actually shown, and keep sending the metric event as normal."
            }
          />
          <div className="mt-5 max-w-lg">
            <ExperimentForms events={events} improvements={[]} />
          </div>
        </>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-1.5">
            {experiments.map((e) => (
              <Link key={String(e.id)} href={`/experiments?id=${String(e.id)}`}>
                <Button variant={selectedId === String(e.id) ? "primary" : "secondary"} size="sm">
                  {String(e.name)}
                </Button>
              </Link>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <div className="space-y-5 lg:col-span-2">
              {config && analysis?.ok ? (
                <>
                  <Card>
                    <CardHeader
                      title={config.name}
                      subtitle={
                        `Key: ${config.key} · metric: ${config.primaryMetricEvent} · ` +
                        `pre-registered minimum: ${num(config.minExposuresPerVariant)} exposures per variant`
                      }
                      action={
                        <div className="flex items-center gap-2">
                          <Badge tone={config.status === "running" ? "accent" : "neutral"}>{titleCase(config.status)}</Badge>
                          <Badge tone={VERDICT_TONE[analysis.value.verdict]}>
                            {titleCase(analysis.value.verdict)}
                          </Badge>
                        </div>
                      }
                    />
                    <CardBody>
                      <Table>
                        <thead>
                          <tr>
                            <Th>Variant</Th><Th align="right">Exposed</Th>
                            <Th align="right">Converted</Th><Th align="right">Rate</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {analysis.value.variants.map((v) => (
                            <tr key={v.variantKey}>
                              <Td>
                                {v.variantName}
                                {v.isControl ? <Badge tone="neutral">control</Badge> : null}
                              </Td>
                              <Td align="right">{num(v.exposed)}</Td>
                              <Td align="right">{num(v.converted)}</Td>
                              <Td align="right">{pct(v.conversionRate, 2)}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>

                      {analysis.value.primary.test ? (
                        <div className="mt-4 grid gap-3 sm:grid-cols-3">
                          <Metric
                            label="Absolute difference"
                            value={`${analysis.value.primary.test.absoluteDiff > 0 ? "+" : ""}${(analysis.value.primary.test.absoluteDiff * 100).toFixed(2)} pts`}
                            definition="Treatment rate minus control rate."
                          />
                          <Metric
                            label="p-value"
                            value={analysis.value.primary.test.pValue < 0.0001
                              ? analysis.value.primary.test.pValue.toExponential(1)
                              : analysis.value.primary.test.pValue.toFixed(4)}
                            definition="Two-sided, from a pooled two-proportion z-test. Not the probability that the treatment is better."
                          />
                          <Metric
                            label="95% interval"
                            value={`${(analysis.value.primary.test.confidenceInterval[0] * 100).toFixed(2)} to ${(analysis.value.primary.test.confidenceInterval[1] * 100).toFixed(2)} pts`}
                            definition="For the absolute difference, using the unpooled standard error."
                          />
                        </div>
                      ) : null}

                      <div className="mt-4">
                        <p className="mb-2 text-xs font-medium text-slate-400">Why this verdict</p>
                        <ul className="space-y-1.5">
                          {analysis.value.reasoning.map((r, i) => (
                            <li key={i} className="text-xs leading-relaxed text-slate-400">{r}</li>
                          ))}
                        </ul>
                      </div>
                    </CardBody>
                  </Card>

                  <Card>
                    <CardHeader
                      title="Validity checks"
                      subtitle="A blocking failure forces the verdict to invalid, however good the p-value looks."
                    />
                    <CardBody>
                      <ul className="space-y-2.5">
                        {analysis.value.checks.map((c) => (
                          <li key={c.id} className="flex gap-2.5">
                            <Badge tone={c.passed ? "good" : c.severity === "blocking" ? "bad" : "warn"}>
                              {c.passed ? "pass" : c.severity === "blocking" ? "blocking" : "warning"}
                            </Badge>
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-slate-300">{titleCase(c.id)}</p>
                              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{c.detail}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {analysis.value.recommendedSampleSizePerVariant !== null ? (
                        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
                          To detect a 10% relative change on the observed baseline at 80% power, you would need
                          roughly {num(analysis.value.recommendedSampleSizePerVariant)} exposures per variant.
                        </p>
                      ) : null}
                    </CardBody>
                  </Card>

                  {analysis.value.guardrails.length > 0 ? (
                    <Card>
                      <CardHeader
                        title="Guardrails"
                        subtitle="Corrected for multiple comparisons, so one guardrail moving is not reported as a finding."
                      />
                      <CardBody>
                        <Table>
                          <thead>
                            <tr><Th>Metric</Th><Th align="right">Control</Th><Th align="right">Treatment</Th><Th align="right">p</Th><Th align="right">Threshold</Th><Th>Verdict</Th></tr>
                          </thead>
                          <tbody>
                            {analysis.value.guardrails.map((g) => (
                              <tr key={g.label}>
                                <Td>{g.label}</Td>
                                <Td align="right">{pct(g.test?.controlRate ?? null, 2)}</Td>
                                <Td align="right">{pct(g.test?.treatmentRate ?? null, 2)}</Td>
                                <Td align="right">{g.test ? g.test.pValue.toFixed(4) : "—"}</Td>
                                <Td align="right">{g.adjustedThreshold.toFixed(4)}</Td>
                                <Td>
                                  <Badge tone={g.direction === "worse" ? "bad" : g.direction === "better" ? "good" : "neutral"}>
                                    {g.direction === "no_change" ? "no change" : g.direction}
                                  </Badge>
                                </Td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                      </CardBody>
                    </Card>
                  ) : null}
                </>
              ) : analysis && !analysis.ok ? (
                <Card><CardBody><p className="text-xs text-rose-500">{analysis.error.message}</p></CardBody></Card>
              ) : null}

              <div>
                <Caveats items={[
                  "A p-value above the threshold means no difference was detected. It does not mean the variants are equal.",
                  "A p-value below the threshold is not the probability that the treatment is better; it is how surprising this data would be if there were no difference.",
                  "Peeking before the pre-registered sample is reached inflates false positives, which is why reading early is refused outright.",
                  "Exposure, not assignment, is what counts: a user who never saw the variant tells you nothing about it.",
                ]} />
              </div>
            </div>

            <div className="space-y-5">
              {config ? <ExperimentControls experimentId={config.id} status={config.status} /> : null}
              <ExperimentForms
                events={events}
                improvements={improvements.map((i) => ({ id: String(i.id), label: String(i.title) }))}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}

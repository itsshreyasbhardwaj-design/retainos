import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  accountHealthRoster, listHealthDefinitions, weightsFromDefinition,
  HEALTH_STATE_MEANING, HEALTH_DISCLAIMER, DEFAULT_SIGNAL_WEIGHTS,
  MINIMUM_SIGNALS_WITH_DATA, listActivationDefinitions, type HealthState,
} from "@retainos/analytics";
import { entitlementFor } from "@retainos/database";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Empty, Button, Caveats, Metric, Table, Th, Td,
} from "@/components/ui";
import { num, money } from "@/lib/format";
import { HealthDefinitionForm } from "./forms";

export const metadata: Metadata = { title: "Customer health" };
export const dynamic = "force-dynamic";

const STATE_TONE: Record<HealthState, "good" | "info" | "warn" | "neutral"> = {
  strong_engagement: "good",
  mixed_signals: "info",
  attention_suggested: "warn",
  insufficient_information: "neutral",
};

export default async function Health() {
  const ctx = await requireProject();
  const handle = db();
  const entitlement = entitlementFor(handle, ctx.org.id);

  if (!entitlement.features.customerHealth) {
    return (
      <>
        <PageHeader title="Customer health" />
        <Empty
          title="Not included on your plan"
          body={`Customer health is part of the Starter plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  const definitions = listHealthDefinitions(handle, ctx.project.id);
  const definition = definitions.find((d) => d.isPrimary) ?? definitions[0] ?? null;
  const activation = listActivationDefinitions(handle, ctx.project.id);
  const activationEvent = (activation.find((d) => d.isPrimary) ?? activation[0])?.activationEvent;

  const configuredWeights = definition ? weightsFromDefinition(definition) : {};
  const roster = accountHealthRoster(handle, ctx.project.id, {
    activationEvent,
    weights: definition ? configuredWeights : undefined,
    limit: 200,
  });

  const counts = roster.reduce<Record<HealthState, number>>((acc, r) => {
    acc[r.state] = (acc[r.state] ?? 0) + 1;
    return acc;
  }, {
    strong_engagement: 0, mixed_signals: 0, attention_suggested: 0, insufficient_information: 0,
  });

  return (
    <>
      <PageHeader
        title="Customer health"
        description="No score out of a hundred. Named signals, each saying what was observed and what would change it, and a state a person can disagree with."
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-4">
        <Metric
          label="Worth a conversation"
          value={num(counts.attention_suggested)}
          definition="Accounts where one or more signals are concerning enough to look at."
          caveat="Not a prediction that they will leave."
          tone={counts.attention_suggested > 0 ? "bad" : undefined}
        />
        <Metric
          label="Mixed signals"
          value={num(counts.mixed_signals)}
          definition="Some signals positive, some not. The normal state for most accounts."
        />
        <Metric
          label="Strong engagement"
          value={num(counts.strong_engagement)}
          definition="Every signal with data behind it points the same way, and none is concerning."
        />
        <Metric
          label="Not enough data"
          value={num(counts.insufficient_information)}
          definition={`Fewer than ${MINIMUM_SIGNALS_WITH_DATA} signals have real data, so no state is claimed.`}
        />
      </div>

      <div className="mb-5">
        <Caveats
          items={[
            HEALTH_DISCLAIMER,
            "An absence of errors proves nothing on a project that has never sent one, and silence from a " +
            "customer is not a positive signal — most people never report anything. Both are reported as " +
            "unknown rather than as good news.",
          ]}
          tone="info"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Accounts"
              subtitle="Ordered by what is worth a conversation, then by revenue — a success team has finite hours and needs an order."
            />
            <CardBody>
              {roster.length === 0 ? (
                <Empty
                  title="No accounts yet"
                  body="Accounts appear once the SDK sends an account_key with its events. RetainOS never infers an account from an email domain."
                  action={<Link href="/settings/sdk"><Button>SDK setup</Button></Link>}
                />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Account</Th>
                      <Th align="right">Seats</Th>
                      <Th>State</Th>
                      <Th>Heaviest concern</Th>
                      <Th align="right">MRR</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map((r) => (
                      <tr key={r.subjectId}>
                        <Td>
                          <Link
                            href={`/health/${encodeURIComponent(r.subjectId)}`}
                            className="font-medium text-offwhite hover:text-cyan-400"
                          >
                            {r.subjectId}
                          </Link>
                        </Td>
                        <Td align="right">{num(r.subjects)}</Td>
                        <Td>
                          <Badge tone={STATE_TONE[r.state]}>{r.state.replace(/_/g, " ")}</Badge>
                        </Td>
                        <Td>
                          {r.topConcern
                            ? <span className="text-xs text-slate-300">{r.topConcern}</span>
                            : <span className="text-xs text-slate-600">none</span>}
                        </Td>
                        <Td align="right">
                          {r.mrrMinor === null
                            ? <span className="text-slate-600">not linked</span>
                            : money(r.mrrMinor, r.currency ?? "INR")}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="What each state means" />
            <CardBody>
              <dl className="space-y-3">
                {(Object.keys(HEALTH_STATE_MEANING) as HealthState[]).map((state) => (
                  <div key={state}>
                    <dt className="mb-1">
                      <Badge tone={STATE_TONE[state]}>{state.replace(/_/g, " ")}</Badge>
                    </dt>
                    <dd className="text-[11px] leading-relaxed text-slate-400">
                      {HEALTH_STATE_MEANING[state]}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>

          <HealthDefinitionForm
            rows={(Object.keys(DEFAULT_SIGNAL_WEIGHTS) as Array<keyof typeof DEFAULT_SIGNAL_WEIGHTS>)
              .map((signal) => ({
                signal,
                weight: configuredWeights[signal] ?? DEFAULT_SIGNAL_WEIGHTS[signal],
              }))}
            name={definition?.name ?? "Default"}
          />
        </div>
      </div>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  assessHealth, healthHistory, listHealthDefinitions, weightsFromDefinition,
  HEALTH_STATE_MEANING, listActivationDefinitions, type SignalDirection,
} from "@retainos/analytics";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Button, Caveats, Table, Th, Td, Empty,
} from "@/components/ui";
import { num, when } from "@/lib/format";
import { SnapshotButton } from "../forms";

export const metadata: Metadata = { title: "Account health" };
export const dynamic = "force-dynamic";

const DIRECTION_TONE: Record<SignalDirection, "good" | "bad" | "neutral" | "info"> = {
  supporting: "good",
  concerning: "bad",
  neutral: "neutral",
  unknown: "info",
};

export default async function AccountHealth({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const accountKey = decodeURIComponent(account);
  const ctx = await requireProject();
  const handle = db();

  const definitions = listHealthDefinitions(handle, ctx.project.id);
  const definition = definitions.find((d) => d.isPrimary) ?? definitions[0] ?? null;
  const activation = listActivationDefinitions(handle, ctx.project.id);
  const activationEvent = (activation.find((d) => d.isPrimary) ?? activation[0])?.activationEvent;

  const assessment = assessHealth(handle, ctx.project.id, { kind: "account", id: accountKey }, {
    activationEvent,
    weights: definition ? weightsFromDefinition(definition) : undefined,
  });
  const history = healthHistory(handle, ctx.project.id, { kind: "account", id: accountKey });

  return (
    <>
      <PageHeader
        title={accountKey}
        description={HEALTH_STATE_MEANING[assessment.state]}
        action={<Link href="/health"><Button variant="secondary" size="sm">All accounts</Button></Link>}
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone={assessment.state === "attention_suggested" ? "warn"
          : assessment.state === "strong_engagement" ? "good"
          : assessment.state === "mixed_signals" ? "info" : "neutral"}>
          {assessment.state.replace(/_/g, " ")}
        </Badge>
        <span className="text-xs text-slate-500">
          {num(assessment.subjects)} known seat(s) · {assessment.windowDays}-day window
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Signals"
              subtitle="Each one says what was observed, which way it counted, and what would change it."
            />
            <CardBody>
              <Table>
                <thead>
                  <tr>
                    <Th>Signal</Th>
                    <Th>Observed</Th>
                    <Th>Counted as</Th>
                  </tr>
                </thead>
                <tbody>
                  {assessment.signals.map((s) => (
                    <tr key={s.signal}>
                      <Td>
                        <span className="font-medium text-offwhite">{s.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                          {s.detail}
                        </span>
                        <span className="mt-1 block text-[11px] leading-snug text-cyan-400/80">
                          Would change it: {s.whatWouldChangeIt}
                        </span>
                      </Td>
                      <Td><span className="text-xs text-slate-300">{s.observed}</span></Td>
                      <Td>
                        <Badge tone={DIRECTION_TONE[s.direction]}>{s.direction}</Badge>
                        {!s.hasEnoughData ? (
                          <span className="mt-1 block text-[10px] text-slate-600">not enough data</span>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Why this state" subtitle="In the order the rules were applied." />
            <CardBody>
              <ol className="space-y-2">
                {assessment.reasoning.map((r, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-300">
                    <span className="tnum shrink-0 text-slate-600">{i + 1}.</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="How to read this" />
            <CardBody>
              <Caveats items={[assessment.disclaimer]} tone="info" />
            </CardBody>
          </Card>

          <SnapshotButton subjectId={accountKey} />

          <Card>
            <CardHeader title="History" subtitle="Recorded snapshots, newest first." />
            <CardBody>
              {history.length === 0 ? (
                <p className="text-xs leading-relaxed text-slate-400">
                  Nothing recorded yet. A snapshot is what makes a change in state visible later.
                </p>
              ) : (
                <ul className="space-y-2">
                  {history.map((h, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-slate-300">{h.state.replace(/_/g, " ")}</span>
                      <span className="text-slate-600">{when(h.observedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

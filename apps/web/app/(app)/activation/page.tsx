import type { Metadata } from "next";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  activationFunnel, listActivationDefinitions, activationBySegment, ACTIVATION_DEFINITION_TEXT,
} from "@retainos/analytics";
import { eventBreakdown } from "@retainos/analytics";
import { PageHeader, Card, CardHeader, CardBody, Metric, Table, Th, Td, Bar, Empty, Caveats, Badge } from "@/components/ui";
import { pct, num, duration, deltaPoints } from "@/lib/format";
import { ActivationForm } from "./form";

export const metadata: Metadata = { title: "Activation" };
export const dynamic = "force-dynamic";

export default async function Activation({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const params = await searchParams;
  const days = Math.min(Math.max(Number(params.days ?? 30) || 30, 1), 365);
  const ctx = await requireProject();
  const handle = db();
  const { projectId } = ctx.projectScope;
  const now = Date.now();
  const from = now - days * 86_400_000;

  const defs = listActivationDefinitions(handle, projectId);
  const def = defs.find((d) => d.isPrimary) ?? defs[0];
  const knownEvents = eventBreakdown(handle, projectId, { from: now - 90 * 86_400_000, to: now, limit: 40 })
    .map((e) => e.name);

  if (!def) {
    return (
      <>
        <PageHeader
          title="Activation"
          description="Activation means something different in every product, so RetainOS will not guess yours."
        />
        <Empty
          title="Define what first value means"
          body={
            "Pick the single event that means a user reached real value. Signing up is never it. For a developer " +
            "tool it might be a first successful integration; for a project manager, a first project with an " +
            "actionable task; for a content tool, a first finished export."
          }
        />
        <div className="mt-5 max-w-lg">
          <ActivationForm knownEvents={knownEvents} current={null} />
        </div>
      </>
    );
  }

  const current = activationFunnel(handle, projectId, { definition: def, from, to: now, now });
  const prior = activationFunnel(handle, projectId, {
    definition: def, from: from - days * 86_400_000, to: from - 1, now,
  });
  const bySource = activationBySegment(handle, projectId, {
    definition: def, from, to: now, dimension: "acquisition_source", now,
  });
  const byPlan = activationBySegment(handle, projectId, {
    definition: def, from, to: now, dimension: "plan", now,
  });

  return (
    <>
      <PageHeader
        title="Activation"
        description={`"${def.activationEvent}" within ${def.windowDays} days of "${def.signupEvent}", over the last ${days} days.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Activation rate"
          value={pct(current.registrations === 0 ? null : current.activationRate)}
          definition={ACTIVATION_DEFINITION_TEXT}
          delta={prior.registrations > 0 ? deltaPoints(current.activationRate, prior.activationRate) : undefined}
        />
        <Metric label="Signups" value={num(current.registrations)}
          definition={`Distinct users whose first "${def.signupEvent}" fell in this period.`} />
        <Metric label="Activated" value={num(current.activated)}
          definition="Signups who activated inside their own window." />
        <Metric label="Median time to value" value={duration(current.timeToValue.medianMs)}
          definition="Median elapsed time from signup to activation, across activated users only." />
      </div>

      {current.warnings.length > 0 ? (
        <div className="mt-4"><Caveats items={current.warnings} /></div>
      ) : null}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Activation funnel"
            subtitle="Each step counted inside the activation window, measured from each user's own signup."
          />
          <CardBody>
            <ol className="space-y-4">
              {current.steps.map((step, i) => (
                <li key={step.label}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm text-offwhite">
                      <span className="mr-2 text-xs text-slate-500">{i + 1}.</span>{step.label}
                    </span>
                    <span className="text-xs tnum text-slate-400">{num(step.users)} · {pct(step.conversionFromStart)}</span>
                  </div>
                  <div className="mt-1.5"><Bar fraction={step.conversionFromStart} /></div>
                  {step.droppedFromPrevious > 0 ? (
                    <p className="mt-1 text-[11px] text-slate-500">{num(step.droppedFromPrevious)} lost at this step</p>
                  ) : null}
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Time to value" subtitle="Across activated users only; users who never activated have no duration." />
          <CardBody>
            <Table>
              <thead><tr><Th>Percentile</Th><Th align="right">Time from signup</Th></tr></thead>
              <tbody>
                <tr><Td>25th</Td><Td align="right">{duration(current.timeToValue.p25Ms)}</Td></tr>
                <tr><Td>Median</Td><Td align="right">{duration(current.timeToValue.medianMs)}</Td></tr>
                <tr><Td>75th</Td><Td align="right">{duration(current.timeToValue.p75Ms)}</Td></tr>
                <tr><Td>90th</Td><Td align="right">{duration(current.timeToValue.p90Ms)}</Td></tr>
              </tbody>
            </Table>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              Based on {num(current.timeToValue.count)} activated users.{" "}
              {num(current.timeToValue.eligibleForWindow)} of {num(current.registrations)} signups have had the
              full {def.windowDays}-day window; the rest are still inside it.
            </p>
          </CardBody>
        </Card>
      </div>

      {bySource.length > 0 || byPlan.length > 0 ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          {[
            { title: "By acquisition source", rows: bySource },
            { title: "By plan", rows: byPlan },
          ].filter((g) => g.rows.length > 0).map((group) => (
            <Card key={group.title}>
              <CardHeader title={group.title} subtitle="Where activation is concentrated, and where it is not." />
              <CardBody>
                <Table>
                  <thead>
                    <tr><Th>Segment</Th><Th align="right">Signups</Th><Th align="right">Activated</Th><Th align="right">Rate</Th></tr>
                  </thead>
                  <tbody>
                    {group.rows.map((r) => (
                      <tr key={r.value}>
                        <Td>{r.value}</Td>
                        <Td align="right">{num(r.registrations)}</Td>
                        <Td align="right">{num(r.activated)}</Td>
                        <Td align="right">
                          {pct(r.activationRate)}
                          {r.registrations < 30 ? <Badge tone="warn">small</Badge> : null}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          ))}
        </div>
      ) : null}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <Caveats tone="info" items={[
            "Activation measures reaching a milestone you defined. It does not measure whether users found that milestone valuable.",
            "A period-over-period change could be a shift in who is signing up rather than a change in the product.",
            "Users still inside their activation window count as not activated, so the rate for a recent period always reads low.",
          ]} />
        </div>
        <div className="max-w-lg">
          <ActivationForm knownEvents={knownEvents} current={def} />
        </div>
      </div>
    </>
  );
}

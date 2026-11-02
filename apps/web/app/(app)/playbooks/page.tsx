import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  listPlaybooks, measurePlaybook, suppressionSummary, eventBreakdown,
  PLAYBOOK_KIND_RULES, CANCELLATION_RULE, MIN_HOLDOUT_PERCENT, MAX_HOLDOUT_PERCENT,
  MIN_OUTBOUND_DELAY_HOURS, type PlaybookKind,
} from "@retainos/analytics";
import { entitlementFor } from "@retainos/database";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Empty, Button, Caveats, Metric, Table, Th, Td,
} from "@/components/ui";
import { num, pct, titleCase } from "@/lib/format";
import { PlaybookForm, PlaybookActions } from "./forms";

export const metadata: Metadata = { title: "Retention playbooks" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  draft: "neutral", approved: "info", active: "good", paused: "warn", archived: "neutral",
} as const;

export default async function Playbooks() {
  const ctx = await requireProject();
  const handle = db();
  const entitlement = entitlementFor(handle, ctx.org.id);
  const now = Date.now();

  if (!entitlement.features.playbooks) {
    return (
      <>
        <PageHeader title="Retention playbooks" />
        <Empty
          title="Not included on your plan"
          body={`Retention playbooks are part of the Growth plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  const playbooks = listPlaybooks(handle, ctx.project.id);
  const events = eventBreakdown(handle, ctx.project.id, {
    from: now - 90 * 86_400_000, to: now, limit: 40,
  }).map((e) => e.name);

  return (
    <>
      <PageHeader
        title="Retention playbooks"
        description="Helpful messages, sent sparingly, measured against a holdout that receives nothing. Without the holdout every playbook “works”, because the people who were going to stay anyway are in the numerator."
      />

      <div className="mb-5">
        <Caveats
          items={[
            `A holdout between ${MIN_HOLDOUT_PERCENT * 100}% and ${MAX_HOLDOUT_PERCENT * 100}% is required. ` +
            "Smaller than that cannot measure whether the playbook does anything, so it is refused.",
            `An outbound message cannot be sent within ${MIN_OUTBOUND_DELAY_HOURS} hour of its trigger: an ` +
            "instant message after something a user just did reads as surveillance.",
            CANCELLATION_RULE,
          ]}
          tone="info"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {playbooks.length === 0 ? (
            <Empty
              title="No playbooks yet"
              body="Start with onboarding recovery: one message to people who began setting up and stopped, pointing at the step they stalled on."
            />
          ) : (
            playbooks.map((p) => {
              const outcome = measurePlaybook(handle, ctx.project.id, p, { now });
              const suppressions = suppressionSummary(handle, ctx.project.id, p.id);
              const rules = PLAYBOOK_KIND_RULES[p.kind as PlaybookKind];
              return (
                <Card key={p.id}>
                  <CardHeader
                    title={p.name}
                    subtitle={rules.purpose}
                    action={
                      <span className="flex items-center gap-1.5">
                        <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                        <Badge tone="neutral">{p.channel}</Badge>
                      </span>
                    }
                  />
                  <CardBody>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <Metric
                        label="Treated"
                        value={num(outcome.treatment.enrolled)}
                        definition={`${num(outcome.treatment.delivered)} delivered. ` +
                          (outcome.treatment.rate === null
                            ? "No settled outcomes yet."
                            : `${pct(outcome.treatment.rate)} reached the metric.`)}
                      />
                      <Metric
                        label="Held out"
                        value={num(outcome.holdout.enrolled)}
                        definition={`Receives nothing, deliberately. ` +
                          (outcome.holdout.rate === null
                            ? "No settled outcomes yet."
                            : `${pct(outcome.holdout.rate)} reached the metric anyway.`)}
                      />
                      <Metric
                        label="Holdout share"
                        value={pct(p.holdoutPercent, 0)}
                        definition="Randomised on the playbook and the person, so it cannot be re-rolled."
                      />
                    </div>

                    <div className="mt-4 rounded-lg border border-navy-700/60 bg-navy-900/40 px-3.5 py-3">
                      <p className="text-xs leading-relaxed text-slate-300">{outcome.interpretation}</p>
                      {outcome.limitations.length > 0 ? (
                        <ul className="mt-2 space-y-1">
                          {outcome.limitations.map((l, i) => (
                            <li key={i} className="text-[11px] leading-snug text-slate-500">{l}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>

                    {p.messageBody ? (
                      <div className="mt-4">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                          Message
                        </p>
                        <p className="mt-1 text-sm font-medium text-offwhite">{p.messageTitle}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{p.messageBody}</p>
                      </div>
                    ) : null}

                    <p className="mt-3 text-[11px] leading-relaxed text-amber-500/80">
                      <span className="font-medium">Must not be used for:</span> {rules.forbidden}
                    </p>

                    {suppressions.length > 0 ? (
                      <div className="mt-4">
                        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                          What this playbook chose not to do
                        </p>
                        <ul className="flex flex-wrap gap-1.5">
                          {suppressions.map((s) => (
                            <li key={s.reason}>
                              <Badge tone="neutral">{titleCase(s.reason)}: {num(s.count)}</Badge>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div className="mt-4 border-t border-navy-800 pt-3">
                      <PlaybookActions
                        id={p.id}
                        status={p.status}
                        approvedBy={p.approvedBy}
                      />
                    </div>
                  </CardBody>
                </Card>
              );
            })
          )}
        </div>

        <div className="space-y-5">
          <PlaybookForm events={events} />

          <Card>
            <CardHeader title="What each kind is for" />
            <CardBody>
              <dl className="space-y-3">
                {(Object.keys(PLAYBOOK_KIND_RULES) as PlaybookKind[]).map((kind) => (
                  <div key={kind}>
                    <dt className="text-xs font-medium text-slate-300">{titleCase(kind)}</dt>
                    <dd className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
                      {PLAYBOOK_KIND_RULES[kind].purpose}
                    </dd>
                    <dd className="mt-1 text-[11px] leading-relaxed text-amber-500/80">
                      Not for: {PLAYBOOK_KIND_RULES[kind].forbidden}
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

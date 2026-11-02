import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  listAlerts, listAlertRules, alertQuality, dataQualityNote, DEFAULT_ALERT_RULES,
  ABSOLUTE_MIN_AFFECTED_USERS, type AlertKind,
} from "@retainos/analytics";
import { entitlementFor } from "@retainos/database";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Empty, Button, Caveats, Metric, Table, Th, Td,
} from "@/components/ui";
import { num, pct, relative, titleCase } from "@/lib/format";
import { AlertActions, RunChecksButton, InstallRulesButton, RuleForm } from "./forms";

export const metadata: Metadata = { title: "Alerts" };
export const dynamic = "force-dynamic";

const SEVERITY_TONE = {
  critical: "bad", high: "bad", medium: "warn", low: "neutral",
} as const;

export default async function Alerts() {
  const ctx = await requireProject();
  const handle = db();
  const entitlement = entitlementFor(handle, ctx.org.id);

  if (!entitlement.features.alerting) {
    return (
      <>
        <PageHeader title="Alerts" />
        <Empty
          title="Not included on your plan"
          body={`Alerting is part of the Starter plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  const rules = listAlertRules(handle, ctx.project.id);
  const open = listAlerts(handle, ctx.project.id, { limit: 50 });
  const quality = alertQuality(handle, ctx.project.id);
  const dataQuality = dataQualityNote(handle, ctx.project.id, ctx.project.timezone, Date.now());

  return (
    <>
      <PageHeader
        title="Alerts"
        description="An alerting system is judged by the alerts it does not send. These rules are built to stay quiet: a floor on affected users, a cooldown, deduplication, and a refusal to fire at all when the data underneath is known to be broken."
        action={<RunChecksButton />}
      />

      {dataQuality.blocking > 0 ? (
        <div className="mb-5">
          <Caveats
            items={[
              dataQuality.note +
              " While that is true, every alert except the ingestion one is withheld rather than sent on " +
              "numbers nobody should act on.",
            ]}
          />
        </div>
      ) : null}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Metric
          label="Open alerts"
          value={num(open.length)}
          definition="Fired, not yet resolved, and not snoozed past today."
        />
        <Metric
          label="Fired in 30 days"
          value={num(quality.totalFired)}
          definition="Every alert that passed the rules and was written."
        />
        <Metric
          label="Acknowledged"
          value={quality.overallAcknowledgementRate === null
            ? "—"
            : pct(quality.overallAcknowledgementRate, 0)}
          definition="The only measure that matters: whether a person acted on them."
          caveat={quality.overallAcknowledgementRate !== null && quality.overallAcknowledgementRate <= 0.2
            ? "Most of these alerts were ignored. That is a rule problem, not an attention problem."
            : null}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Open alerts" subtitle="Each one carries the five things an alert needs to be actionable." />
            <CardBody>
              {open.length === 0 ? (
                <Empty
                  title="Nothing open"
                  body={rules.length === 0
                    ? "No rules are configured yet. Install the defaults and the checks will have something to run against."
                    : "Every check has run without crossing a threshold, or everything that fired has been resolved."}
                  action={rules.length === 0 ? <InstallRulesButton /> : undefined}
                />
              ) : (
                <ul className="space-y-4">
                  {open.map((a) => (
                    <li key={a.id} className="rounded-xl border border-navy-700/70 bg-navy-900/40 px-4 py-3.5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="min-w-0 text-sm font-medium leading-snug text-offwhite">{a.title}</p>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
                          {a.acknowledgedAt ? <Badge tone="info">acknowledged</Badge> : null}
                        </div>
                      </div>

                      <dl className="mt-3 space-y-2">
                        {([
                          ["What the metric did", a.metricDetail],
                          ["Compared against", a.comparisonDetail],
                          ["Data quality", a.dataQuality],
                          ["Rule that fired", a.triggeringRule],
                        ] as const).map(([label, value]) => (
                          <div key={label}>
                            <dt className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                              {label}
                            </dt>
                            <dd className="text-xs leading-relaxed text-slate-300">{value}</dd>
                          </div>
                        ))}
                      </dl>

                      <p className="mt-3 text-xs leading-relaxed text-cyan-400/90">
                        <span className="font-medium">Suggested next step:</span> {a.suggestedAction}
                      </p>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] text-slate-600">
                          fired {relative(a.firedAt)}
                          {a.affectedUsers !== null ? ` · ${num(a.affectedUsers)} affected` : ""}
                        </span>
                        <AlertActions id={a.id} acknowledged={a.acknowledgedAt !== null} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Have these alerts been worth sending?"
              subtitle="Measured by whether anyone acted, not by whether the detection was clever."
            />
            <CardBody>
              {quality.rules.length === 0 ? (
                <p className="text-xs leading-relaxed text-slate-400">{quality.summary}</p>
              ) : (
                <>
                  <Table>
                    <thead>
                      <tr>
                        <Th>Rule</Th>
                        <Th align="right">Fired</Th>
                        <Th align="right">Acknowledged</Th>
                        <Th>Assessment</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {quality.rules.map((r) => (
                        <tr key={r.kind}>
                          <Td>{titleCase(r.kind)}</Td>
                          <Td align="right">{num(r.fired)}</Td>
                          <Td align="right">
                            {r.acknowledgementRate === null ? "—" : pct(r.acknowledgementRate, 0)}
                          </Td>
                          <Td>
                            <span className="text-xs leading-snug text-slate-300">{r.assessment}</span>
                            {r.recommendation ? (
                              <span className="mt-1 block text-[11px] leading-snug text-amber-500/90">
                                {r.recommendation}
                              </span>
                            ) : null}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{quality.summary}</p>
                </>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          {rules.length === 0 ? (
            <Card>
              <CardHeader title="No rules yet" />
              <CardBody>
                <p className="mb-3 text-xs leading-relaxed text-slate-400">
                  The defaults are deliberately conservative: an activation regression needs 50 affected
                  users and a significant test, and an error spike needs to double against its own baseline.
                </p>
                <InstallRulesButton />
              </CardBody>
            </Card>
          ) : (
            rules.map((rule) => <RuleForm key={rule.id} rule={rule} />)
          )}

          <Card>
            <CardHeader title="Why these limits exist" />
            <CardBody>
              <Caveats
                items={[
                  `No rule can be configured below ${ABSOLUTE_MIN_AFFECTED_USERS} affected users: under that, a ` +
                  "change in a rate is arithmetic on a handful of people.",
                  "A cooldown under an hour is refused, because the same problem alerting repeatedly while " +
                  "nobody is fixing it is how a channel gets muted.",
                  "Quiet hours delay an alert rather than cancelling it. The error-spike rule has none, " +
                  "because production being broken is urgent at 3am too.",
                ]}
                tone="info"
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

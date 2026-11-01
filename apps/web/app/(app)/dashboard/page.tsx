import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  activeUsers, withStickiness, activationFunnel, listActivationDefinitions,
  computeRetention, listInsights, mrrSnapshot, currenciesInUse, retentionCurve,
  listImpactMeasurements,
} from "@retainos/analytics";
import { listFeedback, countFeedbackByStatus, listImprovements, listReleases } from "@retainos/database";
import {
  PageHeader, Card, CardHeader, CardBody, Metric, Badge, Empty, Caveats, Confidence, DemoBanner, Button,
} from "@/components/ui";
import { ActivityChart, RetentionCurve } from "@/components/charts";
import { pct, num, money, deltaPoints, relative, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

/**
 * The overview screen.
 *
 * It answers one question: what is going wrong in my product, what evidence do
 * we have, and what should we look at next. Findings come first, because a
 * dashboard full of healthy numbers with the problem buried three screens down
 * is a worse product than one that leads with the problem.
 */
export default async function Dashboard() {
  const ctx = await requireProject();
  const handle = db();
  const { projectId, timezone } = ctx.projectScope;
  const now = Date.now();
  const WEEK = 7 * 86_400_000;

  const actives = withStickiness(activeUsers(handle, projectId, {
    from: now - 30 * 86_400_000, to: now, granularity: "day", timezone, now,
  }));

  const defs = listActivationDefinitions(handle, projectId);
  const def = defs.find((d) => d.isPrimary) ?? defs[0];
  const activation = def
    ? activationFunnel(handle, projectId, { definition: def, from: now - WEEK, to: now, now })
    : null;
  const activationPrior = def
    ? activationFunnel(handle, projectId, { definition: def, from: now - 2 * WEEK, to: now - WEEK - 1, now })
    : null;

  const retention = computeRetention(handle, projectId, {
    from: now - 45 * 86_400_000, to: now, timezone, periods: [1, 7, 30], now,
  });
  const d7 = retention.averageByPeriod.find((p) => p.period === 7);

  const currencies = currenciesInUse(handle, projectId);
  const revenue = currencies.length > 0 ? mrrSnapshot(handle, projectId, now) : [];

  const insights = listInsights(handle, projectId, { limit: 5 }) as Array<Record<string, unknown>>;
  const feedbackCounts = countFeedbackByStatus(handle, ctx.projectScope);
  const recentFeedback = listFeedback(handle, ctx.projectScope, { limit: 5 }) as Array<Record<string, unknown>>;
  const openImprovements = listImprovements(handle, ctx.projectScope, {
    status: ["detected", "investigating", "validated", "planned", "approved", "in_development", "in_review"],
    limit: 5,
  }) as Array<Record<string, unknown>>;
  const releases = listReleases(handle, ctx.projectScope, 3) as Array<Record<string, unknown>>;
  const measurements = listImpactMeasurements(handle, projectId, 3);

  const firstIncomplete = actives.points.find((p) => !p.complete)?.bucket ?? null;
  const totalEvents = actives.points.reduce((s, p) => s + p.eventCount, 0);

  if (totalEvents === 0) {
    return (
      <>
        <PageHeader
          title={`${ctx.project.name} overview`}
          description="No events have arrived yet, so there is nothing to analyse."
        />
        <Empty
          title="Send your first event"
          body={
            "RetainOS has nothing to tell you until your application sends events. Install the SDK, grant " +
            "consent, and fire one event — the inspector will show it arriving, or tell you exactly why it " +
            "was rejected."
          }
          action={
            <Link href="/settings/sdk">
              <Button>Open SDK setup</Button>
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      {ctx.project.isDemo ? <DemoBanner /> : null}

      <PageHeader
        title={`${ctx.project.name} overview`}
        description={`Figures are computed in ${timezone}. The most recent day has not finished, so it will read low.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Weekly active users"
          value={num(actives.wau)}
          definition="Distinct identities with at least one accepted event in the last 7 days."
        />
        <Metric
          label="Activation rate"
          value={activation ? pct(activation.registrations === 0 ? null : activation.activationRate) : "—"}
          definition={
            def
              ? `Users who fired "${def.activationEvent}" within ${def.windowDays} days of signing up, over the last 7 days.`
              : "No activation definition is configured for this project."
          }
          delta={
            activation && activationPrior && activationPrior.registrations > 0
              ? deltaPoints(activation.activationRate, activationPrior.activationRate)
              : undefined
          }
          caveat={activation?.warnings[0] ?? (def ? null : "Define activation to measure it.")}
        />
        <Metric
          label="Day-7 retention"
          value={pct(d7?.rate ?? null)}
          definition={
            d7 && d7.rate !== null
              ? `Across ${num(d7.usersCounted)} users in ${d7.cohortsCounted} cohorts whose day-7 window has fully elapsed.`
              : "No cohort has a complete day-7 window yet. Reporting zero here would invent a decline."
          }
        />
        <Metric
          label={revenue.length > 0 ? `MRR (${revenue[0]!.currency})` : "MRR"}
          value={revenue.length > 0 ? money(revenue[0]!.mrrMinor, revenue[0]!.currency) : "—"}
          definition={
            revenue.length > 0
              ? "Normalised monthly amounts for active and past-due subscriptions. Annual plans divided by 12."
              : "No billing data is connected. RetainOS will not estimate revenue from product usage."
          }
          caveat={
            revenue.length > 0 && revenue[0]!.pastDueMrrMinor > 0
              ? `${money(revenue[0]!.pastDueMrrMinor, revenue[0]!.currency)} of this is in a failed-payment state.`
              : null
          }
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Highest-priority findings"
            subtitle="Detected by deterministic rules over your own data. Severity orders this list; it is not a probability."
            action={<Link href="/ai"><Button variant="ghost" size="sm">All findings</Button></Link>}
          />
          <CardBody>
            {insights.length === 0 ? (
              <p className="text-xs leading-relaxed text-slate-400">
                No open findings. That may mean nothing is wrong, or that there is not yet enough data to detect
                anything — those two look identical from here.
              </p>
            ) : (
              <ul className="space-y-3">
                {insights.map((i) => (
                  <li key={String(i.id)} className="rounded-lg border border-navy-700/60 bg-navy-950/40 p-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <Link href="/ai" className="text-sm font-medium text-offwhite hover:text-blue-400">
                        {String(i.title)}
                      </Link>
                      <Confidence label={String(i.confidence)} basis={String(i.confidence_basis ?? "")} />
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{String(i.observation)}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Activity" subtitle="Active and new users per day." />
          <CardBody className="px-2">
            <ActivityChart data={actives.points} incompleteFrom={firstIncomplete} />
          </CardBody>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Retention curve" subtitle="Average across cohorts with a complete window." />
          <CardBody className="px-2">
            {retention.cohorts.length === 0 ? (
              <p className="px-3 py-6 text-xs text-slate-400">No cohorts in this period yet.</p>
            ) : (
              <RetentionCurve data={retentionCurve(retention)} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Feedback"
            subtitle="What customers told you."
            action={<Link href="/feedback"><Button variant="ghost" size="sm">Inbox</Button></Link>}
          />
          <CardBody>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {Object.entries(feedbackCounts)
                .filter(([, n]) => n > 0)
                .map(([status, n]) => (
                  <Badge key={status} tone={status === "new" ? "info" : "neutral"}>
                    {titleCase(status)} {n}
                  </Badge>
                ))}
              {Object.values(feedbackCounts).every((n) => n === 0) ? (
                <span className="text-xs text-slate-400">No feedback yet.</span>
              ) : null}
            </div>
            <ul className="space-y-2">
              {recentFeedback.map((f) => (
                <li key={String(f.id)} className="text-xs leading-relaxed">
                  <Link href={`/feedback?id=${String(f.id)}`} className="text-slate-300 hover:text-blue-400">
                    {String(f.title)}
                  </Link>
                  <span className="ml-1.5 text-slate-500">· {relative(Number(f.created_at), now)}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="In flight"
            subtitle="Improvements that are not yet resolved."
            action={<Link href="/improvements"><Button variant="ghost" size="sm">All</Button></Link>}
          />
          <CardBody>
            {openImprovements.length === 0 ? (
              <p className="text-xs leading-relaxed text-slate-400">
                Nothing open. Findings become improvement tasks when you decide one is worth acting on.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {openImprovements.map((t) => (
                  <li key={String(t.id)} className="text-xs">
                    <Link href={`/improvements/${String(t.id)}`} className="text-slate-300 hover:text-blue-400">
                      {String(t.title)}
                    </Link>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Badge>{titleCase(String(t.status))}</Badge>
                      {Number(t.evidence_count) > 0 ? (
                        <span className="text-[11px] text-slate-500">{Number(t.evidence_count)} evidence</span>
                      ) : (
                        <span className="text-[11px] text-amber-500/80">no evidence attached</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Recent releases"
            action={<Link href="/releases"><Button variant="ghost" size="sm">Releases</Button></Link>}
          />
          <CardBody>
            {releases.length === 0 ? (
              <p className="text-xs leading-relaxed text-slate-400">
                No releases recorded. Recording them is what lets ImpactLab line a metric up against a change.
              </p>
            ) : (
              <ul className="space-y-2">
                {releases.map((r) => (
                  <li key={String(r.id)} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-slate-300">
                      {String(r.version)} <span className="text-slate-500">{String(r.name)}</span>
                    </span>
                    <span className="shrink-0 text-slate-500">{relative(Number(r.released_at), now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Impact measurement"
            subtitle="Whether shipped work moved anything."
            action={<Link href="/impact"><Button variant="ghost" size="sm">ImpactLab</Button></Link>}
          />
          <CardBody>
            {measurements.length === 0 ? (
              <p className="text-xs leading-relaxed text-slate-400">
                Nothing measured yet. After a release, measure the metric the improvement was meant to move.
              </p>
            ) : (
              <ul className="space-y-2 text-xs">
                {measurements.map((m) => (
                  <li key={m.id} className="flex items-baseline justify-between gap-3">
                    <span className="text-slate-300">{titleCase(m.metric_kind)}</span>
                    <Badge tone={m.method === "experiment" ? "good" : "warn"}>
                      {m.method === "experiment" ? "experiment" : "observational"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-5">
        <Caveats
          tone="info"
          items={[
            "Nothing on this screen establishes a cause. A funnel drop-off shows where users stopped, not why.",
            "Period-over-period comparisons are observational: traffic mix, seasonality and concurrent releases all differ at once.",
            "Only a controlled experiment in ImpactLab supports a causal claim about a change you shipped.",
          ]}
        />
      </div>
    </>
  );
}

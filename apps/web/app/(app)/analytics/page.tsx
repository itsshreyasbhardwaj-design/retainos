import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  activeUsers, withStickiness, eventBreakdown, commonPaths, nextSteps,
  featureAdoption, trackedFeatures, dimensionValues, inactiveUsers,
} from "@retainos/analytics";
import { PageHeader, Card, CardHeader, CardBody, Metric, Table, Th, Td, Empty, Caveats, Bar, Badge, Button, DemoBanner } from "@/components/ui";
import { ActivityChart } from "@/components/charts";
import { pct, num } from "@/lib/format";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

export default async function Analytics({ searchParams }: { searchParams: Promise<{ days?: string; plan?: string }> }) {
  const params = await searchParams;
  const days = Math.min(Math.max(Number(params.days ?? 30) || 30, 1), 365);
  const ctx = await requireProject();
  const handle = db();
  const { projectId, timezone } = ctx.projectScope;
  const now = Date.now();
  const from = now - days * 86_400_000;
  const segment = params.plan ? { plan: params.plan } : undefined;

  const actives = withStickiness(activeUsers(handle, projectId, {
    from, to: now, granularity: days > 90 ? "week" : "day", timezone, now, segment,
  }));
  const events = eventBreakdown(handle, projectId, { from, to: now, segment, limit: 15 });
  const paths = commonPaths(handle, projectId, { from, to: now, depth: 4, segment, limit: 8 });
  const features = trackedFeatures(handle, projectId);
  const adoption = features.length > 0
    ? featureAdoption(handle, projectId, {
        features: features.map((f) => ({ key: f.key, eventName: f.event_name, label: f.label })),
        from, to: now, timezone, segment, now,
      })
    : [];
  const plans = dimensionValues(handle, projectId, "plan", 8);
  const inactive = inactiveUsers(handle, projectId, { thresholdDays: 14, now, limit: 0 });

  const totalEvents = events.reduce((s, e) => s + e.eventCount, 0);
  const firstIncomplete = actives.points.find((p) => !p.complete)?.bucket ?? null;

  return (
    <>
      {ctx.project.isDemo ? <DemoBanner /> : null}
      <PageHeader
        title="Analytics"
        description={`Usage over the last ${days} days, bucketed in ${timezone}.`}
        action={
          <div className="flex flex-wrap gap-1.5">
            {[7, 30, 90].map((d) => (
              <Link key={d} href={`/analytics?days=${d}${params.plan ? `&plan=${params.plan}` : ""}`}>
                <Button variant={d === days ? "primary" : "secondary"} size="sm">{d}d</Button>
              </Link>
            ))}
          </div>
        }
      />

      {plans.length > 0 ? (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-slate-500">Segment by plan:</span>
          <Link href={`/analytics?days=${days}`}>
            <Button variant={params.plan ? "ghost" : "secondary"} size="sm">All</Button>
          </Link>
          {plans.map((p) => (
            <Link key={p.value} href={`/analytics?days=${days}&plan=${encodeURIComponent(p.value)}`}>
              <Button variant={params.plan === p.value ? "primary" : "ghost"} size="sm">{p.value}</Button>
            </Link>
          ))}
        </div>
      ) : null}

      {totalEvents === 0 ? (
        <Empty
          title="No events in this period"
          body="Either nothing was sent, or everything that was sent got rejected. The inspector shows which."
          action={<Link href="/settings/sdk"><Button>Open the event inspector</Button></Link>}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Daily active users" value={num(actives.dau)}
              definition="Distinct identities with an accepted event today so far, in the project timezone." />
            <Metric label="Weekly active users" value={num(actives.wau)}
              definition="Distinct identities with an accepted event in the last 7 days." />
            <Metric label="Monthly active users" value={num(actives.mau)}
              definition="Distinct identities with an accepted event in the last 30 days." />
            <Metric label="Stickiness" value={pct(actives.stickiness)}
              definition="DAU divided by MAU. A rough proxy for how often people come back, not a measure of value."
              caveat="Today is not over, so DAU and therefore stickiness read low." />
          </div>

          <Card className="mt-5">
            <CardHeader title="Active and new users" subtitle={actives.definition} />
            <CardBody className="px-2">
              <ActivityChart data={actives.points} incompleteFrom={firstIncomplete} />
            </CardBody>
          </Card>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Events"
                subtitle="Counted as occurrences and as distinct users, because the two tell different stories."
                action={<Link href="/analytics/events"><Button variant="ghost" size="sm">Inspector</Button></Link>}
              />
              <CardBody>
                <Table>
                  <thead>
                    <tr>
                      <Th>Event</Th>
                      <Th align="right">Occurrences</Th>
                      <Th align="right">Users</Th>
                      <Th align="right">Per user</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.name}>
                        <Td><code className="font-mono text-[12px] text-slate-300">{e.name}</code></Td>
                        <Td align="right">{num(e.eventCount)}</Td>
                        <Td align="right">{num(e.uniqueUsers)}</Td>
                        <Td align="right">{e.eventsPerUser.toFixed(1)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Most common journeys" subtitle="Consecutive repeats of the same event are collapsed." />
              <CardBody>
                {paths.paths.length === 0 ? (
                  <p className="text-xs text-slate-400">Not enough multi-event sessions to show a path yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {paths.paths.map((p) => (
                      <li key={p.path.join(">")}>
                        <div className="flex items-baseline justify-between gap-3">
                          <code className="min-w-0 break-words font-mono text-[11px] leading-relaxed text-slate-300">
                            {p.path.join(" → ")}
                          </code>
                          <span className="shrink-0 text-[11px] tnum text-slate-400">{num(p.users)} · {pct(p.share, 0)}</span>
                        </div>
                        <div className="mt-1.5"><Bar fraction={p.share} tone="cyan" /></div>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-4">
                  <Caveats tone="info" items={[paths.caveat]} />
                </div>
              </CardBody>
            </Card>
          </div>

          {adoption.length > 0 ? (
            <Card className="mt-5">
              <CardHeader
                title="Feature adoption"
                subtitle="Repeat use requires two distinct calendar days, not two events in one session."
              />
              <CardBody>
                <Table>
                  <thead>
                    <tr>
                      <Th>Feature</Th>
                      <Th align="right">Users</Th>
                      <Th align="right">First-time</Th>
                      <Th align="right">Repeat</Th>
                      <Th align="right">Repeat rate</Th>
                      <Th align="right">Of active users</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {adoption.map((f) => (
                      <tr key={f.eventName}>
                        <Td>{f.feature}</Td>
                        <Td align="right">{num(f.discoveredBy)}</Td>
                        <Td align="right">{num(f.firstTimeUsers)}</Td>
                        <Td align="right">{num(f.repeatUsers)}</Td>
                        <Td align="right">{pct(f.repeatRate)}</Td>
                        <Td align="right">{pct(f.adoptionRate)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="mt-4">
                  <Caveats items={[
                    "Adoption measured against all active users understates adoption within a feature's target segment.",
                    "A missing event looks identical to an unused feature. Confirm instrumentation before concluding anything.",
                  ]} />
                </div>
              </CardBody>
            </Card>
          ) : null}

          <Card className="mt-5">
            <CardHeader title="Inactivity" subtitle={`Against this project's configured threshold of ${inactive.thresholdDays} days.`} />
            <CardBody>
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric label="Identities" value={num(inactive.totalIdentities)}
                  definition="Every identity RetainOS has seen in this project." />
                <Metric label="Inactive" value={num(inactive.inactiveIdentities)}
                  definition={`No event for more than ${inactive.thresholdDays} days.`} />
                <Metric label="Share inactive" value={pct(inactive.inactiveShare)}
                  definition="Inactive identities over all identities." />
              </div>
              <div className="mt-4">
                <Caveats items={[inactive.caveat]} />
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </>
  );
}

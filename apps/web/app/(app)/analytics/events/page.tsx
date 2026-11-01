import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { recentEvents, recentRejections, ingestHealth, undeclaredEvents } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Table, Th, Td, Metric, Badge, Empty, Button, Caveats } from "@/components/ui";
import { pct, num, relative, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Event inspector" };
export const dynamic = "force-dynamic";

export default async function Events() {
  const ctx = await requireProject();
  const handle = db();
  const { projectId } = ctx.projectScope;
  const now = Date.now();
  const since = now - 24 * 3_600_000;

  const health = ingestHealth(handle, projectId, since);
  const events = recentEvents(handle, projectId, 40) as Array<Record<string, unknown>>;
  const rejections = recentRejections(handle, projectId, 25) as Array<Record<string, unknown>>;
  const undeclared = undeclaredEvents(handle, projectId, 15);

  return (
    <>
      <PageHeader
        title="Event inspector"
        description="What arrived in the last 24 hours, and what was refused. Rejections are the useful half."
        action={<Link href="/settings/sdk"><Button variant="secondary" size="sm">SDK setup</Button></Link>}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Accepted" value={num(health.accepted)} definition="Events stored in the last 24 hours." />
        <Metric label="Rejected" value={num(health.rejected)}
          definition="Events refused in the last 24 hours. These are not stored and do not appear in any metric."
          tone={health.rejected > 0 ? "bad" : undefined} />
        <Metric label="Acceptance rate" value={pct(health.acceptanceRate)}
          definition="Accepted over accepted plus rejected."
          caveat={health.acceptanceRate !== null && health.acceptanceRate < 0.95
            ? "Below 95%. Every metric covering this window is computed on incomplete data."
            : null} />
      </div>

      {health.byReason.length > 0 ? (
        <Card className="mt-5">
          <CardHeader title="Why events were rejected" />
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {health.byReason.map((r) => (
                <Badge key={r.reason} tone="bad">{titleCase(r.reason)} · {r.n}</Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent events" subtitle="Newest first, by server receipt time." />
          <CardBody>
            {events.length === 0 ? (
              <p className="text-xs text-slate-400">Nothing received yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr><Th>Event</Th><Th>Identity</Th><Th align="right">When</Th></tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={String(e.id)}>
                      <Td>
                        <code className="font-mono text-[12px] text-slate-300">{String(e.name)}</code>
                        {String(e.properties) !== "{}" ? (
                          <div className="mt-0.5 break-all font-mono text-[10px] text-slate-500">{String(e.properties)}</div>
                        ) : null}
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px] text-slate-400">
                          {e.external_id ? String(e.external_id) : `anon ${String(e.anonymous_id ?? "").slice(0, 8)}`}
                        </span>
                      </Td>
                      <Td align="right">{relative(Number(e.received_at), now)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Recent rejections" subtitle="Each one with the exact reason it was refused." />
            <CardBody>
              {rejections.length === 0 ? (
                <p className="text-xs text-slate-400">No rejections. Instrumentation looks healthy.</p>
              ) : (
                <ul className="space-y-2.5">
                  {rejections.map((r) => (
                    <li key={String(r.id)} className="rounded-lg border border-navy-700/60 bg-navy-950/40 p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <code className="font-mono text-[11px] text-slate-300">{String(r.event_name ?? "(no name)")}</code>
                        <Badge tone="bad">{titleCase(String(r.reason))}</Badge>
                      </div>
                      {String(r.detail) !== "{}" ? (
                        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-slate-500">
                          {String(r.detail)}
                        </pre>
                      ) : null}
                      <p className="mt-1 text-[10px] text-slate-500">{relative(Number(r.received_at), now)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {undeclared.length > 0 ? (
            <Card>
              <CardHeader
                title="Events with no schema"
                subtitle="These are being accepted, but nothing validates their properties."
              />
              <CardBody>
                <Table>
                  <thead><tr><Th>Event</Th><Th align="right">Seen</Th></tr></thead>
                  <tbody>
                    {undeclared.map((u) => (
                      <tr key={u.name}>
                        <Td><code className="font-mono text-[12px] text-slate-300">{u.name}</code></Td>
                        <Td align="right">{num(u.event_count)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="mt-3">
                  <Link href="/settings/sdk"><Button variant="secondary" size="sm">Register these events</Button></Link>
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <div className="mt-5">
        <Caveats tone="info" items={[
          "Rejected events are counted and sampled here, but never stored. A metric cannot include an event that was refused.",
          "Properties that matched the privacy denylist were removed before storage; the event itself was still accepted.",
        ]} />
      </div>
    </>
  );
}

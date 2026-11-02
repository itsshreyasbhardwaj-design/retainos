import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  listConnections, listSyncRuns, eventProvenance, authoritativeSourceFor,
  PROVIDER_CAPABILITIES, CSV_EVENT_COLUMNS, type Provider, type SourceDomain,
} from "@retainos/analytics";
import { entitlementFor } from "@retainos/database";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Empty, Button, Caveats, Table, Th, Td, Bar,
} from "@/components/ui";
import { num, when, titleCase } from "@/lib/format";
import { ConnectForm, ProviderActions, AuthorityForm, CsvImportForm, RevertForm } from "./forms";

export const metadata: Metadata = { title: "Data sources" };
export const dynamic = "force-dynamic";

const DOMAINS: SourceDomain[] = ["events", "errors", "subscriptions", "feedback", "releases"];

const STATUS_TONE = {
  connected: "good", disconnected: "neutral", error: "bad", revoked: "warn",
} as const;

export default async function Sources() {
  const ctx = await requireProject();
  const handle = db();
  const entitlement = entitlementFor(handle, ctx.org.id);

  const connections = listConnections(handle, ctx.project.id);
  const provenance = eventProvenance(handle, ctx.project.id);
  const totalEvents = provenance.reduce((s, p) => s + p.events, 0);
  const authorities = DOMAINS.map((domain) => ({
    domain,
    authority: authoritativeSourceFor(handle, ctx.project.id, domain, "*"),
  }));

  interface SyncRunRow {
    id: string;
    provider: string;
    startedAt: number;
    status: string;
    imported: number;
    duplicate: number;
    rejected: number;
    error: string | null;
  }
  const runs: SyncRunRow[] = [];
  for (const connection of connections) {
    for (const run of listSyncRuns(handle, connection.id, 5) as Array<Record<string, any>>) {
      runs.push({
        id: String(run.id),
        provider: connection.provider,
        startedAt: Number(run.started_at),
        status: String(run.status),
        imported: Number(run.records_imported ?? 0),
        duplicate: Number(run.records_duplicate ?? 0),
        rejected: Number(run.records_rejected ?? 0),
        error: run.error ? String(run.error) : null,
      });
    }
  }
  runs.sort((a, b) => b.startedAt - a.startedAt);
  const recentRuns = runs.slice(0, 10);

  return (
    <>
      <PageHeader
        title="Data sources"
        description="RetainOS reads from what you already have rather than asking you to migrate. The cost of that is double counting, so every record carries its source and one source is authoritative per thing."
      />

      {!entitlement.features.providerIntegrations ? (
        <div className="mb-5">
          <Caveats
            items={[
              `Provider integrations are part of the Starter plan and above — you are on ${entitlement.planId}. ` +
              "CSV import below works on every plan, because importing your own data should never cost money.",
            ]}
          />
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Where this project's events came from"
              subtitle="The answer to “can I trust this number?”."
            />
            <CardBody>
              {provenance.length === 0 ? (
                <p className="text-xs leading-relaxed text-slate-400">
                  No events have arrived from any source yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {provenance.map((p) => (
                    <div key={p.source}>
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                        <span className="font-medium text-slate-300">{p.source}</span>
                        <span className="tnum text-slate-500">
                          {num(p.events)} event(s)
                          {p.firstAt ? ` · ${when(p.firstAt)} to ${when(p.lastAt)}` : ""}
                        </span>
                      </div>
                      <Bar fraction={totalEvents > 0 ? p.events / totalEvents : 0}
                           tone={p.source === "sdk" ? "blue" : "cyan"} />
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Connections"
              subtitle="A connection is a stated intention until a check against the provider actually succeeds. Nothing here claims a live feed it has not verified."
            />
            <CardBody>
              {connections.length === 0 ? (
                <Empty
                  title="Nothing connected"
                  body="Register a provider to read from it, or paste a CSV below. Credentials are never stored here — they are read from the server environment by name."
                />
              ) : (
                <ul className="space-y-4">
                  {connections.map((c) => {
                    const capability = PROVIDER_CAPABILITIES[c.provider];
                    return (
                      <li key={c.id} className="rounded-xl border border-navy-700/70 bg-navy-900/40 px-4 py-3.5">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-offwhite">{capability.label}</p>
                            <p className="mt-1 text-xs leading-relaxed text-slate-400">{c.statusLine}</p>
                          </div>
                          <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                          <span className="font-medium text-slate-400">Reads:</span> {capability.reads.join(", ")}
                        </p>
                        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                          <span className="font-medium text-slate-400">Cannot:</span> {capability.cannot.join(" ")}
                        </p>
                        {capability.credentialEnvVars.length > 0 ? (
                          <p className="mt-1 text-[11px] text-slate-600">
                            Credential read from {capability.credentialEnvVars.join(" or ")}.
                          </p>
                        ) : null}
                        <div className="mt-3">
                          <ProviderActions provider={c.provider} status={c.status} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <CsvImportForm columns={[...CSV_EVENT_COLUMNS]} />

          {recentRuns.length > 0 ? (
            <Card>
              <CardHeader
                title="Recent imports"
                subtitle="An import that turns out to be wrong can be removed, and events from other sources are untouched when it is."
              />
              <CardBody>
                <Table>
                  <thead>
                    <tr>
                      <Th>Source</Th>
                      <Th>Status</Th>
                      <Th align="right">Imported</Th>
                      <Th align="right">Duplicate</Th>
                      <Th align="right">Rejected</Th>
                      <Th align="right"></Th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.map((r) => (
                      <tr key={r.id}>
                        <Td>
                          <span className="text-slate-300">{r.provider}</span>
                          <span className="mt-0.5 block text-[11px] text-slate-600">
                            {when(r.startedAt)}
                          </span>
                        </Td>
                        <Td>
                          <Badge tone={r.status === "ok" ? "good" : r.status === "partial" ? "warn" : r.status === "failed" ? "bad" : "neutral"}>
                            {r.status}
                          </Badge>
                          {r.error ? (
                            <span className="mt-0.5 block text-[11px] text-rose-500/90">{r.error}</span>
                          ) : null}
                        </Td>
                        <Td align="right">{num(r.imported)}</Td>
                        <Td align="right">{num(r.duplicate)}</Td>
                        <Td align="right">{num(r.rejected)}</Td>
                        <Td align="right">
                          {r.imported > 0 ? <RevertForm syncRunId={r.id} /> : null}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-5">
          <ConnectForm
            providers={(Object.keys(PROVIDER_CAPABILITIES) as Provider[]).map((p) => ({
              value: p, label: PROVIDER_CAPABILITIES[p].label,
            }))}
          />

          <Card>
            <CardHeader
              title="Who is authoritative"
              subtitle="Without a decision here, the same action arriving from two systems is counted twice."
            />
            <CardBody>
              <ul className="mb-4 space-y-1.5">
                {authorities.map(({ domain, authority }) => (
                  <li key={domain} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-400">{titleCase(domain)}</span>
                    {authority
                      ? <Badge tone="info">{authority.source}</Badge>
                      : <span className="text-slate-600">any source accepted</span>}
                  </li>
                ))}
              </ul>
              <AuthorityForm domains={DOMAINS} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="What this never does" />
            <CardBody>
              <Caveats
                items={[
                  "Credentials are never stored in the database. A config key that looks like one is refused, " +
                  "with the environment variable to use instead named in the error.",
                  "Sentry stack traces are never read: they routinely contain file paths, query strings and " +
                  "user data.",
                  "GitHub access is read-only. RetainOS reads releases to line a metric change up against a " +
                  "deploy, and cannot push, open a pull request or change a repository.",
                  "Payment providers are never asked to charge, refund or retry anything.",
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

import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { projectKeys, listEventSpecs, undeclaredEvents, ingestHealth } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Badge, Button, Table, Th, Td, Caveats, Metric } from "@/components/ui";
import { pct, num, when, relative } from "@/lib/format";
import { SdkTools } from "./tools";

export const metadata: Metadata = { title: "SDK & events" };
export const dynamic = "force-dynamic";

export default async function Sdk() {
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();

  const keys = projectKeys(handle, ctx.projectScope);
  const specs = listEventSpecs(handle, ctx.project.id);
  const undeclared = undeclaredEvents(handle, ctx.project.id, 10);
  const health = ingestHealth(handle, ctx.project.id, now - 24 * 3_600_000);
  const publicKey = keys.ok ? keys.value.find((k) => k.kind === "public_write" && !k.revoked_at)?.public_key : null;
  const endpoint = process.env.RETAINOS_PUBLIC_URL ?? "http://localhost:3000";

  return (
    <>
      <PageHeader
        title="SDK and events"
        description="Keys, the event registry, and the inspector that tells you why an event was refused."
        action={<Link href="/analytics/events"><Button variant="secondary" size="sm">Open inspector</Button></Link>}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Accepted (24h)" value={num(health.accepted)} definition="Events stored in the last 24 hours." />
        <Metric label="Rejected (24h)" value={num(health.rejected)}
          definition="Events refused. These never appear in any metric."
          tone={health.rejected > 0 ? "bad" : undefined} />
        <Metric label="Registered events" value={num(specs.length)}
          definition="Event schemas in the registry for this project."
          caveat={undeclared.length > 0 ? `${undeclared.length} event name(s) are arriving with no schema.` : null} />
      </div>

      {!keys.ok ? (
        <Card className="mt-5">
          <CardBody><p className="text-xs text-rose-500">{keys.error.message}</p></CardBody>
        </Card>
      ) : (
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            <Card>
              <CardHeader
                title="Keys"
                subtitle="A public write key is not a secret: it ships in your bundle and may only append events to this project."
              />
              <CardBody>
                <Table>
                  <thead>
                    <tr><Th>Name</Th><Th>Kind</Th><Th>Value</Th><Th align="right">Last used</Th><Th /></tr>
                  </thead>
                  <tbody>
                    {keys.value.map((k) => (
                      <tr key={k.id}>
                        <Td>{k.name}</Td>
                        <Td>
                          <Badge tone={k.kind === "public_write" ? "info" : "warn"}>
                            {k.kind === "public_write" ? "public write" : "secret admin"}
                          </Badge>
                        </Td>
                        <Td>
                          <code className="break-all font-mono text-[11px] text-slate-400">
                            {k.public_key ?? k.secret_preview ?? "—"}
                          </code>
                        </Td>
                        <Td align="right">{when(k.created_at)}</Td>
                        <Td align="right">
                          {k.revoked_at ? <Badge tone="neutral">revoked</Badge> : null}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="mt-4">
                  <Caveats items={[
                    "A secret key is shown once when created and stored only as a hash. RetainOS cannot show it to you again.",
                    "Never put a secret key in frontend code. It can read your project's data; a public write key cannot.",
                  ]} />
                </div>
              </CardBody>
            </Card>

            {publicKey ? (
              <Card>
                <CardHeader title="Install" subtitle="Copy this into your application." />
                <CardBody className="space-y-4">
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-slate-400">1. Install</p>
                    <pre className="overflow-x-auto rounded-lg border border-navy-700/70 bg-navy-950 px-3.5 py-2.5 text-[11px] font-mono text-slate-300">
{`pnpm add @retainos/sdk`}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-slate-400">2. Initialise and track</p>
                    <pre className="overflow-x-auto rounded-lg border border-navy-700/70 bg-navy-950 px-3.5 py-2.5 text-[11px] leading-relaxed font-mono text-slate-300">
{`import { RetainOS } from "@retainos/sdk";

export const retain = RetainOS.init({
  projectKey: "${publicKey}",
  endpoint: "${endpoint}",
  autoCapture: false,
});

// Nothing leaves the device until consent is granted.
retain.grantConsent();

retain.track("signup_completed");
retain.identify("USER_123");
retain.track("core_action_completed", { feature: "first_project" });

// On logout:
retain.reset();`}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-slate-400">3. Or post directly</p>
                    <pre className="overflow-x-auto rounded-lg border border-navy-700/70 bg-navy-950 px-3.5 py-2.5 text-[11px] leading-relaxed font-mono text-slate-300">
{`curl -X POST ${endpoint}/api/v1/ingest \\
  -H "content-type: application/json" \\
  -H "x-retainos-key: ${publicKey}" \\
  -d '{"events":[{"name":"signup_completed","userId":"USER_123","consent":true}]}'`}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-slate-400">4. Feedback widget (optional)</p>
                    <pre className="overflow-x-auto rounded-lg border border-navy-700/70 bg-navy-950 px-3.5 py-2.5 text-[11px] font-mono text-slate-300">
{`<script src="${endpoint}/widget?key=${publicKey}" async></script>`}
                    </pre>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                      The widget collects only what the person types, plus the page path. It does not read the
                      page, your form fields or keystrokes.
                    </p>
                  </div>
                </CardBody>
              </Card>
            ) : null}

            <Card>
              <CardHeader
                title="Event registry"
                subtitle="Declared events get their properties validated. Undeclared ones are accepted but unchecked."
              />
              <CardBody>
                {specs.length === 0 ? (
                  <p className="text-xs text-slate-400">No events registered yet.</p>
                ) : (
                  <Table>
                    <thead>
                      <tr><Th>Event</Th><Th align="right">Version</Th><Th>Properties</Th><Th /></tr>
                    </thead>
                    <tbody>
                      {specs.map((s) => (
                        <tr key={s.name}>
                          <Td>
                            <code className="font-mono text-[12px] text-slate-300">{s.name}</code>
                            {s.description ? (
                              <div className="mt-0.5 text-[11px] text-slate-500">{s.description}</div>
                            ) : null}
                          </Td>
                          <Td align="right">{s.version}</Td>
                          <Td>
                            {s.properties.length === 0 ? (
                              <span className="text-[11px] text-slate-500">none declared</span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {s.properties.map((p) => (
                                  <Badge key={p.name} tone={p.required ? "info" : "neutral"}>
                                    {p.name}:{p.type}{p.required ? "*" : ""}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </Td>
                          <Td align="right">
                            {s.deprecated ? <Badge tone="warn">deprecated</Badge> : null}
                            {s.allowUnknownProperties === false ? <Badge tone="neutral">closed</Badge> : null}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}

                {undeclared.length > 0 ? (
                  <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
                    <p className="text-xs font-medium text-amber-500">Arriving without a schema</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {undeclared.map((u) => (
                        <Badge key={u.name} tone="warn">{u.name} · {num(u.event_count)}</Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          </div>

          <div>
            <SdkTools
              keys={keys.value.map((k) => ({ id: k.id, name: k.name, kind: k.kind, revoked: Boolean(k.revoked_at) }))}
              knownEvents={[...specs.map((s) => s.name), ...undeclared.map((u) => u.name)]}
            />
          </div>
        </div>
      )}
    </>
  );
}

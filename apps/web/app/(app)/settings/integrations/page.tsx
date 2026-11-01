import type { Metadata } from "next";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { billingConnections, entitlementFor } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Badge, Caveats, Table, Th, Td } from "@/components/ui";
import { relative, titleCase } from "@/lib/format";
import { IntegrationForm } from "./form";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function Integrations() {
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();
  const entitlement = entitlementFor(handle, ctx.org.id);
  const connections = billingConnections(handle, ctx.projectScope) as Array<Record<string, unknown>>;
  const endpoint = process.env.RETAINOS_PUBLIC_URL ?? "http://localhost:3000";

  const configured = {
    github: Boolean(process.env.RETAINOS_GITHUB_TOKEN),
    razorpay: Boolean(process.env.RETAINOS_RAZORPAY_WEBHOOK_SECRET),
    stripe: Boolean(process.env.RETAINOS_STRIPE_WEBHOOK_SECRET),
    llm: (process.env.RETAINOS_LLM_PROVIDER ?? "none") !== "none",
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        description="All optional. RetainOS is fully functional with none of them connected."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="GitHub" subtitle="Turn an approved improvement into a real issue." />
            <CardBody>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={configured.github ? "good" : "neutral"}>
                  {configured.github ? "Token configured" : "No token configured"}
                </Badge>
                <Badge tone={entitlement.features.githubIntegration ? "info" : "warn"}>
                  {entitlement.features.githubIntegration ? "included on your plan" : `not on the ${entitlement.planId} plan`}
                </Badge>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-400">
                Set <code className="rounded bg-navy-800 px-1 py-0.5 font-mono text-[11px]">RETAINOS_GITHUB_TOKEN</code>{" "}
                on the server to a fine-grained token with <strong>Issues: write</strong> on the target repository
                only. The token is read at dispatch time and never reaches the browser.
              </p>
              <div className="mt-3">
                <Caveats tone="info" items={[
                  "No issue is created without an explicit approval in the improvement's own page.",
                  "RetainOS never pushes code, opens a pull request or modifies repository contents. There is no code path that can.",
                  "A task that already has an issue in a repository cannot get a second one.",
                ]} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Billing providers"
              subtitle="Revenue figures come from signed provider events, never from guesses about product usage."
            />
            <CardBody>
              <Table>
                <thead><tr><Th>Provider</Th><Th>Secret</Th><Th>Status</Th><Th align="right">Last event</Th></tr></thead>
                <tbody>
                  {(["razorpay", "stripe", "simulator"] as const).map((p) => {
                    const conn = connections.find((c) => c.provider === p);
                    return (
                      <tr key={p}>
                        <Td>{titleCase(p)}</Td>
                        <Td>
                          {p === "simulator" ? (
                            <Badge tone="neutral">not required</Badge>
                          ) : (
                            <Badge tone={configured[p] ? "good" : "warn"}>
                              {configured[p] ? "configured" : "missing"}
                            </Badge>
                          )}
                        </Td>
                        <Td>
                          <Badge tone={conn?.status === "connected" ? "good" : conn?.status === "error" ? "bad" : "neutral"}>
                            {conn ? String(conn.status) : "not set up"}
                          </Badge>
                        </Td>
                        <Td align="right">
                          {conn?.last_event_at ? relative(Number(conn.last_event_at), now) : "—"}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>

              <div className="mt-4">
                <p className="mb-1.5 text-xs font-medium text-slate-400">Webhook URL</p>
                <pre className="overflow-x-auto rounded-lg border border-navy-700/70 bg-navy-950 px-3.5 py-2.5 text-[11px] font-mono text-slate-300">
{`${endpoint}/api/v1/webhooks/razorpay?project=${ctx.project.id}`}
                </pre>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  Point your provider here and set the matching secret on the server. The signature is verified
                  before anything is applied, and repeat delivery is idempotent on the provider&apos;s own event id.
                </p>
              </div>

              <div className="mt-4">
                <Caveats items={[
                  "A connection shows as connected only once a verified event has actually arrived, so the status reflects reality rather than intent.",
                  "The signature verification follows each provider's documented scheme but has not been exercised against live provider traffic. See FEATURE_STATUS.md.",
                  "The simulator is refused outright in production, so an unsigned webhook endpoint cannot exist on a live deployment.",
                ]} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Language model adapter" subtitle="Optional. RetainAI is fully functional without it." />
            <CardBody>
              <Badge tone={configured.llm ? "info" : "neutral"}>
                {configured.llm ? `provider: ${process.env.RETAINOS_LLM_PROVIDER}` : "none configured"}
              </Badge>
              <p className="mt-3 text-xs leading-relaxed text-slate-400">
                RetainAI&apos;s analysis is a deterministic rule engine and runs with no API key and no per-query
                cost. An adapter can rephrase a finding more fluently; it never computes a metric and never
                invents a finding.
              </p>
              <div className="mt-3">
                <Caveats tone="info" items={[
                  "Where a finding's text is template-generated, the record says so. RetainOS will not imply a model wrote text it did not.",
                  "Feedback text is untrusted input. It is never passed to a model as an instruction.",
                ]} />
              </div>
            </CardBody>
          </Card>
        </div>

        <div>
          <IntegrationForm />
        </div>
      </div>
    </>
  );
}

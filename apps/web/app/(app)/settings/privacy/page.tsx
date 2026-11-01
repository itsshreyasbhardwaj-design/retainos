import type { Metadata } from "next";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { PageHeader, Card, CardHeader, CardBody, Badge, Caveats, Table, Th, Td, Metric } from "@/components/ui";
import { num, when, relative } from "@/lib/format";
import { PrivacyTools } from "./tools";

export const metadata: Metadata = { title: "Privacy" };
export const dynamic = "force-dynamic";

export default async function Privacy() {
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();

  const project = handle.get<{ raw_retention_days: number; require_consent: number }>(
    "SELECT raw_retention_days, require_consent FROM projects WHERE id = ?", [ctx.project.id],
  )!;
  const identities = handle.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identities WHERE project_id = ? AND deleted_at IS NULL", [ctx.project.id],
  )?.n ?? 0;
  const identified = handle.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identities WHERE project_id = ? AND external_id IS NOT NULL", [ctx.project.id],
  )?.n ?? 0;
  const events = handle.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ?", [ctx.project.id],
  )?.n ?? 0;
  const oldest = handle.get<{ t: number }>(
    "SELECT MIN(occurred_at) AS t FROM analytics_events WHERE project_id = ?", [ctx.project.id],
  )?.t;
  const requests = handle.all<Record<string, unknown>>(
    "SELECT * FROM data_deletion_requests WHERE project_id = ? ORDER BY requested_at DESC LIMIT 15",
    [ctx.project.id],
  );
  const scrubbed = handle.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM event_rejections WHERE project_id = ? AND reason = 'sensitive_properties_removed'",
    [ctx.project.id],
  )?.n ?? 0;

  return (
    <>
      <PageHeader
        title="Privacy"
        description="What this project holds, and the tools to honour a user's rights over it."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Identities" value={num(identities)}
          definition="Distinct people RetainOS has seen in this project, identified or anonymous." />
        <Metric label="Identified" value={num(identified)}
          definition="Identities linked to one of your own pseudonymous user ids by an explicit identify() call." />
        <Metric label="Stored events" value={num(events)}
          definition={oldest ? `Oldest event ${when(oldest)}. Retention is ${project.raw_retention_days} days.` : "No events stored."} />
        <Metric label="Properties stripped" value={num(scrubbed)}
          definition="Times a property matched the sensitive denylist and was removed before storage."
          tone={scrubbed > 0 ? "bad" : undefined}
          caveat={scrubbed > 0 ? "Something in your instrumentation is sending sensitive values. Fix it at the source." : null} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="What this project collects" />
            <CardBody>
              <dl className="space-y-3 text-xs leading-relaxed">
                {[
                  ["Collected", "Event name, client timestamp, server receipt time, an identifier, and the properties your code passes. Plus a coarse device category and a two-letter country code when your edge supplies one."],
                  ["Never collected", "Passwords, tokens, session ids, cookies, card numbers, CVVs, bank and routing numbers, Aadhaar, PAN, passport numbers, private keys, seed phrases, one-time codes, health fields, dates of birth and precise coordinates. Dropped by the SDK and again by the server."],
                  ["Never implemented", "Session recording, keystroke capture, form-field capture and device fingerprinting. Not disabled — absent. There is no setting that turns them on."],
                  ["Raw user agent", "Never stored. Only the coarse category derived from it."],
                  ["Consent", project.require_consent === 1
                    ? "Required. An event without an explicit consent flag is rejected."
                    : "Not required for this project. Events are accepted without a consent flag."],
                ].map(([term, def]) => (
                  <div key={term}>
                    <dt className="font-medium text-slate-300">{term}</dt>
                    <dd className="mt-0.5 text-slate-400">{def}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Deletion requests" subtitle="Append-only record of every erasure, with what it removed." />
            <CardBody>
              {requests.length === 0 ? (
                <p className="text-xs text-slate-400">No deletion requests recorded.</p>
              ) : (
                <Table>
                  <thead><tr><Th>Subject</Th><Th>Status</Th><Th>Removed</Th><Th align="right">When</Th></tr></thead>
                  <tbody>
                    {requests.map((r) => {
                      let report: Record<string, number> = {};
                      try { report = JSON.parse(String(r.report ?? "{}")); } catch { report = {}; }
                      return (
                        <tr key={String(r.id)}>
                          <Td>
                            <span className="font-mono text-[11px] text-slate-400">{String(r.subject_value)}</span>
                            <div className="text-[10px] text-slate-500">{String(r.subject_kind).replace(/_/g, " ")}</div>
                          </Td>
                          <Td><Badge tone={r.status === "completed" ? "good" : r.status === "failed" ? "bad" : "warn"}>
                            {String(r.status)}
                          </Badge></Td>
                          <Td>
                            <span className="text-[11px] text-slate-400">
                              {report.identitiesDeleted ?? 0} identities, {report.eventsDeleted ?? 0} events,{" "}
                              {report.feedbackAnonymised ?? 0} feedback anonymised
                            </span>
                          </Td>
                          <Td align="right">{relative(Number(r.requested_at), now)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Children and sensitive services" />
            <CardBody>
              <p className="text-xs leading-relaxed text-slate-400">
                India&apos;s Digital Personal Data Protection Act places specific obligations on processing
                children&apos;s data, including verifiable parental consent and a prohibition on behavioural
                monitoring and targeted advertising directed at children.
              </p>
              <p className="mt-3 text-xs leading-relaxed text-slate-400">
                RetainOS has no behavioural profiling and no advertising features for any audience. It also does
                not implement a parental consent mechanism. If your application serves children, disable
                behavioural tracking for those users and take your own legal advice — this is not something
                RetainOS can do on your behalf, and it will not claim otherwise.
              </p>
              <div className="mt-3">
                <Caveats items={[
                  "Do not instrument flows handling health or financial detail so that those values become event properties. The denylist is a safety net, not a substitute for not sending the data.",
                ]} />
              </div>
            </CardBody>
          </Card>
        </div>

        <div>
          <PrivacyTools projectId={ctx.project.id} canErase={["owner", "admin"].includes(ctx.org.role)} />
        </div>
      </div>
    </>
  );
}

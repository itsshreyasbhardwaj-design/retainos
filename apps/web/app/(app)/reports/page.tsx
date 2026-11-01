import type { Metadata } from "next";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { weeklyBrief, briefToMarkdown } from "@retainos/analytics";
import { jsonParse } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Metric, Badge, Empty, Caveats, Button, Table, Th, Td } from "@/components/ui";
import { pct, num, money, when, relative, deltaPoints, titleCase } from "@/lib/format";
import { ReportTools } from "./tools";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

export default async function Reports() {
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();

  const brief = weeklyBrief(handle, ctx.project.id, { timezone: ctx.projectScope.timezone, now });
  const markdown = briefToMarkdown(brief, ctx.project.name);
  const saved = handle.all<{ id: string; kind: string; created_at: number; period_start: number; period_end: number }>(
    "SELECT id, kind, created_at, period_start, period_end FROM reports WHERE project_id = ? ORDER BY created_at DESC LIMIT 10",
    [ctx.project.id],
  );

  return (
    <>
      <PageHeader
        title="Reports"
        description="The weekly brief, computed live. Figures it cannot compute are listed as gaps rather than filled in."
      />

      <ReportTools markdown={markdown} projectName={ctx.project.name} />

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Weekly active users" value={num(brief.activity.activeUsers)}
          definition="Distinct identities with an accepted event in the last 7 days." />
        <Metric label="New users" value={num(brief.activity.newUsers)}
          definition="Identities whose first-ever event fell in this week." />
        <Metric
          label="Activation rate"
          value={pct(brief.activation?.rate ?? null)}
          definition={brief.activation ? "Signups this week who reached your activation event inside its window." : "No activation definition configured."}
          delta={brief.activation ? deltaPoints(brief.activation.rate, brief.activation.priorRate) : undefined}
        />
        <Metric
          label="Day-7 retention"
          value={pct(brief.retention?.day7 ?? null)}
          definition={brief.retention?.day7 !== null && brief.retention ? `Across ${num(brief.retention.usersCounted)} users in complete cohorts.` : "No cohort has a complete day-7 window yet."}
          delta={brief.retention ? deltaPoints(brief.retention.day7, brief.retention.priorDay7) : undefined}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="This week's findings" />
          <CardBody>
            {brief.newInsights.length === 0 ? (
              <p className="text-xs text-slate-400">No new findings this week.</p>
            ) : (
              <ul className="space-y-2">
                {brief.newInsights.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <Badge tone={
                      i.confidence === "strong_supporting_evidence" ? "good"
                      : i.confidence === "moderate_supporting_evidence" ? "info"
                      : i.confidence === "preliminary_observation" ? "warn" : "neutral"
                    }>
                      {titleCase(i.confidence)}
                    </Badge>
                    <span className="text-slate-300">{i.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Shipped and measured" />
          <CardBody>
            {brief.releasedImprovements.length === 0 && brief.experiments.length === 0 ? (
              <p className="text-xs text-slate-400">Nothing shipped or measured this week.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {brief.releasedImprovements.map((r) => (
                  <li key={r.id} className="text-slate-300">
                    {r.title}{r.version ? <span className="ml-1.5 text-slate-500">{r.version}</span> : null}
                  </li>
                ))}
                {brief.experiments.map((e) => (
                  <li key={e.key} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-slate-300">{e.name}</span>
                    <Badge tone={e.verdict === "improvement_supported" ? "good" : e.verdict ? "neutral" : "warn"}>
                      {e.verdict ? titleCase(e.verdict) : "no result yet"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {brief.revenue.length > 0 ? (
        <Card className="mt-5">
          <CardHeader title="Revenue" />
          <CardBody>
            <Table>
              <thead><tr><Th>Currency</Th><Th align="right">MRR</Th><Th align="right">NRR</Th><Th align="right">Churned</Th></tr></thead>
              <tbody>
                {brief.revenue.map((r) => (
                  <tr key={r.currency}>
                    <Td>{r.currency}</Td>
                    <Td align="right">{money(r.mrrMinor, r.currency)}</Td>
                    <Td align="right">{pct(r.netRevenueRetention)}</Td>
                    <Td align="right">{money(r.churnMinor, r.currency)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {brief.revenue.flatMap((r) => r.caveats).length > 0 ? (
              <div className="mt-4"><Caveats items={[...new Set(brief.revenue.flatMap((r) => r.caveats))]} /></div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card className="mt-5">
        <CardHeader title="Suggested next investigations" subtitle="Questions to look into, not actions to take." />
        <CardBody>
          <ul className="space-y-2">
            {brief.recommendedInvestigations.map((r, i) => (
              <li key={i} className="flex gap-2.5 text-xs leading-relaxed text-slate-400">
                <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-cyan-400/60" />
                {r}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {brief.gaps.length > 0 ? (
        <Card className="mt-5">
          <CardHeader
            title="What this report could not compute"
            subtitle="Listed rather than filled in with a plausible substitute."
          />
          <CardBody><Caveats items={brief.gaps} /></CardBody>
        </Card>
      ) : null}

      {saved.length > 0 ? (
        <Card className="mt-5">
          <CardHeader title="Saved reports" />
          <CardBody>
            <Table>
              <thead><tr><Th>Kind</Th><Th>Period</Th><Th align="right">Generated</Th></tr></thead>
              <tbody>
                {saved.map((r) => (
                  <tr key={r.id}>
                    <Td>{titleCase(r.kind)}</Td>
                    <Td>{when(r.period_start)} to {when(r.period_end)}</Td>
                    <Td align="right">{relative(r.created_at, now)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { runInstrumentationDoctor, listFindings } from "@retainos/analytics";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Empty, Button, Caveats, Metric,
} from "@/components/ui";
import { num, relative } from "@/lib/format";
import { RunDoctorButton } from "./forms";

export const metadata: Metadata = { title: "Instrumentation doctor" };
export const dynamic = "force-dynamic";

const SEVERITY_TONE = { blocking: "bad", warning: "warn", advisory: "neutral" } as const;

export default async function Instrumentation() {
  const ctx = await requireProject();
  const handle = db();

  // Deliberately available on every plan, free included: unreliable data makes
  // every other part of the product worse, including for people who never pay.
  const report = runInstrumentationDoctor(handle, ctx.project.id, {
    timezone: ctx.project.timezone,
  });
  const stored = listFindings(handle, ctx.project.id, true) as Array<Record<string, any>>;
  const resolved = stored.filter((f) => f.resolved_at !== null);

  const counts = {
    blocking: report.findings.filter((f) => f.severity === "blocking").length,
    warning: report.findings.filter((f) => f.severity === "warning").length,
    advisory: report.findings.filter((f) => f.severity === "advisory").length,
  };

  return (
    <>
      <PageHeader
        title="Instrumentation doctor"
        description="Bad instrumentation does not fail, it answers. A missing activation event produces a confident activation rate of zero; a duplicated event name halves a funnel. These checks find the failures that look like findings."
        action={<RunDoctorButton />}
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-4">
        <Metric
          label="Blocking"
          value={num(counts.blocking)}
          definition="Some metric on this project is currently wrong, not merely incomplete."
          tone={counts.blocking > 0 ? "bad" : "good"}
        />
        <Metric
          label="Warnings"
          value={num(counts.warning)}
          definition="A metric is less reliable than it appears."
        />
        <Metric
          label="Advisory"
          value={num(counts.advisory)}
          definition="Worth knowing. Does not affect the accuracy of any number."
        />
        <Metric
          label="Checks run"
          value={num(report.checksRun)}
          definition="Every check runs on every project, on every plan, including free."
        />
      </div>

      <div className="mb-5">
        <Caveats items={[report.summary]} tone={report.healthy ? "info" : "warn"} />
      </div>

      {report.findings.length === 0 ? (
        <Empty
          title="Everything passed"
          body={`All ${report.checksRun} checks passed over the last two weeks. Nothing below is undermined by the data itself.`}
        />
      ) : (
        <div className="space-y-4">
          {report.findings.map((f) => (
            <Card key={f.checkId}>
              <CardHeader
                title={f.title}
                action={<Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>}
              />
              <CardBody>
                <dl className="space-y-3">
                  {([
                    ["What is wrong", f.detail],
                    ["Why it affects your numbers", f.whyItMatters],
                    ["Suggested fix", f.suggestedFix],
                    ["How to verify the fix", f.howToVerify],
                  ] as const).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                        {label}
                      </dt>
                      <dd className="text-xs leading-relaxed text-slate-300">{value}</dd>
                    </div>
                  ))}
                  {Object.keys(f.evidence).length > 0 ? (
                    <div>
                      <dt className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                        Supporting evidence
                      </dt>
                      <dd className="mt-1">
                        <pre className="overflow-x-auto rounded-lg border border-navy-700/60 bg-navy-950/60 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
{JSON.stringify(f.evidence, null, 2)}
                        </pre>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {resolved.length > 0 ? (
        <Card className="mt-5">
          <CardHeader
            title="Resolved"
            subtitle="Findings that stopped firing. They clear themselves, so the list above stays a to-do rather than an archive."
          />
          <CardBody>
            <ul className="space-y-1.5">
              {resolved.slice(0, 20).map((f) => (
                <li key={String(f.id)} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-400">{String(f.title)}</span>
                  <span className="text-slate-600">resolved {relative(f.resolved_at)}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <div className="mt-5">
        <Caveats
          items={[
            "This page is on every plan, free included. Reliable data makes every other part of RetainOS " +
            "work, so putting it behind a paywall would make the product worse for everyone.",
          ]}
          tone="info"
        />
      </div>
    </>
  );
}

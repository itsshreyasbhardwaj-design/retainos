import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { listReleases, listImprovements, changelog } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Badge, Empty, Button, Table, Th, Td, Caveats } from "@/components/ui";
import { num, when, titleCase } from "@/lib/format";
import { ReleaseForms } from "./forms";

export const metadata: Metadata = { title: "Releases" };
export const dynamic = "force-dynamic";

export default async function Releases() {
  const ctx = await requireProject();
  const handle = db();
  const releases = listReleases(handle, ctx.projectScope, 50) as Array<Record<string, unknown>>;
  const shippable = listImprovements(handle, ctx.projectScope, {
    status: ["in_review", "approved", "in_development"], limit: 50,
  }) as Array<Record<string, unknown>>;
  const entries = changelog(handle, ctx.project.id, false, 50) as Array<Record<string, unknown>>;

  return (
    <>
      <PageHeader
        title="Releases"
        description="Recording a release is what lets ImpactLab line a metric up against a change."
        action={<Link href="/changelog"><Button variant="secondary" size="sm">Public changelog</Button></Link>}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {releases.length === 0 ? (
            <Empty
              title="No releases recorded"
              body="Record each release with its version and date, and link the improvements it carried. Everything downstream depends on knowing when things changed."
            />
          ) : (
            <Card>
              <CardHeader title="Recorded releases" />
              <CardBody>
                <Table>
                  <thead>
                    <tr><Th>Version</Th><Th>Name</Th><Th align="right">Improvements</Th><Th align="right">Shipped</Th></tr>
                  </thead>
                  <tbody>
                    {releases.map((r) => (
                      <tr key={String(r.id)}>
                        <Td><code className="font-mono text-[12px] text-slate-300">{String(r.version)}</code></Td>
                        <Td>{String(r.name)}</Td>
                        <Td align="right">{num(Number(r.improvement_count))}</Td>
                        <Td align="right">{when(Number(r.released_at))}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          )}

          {entries.length > 0 ? (
            <Card>
              <CardHeader title="Changelog entries" subtitle="Public entries appear on your customer-facing changelog." />
              <CardBody>
                <ul className="space-y-2.5">
                  {entries.map((e) => (
                    <li key={String(e.id)} className="flex flex-wrap items-baseline gap-2 text-xs">
                      <Badge tone={
                        e.category === "bug_fix" ? "bad"
                        : e.category === "new_feature" ? "good"
                        : e.category === "known_limitation" ? "warn" : "info"
                      }>
                        {titleCase(String(e.category))}
                      </Badge>
                      <span className="text-slate-300">{String(e.title)}</span>
                      {e.version ? <code className="font-mono text-[10px] text-slate-500">{String(e.version)}</code> : null}
                      {e.is_public === 1 ? <Badge tone="neutral">public</Badge> : <Badge tone="neutral">internal</Badge>}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <Caveats tone="info" items={[
            "A release record is a date and a list of what shipped. It is not evidence that anything improved.",
            "Recording more than one release inside a measurement window is detected as a confounder in ImpactLab.",
          ]} />
        </div>

        <div>
          <ReleaseForms
            improvements={shippable.map((i) => ({ id: String(i.id), label: String(i.title) }))}
            releases={releases.map((r) => ({ id: String(r.id), label: `${String(r.version)} — ${String(r.name)}` }))}
          />
        </div>
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { listFeedback } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Badge, Empty, Caveats } from "@/components/ui";
import { num, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Roadmap" };
export const dynamic = "force-dynamic";

const COLUMNS = [
  { status: "under_review", label: "Under review", tone: "neutral" as const },
  { status: "planned", label: "Planned", tone: "info" as const },
  { status: "in_progress", label: "In progress", tone: "accent" as const },
  { status: "released", label: "Released", tone: "good" as const },
];

export default async function Roadmap() {
  const ctx = await requireProject();
  const handle = db();

  const byColumn = COLUMNS.map((c) => ({
    ...c,
    items: listFeedback(handle, ctx.projectScope, { status: [c.status as never], limit: 25 }) as Array<Record<string, unknown>>,
  }));
  const total = byColumn.reduce((s, c) => s + c.items.length, 0);

  return (
    <>
      <PageHeader
        title="Roadmap"
        description="Built from feedback status, so it cannot drift out of step with the inbox."
      />

      {total === 0 ? (
        <Empty
          title="Nothing on the roadmap"
          body="Move feedback into Under review, Planned, In progress or Released and it appears here automatically."
        />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-4">
            {byColumn.map((col) => (
              <Card key={col.status}>
                <CardHeader title={<span className="flex items-center gap-2">{col.label}<Badge tone={col.tone}>{num(col.items.length)}</Badge></span>} />
                <CardBody>
                  {col.items.length === 0 ? (
                    <p className="text-[11px] text-slate-500">Nothing here.</p>
                  ) : (
                    <ul className="space-y-2.5">
                      {col.items.map((i) => (
                        <li key={String(i.id)} className="rounded-lg border border-navy-700/60 bg-navy-950/40 p-2.5">
                          <p className="text-xs leading-snug text-slate-300">{String(i.title)}</p>
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <Badge tone="neutral">{titleCase(String(i.kind))}</Badge>
                            {Number(i.vote_count) > 0 ? <span className="text-[10px] text-slate-500">{Number(i.vote_count)} votes</span> : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>

          <div className="mt-5">
            <Caveats tone="info" items={[
              "This roadmap reflects status, not commitment. Nothing here is a promise of a delivery date.",
              "Items marked Released describe work that shipped, not work verified to have helped. ImpactLab is where that question gets answered.",
            ]} />
          </div>
        </>
      )}
    </>
  );
}

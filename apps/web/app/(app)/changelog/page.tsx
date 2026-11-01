import type { Metadata } from "next";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { changelog } from "@retainos/database";
import { PageHeader, Card, CardBody, Badge, Empty, Caveats } from "@/components/ui";
import { when, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Changelog" };
export const dynamic = "force-dynamic";

const TONES = {
  new_feature: "good", improvement: "info", bug_fix: "bad",
  performance: "accent", known_limitation: "warn",
} as const;

export default async function Changelog() {
  const ctx = await requireProject();
  const entries = changelog(db(), ctx.project.id, true, 100) as Array<Record<string, unknown>>;

  const byVersion = new Map<string, Array<Record<string, unknown>>>();
  for (const e of entries) {
    const key = e.version ? String(e.version) : "Unversioned";
    const list = byVersion.get(key) ?? [];
    list.push(e);
    byVersion.set(key, list);
  }

  return (
    <>
      <PageHeader
        title="Changelog"
        description="What your customers would see. Only entries marked public appear here."
      />

      {entries.length === 0 ? (
        <Empty
          title="No public entries"
          body="Add changelog entries from the Releases page and mark them public. Known limitations belong here as much as new features do."
        />
      ) : (
        <>
          <div className="space-y-5">
            {[...byVersion.entries()].map(([version, items]) => (
              <Card key={version}>
                <CardBody>
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-sm font-semibold text-offwhite">{version}</h2>
                    {items[0]?.released_at ? (
                      <span className="text-[11px] text-slate-500">{when(Number(items[0].released_at))}</span>
                    ) : null}
                  </div>
                  <ul className="space-y-3">
                    {items.map((e) => (
                      <li key={String(e.id)}>
                        <div className="flex flex-wrap items-baseline gap-2">
                          <Badge tone={TONES[String(e.category) as keyof typeof TONES] ?? "neutral"}>
                            {titleCase(String(e.category))}
                          </Badge>
                          <span className="text-sm text-slate-300">{String(e.title)}</span>
                        </div>
                        {String(e.body) ? (
                          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">{String(e.body)}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ))}
          </div>

          <div className="mt-5">
            <Caveats tone="info" items={[
              "RetainOS does not send release announcements. Notifying customers needs a delivery provider you " +
              "configure and consent you have collected, neither of which it assumes on your behalf.",
            ]} />
          </div>
        </>
      )}
    </>
  );
}

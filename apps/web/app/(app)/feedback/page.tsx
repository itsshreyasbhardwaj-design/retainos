import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { listFeedback, countFeedbackByStatus, FEEDBACK_STATUSES, FEEDBACK_KINDS } from "@retainos/database";
import { listClusters, duplicateCandidates } from "@retainos/analytics";
import { PageHeader, Card, CardHeader, CardBody, Badge, Empty, Caveats, Button, Table, Th, Td } from "@/components/ui";
import { num, relative, titleCase } from "@/lib/format";
import { FeedbackTools, StatusControl } from "./tools";

export const metadata: Metadata = { title: "Feedback inbox" };
export const dynamic = "force-dynamic";

export default async function Feedback({
  searchParams,
}: { searchParams: Promise<{ status?: string; kind?: string; q?: string; id?: string }> }) {
  const params = await searchParams;
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();

  const counts = countFeedbackByStatus(handle, ctx.projectScope);
  const items = listFeedback(handle, ctx.projectScope, {
    status: params.status ? [params.status as never] : undefined,
    kind: params.kind ? [params.kind as never] : undefined,
    search: params.q || undefined,
    limit: 60,
  }) as Array<Record<string, unknown>>;
  const clusters = listClusters(handle, ctx.project.id) as Array<Record<string, unknown>>;

  const selected = params.id ? items.find((i) => String(i.id) === params.id) ?? null : null;
  const duplicates = selected ? duplicateCandidates(handle, ctx.project.id, String(selected.id)) : [];
  const total = Object.values(counts).reduce((s, n) => s + n, 0);

  return (
    <>
      <PageHeader
        title="Feedback inbox"
        description="What customers actually told you, grouped by shared terms where that helps."
        action={<Link href="/feedback/roadmap"><Button variant="secondary" size="sm">Public roadmap</Button></Link>}
      />

      {total === 0 ? (
        <>
          <Empty
            title="No feedback yet"
            body={
              "Install the feedback widget so customers can report problems from inside your product, or record " +
              "something you heard elsewhere. Absence of feedback is not evidence that users are satisfied — most " +
              "never write in."
            }
            action={<Link href="/settings/sdk"><Button>Get the widget snippet</Button></Link>}
          />
          <div className="mt-5 max-w-lg"><FeedbackTools kinds={FEEDBACK_KINDS} selected={null} duplicates={[]} /></div>
        </>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <Link href="/feedback"><Button variant={params.status ? "ghost" : "secondary"} size="sm">All {total}</Button></Link>
            {FEEDBACK_STATUSES.filter((s) => counts[s]! > 0).map((s) => (
              <Link key={s} href={`/feedback?status=${s}`}>
                <Button variant={params.status === s ? "primary" : "ghost"} size="sm">
                  {titleCase(s)} {counts[s]}
                </Button>
              </Link>
            ))}
          </div>

          <form method="get" className="mb-5 flex flex-wrap gap-2">
            {params.status ? <input type="hidden" name="status" value={params.status} /> : null}
            <input
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search titles and descriptions"
              className="min-w-0 flex-1 rounded-lg border border-navy-600 bg-navy-950/60 px-3 py-1.5 text-xs text-offwhite placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
            <select
              name="kind"
              defaultValue={params.kind ?? ""}
              className="rounded-lg border border-navy-600 bg-navy-950/60 px-2.5 py-1.5 text-xs text-offwhite focus:border-blue-500 focus:outline-none"
            >
              <option value="">Any type</option>
              {FEEDBACK_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <Button type="submit" variant="secondary" size="sm">Search</Button>
          </form>

          <div className="grid gap-5 lg:grid-cols-3">
            <div className="space-y-3 lg:col-span-2">
              {items.length === 0 ? (
                <Card><CardBody><p className="text-xs text-slate-400">Nothing matches that filter.</p></CardBody></Card>
              ) : (
                items.map((f) => (
                  <Card key={String(f.id)}>
                    <CardBody>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Link
                            href={`/feedback?id=${String(f.id)}${params.status ? `&status=${params.status}` : ""}`}
                            className="text-sm font-medium text-offwhite hover:text-blue-400"
                          >
                            {String(f.title)}
                          </Link>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <Badge tone={f.kind === "bug" ? "bad" : f.kind === "feature_request" ? "info" : "neutral"}>
                              {titleCase(String(f.kind))}
                            </Badge>
                            <Badge>{titleCase(String(f.status))}</Badge>
                            <Badge tone="neutral">via {String(f.source)}</Badge>
                            {Number(f.vote_count) > 0 ? <Badge tone="accent">{Number(f.vote_count)} votes</Badge> : null}
                            {f.consent_to_contact === 1 ? <Badge tone="good">contactable</Badge> : null}
                            <span className="text-[11px] text-slate-500">{relative(Number(f.created_at), now)}</span>
                          </div>
                        </div>
                        <StatusControl feedbackId={String(f.id)} status={String(f.status)} />
                      </div>
                      {String(f.body) ? (
                        <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">{String(f.body)}</p>
                      ) : null}
                      {f.page_identifier || f.product_version ? (
                        <p className="mt-2 font-mono text-[10px] text-slate-500">
                          {f.page_identifier ? `path ${String(f.page_identifier)}` : ""}
                          {f.page_identifier && f.product_version ? " · " : ""}
                          {f.product_version ? `version ${String(f.product_version)}` : ""}
                        </p>
                      ) : null}
                    </CardBody>
                  </Card>
                ))
              )}
            </div>

            <div className="space-y-5">
              {clusters.length > 0 ? (
                <Card>
                  <CardHeader
                    title="Themes"
                    subtitle="Grouped by shared terms, not by meaning. Correct them where they are wrong."
                  />
                  <CardBody>
                    <Table>
                      <thead><tr><Th>Theme</Th><Th align="right">Items</Th></tr></thead>
                      <tbody>
                        {clusters.slice(0, 10).map((c) => (
                          <tr key={String(c.id)}>
                            <Td>
                              {String(c.label)}
                              {c.edited_by_human === 1 ? <Badge tone="good">curated</Badge> : null}
                            </Td>
                            <Td align="right">{num(Number(c.live_count))}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </CardBody>
                </Card>
              ) : null}

              <FeedbackTools kinds={FEEDBACK_KINDS} selected={selected ? { id: String(selected.id), title: String(selected.title) } : null} duplicates={duplicates} />

              <Caveats items={[
                "Report volume reflects who chose to write in. It is not a measure of how many users are affected.",
                "Sentiment in a report is not evidence of dissatisfaction across your base, or of a coming cancellation.",
                "Votes signal interest. They are not verified demand.",
              ]} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

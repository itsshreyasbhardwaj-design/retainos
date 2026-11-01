import type { Metadata } from "next";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { listFeedback } from "@retainos/database";
import { PageHeader, Card, CardBody, Badge, Empty, Caveats, Table, Th, Td } from "@/components/ui";
import { num, relative, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Feature requests" };
export const dynamic = "force-dynamic";

export default async function Requests() {
  const ctx = await requireProject();
  const handle = db();
  const now = Date.now();
  const requests = listFeedback(handle, ctx.projectScope, { kind: ["feature_request"], limit: 100 }) as Array<Record<string, unknown>>;

  return (
    <>
      <PageHeader
        title="Feature requests"
        description="Ordered by votes. Votes are a signal of interest, not verified demand."
      />

      {requests.length === 0 ? (
        <Empty
          title="No feature requests yet"
          body="Requests arrive through the widget or the public portal, and can be recorded by hand from the inbox."
        />
      ) : (
        <>
          <Card>
            <CardBody>
              <Table>
                <thead>
                  <tr><Th>Request</Th><Th>Status</Th><Th align="right">Votes</Th><Th align="right">Raised</Th></tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={String(r.id)}>
                      <Td>
                        <span className="text-slate-300">{String(r.title)}</span>
                        {r.duplicate_of ? <Badge tone="neutral">merged</Badge> : null}
                      </Td>
                      <Td><Badge tone={r.status === "planned" ? "info" : r.status === "released" ? "good" : "neutral"}>
                        {titleCase(String(r.status))}
                      </Badge></Td>
                      <Td align="right">{num(Number(r.vote_count))}</Td>
                      <Td align="right">{relative(Number(r.created_at), now)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>

          <div className="mt-5">
            <Caveats items={[
              "A vote count reflects the people who found the portal and chose to vote. It is not a sample of your users.",
              "Vote totals are deduplicated per voter, but a determined person can still create multiple identities.",
              "Shipping the most-voted request is not the same as shipping the most valuable one.",
            ]} />
          </div>
        </>
      )}
    </>
  );
}

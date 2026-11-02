import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  listFrictionCases, RELATIONSHIP_STRENGTH, FRICTION_STATUSES, type FrictionStatus,
} from "@retainos/analytics";
import { entitlementFor } from "@retainos/database";
import {
  PageHeader, Card, CardHeader, CardBody, Badge, Empty, Button, Table, Th, Td, Confidence, Caveats, Metric,
} from "@/components/ui";
import { num, money, relative, titleCase } from "@/lib/format";
import { RefreshFrictionButton } from "./actions-client";

export const metadata: Metadata = { title: "FrictionGraph" };
export const dynamic = "force-dynamic";

const OPEN_STATUSES: FrictionStatus[] = [
  "detected", "investigating", "evidence_collected", "validated", "approved", "in_development",
];

const STATUS_TONE: Record<string, "neutral" | "info" | "good" | "warn" | "bad" | "accent"> = {
  detected: "warn",
  investigating: "info",
  evidence_collected: "info",
  validated: "accent",
  approved: "accent",
  in_development: "accent",
  released: "good",
  measuring: "info",
  resolved: "good",
  inconclusive: "neutral",
  dismissed: "neutral",
};

export default async function Friction({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireProject();
  const handle = db();
  const entitlement = entitlementFor(handle, ctx.org.id);
  const params = await searchParams;

  if (!entitlement.features.frictionGraph) {
    return (
      <>
        <PageHeader title="FrictionGraph" />
        <Empty
          title="Not included on your plan"
          body={`FrictionGraph is available from the Free plan upwards. You are on ${entitlement.planId}, which is unexpected — please get in touch.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  const showAll = params.status === "all";
  const cases = listFrictionCases(handle, ctx.project.id, {
    status: showAll ? undefined : OPEN_STATUSES,
    limit: 100,
  }) as Array<Record<string, any>>;

  const totalExposure = cases.reduce((s, c) => s + (c.revenue_exposure_minor ?? 0), 0);
  const withStrongEvidence = cases.filter((c) => c.evidence_quality === "strong_supporting_evidence").length;

  return (
    <>
      <PageHeader
        title="FrictionGraph"
        description="Signals that touch the same people, joined into one case. Links come from shared keys — the same users, the same error fingerprint, the same account — never from two things merely happening at once."
        action={<RefreshFrictionButton />}
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Metric
          label="Open cases"
          value={num(cases.filter((c) => OPEN_STATUSES.includes(c.status)).length)}
          definition="Cases that have been detected and not yet released, resolved or dismissed."
        />
        <Metric
          label="Strong evidence"
          value={num(withStrongEvidence)}
          definition="Cases whose evidence meets the strongest of the four confidence levels."
        />
        <Metric
          label="Revenue exposure"
          value={totalExposure > 0 ? money(totalExposure) : "—"}
          definition="Monthly recurring revenue attached to the accounts these cases touch."
          caveat="Exposure is not predicted loss. These accounts pay this much and were affected; neither fact implies they will leave."
        />
      </div>

      <div className="mb-5">
        <Caveats
          items={[
            "A case is a set of signals about the same users, not a diagnosis. The observation and the " +
            "hypotheses are stored separately so one is never read as the other.",
            `Relationship strengths are fixed and visible: shared affected users ${RELATIONSHIP_STRENGTH.shared_affected_users}, ` +
            `same error fingerprint ${RELATIONSHIP_STRENGTH.same_error_fingerprint}, same workflow ${RELATIONSHIP_STRENGTH.same_workflow}, ` +
            `temporal proximity ${RELATIONSHIP_STRENGTH.temporal_proximity} — the weakest, and suppressed whenever a stronger link exists.`,
          ]}
          tone="info"
        />
      </div>

      <Card>
        <CardHeader
          title={showAll ? "Every case" : "Open cases"}
          subtitle={`${cases.length} shown, ordered by their opportunity rank where one has been computed.`}
          action={
            <Link href={showAll ? "/friction" : "/friction?status=all"}>
              <Button variant="secondary" size="sm">{showAll ? "Open only" : "Show all"}</Button>
            </Link>
          }
        />
        <CardBody>
          {cases.length === 0 ? (
            <Empty
              title={showAll ? "No cases yet" : "Nothing open"}
              body={
                showAll
                  ? "Run the detectors. They look for activation stalls, reliability problems, billing friction, feedback volume and retention drops, then pull in every other signal touching the same users."
                  : "Every detected case has been released, resolved or dismissed."
              }
              action={<RefreshFrictionButton />}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Case</Th>
                  <Th>Kind</Th>
                  <Th>Status</Th>
                  <Th align="right">Users</Th>
                  <Th align="right">Evidence</Th>
                  <Th align="right">Score</Th>
                  <Th align="right">Detected</Th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <Link href={`/friction/${c.id}`} className="font-medium text-offwhite hover:text-cyan-400">
                        {c.title}
                      </Link>
                      {c.affected_workflow ? (
                        <span className="mt-0.5 block text-[11px] text-slate-500">{c.affected_workflow}</span>
                      ) : null}
                    </Td>
                    <Td><Badge tone="neutral">{titleCase(String(c.kind))}</Badge></Td>
                    <Td><Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{titleCase(String(c.status))}</Badge></Td>
                    <Td align="right">{num(c.affected_users)}</Td>
                    <Td align="right">
                      <Confidence label={String(c.evidence_quality)} basis={String(c.evidence_basis ?? "")} />
                    </Td>
                    <Td align="right">
                      {c.score === null || c.score === undefined
                        ? <span className="text-slate-600">not ranked</span>
                        : <span className="tnum">{Number(c.score).toFixed(1)}</span>}
                    </Td>
                    <Td align="right"><span className="text-slate-500">{relative(c.detected_at)}</span></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import {
  mrrSnapshot, mrrMovement, mrrSeries, churnBreakdown, revenueAtRisk, currenciesInUse,
} from "@retainos/analytics";
import { listSubscriptions, billingConnections, entitlementFor } from "@retainos/database";
import { monthKey, dayKeyToMillis } from "@retainos/shared";
import { PageHeader, Card, CardHeader, CardBody, Metric, Table, Th, Td, Empty, Caveats, Badge, Button } from "@/components/ui";
import { MrrChart } from "@/components/charts";
import { pct, num, money, relative, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Revenue" };
export const dynamic = "force-dynamic";

/** The last `count` calendar months, as key plus bounds in the project timezone. */
function recentMonths(count: number, timezone: string, now: number) {
  const out: Array<{ key: string; start: number; end: number }> = [];
  const current = new Date(now);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const start = dayKeyToMillis(`${key}-01`, timezone);
    const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const nextKey = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push({ key, start, end: dayKeyToMillis(`${nextKey}-01`, timezone) - 1 });
  }
  return out;
}

export default async function Revenue() {
  const ctx = await requireProject();
  const handle = db();
  const { projectId, timezone } = ctx.projectScope;
  const now = Date.now();

  const entitlement = entitlementFor(handle, ctx.org.id);
  const currencies = currenciesInUse(handle, projectId);
  const connections = billingConnections(handle, ctx.projectScope) as Array<Record<string, unknown>>;

  if (!entitlement.features.revenueIntelligence) {
    return (
      <>
        <PageHeader title="Revenue intelligence" />
        <Empty
          title="Not included on your plan"
          body={`Revenue intelligence is part of the Growth plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  if (currencies.length === 0) {
    return (
      <>
        <PageHeader
          title="Revenue intelligence"
          description="Figures here come from verified billing events only."
        />
        <Empty
          title="No subscription data"
          body={
            "RetainOS will not estimate revenue from product usage. Connect a billing provider so subscription " +
            "state arrives as signed webhook events, or import subscription records directly."
          }
          action={<Link href="/settings/integrations"><Button>Connect billing</Button></Link>}
        />
      </>
    );
  }

  const primary = currencies[0]!;
  const snapshots = mrrSnapshot(handle, projectId, now);
  const months = recentMonths(6, timezone, now);
  const series = mrrSeries(handle, projectId, { months, currency: primary });
  const thisMonth = series[series.length - 1]!;
  const churn = churnBreakdown(handle, projectId, thisMonth.startMrrMinor >= 0 ? months[months.length - 1]!.start : now - 30 * 86_400_000, now);
  const atRisk = revenueAtRisk(handle, projectId, {
    thresholdDays: 14, currency: primary, now,
  });
  const subs = listSubscriptions(handle, ctx.projectScope) as Array<Record<string, unknown>>;
  const snapshot = snapshots.find((s) => s.currency === primary);

  return (
    <>
      <PageHeader
        title="Revenue intelligence"
        description={`${primary}. Currencies are reported separately and never converted without an explicit rate.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="MRR" value={money(snapshot?.mrrMinor ?? 0, primary)} definition={thisMonth.definitions.mrr} />
        <Metric label="ARR" value={money(snapshot?.arrMinor ?? 0, primary)}
          definition="MRR multiplied by 12. An annualised run rate, not booked revenue." />
        <Metric label="Net revenue retention" value={pct(thisMonth.netRevenueRetention)}
          definition={thisMonth.definitions.netRevenueRetention} />
        <Metric label="Gross revenue retention" value={pct(thisMonth.grossRevenueRetention)}
          definition={thisMonth.definitions.grossRevenueRetention} />
      </div>

      {thisMonth.caveats.length > 0 ? <div className="mt-4"><Caveats items={thisMonth.caveats} /></div> : null}

      <Card className="mt-5">
        <CardHeader
          title="MRR movement"
          subtitle="New and expansion above the line, contraction and churn below. The parts always reconcile with the change in MRR."
        />
        <CardBody className="px-2">
          <MrrChart data={series} />
        </CardBody>
      </Card>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={`This month (${thisMonth.periodKey})`} />
          <CardBody>
            <Table>
              <thead><tr><Th>Component</Th><Th align="right">Amount</Th><Th>Definition</Th></tr></thead>
              <tbody>
                {([
                  ["Starting MRR", thisMonth.startMrrMinor, "MRR at the start of the period."],
                  ["New", thisMonth.newMinor, thisMonth.definitions.new],
                  ["Reactivation", thisMonth.reactivationMinor, thisMonth.definitions.reactivation],
                  ["Expansion", thisMonth.expansionMinor, thisMonth.definitions.expansion],
                  ["Contraction", -thisMonth.contractionMinor, thisMonth.definitions.contraction],
                  ["Churn", -thisMonth.churnMinor, thisMonth.definitions.churn],
                  ["Ending MRR", thisMonth.endMrrMinor, "MRR at the end of the period."],
                ] as const).map(([label, amount, definition]) => (
                  <tr key={label}>
                    <Td>{label}</Td>
                    <Td align="right" className={amount < 0 ? "text-rose-500" : undefined}>
                      {money(amount, primary)}
                    </Td>
                    <Td className="max-w-xs text-[11px] leading-snug text-slate-500">{definition}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Churn by verified cause" subtitle={churn.note} />
            <CardBody>
              {churn.total === 0 ? (
                <p className="text-xs text-slate-400">No cancellations in this period.</p>
              ) : (
                <Table>
                  <thead><tr><Th>Cause</Th><Th align="right">Subscriptions</Th></tr></thead>
                  <tbody>
                    {([
                      ["Voluntary cancellation", churn.voluntary],
                      ["Payment failure", churn.paymentFailure],
                      ["Expiration", churn.expiration],
                      ["Trial expired", churn.trialExpired],
                      ["Downgrade to nothing", churn.downgrade],
                      ["Cause not recorded", churn.unknown],
                    ] as const).filter(([, n]) => n > 0).map(([label, n]) => (
                      <tr key={label}><Td>{label}</Td><Td align="right">{num(n)}</Td></tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Revenue at risk" subtitle="Observed states, not predictions." />
            <CardBody>
              <div className="grid gap-3 sm:grid-cols-2">
                <Metric label="On inactive accounts" value={money(atRisk.inactivePaidMrrMinor, primary)}
                  definition={`${num(atRisk.inactivePaidCount)} paying subscriptions whose user has had no activity for over ${atRisk.thresholdDays} days.`} />
                <Metric label="Failed payments" value={money(atRisk.paymentFailureMrrMinor, primary)}
                  definition={`${num(atRisk.paymentFailureCount)} subscriptions in a past-due state.`}
                  tone={atRisk.paymentFailureCount > 0 ? "bad" : undefined} />
              </div>
              <div className="mt-4"><Caveats items={[atRisk.label]} /></div>
            </CardBody>
          </Card>
        </div>
      </div>

      <Card className="mt-5">
        <CardHeader
          title="Subscriptions"
          subtitle={`${num(subs.length)} records. Connections: ${connections.map((c) => `${String(c.provider)} (${String(c.status)})`).join(", ") || "none"}.`}
        />
        <CardBody>
          {subs.length === 0 ? (
            <p className="text-xs text-slate-400">No subscription records yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Customer</Th><Th>Plan</Th><Th>Status</Th>
                  <Th align="right">Amount</Th><Th>Interval</Th><Th align="right">Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {subs.slice(0, 40).map((s) => (
                  <tr key={String(s.id)}>
                    <Td><span className="font-mono text-[11px]">{String(s.user_external_id ?? "unlinked")}</span></Td>
                    <Td>{String(s.plan_name)}</Td>
                    <Td>
                      <Badge tone={
                        s.status === "active" ? "good"
                        : s.status === "past_due" ? "bad"
                        : s.status === "trialing" ? "info" : "neutral"
                      }>
                        {titleCase(String(s.status))}
                      </Badge>
                    </Td>
                    <Td align="right">{money(Number(s.amount_minor), String(s.currency))}</Td>
                    <Td>{String(s.interval)}</Td>
                    <Td align="right">{s.last_seen_at ? relative(Number(s.last_seen_at), now) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {currencies.length > 1 ? (
        <Card className="mt-5">
          <CardHeader title="Other currencies" subtitle="Reported separately. RetainOS does not convert between them." />
          <CardBody>
            <Table>
              <thead><tr><Th>Currency</Th><Th align="right">MRR</Th><Th align="right">Active</Th><Th align="right">Past due</Th></tr></thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.currency}>
                    <Td>{s.currency}</Td>
                    <Td align="right">{money(s.mrrMinor, s.currency)}</Td>
                    <Td align="right">{num(s.activeSubscriptions)}</Td>
                    <Td align="right">{num(s.pastDueSubscriptions)}</Td>
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

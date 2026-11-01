import type { Metadata } from "next";
import { appContext } from "@/lib/session";
import { db } from "@/lib/db";
import { usageSummary, entitlementFor } from "@retainos/database";
import { PLANS, PLAN_ORDER, formatPaise, annualDiscountPercent } from "@retainos/shared";
import { PageHeader, Card, CardHeader, CardBody, Badge, Caveats, Table, Th, Td, Bar } from "@/components/ui";
import { num, when, titleCase } from "@/lib/format";
import { BillingForm } from "./form";

export const metadata: Metadata = { title: "Plan & usage" };
export const dynamic = "force-dynamic";

export default async function Billing() {
  const ctx = await appContext();
  const handle = db();
  const now = Date.now();

  const usage = usageSummary(handle, ctx.org.id, now);
  const entitlement = entitlementFor(handle, ctx.org.id);
  const subscription = handle.get<Record<string, unknown>>(
    "SELECT * FROM org_subscriptions WHERE org_id = ?", [ctx.org.id],
  );
  const records = handle.all<Record<string, unknown>>(
    "SELECT * FROM billing_records WHERE org_id = ? ORDER BY created_at DESC LIMIT 10", [ctx.org.id],
  );

  return (
    <>
      <PageHeader
        title="Plan and usage"
        description={`On the ${usage.plan.name} plan, ${usage.status}. Usage period ${usage.periodKey}.`}
      />

      <div className="mb-5">
        <Caveats items={[
          "This deployment uses the development billing simulator. No payment is taken, and a simulated payment is never reported as a real one.",
          "In production, payment runs through Razorpay. A subscription is only marked paid when a signed provider event says so.",
        ]} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Usage this period"
              subtitle="Metered limits are enforced on the server, in the code path that does the work."
            />
            <CardBody>
              <ul className="space-y-4">
                {usage.metrics.map((m) => (
                  <li key={m.metric}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm text-slate-300">{titleCase(m.metric)}</span>
                      <span className="text-xs tnum text-slate-400">
                        {num(m.used)} of {num(m.limit)} ({m.percent}%)
                      </span>
                    </div>
                    <div className="mt-1.5">
                      <Bar fraction={m.limit === 0 ? 1 : m.used / m.limit}
                        tone={m.percent >= 90 ? "rose" : m.percent >= 70 ? "cyan" : "emerald"} />
                    </div>
                    {m.limit === 0 ? (
                      <p className="mt-1 text-[11px] text-slate-500">Not included on this plan.</p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Caveats tone="info" items={[
                  "When a batch of events crosses your allowance, RetainOS accepts what fits and tells the SDK how many were rejected and why. It does not silently drop events or bill past your plan.",
                ]} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Plans" subtitle="Prices are a commercial hypothesis, not validated willingness to pay." />
            <CardBody>
              <Table>
                <thead>
                  <tr>
                    <Th>Plan</Th><Th align="right">Monthly</Th><Th align="right">Annual</Th>
                    <Th align="right">Projects</Th><Th align="right">Events/month</Th><Th align="right">Seats</Th><Th />
                  </tr>
                </thead>
                <tbody>
                  {PLAN_ORDER.map((id) => (
                    <tr key={id}>
                      <Td>
                        {PLANS[id].name}
                        {usage.plan.id === id ? <Badge tone="good">current</Badge> : null}
                      </Td>
                      <Td align="right">{formatPaise(PLANS[id].monthlyPaise)}</Td>
                      <Td align="right">
                        {PLANS[id].annualPaise > 0
                          ? <>{formatPaise(PLANS[id].annualPaise)}<span className="ml-1 text-[10px] text-emerald-400">−{annualDiscountPercent(PLANS[id])}%</span></>
                          : "—"}
                      </Td>
                      <Td align="right">{num(PLANS[id].limits.projects)}</Td>
                      <Td align="right">{num(PLANS[id].limits.eventsPerMonth)}</Td>
                      <Td align="right">{num(PLANS[id].limits.teamMembers)}</Td>
                      <Td align="right" />
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>

          {records.length > 0 ? (
            <Card>
              <CardHeader title="Billing records" />
              <CardBody>
                <Table>
                  <thead><tr><Th>Description</Th><Th>Provider</Th><Th>Status</Th><Th align="right">When</Th></tr></thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={String(r.id)}>
                        <Td>
                          {String(r.description)}
                          {r.is_simulated === 1 ? <Badge tone="warn">simulated</Badge> : null}
                        </Td>
                        <Td>{String(r.provider)}</Td>
                        <Td><Badge tone={r.status === "succeeded" ? "good" : "neutral"}>{String(r.status)}</Badge></Td>
                        <Td align="right">{when(Number(r.created_at))}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-5">
          <BillingForm
            currentPlan={usage.plan.id}
            currentInterval={String(subscription?.interval ?? "month")}
            isOwner={ctx.org.role === "owner"}
            periodEnd={subscription ? Number(subscription.current_period_end) : null}
          />
          <Caveats tone="info" items={[
            "Cancelling is an ordinary setting. There is no retention flow, no exit survey you must complete and no countdown.",
            "If a subscription lapses you keep read and export access to your own data, on free-plan limits.",
          ]} />
        </div>
      </div>
    </>
  );
}

"use client";

import { useActionState } from "react";
import { changePlanAction } from "@/lib/actions";
import { PLANS, PLAN_ORDER, formatPaise } from "@retainos/shared/plans";
import { Card, CardHeader, CardBody, Button, Select, ErrorBanner, SuccessBanner } from "@/components/ui";

export function BillingForm({
  currentPlan, currentInterval, isOwner, periodEnd,
}: { currentPlan: string; currentInterval: string; isOwner: boolean; periodEnd: number | null }) {
  const [state, action, pending] = useActionState(changePlanAction, {} as { error?: string; ok?: string });

  return (
    <Card>
      <CardHeader
        title="Change plan"
        subtitle={periodEnd ? `Current period ends ${new Date(periodEnd).toISOString().slice(0, 10)}.` : undefined}
      />
      <CardBody>
        {!isOwner ? (
          <p className="text-xs leading-relaxed text-slate-400">Only an owner can change the plan.</p>
        ) : (
          <form action={action} className="space-y-3">
            <ErrorBanner message={state?.error} />
            <SuccessBanner message={state?.ok} />
            <Select
              label="Plan"
              name="planId"
              defaultValue={currentPlan}
              options={PLAN_ORDER.map((id) => ({
                value: id,
                label: `${PLANS[id].name} — ${formatPaise(PLANS[id].monthlyPaise)}/mo`,
              }))}
            />
            <Select
              label="Billing interval"
              name="interval"
              defaultValue={currentInterval}
              options={[
                { value: "month", label: "Monthly" },
                { value: "year", label: "Annual" },
              ]}
            />
            <Button type="submit" disabled={pending}>{pending ? "Changing…" : "Change plan"}</Button>
            <p className="text-[11px] leading-relaxed text-slate-500">
              This uses the development billing simulator. No payment is taken and none is recorded as confirmed.
              Downgrading to Free keeps your data and applies free-plan limits.
            </p>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

"use client";

import { useActionState } from "react";
import { connectBillingAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Select, ErrorBanner, SuccessBanner } from "@/components/ui";

export function IntegrationForm() {
  const [state, action, pending] = useActionState(connectBillingAction, {} as { error?: string; ok?: string });
  return (
    <Card>
      <CardHeader title="Set up a billing connection" subtitle="Records the intent. Status follows real events." />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Select
            label="Provider"
            name="provider"
            defaultValue="razorpay"
            options={[
              { value: "razorpay", label: "Razorpay (India-first)" },
              { value: "stripe", label: "Stripe" },
              { value: "simulator", label: "Development simulator" },
              { value: "manual", label: "Manual records" },
            ]}
          />
          <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Set up"}</Button>
          <p className="text-[11px] leading-relaxed text-slate-500">
            This creates the record only. Nothing is marked connected until a signed webhook event arrives.
          </p>
        </form>
      </CardBody>
    </Card>
  );
}

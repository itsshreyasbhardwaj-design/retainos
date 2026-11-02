"use client";

import { useActionState } from "react";
import { recordEstimateAction } from "@/lib/actions-product";
import {
  Card, CardHeader, CardBody, Button, Field, Select, ErrorBanner, SuccessBanner,
} from "@/components/ui";

type State = { error?: string; ok?: string };

export function EstimateImpactForm({ cases }: { cases: Array<{ id: string; label: string }> }) {
  const [state, action, pending] = useActionState(recordEstimateAction, {} as State);
  return (
    <Card>
      <CardHeader
        title="Record an estimate"
        subtitle="A model, stored as a model. Every input becomes a listed assumption with its source, and the result carries a range built from the least certain one."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Field label="Label" name="label" required
            defaultValue="Projected monthly effect of fixing this" />
          {cases.length > 0 ? (
            <Select
              label="Friction case (optional)"
              name="caseId"
              defaultValue=""
              options={[{ value: "", label: "Not linked" }, ...cases.map((c) => ({ value: c.id, label: c.label }))]}
            />
          ) : null}
          <Field label="Affected users" name="affectedUsers" type="number" defaultValue={0}
            hint="Measured from the product, not guessed." />
          <Field label="Conversion change (percentage points)" name="conversionDelta" type="number"
            step="0.1" defaultValue={5} />
          <Select
            label="Where that figure came from"
            name="deltaSource"
            defaultValue="user_supplied"
            options={[
              { value: "measured", label: "Measured from our own data" },
              { value: "user_supplied", label: "My judgement" },
              { value: "default", label: "A default I have not checked" },
            ]}
          />
          <Field label="Monthly revenue per converting user (minor units)" name="arpuMinor"
            type="number" defaultValue={90000}
            hint="90000 paise is ₹900 a month." />
          <Select
            label="Where that figure came from"
            name="arpuSource"
            defaultValue="measured"
            options={[
              { value: "measured", label: "Measured from our own billing" },
              { value: "user_supplied", label: "My judgement" },
              { value: "default", label: "A default I have not checked" },
            ]}
          />
          <Field label="Currency" name="currency" defaultValue="INR" />
          <Field label="Horizon (months)" name="horizonMonths" type="number" defaultValue={12}
            hint="Over twelve adds a stated limitation: it assumes nothing else changes for a year." />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Recording…" : "Record estimate"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

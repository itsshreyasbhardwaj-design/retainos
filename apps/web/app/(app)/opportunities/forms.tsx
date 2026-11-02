"use client";

import { useActionState } from "react";
import { setWeightsAction, rerankAction } from "@/lib/actions-product";
import {
  Card, CardHeader, CardBody, Button, Field, ErrorBanner, SuccessBanner,
} from "@/components/ui";

type State = { error?: string; ok?: string };

function label(factor: string) {
  return factor.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function WeightsForm({
  rows,
}: {
  rows: Array<{ factor: string; weight: number }>;
}) {
  const [state, action, pending] = useActionState(setWeightsAction, {} as State);
  return (
    <Card>
      <CardHeader
        title="Weights"
        subtitle="Change what matters to your business. The measurements do not change; only what they are worth."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          {rows.map((row) => (
            <Field
              key={row.factor}
              label={label(row.factor)}
              name={row.factor}
              type="number"
              step="0.01"
              defaultValue={row.weight}
            />
          ))}
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save weights"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function RerankButton() {
  const [state, action, pending] = useActionState(
    async () => rerankAction(),
    {} as State,
  );
  return (
    <form action={action} className="flex items-center gap-2">
      {state?.ok ? <span className="text-xs text-emerald-400">{state.ok}</span> : null}
      {state?.error ? <span className="text-xs text-rose-500">{state.error}</span> : null}
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Ranking…" : "Recompute ranking"}
      </Button>
    </form>
  );
}

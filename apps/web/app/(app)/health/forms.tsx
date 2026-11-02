"use client";

import { useActionState } from "react";
import { saveHealthDefinitionAction, snapshotHealthAction } from "@/lib/actions-product";
import {
  Card, CardHeader, CardBody, Button, Field, ErrorBanner, SuccessBanner,
} from "@/components/ui";

type State = { error?: string; ok?: string };

function label(signal: string) {
  return signal.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function HealthDefinitionForm({
  rows, name,
}: {
  rows: Array<{ signal: string; weight: number }>;
  name: string;
}) {
  const [state, action, pending] = useActionState(saveHealthDefinitionAction, {} as State);
  return (
    <Card>
      <CardHeader
        title="Signal weights"
        subtitle="A business that sells per seat can say seat spread is what matters. The observations stay the same; only what they are worth changes."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Field label="Definition name" name="name" defaultValue={name} />
          {rows.map((row) => (
            <Field
              key={row.signal}
              label={label(row.signal)}
              name={row.signal}
              type="number"
              step="0.1"
              min="0"
              max="5"
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

export function SnapshotButton({ subjectId }: { subjectId: string }) {
  const [state, action, pending] = useActionState(snapshotHealthAction, {} as State);
  return (
    <Card>
      <CardHeader
        title="Record a snapshot"
        subtitle="Stores today's state and every signal's contribution, so a change becomes visible rather than remembered."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <input type="hidden" name="kind" value="account" />
          <input type="hidden" name="subjectId" value={subjectId} />
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            {pending ? "Recording…" : "Record snapshot"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

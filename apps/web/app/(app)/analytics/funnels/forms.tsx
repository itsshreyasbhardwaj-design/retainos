"use client";

import { useActionState } from "react";
import { saveFunnelAction, deleteFunnelAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Textarea, ErrorBanner, SuccessBanner } from "@/components/ui";

export function FunnelForms({
  knownEvents, saved,
}: { knownEvents: string[]; saved: Array<{ id: string; name: string }> }) {
  const [saveState, save, saving] = useActionState(saveFunnelAction, {} as { error?: string; ok?: string });
  const [delState, del, deleting] = useActionState(deleteFunnelAction, {} as { error?: string; ok?: string });

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Build a funnel" subtitle="One event per line, in the order users should perform them." />
        <CardBody>
          <form action={save} className="space-y-4">
            <ErrorBanner message={saveState?.error} />
            <SuccessBanner message={saveState?.ok} />
            <Field label="Name" name="name" required placeholder="Signup to first project" />
            <Textarea
              label="Steps"
              name="steps"
              rows={5}
              required
              placeholder={"signup_completed\nonboarding_started\nonboarding_completed\nproject_created"}
              hint={
                knownEvents.length > 0
                  ? `Events seen in this project: ${knownEvents.slice(0, 10).join(", ")}${knownEvents.length > 10 ? "…" : ""}`
                  : "No events have arrived yet, so there is nothing to build a funnel from."
              }
            />
            <Field
              label="Conversion window (hours)"
              name="windowHours"
              type="number"
              defaultValue={168}
              hint="Measured from each user's first step, not from the previous step."
            />
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save funnel"}</Button>
          </form>
        </CardBody>
      </Card>

      {saved.length > 0 ? (
        <Card>
          <CardHeader title="Saved funnels" />
          <CardBody>
            <ErrorBanner message={delState?.error} />
            <SuccessBanner message={delState?.ok} />
            <ul className="space-y-2">
              {saved.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-300">{f.name}</span>
                  <form action={del}>
                    <input type="hidden" name="funnelId" value={f.id} />
                    <Button type="submit" variant="danger" size="sm" disabled={deleting}>Delete</Button>
                  </form>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

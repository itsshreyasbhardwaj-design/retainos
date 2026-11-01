"use client";

import { useActionState } from "react";
import { issueKeyAction, revokeKeyAction, saveEventSchemaAction, deleteEventSchemaAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Textarea, Select, ErrorBanner, SuccessBanner, Caveats } from "@/components/ui";

export function SdkTools({
  keys, knownEvents,
}: {
  keys: Array<{ id: string; name: string; kind: string; revoked: boolean }>;
  knownEvents: string[];
}) {
  const [keyState, issue, issuing] = useActionState(issueKeyAction, {} as { error?: string; ok?: string; secret?: string });
  const [revokeState, revoke, revoking] = useActionState(revokeKeyAction, {} as { error?: string; ok?: string });
  const [schemaState, saveSchema, savingSchema] = useActionState(saveEventSchemaAction, {} as { error?: string; ok?: string });
  const [delState, delSchema, deleting] = useActionState(deleteEventSchemaAction, {} as { error?: string; ok?: string });

  const active = keys.filter((k) => !k.revoked);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Issue a secret key" subtitle="For server-side reads. Shown once." />
        <CardBody>
          <form action={issue} className="space-y-3">
            <ErrorBanner message={keyState?.error} />
            <SuccessBanner message={keyState?.ok} />
            {keyState?.secret ? (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.08] p-3">
                <p className="text-[11px] font-medium text-amber-500">Copy this now. It cannot be shown again.</p>
                <code className="mt-1.5 block break-all font-mono text-[11px] text-offwhite">{keyState.secret}</code>
              </div>
            ) : null}
            <Field label="Key name" name="name" placeholder="CI pipeline" required />
            <Button type="submit" size="sm" disabled={issuing}>{issuing ? "Creating…" : "Issue key"}</Button>
          </form>
        </CardBody>
      </Card>

      {active.length > 1 ? (
        <Card>
          <CardHeader title="Revoke a key" subtitle="Takes effect immediately." />
          <CardBody>
            <form action={revoke} className="space-y-3">
              <ErrorBanner message={revokeState?.error} />
              <SuccessBanner message={revokeState?.ok} />
              <Select
                label="Key"
                name="keyId"
                options={active.map((k) => ({ value: k.id, label: `${k.name} (${k.kind.replace(/_/g, " ")})` }))}
              />
              <Button type="submit" size="sm" variant="danger" disabled={revoking}>
                {revoking ? "Revoking…" : "Revoke"}
              </Button>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Revoking a public write key stops ingestion from any client still using it. Deploy the new key first.
              </p>
            </form>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Register an event"
          subtitle="Declared properties are validated on arrival; undeclared ones are not."
        />
        <CardBody>
          <form action={saveSchema} className="space-y-3">
            <ErrorBanner message={schemaState?.error} />
            <SuccessBanner message={schemaState?.ok} />
            <Field
              label="Event name"
              name="name"
              required
              placeholder="core_action_completed"
              hint="lower_snake_case. Prefer outcome names over interaction names: project_created, not clicked_create."
            />
            <Field label="Description" name="description" placeholder="The user performed the core value action." />
            <Textarea
              label="Properties"
              name="properties"
              rows={4}
              placeholder={"feature:string:required\nduration_ms:number\nfirst_time:boolean"}
              hint="One per line as name:type[:required]. Types: string, number, boolean, timestamp."
            />
            <label className="flex items-start gap-2 text-[11px] leading-snug text-slate-400">
              <input type="checkbox" name="closed" className="mt-0.5" />
              <span>Closed schema — reject properties not declared above.</span>
            </label>
            <label className="flex items-start gap-2 text-[11px] leading-snug text-slate-400">
              <input type="checkbox" name="deprecated" className="mt-0.5" />
              <span>Deprecated — still accepted, but the SDK warns on use.</span>
            </label>
            <Button type="submit" size="sm" disabled={savingSchema}>{savingSchema ? "Saving…" : "Save schema"}</Button>
          </form>
        </CardBody>
      </Card>

      {knownEvents.length > 0 ? (
        <Card>
          <CardHeader title="Remove a schema" />
          <CardBody>
            <form action={delSchema} className="space-y-3">
              <ErrorBanner message={delState?.error} />
              <SuccessBanner message={delState?.ok} />
              <Select
                label="Event"
                name="name"
                options={[...new Set(knownEvents)].map((e) => ({ value: e, label: e }))}
              />
              <Button type="submit" size="sm" variant="danger" disabled={deleting}>
                {deleting ? "Removing…" : "Remove schema"}
              </Button>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Removing a schema does not delete events. It stops their properties being validated.
              </p>
            </form>
          </CardBody>
        </Card>
      ) : null}

      <Caveats tone="info" items={[
        "Changing an event's properties increments its schema version, so you can tell whether a metric definition shifted underneath you.",
        "A schema version change inside an experiment window is flagged as a blocking validity failure.",
      ]} />
    </div>
  );
}

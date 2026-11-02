"use client";

import { useActionState } from "react";
import {
  connectProviderAction, verifyProviderAction, revokeProviderAction,
  setSourceAuthorityAction, importCsvAction, revertImportAction,
} from "@/lib/actions-product";
import {
  Card, CardHeader, CardBody, Button, Field, Select, Textarea, ErrorBanner, SuccessBanner,
} from "@/components/ui";

type State = { error?: string; ok?: string };

export function ConnectForm({ providers }: { providers: Array<{ value: string; label: string }> }) {
  const [state, action, pending] = useActionState(connectProviderAction, {} as State);
  return (
    <Card>
      <CardHeader
        title="Register a source"
        subtitle="Non-secret configuration only. The credential itself lives in the server environment."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Select label="Provider" name="provider" options={providers} />
          <Field label="Host (optional)" name="host" placeholder="https://eu.posthog.com" />
          <Field label="Project reference (optional)" name="projectRef"
            hint="The provider's own project id or slug, where it needs one." />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Registering…" : "Register"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function ProviderActions({ provider, status }: { provider: string; status: string }) {
  const [verifyState, verifyAction, verifying] = useActionState(verifyProviderAction, {} as State);
  const [revokeState, revokeAction, revoking] = useActionState(revokeProviderAction, {} as State);
  return (
    <div className="space-y-2">
      {verifyState?.error ? <p className="text-[11px] text-rose-500">{verifyState.error}</p> : null}
      {verifyState?.ok ? <p className="text-[11px] text-emerald-400">{verifyState.ok}</p> : null}
      {revokeState?.ok ? <p className="text-[11px] text-emerald-400">{revokeState.ok}</p> : null}
      <div className="flex flex-wrap gap-2">
        <form action={verifyAction}>
          <input type="hidden" name="provider" value={provider} />
          <Button type="submit" variant="secondary" size="sm" disabled={verifying}>
            {verifying ? "Checking…" : "Verify now"}
          </Button>
        </form>
        {status !== "revoked" ? (
          <form action={revokeAction}>
            <input type="hidden" name="provider" value={provider} />
            <Button type="submit" variant="ghost" size="sm" disabled={revoking}>
              Revoke
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

export function AuthorityForm({ domains }: { domains: string[] }) {
  const [state, action, pending] = useActionState(setSourceAuthorityAction, {} as State);
  return (
    <form action={action} className="space-y-3 border-t border-navy-800 pt-4">
      <ErrorBanner message={state?.error} />
      <SuccessBanner message={state?.ok} />
      <Select
        label="Domain"
        name="domain"
        options={domains.map((d) => ({ value: d, label: d }))}
      />
      <Field label="Authoritative source" name="source" defaultValue="sdk"
        hint="For example sdk, posthog, sentry or csv." />
      <Field label="Specific event (optional)" name="entity"
        hint="Leave blank to cover the whole domain. An entity-level decision beats the domain one." />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Set authority"}
      </Button>
    </form>
  );
}

export function CsvImportForm({ columns }: { columns: string[] }) {
  const [state, action, pending] = useActionState(importCsvAction, {} as State);
  return (
    <Card>
      <CardHeader
        title="Import events from a CSV"
        subtitle="Works on every plan and needs no account anywhere. Historical dates are accepted; live ingestion would refuse them, and a backfill is not a skewed clock."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Textarea
            label="CSV"
            name="csv"
            rows={8}
            placeholder={`${columns.join(",")}\nph-1,project_published,2026-03-01T10:00:00Z,user-123`}
            hint={`Required columns: ${columns.join(", ")}. Any other column becomes an event property. ` +
              "A row whose user cannot be matched is rejected rather than attached to someone plausible."}
          />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function RevertForm({ syncRunId }: { syncRunId: string }) {
  const [state, action, pending] = useActionState(revertImportAction, {} as State);
  return (
    <form action={action}>
      <input type="hidden" name="syncRunId" value={syncRunId} />
      {state?.ok ? <span className="mr-2 text-[11px] text-emerald-400">{state.ok}</span> : null}
      {state?.error ? <span className="mr-2 text-[11px] text-rose-500">{state.error}</span> : null}
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Removing…" : "Undo"}
      </Button>
    </form>
  );
}

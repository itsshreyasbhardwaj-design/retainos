"use client";

import { useActionState } from "react";
import { eraseSubjectAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Select, ErrorBanner, SuccessBanner, Caveats } from "@/components/ui";

export function PrivacyTools({ projectId, canErase }: { projectId: string; canErase: boolean }) {
  const [state, erase, erasing] = useActionState(eraseSubjectAction, {} as { error?: string; ok?: string });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Export this project" subtitle="Available on every plan, including after a subscription lapses." />
        <CardBody className="space-y-2">
          <a
            href={`/api/v1/export?project=${projectId}&format=json`}
            className="block rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-center text-xs font-medium text-offwhite hover:bg-navy-700"
          >
            Download JSON
          </a>
          <a
            href={`/api/v1/export?project=${projectId}&format=csv&table=analytics_events`}
            className="block rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-center text-xs font-medium text-offwhite hover:bg-navy-700"
          >
            Download events as CSV
          </a>
          <p className="text-[11px] leading-relaxed text-slate-500">
            Your product data is yours. Withholding it on cancellation would be a dark pattern, so export stays
            available regardless of plan state.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Erase an end user"
          subtitle="For a deletion request from one of your own users."
        />
        <CardBody>
          {!canErase ? (
            <p className="text-xs leading-relaxed text-slate-400">
              Your role cannot perform an erasure. Ask an owner or admin.
            </p>
          ) : (
            <form action={erase} className="space-y-3">
              <ErrorBanner message={state?.error} />
              <SuccessBanner message={state?.ok} />
              <Select
                label="Identify them by"
                name="subjectKind"
                defaultValue="external_id"
                options={[
                  { value: "external_id", label: "Your own user id" },
                  { value: "anonymous_id", label: "Anonymous id" },
                ]}
              />
              <Field label="Value" name="subjectValue" required placeholder="USER_123" />
              <Button type="submit" variant="danger" size="sm" disabled={erasing}>
                {erasing ? "Erasing…" : "Erase this user's data"}
              </Button>
            </form>
          )}
          <div className="mt-4">
            <Caveats items={[
              "This cannot be undone.",
              "It deletes their events, identity, experiment records and onboarding progress.",
              "It anonymises their feedback rather than destroying the product signal, and detaches their subscription rows while keeping the financial records.",
              "Affected daily aggregates are queued for recomputation, so the numbers stay consistent with the raw store instead of quietly disagreeing with it.",
            ]} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

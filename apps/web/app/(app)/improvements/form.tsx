"use client";

import { useActionState } from "react";
import { createImprovementAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Textarea, Select, ErrorBanner, SuccessBanner } from "@/components/ui";

export function NewImprovementForm({
  prefill,
}: {
  prefill: {
    title: string; affectedWorkflow: string; description: string;
    evidenceKind: string; evidenceSummary: string; evidenceSnapshot: string;
  } | null;
}) {
  const [state, action, pending] = useActionState(createImprovementAction, {} as { error?: string; ok?: string });

  return (
    <Card>
      <CardHeader
        title={prefill ? "Create from this drop-off" : "New improvement task"}
        subtitle={
          prefill
            ? "The measurement that found this is attached as evidence, frozen at today's numbers."
            : "Keep what you observed separate from what you think explains it."
        }
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />

          {prefill ? (
            <>
              <input type="hidden" name="evidenceKind" value={prefill.evidenceKind} />
              <input type="hidden" name="evidenceSummary" value={prefill.evidenceSummary} />
              <input type="hidden" name="evidenceSnapshot" value={prefill.evidenceSnapshot} />
            </>
          ) : null}

          <Field label="Title" name="title" required defaultValue={prefill?.title} placeholder="Reduce drop-off during first project creation" />
          <Textarea
            label="What was observed"
            name="description"
            rows={3}
            defaultValue={prefill?.description}
            hint="Facts and figures only. The guess goes in the next field."
          />
          <Field label="Affected workflow" name="affectedWorkflow" defaultValue={prefill?.affectedWorkflow} />
          <Textarea
            label="Hypothesised cause"
            name="hypothesis"
            rows={2}
            hint="Clearly a hypothesis. It is rendered as unconfirmed everywhere it appears, including in a GitHub issue."
          />
          <Textarea label="How to investigate" name="investigation" rows={2}
            hint="What would settle whether the hypothesis is right." />
          <Textarea label="Proposed work" name="proposedWork" rows={2} />
          <Textarea label="Acceptance criteria" name="acceptanceCriteria" rows={2} />
          <Field label="Primary metric" name="primaryMetric" placeholder="project_created conversion"
            hint="The one metric this work is meant to move." />
          <Textarea label="Measurement plan" name="measurementPlan" rows={2}
            hint="Decide before merging how you will tell whether it worked." />
          <Select
            label="Priority"
            name="priority"
            defaultValue=""
            options={[
              { value: "", label: "Not set" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "critical", label: "Critical" },
            ]}
          />
          <Field label="Priority rationale" name="priorityRationale" placeholder="Affects 40% of new signups" />
          <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create task"}</Button>
        </form>
      </CardBody>
    </Card>
  );
}

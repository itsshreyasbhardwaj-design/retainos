"use client";

import { useActionState } from "react";
import {
  transitionCaseAction, linkCaseAction, setEstimateAction, recordObservedImpactAction,
} from "@/lib/actions-product";
import {
  Card, CardHeader, CardBody, Button, Field, Select, Textarea, ErrorBanner, SuccessBanner, Badge,
} from "@/components/ui";

type State = { error?: string; ok?: string };

function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function CaseWorkflow({
  caseId, status, allowed, improvements, improvementId,
}: {
  caseId: string;
  status: string;
  allowed: string[];
  improvements: Array<{ id: string; label: string }>;
  improvementId: string | null;
}) {
  const [moveState, moveAction, moving] = useActionState(transitionCaseAction, {} as State);
  const [linkState, linkAction, linking] = useActionState(linkCaseAction, {} as State);

  return (
    <Card>
      <CardHeader
        title="Move this case on"
        subtitle="Only the transitions the workflow allows are offered; the rest are not hidden buttons, they are genuinely not possible."
      />
      <CardBody>
        <ErrorBanner message={moveState?.error} />
        <SuccessBanner message={moveState?.ok} />

        {allowed.length === 0 ? (
          <p className="text-xs leading-relaxed text-slate-400">
            {titleCase(status)} is a terminal state for this case.
          </p>
        ) : (
          <form action={moveAction} className="space-y-3">
            <input type="hidden" name="caseId" value={caseId} />
            <Select
              label="New status"
              name="status"
              options={allowed.map((s) => ({ value: s, label: titleCase(s) }))}
            />
            <Textarea
              label="Note (optional)"
              name="note"
              rows={2}
              hint="Stored on the case's history, so the decision survives the person who made it."
            />
            <Button type="submit" size="sm" disabled={moving}>
              {moving ? "Saving…" : "Update status"}
            </Button>
          </form>
        )}

        {improvements.length > 0 ? (
          <form action={linkAction} className="mt-5 space-y-3 border-t border-navy-800 pt-4">
            <input type="hidden" name="caseId" value={caseId} />
            <ErrorBanner message={linkState?.error} />
            <SuccessBanner message={linkState?.ok} />
            {improvementId ? (
              <p className="text-xs text-slate-400">
                Already linked to an improvement. <Badge tone="good">linked</Badge>
              </p>
            ) : null}
            <Select
              label="Link to an improvement"
              name="improvementId"
              options={improvements.map((i) => ({ value: i.id, label: i.label }))}
              hint="Linking is how the case gets measured after the work ships."
            />
            <Button type="submit" variant="secondary" size="sm" disabled={linking}>
              {linking ? "Linking…" : "Link"}
            </Button>
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}

export function EstimateForm({
  caseId, estimate,
}: {
  caseId: string;
  estimate: Record<string, any> | null;
}) {
  const [state, action, pending] = useActionState(setEstimateAction, {} as State);
  return (
    <Card>
      <CardHeader
        title="Your judgement"
        subtitle="Effort and importance are things only you know. Leave one blank and it counts for nothing rather than being guessed at."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <input type="hidden" name="caseId" value={caseId} />
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Select
            label="Engineering effort"
            name="effort"
            defaultValue={estimate?.engineering_effort ?? ""}
            options={[
              { value: "", label: "Not estimated" },
              { value: "small", label: "Small" },
              { value: "medium", label: "Medium" },
              { value: "large", label: "Large" },
              { value: "unknown", label: "Genuinely unknown" },
            ]}
          />
          <Select
            label="Strategic importance"
            name="importance"
            defaultValue={estimate?.strategic_importance ?? ""}
            options={[
              { value: "", label: "Not estimated" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "unknown", label: "Genuinely unknown" },
            ]}
          />
          <Select
            label="Is there a workaround?"
            name="hasWorkaround"
            defaultValue={estimate?.has_workaround === null || estimate?.has_workaround === undefined
              ? "" : estimate.has_workaround === 1 ? "true" : "false"}
            options={[
              { value: "", label: "Not answered" },
              { value: "true", label: "Yes, users can get around it" },
              { value: "false", label: "No, they are stuck" },
            ]}
          />
          <Textarea label="Note (optional)" name="note" rows={2} defaultValue={estimate?.note ?? ""} />
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save estimate"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function ObservedImpactForm({ caseId }: { caseId: string }) {
  const [state, action, pending] = useActionState(recordObservedImpactAction, {} as State);
  return (
    <Card>
      <CardHeader
        title="Record observed revenue movement"
        subtitle="Reads the billing records of the users this case affected. No model, and no causal claim."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <input type="hidden" name="caseId" value={caseId} />
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Field
            label="Window (days)"
            name="windowDays"
            type="number"
            defaultValue={30}
            hint="MRR that was being paid at the start of this window and was zero by the end."
          />
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            {pending ? "Reading billing…" : "Record what the billing data says"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

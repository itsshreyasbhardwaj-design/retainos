"use client";

import { useActionState } from "react";
import {
  createExperimentAction, startExperimentAction, stopExperimentAction, analyseExperimentAction,
} from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Textarea, Select, ErrorBanner, SuccessBanner } from "@/components/ui";

export function ExperimentControls({ experimentId, status }: { experimentId: string; status: string }) {
  const [state, analyse, analysing] = useActionState(analyseExperimentAction, {} as { error?: string; ok?: string });
  return (
    <Card>
      <CardHeader title="Controls" subtitle="Start it when the code is live, and only then." />
      <CardBody className="space-y-3">
        <ErrorBanner message={state?.error} />
        <SuccessBanner message={state?.ok} />
        {status === "draft" ? (
          <form action={startExperimentAction}>
            <input type="hidden" name="experimentId" value={experimentId} />
            <Button type="submit" size="sm">Start the experiment</Button>
          </form>
        ) : null}
        {status === "running" ? (
          <form action={stopExperimentAction}>
            <input type="hidden" name="experimentId" value={experimentId} />
            <Button type="submit" size="sm" variant="secondary">Stop collecting</Button>
          </form>
        ) : null}
        <form action={analyse}>
          <input type="hidden" name="experimentId" value={experimentId} />
          <Button type="submit" size="sm" variant="secondary" disabled={analysing}>
            {analysing ? "Analysing…" : "Save this analysis"}
          </Button>
        </form>
        <p className="text-[11px] leading-relaxed text-slate-500">
          Saving stores the full analysis — rates, test statistic, interval and every validity check — so a
          decision made today can be audited later against exactly what was known.
        </p>
      </CardBody>
    </Card>
  );
}

export function ExperimentForms({
  events, improvements,
}: {
  events: string[];
  improvements: Array<{ id: string; label: string }>;
}) {
  const [state, action, pending] = useActionState(createExperimentAction, {} as { error?: string; ok?: string });
  const eventOptions = events.length > 0
    ? events.map((e) => ({ value: e, label: e }))
    : [{ value: "core_action_completed", label: "core_action_completed" }];

  return (
    <Card>
      <CardHeader
        title="New experiment"
        subtitle="Two variants, split evenly. Set the minimum sample before you start, not after you look."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Field label="Name" name="name" required placeholder="Simplified onboarding" />
          <Field label="Key" name="key" required placeholder="simplified-onboarding"
            hint="Used in your code to ask for the variant. Lowercase, letters, digits, hyphens and underscores." />
          <Textarea label="Hypothesis" name="hypothesis" rows={2}
            placeholder="Removing the second onboarding step will raise first-project creation." />
          <Select label="Primary metric event" name="primaryMetricEvent" options={eventOptions}
            hint="The single event the decision rests on." />
          <Field label="Treatment name" name="treatmentName" defaultValue="Treatment" />
          <Field
            label="Minimum exposures per variant"
            name="minExposures"
            type="number"
            defaultValue={200}
            hint="Pre-registered. RetainOS refuses to call a result before this is reached, because reading early inflates false positives."
          />
          {improvements.length > 0 ? (
            <Select
              label="Improvement (optional)"
              name="improvementId"
              defaultValue=""
              options={[{ value: "", label: "Not linked" }, ...improvements.map((i) => ({ value: i.id, label: i.label }))]}
              hint="Linking it writes the verdict back onto that task."
            />
          ) : null}
          <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create as draft"}</Button>
        </form>
      </CardBody>
    </Card>
  );
}

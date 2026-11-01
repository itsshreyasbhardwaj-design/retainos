"use client";

import { useActionState } from "react";
import { measureImpactAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Select, ErrorBanner, SuccessBanner, Caveats } from "@/components/ui";

export function MeasureForm({
  releases, improvements, events,
}: {
  releases: Array<{ id: string; label: string }>;
  improvements: Array<{ id: string; label: string }>;
  events: string[];
}) {
  const [state, action, pending] = useActionState(measureImpactAction, {} as { error?: string; ok?: string });
  const eventOptions = events.length > 0
    ? events.map((e) => ({ value: e, label: e }))
    : [{ value: "signup_completed", label: "signup_completed" }];

  if (releases.length === 0) {
    return (
      <Card>
        <CardHeader title="Measure a release" />
        <CardBody>
          <p className="text-xs leading-relaxed text-slate-400">
            Record a release first. A before-and-after needs a point in time to compare across.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Measure a release"
        subtitle="Pick the metric the work was meant to move, then read the confounders before concluding anything."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Select label="Release" name="releaseId" options={releases.map((r) => ({ value: r.id, label: r.label }))} />
          {improvements.length > 0 ? (
            <Select
              label="Improvement (optional)"
              name="improvementId"
              defaultValue=""
              options={[{ value: "", label: "Not linked" }, ...improvements.map((i) => ({ value: i.id, label: i.label }))]}
              hint="Linking it puts the measurement on that task's impact timeline."
            />
          ) : null}
          <Field label="Metric label" name="metricLabel" defaultValue="Signup to core action" required />
          <Select label="Denominator event" name="denominatorEvent" options={eventOptions}
            defaultValue={events.includes("signup_completed") ? "signup_completed" : eventOptions[0]!.value}
            hint="The population. Usually signups." />
          <Select label="Numerator event" name="numeratorEvent" options={eventOptions}
            defaultValue={events.includes("core_action_completed") ? "core_action_completed" : eventOptions[0]!.value}
            hint="The outcome you want more of." />
          <Field label="Window (days)" name="windowDays" type="number" defaultValue={14}
            hint="Under 14 days does not cover two full weekly cycles, so day-of-week effects are not averaged out." />
          <Button type="submit" disabled={pending}>{pending ? "Measuring…" : "Measure"}</Button>
        </form>
        <div className="mt-4">
          <Caveats tone="info" items={[
            "This produces a correlation, not a cause. If the answer matters, run a controlled experiment instead.",
          ]} />
        </div>
      </CardBody>
    </Card>
  );
}

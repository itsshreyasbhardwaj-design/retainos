"use client";

import { useActionState } from "react";
import { saveActivationAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Select, ErrorBanner, SuccessBanner } from "@/components/ui";

export function ActivationForm({
  knownEvents, current,
}: {
  knownEvents: string[];
  current: { id: string; name: string; activationEvent: string; signupEvent: string; windowDays: number } | null;
}) {
  const [state, action, pending] = useActionState(saveActivationAction, {} as { error?: string; ok?: string });
  const options = knownEvents.length > 0
    ? knownEvents.map((e) => ({ value: e, label: e }))
    : [{ value: "core_action_completed", label: "core_action_completed" }];

  return (
    <Card>
      <CardHeader
        title={current ? "Change the activation definition" : "Define activation"}
        subtitle="Changing this changes every activation figure. The definition is shown wherever the metric appears."
      />
      <CardBody>
        <form action={action} className="space-y-4">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          {current ? <input type="hidden" name="id" value={current.id} /> : null}
          <Field label="Name" name="name" defaultValue={current?.name ?? "First real value"} required />
          <Select
            label="Activation event"
            name="activationEvent"
            defaultValue={current?.activationEvent}
            options={options}
            hint="The single event meaning this user reached real value. Signup completion is not activation."
          />
          <Select
            label="Signup event"
            name="signupEvent"
            defaultValue={current?.signupEvent ?? "signup_completed"}
            options={knownEvents.length > 0 ? options : [{ value: "signup_completed", label: "signup_completed" }]}
            hint="The event that starts the clock."
          />
          <Field
            label="Window (days)"
            name="windowDays"
            type="number"
            defaultValue={current?.windowDays ?? 7}
            hint="How long a user has to activate, measured from their own signup. Pick a period that matches how your product is used."
          />
          <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save definition"}</Button>
        </form>
      </CardBody>
    </Card>
  );
}

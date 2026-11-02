"use client";

import { useActionState, useState } from "react";
import {
  savePlaybookAction, approvePlaybookAction, setPlaybookStatusAction,
  enrolPlaybookAction, measurePlaybookAction,
} from "@/lib/actions-product";
import {
  Card, CardHeader, CardBody, Button, Field, Select, Textarea, ErrorBanner, SuccessBanner,
} from "@/components/ui";

type State = { error?: string; ok?: string };

const KINDS = [
  "onboarding_recovery", "feature_discovery", "inactivity_follow_up",
  "feedback_follow_up", "cancellation_feedback", "payment_failure_assistance",
] as const;

const TRIGGERS = [
  "funnel_stalled", "event_absent", "event_occurred", "subscription_state",
] as const;

function label(s: string) {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function PlaybookForm({ events }: { events: string[] }) {
  const [state, action, pending] = useActionState(savePlaybookAction, {} as State);
  const [trigger, setTrigger] = useState<string>("funnel_stalled");
  const [kind, setKind] = useState<string>("onboarding_recovery");
  const eventOptions = events.length > 0
    ? events.map((e) => ({ value: e, label: e }))
    : [{ value: "signup_completed", label: "signup_completed" }];

  // Sensible first guesses so the defaults describe a real funnel rather than
  // an event to itself, which the engine refuses anyway.
  const pick = (preferred: string[], fallbackIndex: number) =>
    preferred.find((candidate) => events.includes(candidate)) ?? eventOptions[
      Math.min(fallbackIndex, eventOptions.length - 1)
    ]!.value;
  const fromDefault = pick(["signup_completed", "onboarding_started"], 0);
  const toDefault = pick(["onboarding_completed", "project_created", "core_action_completed"], 1);

  return (
    <Card>
      <CardHeader
        title="New playbook"
        subtitle="Saved as a draft. It enrols nobody until a person approves it, and editing it later returns it to draft."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />

          <Field label="Name" name="name" required defaultValue="Onboarding recovery" />

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">Kind</span>
            <select
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="w-full rounded-lg border border-navy-600 bg-navy-950/60 px-3 py-2 text-sm text-offwhite focus:border-blue-500 focus:outline-none"
            >
              {KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">Trigger</span>
            <select
              name="triggerKind"
              value={kind === "cancellation_feedback" ? "subscription_state" : trigger}
              onChange={(e) => setTrigger(e.target.value)}
              disabled={kind === "cancellation_feedback"}
              className="w-full rounded-lg border border-navy-600 bg-navy-950/60 px-3 py-2 text-sm text-offwhite focus:border-blue-500 focus:outline-none disabled:opacity-60"
            >
              {TRIGGERS.map((t) => <option key={t} value={t}>{label(t)}</option>)}
            </select>
            {kind === "cancellation_feedback" ? (
              <span className="mt-1.5 block text-[11px] leading-snug text-slate-500">
                A cancellation playbook can only trigger on the completed subscription state. RetainOS
                offers no way to act before someone has finished leaving.
              </span>
            ) : null}
          </label>

          {(kind === "cancellation_feedback" || trigger === "subscription_state") ? (
            <Select
              label="Subscription state"
              name="subscriptionState"
              defaultValue="cancelled"
              options={[
                { value: "cancelled", label: "Cancelled (completed)" },
                { value: "expired", label: "Expired" },
              ]}
            />
          ) : trigger === "funnel_stalled" ? (
            <>
              <Select label="Started with" name="fromEvent" options={eventOptions}
                defaultValue={fromDefault} />
              <Select label="But never did" name="toEvent" options={eventOptions}
                defaultValue={toDefault}
                hint="Must be a different event: a funnel from one event to itself has no audience." />
            </>
          ) : (
            <Select label="Event" name="triggerEvent" options={eventOptions} />
          )}

          <Field label="Delay (hours)" name="delayHours" type="number" defaultValue={24} min="1"
            hint="At least one hour for anything outbound." />
          <Select
            label="Channel"
            name="channel"
            defaultValue="in_app"
            options={[
              { value: "in_app", label: "In-app" },
              { value: "email", label: "Email (requires recorded consent)" },
              { value: "none", label: "None — record the trigger only" },
            ]}
          />
          <Field label="Message title" name="messageTitle"
            defaultValue="Stuck on the import step?" />
          <Textarea label="Message body" name="messageBody" rows={3}
            defaultValue="You started a project and stopped at the import step. Here is how that step works."
            hint="Pressure phrases — “last chance”, “your streak”, “before it's too late” — are refused by name." />
          <Field label="Help link (optional)" name="helpUrl" placeholder="https://" />
          <Field label="Holdout (%)" name="holdoutPercent" type="number" step="1" min="5" max="50"
            defaultValue={10} hint="Receives nothing, so the effect can be measured." />
          <Select label="Stop if they already did this" name="stopOnEvent" defaultValue={toDefault}
            options={[{ value: "", label: "Nothing" }, ...eventOptions]}
            hint="Nobody is nudged to do something they have already done." />
          <Select label="Primary metric" name="primaryMetricEvent" defaultValue={toDefault}
            options={[{ value: "", label: "None — cannot be measured" }, ...eventOptions]}
            hint="The behaviour the message is meant to produce. Without one, the playbook cannot be measured at all." />
          <Field label="Max messages per person" name="maxPerUserTotal" type="number" min="1" max="5"
            defaultValue={1} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quiet from" name="quietHoursStart" type="number" min="0" max="23" defaultValue={21} />
            <Field label="Quiet until" name="quietHoursEnd" type="number" min="0" max="23" defaultValue={8} />
          </div>

          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save as draft"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function PlaybookActions({
  id, status, approvedBy,
}: {
  id: string; status: string; approvedBy: string | null;
}) {
  const [approveState, approveAction, approving] = useActionState(approvePlaybookAction, {} as State);
  const [statusState, statusAction, settingStatus] = useActionState(setPlaybookStatusAction, {} as State);
  const [enrolState, enrolAction, enrolling] = useActionState(enrolPlaybookAction, {} as State);
  const [measureState, measureAction, measuring] = useActionState(measurePlaybookAction, {} as State);

  const messages = [approveState, statusState, enrolState, measureState];

  return (
    <div className="space-y-2">
      {messages.map((m, i) => (
        <div key={i}>
          {m?.error ? <p className="text-[11px] leading-snug text-rose-500">{m.error}</p> : null}
          {m?.ok ? <p className="text-[11px] leading-snug text-emerald-400">{m.ok}</p> : null}
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        {status === "draft" ? (
          <form action={approveAction}>
            <input type="hidden" name="id" value={id} />
            <Button type="submit" size="sm" disabled={approving}>
              {approving ? "Approving…" : "Approve"}
            </Button>
          </form>
        ) : null}

        {status === "approved" || status === "paused" ? (
          <form action={statusAction}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="status" value="active" />
            <Button type="submit" size="sm" disabled={settingStatus}>Activate</Button>
          </form>
        ) : null}

        {status === "active" ? (
          <>
            <form action={enrolAction}>
              <input type="hidden" name="id" value={id} />
              <Button type="submit" size="sm" disabled={enrolling}>
                {enrolling ? "Enrolling…" : "Enrol the audience"}
              </Button>
            </form>
            <form action={statusAction}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="status" value="paused" />
              <Button type="submit" variant="ghost" size="sm" disabled={settingStatus}>Pause</Button>
            </form>
          </>
        ) : null}

        <form action={measureAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="outcomeWindowDays" value={14} />
          <Button type="submit" variant="secondary" size="sm" disabled={measuring}>
            {measuring ? "Measuring…" : "Measure against the holdout"}
          </Button>
        </form>
      </div>

      {approvedBy ? (
        <p className="text-[11px] text-slate-600">Approved by a named user and recorded in the audit log.</p>
      ) : null}
    </div>
  );
}

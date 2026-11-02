"use client";

import { useActionState } from "react";
import {
  alertLifecycleAction, runAlertsAction, installDefaultRulesAction, saveAlertRuleAction,
} from "@/lib/actions-product";
import {
  Card, CardHeader, CardBody, Button, Field, Select, ErrorBanner, SuccessBanner,
} from "@/components/ui";

type State = { error?: string; ok?: string };

function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function RunChecksButton() {
  const [state, action, pending] = useActionState(async () => runAlertsAction(), {} as State);
  return (
    <form action={action} className="flex flex-wrap items-center justify-end gap-2">
      {state?.ok ? <span className="max-w-sm text-right text-xs text-emerald-400">{state.ok}</span> : null}
      {state?.error ? <span className="text-xs text-rose-500">{state.error}</span> : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Checking…" : "Run checks now"}
      </Button>
    </form>
  );
}

export function InstallRulesButton() {
  const [state, action, pending] = useActionState(async () => installDefaultRulesAction(), {} as State);
  return (
    <form action={action} className="space-y-2">
      <ErrorBanner message={state?.error} />
      <SuccessBanner message={state?.ok} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Installing…" : "Install the default rules"}
      </Button>
    </form>
  );
}

export function AlertActions({ id, acknowledged }: { id: string; acknowledged: boolean }) {
  const [state, action, pending] = useActionState(alertLifecycleAction, {} as State);
  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="days" value={7} />
      {state?.error ? <span className="text-[11px] text-rose-500">{state.error}</span> : null}
      {!acknowledged ? (
        <Button type="submit" name="what" value="acknowledge" variant="secondary" size="sm" disabled={pending}>
          Acknowledge
        </Button>
      ) : null}
      <Button type="submit" name="what" value="snooze" variant="ghost" size="sm" disabled={pending}>
        Snooze a week
      </Button>
      <Button type="submit" name="what" value="resolve" variant="ghost" size="sm" disabled={pending}>
        Resolve
      </Button>
    </form>
  );
}

export function RuleForm({
  rule,
}: {
  rule: {
    id: string; kind: string; enabled: boolean; threshold: number; minAffectedUsers: number;
    comparisonDays: number; cooldownHours: number;
    quietHoursStart: number | null; quietHoursEnd: number | null;
  };
}) {
  const [state, action, pending] = useActionState(saveAlertRuleAction, {} as State);
  return (
    <Card>
      <CardHeader title={titleCase(rule.kind)} />
      <CardBody>
        <form action={action} className="space-y-3">
          <input type="hidden" name="kind" value={rule.kind} />
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Select
            label="Enabled"
            name="enabled"
            defaultValue={rule.enabled ? "true" : "false"}
            options={[{ value: "true", label: "On" }, { value: "false", label: "Off" }]}
          />
          <Field label="Threshold" name="threshold" type="number" step="0.01" defaultValue={rule.threshold}
            hint="A relative change, or a multiple for the spike rules." />
          <Field label="Minimum affected users" name="minAffectedUsers" type="number"
            defaultValue={rule.minAffectedUsers} />
          <Field label="Comparison window (days)" name="comparisonDays" type="number"
            defaultValue={rule.comparisonDays} />
          <Field label="Cooldown (hours)" name="cooldownHours" type="number"
            defaultValue={rule.cooldownHours} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quiet from" name="quietHoursStart" type="number" min="0" max="23"
              defaultValue={rule.quietHoursStart ?? ""} />
            <Field label="Quiet until" name="quietHoursEnd" type="number" min="0" max="23"
              defaultValue={rule.quietHoursEnd ?? ""} />
          </div>
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save rule"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

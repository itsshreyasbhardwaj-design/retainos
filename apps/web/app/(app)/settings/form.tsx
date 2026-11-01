"use client";

import { useActionState } from "react";
import { updateSettingsAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Select, Textarea, ErrorBanner, SuccessBanner } from "@/components/ui";

export function SettingsForm({
  timezones, current,
}: {
  timezones: string[];
  current: {
    name: string; timezone: string; requireConsent: boolean; strictSchema: boolean;
    allowedOrigins: string[]; rawRetentionDays: number; inactivityDays: number;
  };
}) {
  const [state, action, pending] = useActionState(updateSettingsAction, {} as { error?: string; ok?: string });
  const zones = timezones.includes(current.timezone) ? timezones : [current.timezone, ...timezones];

  return (
    <Card>
      <CardHeader title="Configuration" />
      <CardBody>
        <form action={action} className="space-y-4">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />

          <Field label="Project name" name="name" defaultValue={current.name} required />
          <Select
            label="Reporting timezone"
            name="timezone"
            defaultValue={current.timezone}
            options={zones.map((t) => ({ value: t, label: t }))}
          />

          <label className="flex items-start gap-2.5 rounded-lg border border-navy-700/60 bg-navy-950/40 p-3">
            <input type="checkbox" name="requireConsent" defaultChecked={current.requireConsent} className="mt-0.5" />
            <span className="text-xs leading-relaxed">
              <span className="font-medium text-slate-300">Require explicit consent</span>
              <span className="mt-0.5 block text-slate-500">
                Events arriving without a consent flag are rejected. Recommended, and on by default.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 rounded-lg border border-navy-700/60 bg-navy-950/40 p-3">
            <input type="checkbox" name="strictSchema" defaultChecked={current.strictSchema} className="mt-0.5" />
            <span className="text-xs leading-relaxed">
              <span className="font-medium text-slate-300">Strict schema</span>
              <span className="mt-0.5 block text-slate-500">
                Reject events that have no registered schema. Turn this on once your event registry is settled;
                before then it will reject events you meant to send.
              </span>
            </span>
          </label>

          <Textarea
            label="Allowed origins"
            name="allowedOrigins"
            rows={3}
            defaultValue={current.allowedOrigins.join("\n")}
            placeholder={"https://app.example.com\n*.example.com"}
            hint="One per line. Leave blank to allow any origin. Supports a leading wildcard, e.g. *.example.com."
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Raw event retention (days)"
              name="rawRetentionDays"
              type="number"
              defaultValue={current.rawRetentionDays}
              hint="1 to 1095. Aggregates outlive raw events."
            />
            <Field
              label="Inactivity threshold (days)"
              name="inactivityDays"
              type="number"
              defaultValue={current.inactivityDays}
              hint="1 to 365. Match how often your product is meant to be used."
            />
          </div>

          <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save settings"}</Button>
        </form>
      </CardBody>
    </Card>
  );
}

"use client";

import { useActionState } from "react";
import { createProjectAction } from "@/lib/actions-auth";
import { Button, Field, Select, ErrorBanner } from "@/components/ui";

export function NewProjectForm({ timezones, orgName }: { timezones: string[]; orgName: string }) {
  const [state, action, pending] = useActionState(createProjectAction, {} as { error?: string });
  return (
    <form action={action} className="space-y-4">
      <ErrorBanner message={state?.error} />
      <Field label="Project name" name="name" required placeholder="Acme App" hint={`Created inside ${orgName}.`} />
      <Select
        label="Reporting timezone"
        name="timezone"
        defaultValue="Asia/Kolkata"
        options={timezones.map((t) => ({ value: t, label: t }))}
        hint="Daily and weekly buckets are computed in this zone. Timestamps are always stored in UTC."
      />
      <Select
        label="Currency"
        name="currency"
        defaultValue="INR"
        options={[
          { value: "INR", label: "INR — Indian rupee" },
          { value: "USD", label: "USD — US dollar" },
          { value: "EUR", label: "EUR — Euro" },
          { value: "GBP", label: "GBP — Pound sterling" },
          { value: "SGD", label: "SGD — Singapore dollar" },
          { value: "AED", label: "AED — UAE dirham" },
        ]}
        hint="Used for revenue reporting. Currencies are never converted without an explicit exchange rate."
      />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { runDoctorAction } from "@/lib/actions-product";
import { Button } from "@/components/ui";

export function RunDoctorButton() {
  const [state, action, pending] = useActionState(
    async () => runDoctorAction(),
    {} as { error?: string; ok?: string },
  );
  return (
    <form action={action} className="flex flex-wrap items-center justify-end gap-2">
      {state?.ok ? <span className="max-w-sm text-right text-xs text-emerald-400">{state.ok}</span> : null}
      {state?.error ? <span className="text-xs text-rose-500">{state.error}</span> : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Checking…" : "Re-check and save findings"}
      </Button>
    </form>
  );
}

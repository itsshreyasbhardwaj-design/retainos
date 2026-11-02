"use client";

import { useActionState } from "react";
import { refreshFrictionAction } from "@/lib/actions-product";
import { Button } from "@/components/ui";

export function RefreshFrictionButton() {
  const [state, action, pending] = useActionState(
    async () => refreshFrictionAction(),
    {} as { error?: string; ok?: string },
  );
  return (
    <form action={action} className="flex flex-wrap items-center justify-end gap-2">
      {state?.ok ? <span className="text-xs text-emerald-400">{state.ok}</span> : null}
      {state?.error ? <span className="text-xs text-rose-500">{state.error}</span> : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Detecting…" : "Run detectors"}
      </Button>
    </form>
  );
}

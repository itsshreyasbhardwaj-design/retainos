"use client";

import { useActionState } from "react";
import { saveBriefAction } from "@/lib/actions-product";
import { Button } from "@/components/ui";

export function SaveBriefButton() {
  const [state, action, pending] = useActionState(
    async () => saveBriefAction(),
    {} as { error?: string; ok?: string },
  );
  return (
    <form action={action} className="flex items-center gap-2">
      {state?.ok ? <span className="text-xs text-emerald-400">{state.ok}</span> : null}
      {state?.error ? <span className="text-xs text-rose-500">{state.error}</span> : null}
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save this brief"}
      </Button>
    </form>
  );
}

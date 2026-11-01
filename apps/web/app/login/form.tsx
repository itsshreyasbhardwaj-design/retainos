"use client";

import { useActionState } from "react";
import { loginAction } from "@/lib/actions-auth";
import { Button, Field, ErrorBanner } from "@/components/ui";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, {} as { error?: string });
  return (
    <form action={action} className="mt-5 space-y-4">
      <ErrorBanner message={state?.error} />
      <Field label="Email" name="email" type="email" required autoComplete="email" />
      <Field label="Password" name="password" type="password" required autoComplete="current-password" />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Checking…" : "Log in"}
      </Button>
    </form>
  );
}

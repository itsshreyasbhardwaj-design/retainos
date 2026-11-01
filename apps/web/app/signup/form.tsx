"use client";

import { useActionState } from "react";
import { signupAction } from "@/lib/actions-auth";
import { Button, Field, ErrorBanner } from "@/components/ui";

export function SignupForm() {
  const [state, action, pending] = useActionState(signupAction, {} as { error?: string });
  return (
    <form action={action} className="mt-5 space-y-4">
      <ErrorBanner message={state?.error} />
      <Field label="Your name" name="name" required autoComplete="name" />
      <Field label="Work email" name="email" type="email" required autoComplete="email" />
      <Field
        label="Password"
        name="password"
        type="password"
        required
        autoComplete="new-password"
        hint="At least 12 characters, with a lowercase letter and an uppercase letter or digit."
      />
      <Field label="Organization name" name="orgName" placeholder="Acme Software" hint="You can change this later." />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : "Create account"}
      </Button>
      <p className="text-[11px] leading-relaxed text-slate-500">
        By creating an account you agree to the terms. RetainOS stores your password only as a scrypt hash and
        never in plain text.
      </p>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { inviteMemberAction } from "@/lib/actions";
import { ROLES, ROLE_LABELS } from "@retainos/shared/roles";
import { Card, CardHeader, CardBody, Button, Field, Select, ErrorBanner, SuccessBanner } from "@/components/ui";

export function TeamForm({
  canManage, isOwner, seatsLeft,
}: { canManage: boolean; isOwner: boolean; seatsLeft: number }) {
  const [state, action, pending] = useActionState(inviteMemberAction, {} as { error?: string; ok?: string });

  if (!canManage) {
    return (
      <Card>
        <CardHeader title="Add a teammate" />
        <CardBody>
          <p className="text-xs leading-relaxed text-slate-400">
            Your role cannot manage members. Ask an owner or admin.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Add a teammate"
        subtitle={seatsLeft > 0 ? `${seatsLeft} seat${seatsLeft === 1 ? "" : "s"} left on your plan.` : "No seats left on your plan."}
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <ErrorBanner message={state?.error} />
          <SuccessBanner message={state?.ok} />
          <Field label="Email" name="email" type="email" required />
          <Field label="Name" name="name" placeholder="Optional" />
          <Field
            label="Initial password"
            name="password"
            type="password"
            hint="Only needed if they do not already have a RetainOS account. Give it to them out of band and ask them to change it."
          />
          <Select
            label="Role"
            name="role"
            defaultValue="viewer"
            options={ROLES.filter((r) => isOwner || r !== "owner").map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
          <Button type="submit" disabled={pending || seatsLeft === 0}>
            {pending ? "Adding…" : "Add member"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

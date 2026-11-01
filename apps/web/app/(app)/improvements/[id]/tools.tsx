"use client";

import { useActionState } from "react";
import {
  transitionImprovementAction, attachEvidenceAction, draftIssueAction, dispatchIssueAction,
} from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Textarea, Select, Badge, ErrorBanner, SuccessBanner, Caveats } from "@/components/ui";

export function ImprovementTools({
  improvementId, status, allowedNext, links,
}: {
  improvementId: string;
  status: string;
  allowedNext: readonly string[];
  links: Array<Record<string, unknown>>;
}) {
  const [moveState, move, moving] = useActionState(transitionImprovementAction, {} as { error?: string; ok?: string });
  const [evState, attach, attaching] = useActionState(attachEvidenceAction, {} as { error?: string; ok?: string });
  const [draftState, draft, drafting] = useActionState(draftIssueAction, {} as { error?: string; ok?: string });
  const [sendState, send, sending] = useActionState(dispatchIssueAction, {} as { error?: string; ok?: string });

  const pendingApproval = links.filter((l) => l.dispatch_state === "draft");
  const dispatched = links.filter((l) => l.dispatch_state === "dispatched");
  const failed = links.filter((l) => l.dispatch_state === "failed");

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Move this forward"
          subtitle="FixFlow is a workflow: a task cannot jump from detected straight to released."
        />
        <CardBody>
          <form action={move} className="space-y-3">
            <ErrorBanner message={moveState?.error} />
            <SuccessBanner message={moveState?.ok} />
            <input type="hidden" name="improvementId" value={improvementId} />
            {allowedNext.length === 0 ? (
              <p className="text-xs text-slate-400">No transitions available from {status.replace(/_/g, " ")}.</p>
            ) : (
              <>
                <Select
                  label="Next state"
                  name="status"
                  options={allowedNext.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))}
                  hint={
                    allowedNext.includes("approved")
                      ? "Approving requires the improvement:approve permission, and is recorded in the audit log."
                      : undefined
                  }
                />
                <Field label="Note (optional)" name="note" placeholder="Why this is moving" />
                <Button type="submit" size="sm" disabled={moving}>{moving ? "Moving…" : "Move"}</Button>
              </>
            )}
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Attach evidence" subtitle="A note, or a reference to something measured." />
        <CardBody>
          <form action={attach} className="space-y-3">
            <ErrorBanner message={evState?.error} />
            <SuccessBanner message={evState?.ok} />
            <input type="hidden" name="improvementId" value={improvementId} />
            <Select
              label="Kind"
              name="kind"
              defaultValue="note"
              options={[
                { value: "note", label: "Note" },
                { value: "feedback_item", label: "Feedback item" },
                { value: "funnel_step", label: "Funnel step" },
                { value: "retention_cohort", label: "Retention cohort" },
                { value: "event_metric", label: "Event metric" },
                { value: "activation_metric", label: "Activation metric" },
                { value: "revenue_metric", label: "Revenue metric" },
              ]}
            />
            <Field label="Reference id (optional)" name="referenceId" placeholder="fbk_…"
              hint="A feedback item must belong to this project; evidence cannot be borrowed across projects." />
            <Textarea label="Summary" name="summary" rows={2} required />
            <Button type="submit" size="sm" variant="secondary" disabled={attaching}>
              {attaching ? "Attaching…" : "Attach"}
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="GitHub"
          subtitle="Draft, review, then approve. Approval is the only thing that can send it."
        />
        <CardBody className="space-y-4">
          {dispatched.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-400">Created</p>
              <ul className="space-y-1.5">
                {dispatched.map((l) => (
                  <li key={String(l.id)} className="text-xs">
                    <a href={String(l.issue_url)} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">
                      {String(l.repository)}#{String(l.issue_number)} ↗
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {failed.length > 0 ? (
            <Caveats items={failed.map((l) => `Dispatch to ${String(l.repository)} failed: ${String(l.last_error ?? "unknown error")}`)} />
          ) : null}

          {pendingApproval.length > 0 ? (
            <form action={send} className="space-y-2">
              <ErrorBanner message={sendState?.error} />
              <SuccessBanner message={sendState?.ok} />
              <input type="hidden" name="linkId" value={String(pendingApproval[0]!.id)} />
              <p className="text-xs leading-relaxed text-slate-400">
                A draft for <code className="font-mono">{String(pendingApproval[0]!.repository)}</code> is waiting.
                Read it on the left, then approve to create it on GitHub.
              </p>
              <Button type="submit" size="sm" disabled={sending}>
                {sending ? "Creating…" : "Approve and create the issue"}
              </Button>
            </form>
          ) : (
            <form action={draft} className="space-y-3">
              <ErrorBanner message={draftState?.error} />
              <SuccessBanner message={draftState?.ok} />
              <input type="hidden" name="improvementId" value={improvementId} />
              <Field
                label="Repository"
                name="repository"
                required
                placeholder="owner/name"
                hint="Needs RETAINOS_GITHUB_TOKEN on the server, with Issues: write on this repository only."
              />
              <Button type="submit" size="sm" variant="secondary" disabled={drafting}>
                {drafting ? "Drafting…" : "Draft an issue"}
              </Button>
            </form>
          )}

          <Caveats tone="info" items={[
            "RetainOS never creates an issue without an explicit approval, and never pushes code or opens a pull request.",
            "The drafted issue states where reproduction steps are missing rather than inventing them.",
          ]} />
        </CardBody>
      </Card>
    </div>
  );
}

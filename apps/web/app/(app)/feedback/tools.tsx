"use client";

import { useActionState } from "react";
import {
  addFeedbackAction, rebuildClustersAction, mergeFeedbackAction,
  addFeedbackCommentAction, setFeedbackStatusAction,
} from "@/lib/actions";
import { FEEDBACK_STATUSES } from "@retainos/shared/vocabulary";
import { Card, CardHeader, CardBody, Button, Field, Textarea, Select, ErrorBanner, SuccessBanner, Badge } from "@/components/ui";

export function StatusControl({ feedbackId, status }: { feedbackId: string; status: string }) {
  return (
    <form action={setFeedbackStatusAction} className="shrink-0">
      <input type="hidden" name="feedbackId" value={feedbackId} />
      <label className="sr-only" htmlFor={`status-${feedbackId}`}>Status</label>
      <select
        id={`status-${feedbackId}`}
        name="status"
        defaultValue={status}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded-lg border border-navy-600 bg-navy-900 px-2 py-1 text-[11px] text-offwhite focus:border-blue-500 focus:outline-none"
      >
        {FEEDBACK_STATUSES.map((s) => (
          <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
        ))}
      </select>
    </form>
  );
}

export function FeedbackTools({
  kinds, selected, duplicates,
}: {
  kinds: Array<{ id: string; label: string }>;
  selected: { id: string; title: string } | null;
  duplicates: Array<{ id: string; title: string; similarity: number }>;
}) {
  const [addState, add, adding] = useActionState(addFeedbackAction, {} as { error?: string; ok?: string });
  const [clusterState, cluster, clustering] = useActionState(rebuildClustersAction, {} as { error?: string; ok?: string });
  const [mergeState, merge, merging] = useActionState(mergeFeedbackAction, {} as { error?: string; ok?: string });
  const [commentState, comment, commenting] = useActionState(addFeedbackCommentAction, {} as { error?: string; ok?: string });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Record feedback" subtitle="For something a customer told you outside the product." />
        <CardBody>
          <form action={add} className="space-y-3">
            <ErrorBanner message={addState?.error} />
            <SuccessBanner message={addState?.ok} />
            <Select label="Type" name="kind" options={kinds.map((k) => ({ value: k.id, label: k.label }))} defaultValue="bug" />
            <Field label="Summary" name="title" required placeholder="CSV export fails on large projects" />
            <Textarea label="Details" name="body" rows={3} placeholder="What they said, in their words where possible." />
            <Button type="submit" size="sm" disabled={adding}>{adding ? "Saving…" : "Record"}</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Regroup themes" subtitle="Recomputes groupings from shared terms. Curated groups are preserved." />
        <CardBody>
          <form action={cluster}>
            <ErrorBanner message={clusterState?.error} />
            <SuccessBanner message={clusterState?.ok} />
            <Button type="submit" variant="secondary" size="sm" disabled={clustering}>
              {clustering ? "Grouping…" : "Regroup"}
            </Button>
          </form>
        </CardBody>
      </Card>

      {selected ? (
        <>
          {duplicates.length > 0 ? (
            <Card>
              <CardHeader
                title="Possible duplicates"
                subtitle={`Similar to "${selected.title}" by shared terms. Check before merging.`}
              />
              <CardBody>
                <ErrorBanner message={mergeState?.error} />
                <SuccessBanner message={mergeState?.ok} />
                <ul className="space-y-2.5">
                  {duplicates.map((d) => (
                    <li key={d.id} className="rounded-lg border border-navy-700/60 bg-navy-950/40 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="min-w-0 text-xs text-slate-300">{d.title}</span>
                        <Badge tone="accent">{Math.round(d.similarity * 100)}% terms</Badge>
                      </div>
                      <form action={merge} className="mt-2">
                        <input type="hidden" name="duplicateId" value={d.id} />
                        <input type="hidden" name="canonicalId" value={selected.id} />
                        <Button type="submit" variant="secondary" size="sm" disabled={merging}>
                          Merge into the selected item
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Add a note" subtitle={`On "${selected.title}".`} />
            <CardBody>
              <form action={comment} className="space-y-3">
                <ErrorBanner message={commentState?.error} />
                <SuccessBanner message={commentState?.ok} />
                <input type="hidden" name="feedbackId" value={selected.id} />
                <Textarea label="Note" name="body" rows={3} required />
                <label className="flex items-start gap-2 text-[11px] leading-snug text-slate-400">
                  <input type="checkbox" name="internal" defaultChecked className="mt-0.5" />
                  <span>Internal only. Unchecked notes appear on the public portal.</span>
                </label>
                <Button type="submit" size="sm" disabled={commenting}>{commenting ? "Adding…" : "Add note"}</Button>
              </form>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}

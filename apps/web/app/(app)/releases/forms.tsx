"use client";

import { useActionState } from "react";
import { createReleaseAction, addChangelogAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, Field, Textarea, Select, ErrorBanner, SuccessBanner } from "@/components/ui";

export function ReleaseForms({
  improvements, releases,
}: {
  improvements: Array<{ id: string; label: string }>;
  releases: Array<{ id: string; label: string }>;
}) {
  const [relState, createRelease, creating] = useActionState(createReleaseAction, {} as { error?: string; ok?: string });
  const [logState, addLog, logging] = useActionState(addChangelogAction, {} as { error?: string; ok?: string });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Record a release" />
        <CardBody>
          <form action={createRelease} className="space-y-3">
            <ErrorBanner message={relState?.error} />
            <SuccessBanner message={relState?.ok} />
            <Field label="Version" name="version" required placeholder="2.4.0" />
            <Field label="Name" name="name" placeholder="Simplified onboarding" />
            <Field label="Release date" name="releasedAt" type="date" defaultValue={today} required />
            <Textarea label="Notes" name="notes" rows={2} />
            {improvements.length > 0 ? (
              <fieldset>
                <legend className="mb-1.5 text-xs font-medium text-slate-400">Improvements in this release</legend>
                <div className="space-y-1.5">
                  {improvements.map((i) => (
                    <label key={i.id} className="flex items-start gap-2 text-[11px] leading-snug text-slate-400">
                      <input type="checkbox" name="improvementIds" value={i.id} className="mt-0.5" />
                      <span>{i.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
            <Button type="submit" disabled={creating}>{creating ? "Recording…" : "Record release"}</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Add a changelog entry" subtitle="Known limitations belong here too, not only wins." />
        <CardBody>
          <form action={addLog} className="space-y-3">
            <ErrorBanner message={logState?.error} />
            <SuccessBanner message={logState?.ok} />
            {releases.length > 0 ? (
              <Select
                label="Release"
                name="releaseId"
                defaultValue=""
                options={[{ value: "", label: "Not tied to a release" }, ...releases.map((r) => ({ value: r.id, label: r.label }))]}
              />
            ) : null}
            <Select
              label="Category"
              name="category"
              defaultValue="improvement"
              options={[
                { value: "new_feature", label: "New feature" },
                { value: "improvement", label: "Improvement" },
                { value: "bug_fix", label: "Bug fix" },
                { value: "performance", label: "Performance" },
                { value: "known_limitation", label: "Known limitation" },
              ]}
            />
            <Field label="Title" name="title" required />
            <Textarea label="Detail" name="body" rows={2} />
            <label className="flex items-start gap-2 text-[11px] leading-snug text-slate-400">
              <input type="checkbox" name="isPublic" className="mt-0.5" />
              <span>Show on the public changelog.</span>
            </label>
            <Button type="submit" variant="secondary" disabled={logging}>{logging ? "Adding…" : "Add entry"}</Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

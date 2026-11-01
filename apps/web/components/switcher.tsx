"use client";

import { useState, useTransition } from "react";
import { cx } from "./ui.tsx";

/**
 * Organization and project switcher.
 *
 * Switching writes a cookie through a server action and reloads, so the server
 * re-resolves the scope from the database rather than trusting a client choice.
 */
export function Switcher({
  orgs, currentOrgId, projects, currentProjectId, onSwitchOrg, onSwitchProject,
}: {
  orgs: Array<{ id: string; name: string; isDemo: boolean }>;
  currentOrgId: string;
  projects: Array<{ id: string; name: string; isDemo: boolean }>;
  currentProjectId: string | null;
  onSwitchOrg: (formData: FormData) => Promise<void>;
  onSwitchProject: (formData: FormData) => Promise<void>;
}) {
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={(fd) => start(() => onSwitchOrg(fd))}>
        <label className="sr-only" htmlFor="org-select">Organization</label>
        <select
          id="org-select"
          name="orgId"
          defaultValue={currentOrgId}
          disabled={pending}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="rounded-lg border border-navy-600 bg-navy-900 px-2.5 py-1.5 text-xs text-offwhite
                     focus:border-blue-500 focus:outline-none disabled:opacity-60"
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>{o.name}{o.isDemo ? " (demo)" : ""}</option>
          ))}
        </select>
      </form>

      {projects.length > 0 ? (
        <form action={(fd) => start(() => onSwitchProject(fd))}>
          <label className="sr-only" htmlFor="project-select">Project</label>
          <select
            id="project-select"
            name="projectId"
            defaultValue={currentProjectId ?? ""}
            disabled={pending}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            className="rounded-lg border border-navy-600 bg-navy-900 px-2.5 py-1.5 text-xs text-offwhite
                       focus:border-blue-500 focus:outline-none disabled:opacity-60"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.isDemo ? " (demo)" : ""}</option>
            ))}
          </select>
        </form>
      ) : null}

      {pending ? <span className="text-[11px] text-slate-500">switching…</span> : null}
    </div>
  );
}

import type { Metadata } from "next";
import { appContext } from "@/lib/session";
import { NewProjectForm } from "./form";

export const metadata: Metadata = { title: "New project" };

/** Common IANA zones, India first given the launch market. */
const TIMEZONES = [
  "Asia/Kolkata", "UTC", "Europe/London", "Europe/Berlin", "America/New_York",
  "America/Chicago", "America/Los_Angeles", "Asia/Singapore", "Asia/Dubai",
  "Asia/Tokyo", "Australia/Sydney", "America/Sao_Paulo", "Africa/Lagos",
];

export default async function NewProject() {
  const ctx = await appContext();
  return (
    <div className="mx-auto max-w-lg px-5 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-offwhite">Create a project</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        A project is one application you want to understand. It gets its own event key, its own event schema and
        its own reporting timezone.
      </p>
      <div className="mt-6 rounded-xl border border-navy-700/70 bg-navy-900/60 p-6">
        <NewProjectForm timezones={TIMEZONES} orgName={ctx.org.name} />
      </div>
    </div>
  );
}

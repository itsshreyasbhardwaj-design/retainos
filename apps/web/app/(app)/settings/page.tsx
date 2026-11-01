import type { Metadata } from "next";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { jsonParse } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Caveats } from "@/components/ui";
import { SettingsForm } from "./form";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const TIMEZONES = [
  "Asia/Kolkata", "UTC", "Europe/London", "Europe/Berlin", "America/New_York",
  "America/Chicago", "America/Los_Angeles", "Asia/Singapore", "Asia/Dubai",
  "Asia/Tokyo", "Australia/Sydney", "America/Sao_Paulo", "Africa/Lagos",
];

export default async function Settings() {
  const ctx = await requireProject();
  const project = db().get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [ctx.project.id])!;

  return (
    <>
      <PageHeader
        title="Project settings"
        description="These choices change how every metric is computed, so they are shown wherever a metric appears."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SettingsForm
            timezones={TIMEZONES}
            current={{
              name: String(project.name),
              timezone: String(project.reporting_timezone),
              requireConsent: project.require_consent === 1,
              strictSchema: project.strict_schema === 1,
              allowedOrigins: jsonParse<string[]>(project.allowed_origins, []),
              rawRetentionDays: Number(project.raw_retention_days),
              inactivityDays: Number(project.inactivity_days),
            }}
          />
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Why these matter" />
            <CardBody>
              <dl className="space-y-3 text-xs leading-relaxed">
                {[
                  ["Reporting timezone", "Daily and weekly buckets are computed here. Timestamps are always stored in UTC; only the bucketing is local. Changing this changes every daily figure."],
                  ["Require consent", "With this on, an event without an explicit consent flag is rejected. The absence of a signal is not treated as agreement."],
                  ["Strict schema", "With this on, an event with no registered schema is rejected rather than accepted unvalidated. Turn it on once your event registry is settled."],
                  ["Allowed origins", "Enforced server-side, not just through CORS. Anyone can post with a public key from curl, so this is defence in depth rather than a security boundary."],
                  ["Raw event retention", "How long individual events are kept. Aggregated counts outlive them, so history survives without retaining event rows."],
                  ["Inactivity threshold", "What counts as inactive in your product. A fortnight is meaningless for a product used monthly."],
                ].map(([term, def]) => (
                  <div key={term}>
                    <dt className="font-medium text-slate-300">{term}</dt>
                    <dd className="mt-0.5 text-slate-400">{def}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>

          <Caveats items={[
            "Changing the reporting timezone re-buckets historical data. Figures you have already reported elsewhere may shift.",
            "Shortening raw retention deletes events permanently at the next retention run. Aggregates are kept.",
          ]} />
        </div>
      </div>
    </>
  );
}

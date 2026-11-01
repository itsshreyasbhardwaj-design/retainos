import type { Metadata } from "next";
import Link from "next/link";
import { requireProject } from "@/lib/session";
import { db } from "@/lib/db";
import { entitlementFor } from "@retainos/database";
import { PageHeader, Card, CardHeader, CardBody, Badge, Empty, Caveats, Button, Table, Th, Td, Metric } from "@/components/ui";
import { pct, num } from "@/lib/format";

export const metadata: Metadata = { title: "Onboarding" };
export const dynamic = "force-dynamic";

export default async function OnboardingBuilder() {
  const ctx = await requireProject();
  const handle = db();
  const entitlement = entitlementFor(handle, ctx.org.id);

  if (!entitlement.features.onboardOs) {
    return (
      <>
        <PageHeader title="Onboarding" />
        <Empty
          title="Not included on your plan"
          body={`The onboarding builder is part of the Starter plan and above. You are on ${entitlement.planId}.`}
          action={<Link href="/settings/billing"><Button>See plans</Button></Link>}
        />
      </>
    );
  }

  const flows = handle.all<Record<string, unknown>>(
    `SELECT f.*,
            (SELECT COUNT(*) FROM onboarding_steps s WHERE s.flow_id = f.id) AS step_count,
            (SELECT COUNT(*) FROM onboarding_progress p WHERE p.flow_id = f.id) AS started,
            (SELECT COUNT(*) FROM onboarding_progress p WHERE p.flow_id = f.id AND p.completed_at IS NOT NULL) AS completed,
            (SELECT COUNT(*) FROM onboarding_progress p WHERE p.flow_id = f.id AND p.dismissed_at IS NOT NULL) AS dismissed
       FROM onboarding_flows f WHERE f.project_id = ? ORDER BY f.created_at DESC`,
    [ctx.project.id],
  );

  return (
    <>
      <PageHeader
        title="Onboarding"
        description="Checklist flows whose steps complete when the matching event arrives, so progress reflects what users did rather than what they clicked past."
      />

      {flows.length === 0 ? (
        <>
          <Empty
            title="No onboarding flows"
            body={
              "A flow is a list of steps, each completed by an event your application already sends. RetainOS " +
              "tracks progress and completion; the UI is rendered by your own application using the embeddable " +
              "React components."
            }
          />
          <Card className="mt-5">
            <CardHeader title="How to add one" subtitle="The data model is in place; flows are created through the API or a seed script." />
            <CardBody>
              <p className="text-xs leading-relaxed text-slate-400">
                This screen reports on flows and their completion. Creating and editing flows through the UI is
                the part of OnboardOS that is not built yet — see FEATURE_STATUS.md, which records it as partial
                rather than claiming it is finished.
              </p>
              <div className="mt-3">
                <Caveats items={[
                  "Do not assume an onboarding overlay improves activation. Run it as an experiment: the honest default is that it makes no difference until shown otherwise.",
                  "Every flow is dismissible. Non-dismissible onboarding is a dark pattern and RetainOS does not offer it.",
                ]} />
              </div>
            </CardBody>
          </Card>
        </>
      ) : (
        <>
          <div className="space-y-5">
            {flows.map((f) => {
              const started = Number(f.started);
              const completed = Number(f.completed);
              const dismissed = Number(f.dismissed);
              const steps = handle.all<Record<string, unknown>>(
                "SELECT * FROM onboarding_steps WHERE flow_id = ? ORDER BY position ASC", [String(f.id)],
              );
              return (
                <Card key={String(f.id)}>
                  <CardHeader
                    title={String(f.name)}
                    subtitle={String(f.description)}
                    action={
                      <div className="flex items-center gap-2">
                        <Badge tone={f.is_active === 1 ? "good" : "neutral"}>
                          {f.is_active === 1 ? "active" : "inactive"}
                        </Badge>
                        {f.dismissible === 1 ? <Badge tone="info">dismissible</Badge> : <Badge tone="bad">not dismissible</Badge>}
                      </div>
                    }
                  />
                  <CardBody>
                    <div className="grid gap-3 sm:grid-cols-4">
                      <Metric label="Started" value={num(started)}
                        definition="Users who began this flow." />
                      <Metric label="Completed" value={num(completed)}
                        definition="Users who finished every required step." />
                      <Metric label="Completion rate" value={pct(started === 0 ? null : completed / started)}
                        definition="Completed over started." />
                      <Metric label="Dismissed" value={num(dismissed)}
                        definition="Users who chose to dismiss it. A high number is a signal worth reading."
                        tone={started > 0 && dismissed / started > 0.4 ? "bad" : undefined} />
                    </div>

                    {steps.length > 0 ? (
                      <div className="mt-4">
                        <Table>
                          <thead><tr><Th>Step</Th><Th>Completed by event</Th><Th>Help</Th></tr></thead>
                          <tbody>
                            {steps.map((s) => (
                              <tr key={String(s.id)}>
                                <Td>{String(s.position)}. {String(s.title)}</Td>
                                <Td><code className="font-mono text-[11px] text-slate-400">{String(s.completion_event)}</code></Td>
                                <Td className="text-[11px] text-slate-500">{String(s.help_text ?? "")}</Td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              );
            })}
          </div>

          <div className="mt-5">
            <Caveats items={[
              "A completion rate is not evidence the flow helped. Compare activation between users who saw it and users who did not, ideally as a controlled experiment.",
              "Creating and editing flows through this UI is not built yet. FEATURE_STATUS.md records OnboardOS as partial.",
            ]} />
          </div>
        </>
      )}
    </>
  );
}

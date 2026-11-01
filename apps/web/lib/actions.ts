"use server";

import { revalidatePath } from "next/cache";
import {
  upsertEventSpec, deleteEventSpec, issueSecretKey, revokeKey, updateProjectSettings,
  submitFeedback, setFeedbackStatus, addComment, mergeDuplicate, upsertTag, tagFeedback,
  softDeleteFeedback, createImprovement, attachEvidence, transitionImprovement, setOutcome,
  createRelease, addChangelogEntry, connectBilling, eraseSubject, applyProviderEvent,
  addMember, createUser, resolveProjectScope, requireFeature, consumeUsage, entitlementFor,
  writeAudit, enqueueJob, type ImprovementStatus, type FeedbackStatus,
} from "@retainos/database";
import {
  upsertActivationDefinition, saveFunnel, deleteFunnel, draftIssue, createIssueDraft,
  approveIssueDraft, getIssueLink, recordDispatchResult, createExperiment, startExperiment,
  stopExperiment, analyseExperiment, saveAnalysis, beforeAfter, saveImpactMeasurement,
  generateInsights, persistInsights, dismissInsight, rebuildClusters, weeklyBrief, saveReport,
  drainJobs, type FunnelStep,
} from "@retainos/analytics";
import { db } from "./db.ts";
import { appContext, requireProject } from "./session.ts";
import { dispatchGithubIssue } from "./github.ts";

type ActionResult = { error?: string; ok?: string };

function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
}
function int(fd: FormData, name: string, fallback: number): number {
  const n = Number(str(fd, name));
  return Number.isFinite(n) ? n : fallback;
}
function bool(fd: FormData, name: string): boolean {
  return fd.get(name) === "on" || fd.get(name) === "true";
}

/** Wrap an action so a thrown error becomes a message rather than a crash page. */
async function guard(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

// --- project settings -------------------------------------------------------

export async function updateSettingsAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const origins = str(fd, "allowedOrigins").split(/[\s,]+/).filter(Boolean);
    const r = updateProjectSettings(db(), ctx.projectScope, {
      name: str(fd, "name") || undefined,
      timezone: str(fd, "timezone") || undefined,
      requireConsent: bool(fd, "requireConsent"),
      strictSchema: bool(fd, "strictSchema"),
      allowedOrigins: origins,
      rawRetentionDays: int(fd, "rawRetentionDays", 90),
      inactivityDays: int(fd, "inactivityDays", 14),
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings");
    return { ok: "Settings saved." };
  });
}

export async function issueKeyAction(_p: unknown, fd: FormData): Promise<ActionResult & { secret?: string }> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = issueSecretKey(db(), ctx.projectScope, str(fd, "name") || "API key");
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings/sdk");
    // Shown once. It is not stored in plaintext and cannot be shown again.
    return { ok: "Key created. Copy it now — it will not be shown again.", secret: r.value.secret };
  }) as Promise<ActionResult & { secret?: string }>;
}

export async function revokeKeyAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = revokeKey(db(), ctx.projectScope, str(fd, "keyId"));
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings/sdk");
    return { ok: "Key revoked." };
  });
}

export async function saveEventSchemaAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const raw = str(fd, "properties");
    let properties: Array<{ name: string; type: "string" | "number" | "boolean" | "timestamp"; required: boolean }> = [];
    // One property per line: "name:type:required".
    for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [name, type = "string", required = ""] = line.split(":").map((p) => p.trim());
      if (!name) continue;
      if (!["string", "number", "boolean", "timestamp"].includes(type)) {
        return { error: `Property "${name}" has an unsupported type "${type}". Use string, number, boolean or timestamp.` };
      }
      properties.push({ name, type: type as never, required: required === "required" });
    }
    const r = upsertEventSpec(db(), ctx.projectScope, {
      name: str(fd, "name"),
      description: str(fd, "description") || undefined,
      properties,
      allowUnknownProperties: !bool(fd, "closed"),
      deprecated: bool(fd, "deprecated"),
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings/sdk");
    return { ok: `Schema saved at version ${r.value.version}.` };
  });
}

export async function deleteEventSchemaAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = deleteEventSpec(db(), ctx.projectScope, str(fd, "name"));
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings/sdk");
    return { ok: "Schema removed." };
  });
}

export async function saveActivationAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = upsertActivationDefinition(db(), { orgId: ctx.org.id, projectId: ctx.project.id }, {
      id: str(fd, "id") || undefined,
      name: str(fd, "name") || "Activation",
      activationEvent: str(fd, "activationEvent"),
      signupEvent: str(fd, "signupEvent") || "signup_completed",
      windowDays: int(fd, "windowDays", 7),
      isPrimary: true,
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/activation");
    return { ok: "Activation definition saved." };
  });
}

// --- funnels ----------------------------------------------------------------

export async function saveFunnelAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const steps: FunnelStep[] = str(fd, "steps")
      .split("\n").map((l) => l.trim()).filter(Boolean)
      .map((event) => ({ event }));
    if (steps.length < 2) return { error: "A funnel needs at least two steps, one per line." };
    const r = saveFunnel(db(), { orgId: ctx.org.id, projectId: ctx.project.id, userId: ctx.user.id }, {
      name: str(fd, "name") || "Funnel",
      steps,
      conversionWindowHours: int(fd, "windowHours", 168),
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/analytics/funnels");
    return { ok: "Funnel saved." };
  });
}

export async function deleteFunnelAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = deleteFunnel(db(), ctx.project.id, str(fd, "funnelId"));
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/analytics/funnels");
    return { ok: "Funnel deleted." };
  });
}

// --- feedback ---------------------------------------------------------------

export async function addFeedbackAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = submitFeedback(db(), { orgId: ctx.org.id, projectId: ctx.project.id }, {
      kind: (str(fd, "kind") || "general") as never,
      title: str(fd, "title"),
      body: str(fd, "body"),
      source: "manual",
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/feedback");
    return { ok: "Feedback recorded." };
  });
}

export async function setFeedbackStatusAction(fd: FormData): Promise<void> {
  const ctx = await requireProject();
  setFeedbackStatus(db(), ctx.projectScope, String(fd.get("feedbackId")), String(fd.get("status")) as FeedbackStatus);
  revalidatePath("/feedback");
}

export async function addFeedbackCommentAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = addComment(db(), ctx.projectScope, str(fd, "feedbackId"), str(fd, "body"), bool(fd, "internal"));
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/feedback");
    return { ok: "Comment added." };
  });
}

export async function mergeFeedbackAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = mergeDuplicate(db(), ctx.projectScope, str(fd, "duplicateId"), str(fd, "canonicalId"));
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/feedback");
    return { ok: "Merged as a duplicate." };
  });
}

export async function deleteFeedbackAction(fd: FormData): Promise<void> {
  const ctx = await requireProject();
  softDeleteFeedback(db(), ctx.projectScope, String(fd.get("feedbackId")));
  revalidatePath("/feedback");
}

export async function rebuildClustersAction(_p: unknown): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = rebuildClusters(db(), { orgId: ctx.org.id, projectId: ctx.project.id });
    revalidatePath("/feedback");
    return { ok: `Grouped ${r.itemsGrouped} items into ${r.clusters} themes. Review and correct them — grouping is by shared terms, not meaning.` };
  });
}

// --- improvements and FixFlow ----------------------------------------------

export async function createImprovementAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const handle = db();
    const gate = requireFeature(handle, ctx.scope, "fixFlow");
    if (!gate.ok) return { error: gate.error.message };

    const r = createImprovement(handle, ctx.projectScope, {
      title: str(fd, "title"),
      description: str(fd, "description"),
      affectedWorkflow: str(fd, "affectedWorkflow") || undefined,
      hypothesis: str(fd, "hypothesis") || undefined,
      investigation: str(fd, "investigation") || undefined,
      proposedWork: str(fd, "proposedWork") || undefined,
      acceptanceCriteria: str(fd, "acceptanceCriteria") || undefined,
      measurementPlan: str(fd, "measurementPlan") || undefined,
      priority: (str(fd, "priority") || undefined) as never,
      priorityRationale: str(fd, "priorityRationale") || undefined,
      primaryMetric: str(fd, "primaryMetric") || undefined,
    });
    if (!r.ok) return { error: r.error.message };

    // Carry across evidence the caller selected, with its snapshot frozen.
    const evidenceSummary = str(fd, "evidenceSummary");
    const evidenceKind = str(fd, "evidenceKind");
    if (evidenceSummary && evidenceKind) {
      let snapshot: Record<string, unknown> = {};
      try {
        snapshot = JSON.parse(str(fd, "evidenceSnapshot") || "{}");
      } catch {
        snapshot = {};
      }
      attachEvidence(handle, ctx.projectScope, r.value.id, {
        kind: evidenceKind as never,
        referenceId: str(fd, "evidenceReferenceId") || null,
        summary: evidenceSummary,
        snapshot,
      });
    }
    revalidatePath("/improvements");
    return { ok: "Improvement task created." };
  });
}

export async function attachEvidenceAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = attachEvidence(db(), ctx.projectScope, str(fd, "improvementId"), {
      kind: (str(fd, "kind") || "note") as never,
      referenceId: str(fd, "referenceId") || null,
      summary: str(fd, "summary"),
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath(`/improvements/${str(fd, "improvementId")}`);
    return { ok: "Evidence attached." };
  });
}

export async function transitionImprovementAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = transitionImprovement(
      db(), ctx.projectScope, str(fd, "improvementId"),
      str(fd, "status") as ImprovementStatus, str(fd, "note") || undefined,
    );
    if (!r.ok) return { error: r.error.message };
    revalidatePath(`/improvements/${str(fd, "improvementId")}`);
    return { ok: `Moved to ${str(fd, "status").replace(/_/g, " ")}.` };
  });
}

export async function draftIssueAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const handle = db();
    const gate = requireFeature(handle, ctx.scope, "githubIntegration");
    if (!gate.ok) return { error: gate.error.message };

    const improvementId = str(fd, "improvementId");
    const draft = draftIssue(handle, ctx.project.id, improvementId);
    if (!draft.ok) return { error: draft.error.message };
    const created = createIssueDraft(handle, { orgId: ctx.org.id, projectId: ctx.project.id, userId: ctx.user.id }, {
      improvementId, repository: str(fd, "repository"), draft: draft.value,
    });
    if (!created.ok) return { error: created.error.message };
    revalidatePath(`/improvements/${improvementId}`);
    return { ok: "Issue drafted. Review it, then approve to create it on GitHub." };
  });
}

/**
 * Approve and dispatch a GitHub issue.
 *
 * Two distinct steps in one submission, in this order: the approval is recorded
 * first, so if the network call fails there is still an auditable record that a
 * human approved this exact text.
 */
export async function dispatchIssueAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const handle = db();
    const linkId = str(fd, "linkId");

    const approved = approveIssueDraft(handle, { orgId: ctx.org.id, projectId: ctx.project.id, userId: ctx.user.id }, linkId);
    if (!approved.ok) return { error: approved.error.message };

    const quota = consumeUsage(handle, ctx.org.id, "integration_syncs", 1);
    if (quota.allowed === 0) {
      return { error: `Your plan allows ${quota.limit} integration syncs per month and you have used ${quota.used}.` };
    }

    const link = getIssueLink(handle, ctx.project.id, linkId);
    if (!link) return { error: "Issue draft not found." };

    const result = await dispatchGithubIssue({
      repository: String(link.repository),
      title: String(link.draft_title),
      body: String(link.draft_body),
      labels: JSON.parse(String(link.labels ?? "[]")) as string[],
    });

    recordDispatchResult(handle, linkId, result);
    writeAudit(handle, {
      orgId: ctx.org.id, actorUserId: ctx.user.id,
      action: "error" in result ? "github.dispatch_failed" : "github.issue_created",
      targetKind: "github_issue_link", targetId: linkId,
      detail: "error" in result ? { error: result.error } : { issueNumber: result.issueNumber, repository: link.repository },
    });
    revalidatePath(`/improvements/${String(link.improvement_id)}`);

    return "error" in result
      ? { error: `GitHub rejected the request: ${result.error}` }
      : { ok: `Created issue #${result.issueNumber} in ${String(link.repository)}.` };
  });
}

// --- releases and changelog -------------------------------------------------

export async function createReleaseAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const releasedAt = str(fd, "releasedAt") ? Date.parse(str(fd, "releasedAt")) : Date.now();
    if (!Number.isFinite(releasedAt)) return { error: "Enter a valid release date." };
    const improvementIds = fd.getAll("improvementIds").filter((v): v is string => typeof v === "string");
    const r = createRelease(db(), ctx.projectScope, {
      name: str(fd, "name"), version: str(fd, "version"), releasedAt,
      notes: str(fd, "notes"), improvementIds,
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/releases");
    return { ok: "Release recorded." };
  });
}

export async function addChangelogAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = addChangelogEntry(db(), ctx.projectScope, {
      releaseId: str(fd, "releaseId") || null,
      category: (str(fd, "category") || "improvement") as never,
      title: str(fd, "title"), body: str(fd, "body"), isPublic: bool(fd, "isPublic"),
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/changelog");
    return { ok: "Changelog entry added." };
  });
}

// --- ImpactLab --------------------------------------------------------------

export async function measureImpactAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const handle = db();
    const gate = requireFeature(handle, ctx.scope, "impactLab");
    if (!gate.ok) return { error: gate.error.message };

    const releaseId = str(fd, "releaseId");
    const release = handle.get<{ released_at: number; version: string }>(
      "SELECT released_at, version FROM releases WHERE id = ? AND project_id = ?", [releaseId, ctx.project.id],
    );
    if (!release) return { error: "Release not found in this project." };

    const r = beforeAfter(handle, ctx.project.id, {
      releaseAt: release.released_at,
      windowDays: int(fd, "windowDays", 14),
      metricKind: "event_conversion",
      metricLabel: str(fd, "metricLabel") || "Conversion",
      denominatorEvent: str(fd, "denominatorEvent") || "signup_completed",
      numeratorEvent: str(fd, "numeratorEvent") || "core_action_completed",
      timezone: ctx.projectScope.timezone,
    });
    if (!r.ok) return { error: r.error.message };

    saveImpactMeasurement(handle, { orgId: ctx.org.id, projectId: ctx.project.id }, {
      improvementId: str(fd, "improvementId") || null,
      releaseId,
      method: "before_after",
      metricKind: "event_conversion",
      metricConfig: {
        denominatorEvent: str(fd, "denominatorEvent"),
        numeratorEvent: str(fd, "numeratorEvent"),
      },
      windowDays: int(fd, "windowDays", 14),
      result: r.value,
    });
    revalidatePath("/impact");
    return { ok: "Measured. Read the confounders before drawing a conclusion." };
  });
}

// --- experiments ------------------------------------------------------------

export async function createExperimentAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const handle = db();
    const gate = requireFeature(handle, ctx.scope, "experiments");
    if (!gate.ok) return { error: gate.error.message };

    const r = createExperiment(handle, { orgId: ctx.org.id, projectId: ctx.project.id, userId: ctx.user.id }, {
      key: str(fd, "key"),
      name: str(fd, "name"),
      hypothesis: str(fd, "hypothesis"),
      primaryMetricEvent: str(fd, "primaryMetricEvent"),
      primaryMetricKind: "conversion",
      minExposuresPerVariant: int(fd, "minExposures", 200),
      improvementId: str(fd, "improvementId") || null,
      variants: [
        { key: "control", name: "Control", isControl: true, weight: 0.5 },
        { key: "treatment", name: str(fd, "treatmentName") || "Treatment", weight: 0.5 },
      ],
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/experiments");
    return { ok: "Experiment created as a draft. Start it when the code is live." };
  });
}

export async function startExperimentAction(fd: FormData): Promise<void> {
  const ctx = await requireProject();
  startExperiment(db(), ctx.project.id, String(fd.get("experimentId")));
  revalidatePath("/experiments");
}

export async function stopExperimentAction(fd: FormData): Promise<void> {
  const ctx = await requireProject();
  stopExperiment(db(), ctx.project.id, String(fd.get("experimentId")));
  revalidatePath("/experiments");
}

export async function analyseExperimentAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const handle = db();
    const r = analyseExperiment(handle, ctx.project.id, str(fd, "experimentId"));
    if (!r.ok) return { error: r.error.message };
    saveAnalysis(handle, ctx.org.id, r.value);
    if (r.value.verdict !== "invalid_experiment") {
      const experiment = handle.get<{ improvement_id: string | null }>(
        "SELECT improvement_id FROM experiments WHERE id = ?", [str(fd, "experimentId")],
      );
      if (experiment?.improvement_id) {
        setOutcome(handle, ctx.projectScope, experiment.improvement_id, r.value.verdict);
      }
    }
    revalidatePath("/experiments");
    return { ok: `Analysed: ${r.value.verdict.replace(/_/g, " ")}.` };
  });
}

// --- RetainAI and reports ---------------------------------------------------

export async function runAnalysisAction(_p: unknown): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const handle = db();
    const generated = generateInsights(handle, ctx.project.id, { timezone: ctx.projectScope.timezone });
    const r = persistInsights(handle, { orgId: ctx.org.id, projectId: ctx.project.id }, generated);
    revalidatePath("/ai");
    return {
      ok: `Analysis complete: ${r.created} new finding${r.created === 1 ? "" : "s"}, ${r.skipped} already known.`,
    };
  });
}

export async function dismissInsightAction(fd: FormData): Promise<void> {
  const ctx = await requireProject();
  dismissInsight(db(), ctx.project.id, String(fd.get("insightId")));
  revalidatePath("/ai");
}

export async function generateReportAction(_p: unknown): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const handle = db();
    const quota = consumeUsage(handle, ctx.org.id, "reports_generated", 1);
    if (quota.allowed === 0) {
      return { error: `Your plan allows ${quota.limit} reports per month and you have used ${quota.used}.` };
    }
    const brief = weeklyBrief(handle, ctx.project.id, { timezone: ctx.projectScope.timezone });
    saveReport(handle, { orgId: ctx.org.id, projectId: ctx.project.id, userId: ctx.user.id },
      "weekly_brief", brief, { start: brief.periodStart, end: brief.periodEnd });
    revalidatePath("/reports");
    return { ok: "Weekly brief generated." };
  });
}

// --- privacy ----------------------------------------------------------------

export async function eraseSubjectAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = eraseSubject(db(), ctx.projectScope, {
      kind: (str(fd, "subjectKind") || "external_id") as "external_id" | "anonymous_id",
      value: str(fd, "subjectValue"),
    });
    if (!r.ok) return { error: r.error.message };
    const rep = r.value.report;
    revalidatePath("/settings/privacy");
    return {
      ok: rep.identitiesDeleted === 0
        ? "No matching user was found in this project. Nothing was deleted."
        : `Erased ${rep.identitiesDeleted} identity record(s), ${rep.eventsDeleted} events, and anonymised ` +
          `${rep.feedbackAnonymised} feedback item(s). Affected aggregates are queued for recomputation.`,
    };
  });
}

// --- team -------------------------------------------------------------------

export async function inviteMemberAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await appContext();
    const handle = db();
    const email = str(fd, "email");
    const role = str(fd, "role") || "viewer";

    // Local-first: there is no email provider by default, so a teammate is
    // added directly with a password you give them out of band. This is stated
    // in the UI rather than pretending an invitation email was sent.
    let userId = handle.get<{ id: string }>("SELECT id FROM users WHERE email = ?", [email.toLowerCase()])?.id;
    if (!userId) {
      const created = createUser(handle, {
        email, name: str(fd, "name") || email.split("@")[0]!, password: str(fd, "password"),
      });
      if (!created.ok) return { error: created.error.message };
      userId = created.value.id;
    }
    const added = addMember(handle, ctx.scope, { userId, role: role as never });
    if (!added.ok) return { error: added.error.message };
    revalidatePath("/settings/team");
    return { ok: `${email} added as ${role.replace(/_/g, " ")}.` };
  });
}

// --- billing simulator ------------------------------------------------------

export async function changePlanAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await appContext();
    const handle = db();
    if (ctx.org.role !== "owner") return { error: "Only an owner can change the plan." };

    const planId = str(fd, "planId");
    if (!["free", "starter", "growth", "agency"].includes(planId)) return { error: "Unknown plan." };
    const interval = str(fd, "interval") === "year" ? "year" : "month";
    const now = Date.now();

    handle.run(
      `UPDATE org_subscriptions SET plan_id = ?, interval = ?, status = 'active', provider = 'simulator',
         current_period_start = ?, current_period_end = ?, updated_at = ?
       WHERE org_id = ?`,
      [planId, interval, now, now + (interval === "year" ? 365 : 30) * 86_400_000, now, ctx.org.id],
    );
    writeAudit(handle, {
      orgId: ctx.org.id, actorUserId: ctx.user.id, action: "billing.plan_changed",
      targetKind: "organization", targetId: ctx.org.id,
      detail: { planId, interval, provider: "simulator", simulated: true },
    }, now);
    revalidatePath("/settings/billing");
    return {
      ok: `Plan changed to ${planId} (${interval}ly) using the development billing simulator. ` +
          "No payment was taken and none was simulated as confirmed.",
    };
  });
}

export async function connectBillingAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const r = connectBilling(db(), ctx.projectScope, (str(fd, "provider") || "simulator") as never);
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings/integrations");
    return {
      ok: "Connection recorded. It stays disconnected until a verified webhook event arrives, " +
          "so the status reflects reality rather than intent.",
    };
  });
}

// --- worker -----------------------------------------------------------------

export async function runWorkerAction(_p: unknown): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireProject();
    const handle = db();
    enqueueJob(handle, {
      orgId: ctx.org.id, projectId: ctx.project.id, kind: "recompute_day",
      dedupeKey: `manual_recompute:${ctx.project.id}:${Date.now()}`,
    });
    const results = drainJobs(handle, { max: 50 });
    const failed = results.filter((r) => !r.ok);
    revalidatePath("/dashboard");
    return failed.length > 0
      ? { error: `${failed.length} of ${results.length} jobs failed: ${failed.map((f) => f.detail).join("; ")}` }
      : { ok: `Processed ${results.length} job${results.length === 1 ? "" : "s"}.` };
  });
}

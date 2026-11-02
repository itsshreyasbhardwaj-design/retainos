"use server";

import { revalidatePath } from "next/cache";
import { entitlementFor, writeAudit } from "@retainos/database";
import {
  refreshFrictionGraph, transitionCase, linkCaseToImprovement, caseIdentityIds,
  type FrictionStatus,
  setWeights, setEstimate, rankOpportunities, DEFAULT_WEIGHTS, type FactorWeights,
  runInstrumentationDoctor, persistFindings,
  recordImpact, observedMovementForIdentities, estimateMonthlyRevenue,
  upsertHealthDefinition, assessHealth, recordHealthObservation, listHealthDefinitions,
  upsertPlaybook, approvePlaybook, setPlaybookStatus, getPlaybook, enrolIdentities,
  setMessagingConsent, measurePlaybook, type PlaybookKind, type TriggerKind, type Channel,
  upsertAlertRule, ensureDefaultAlertRules, runAlertChecks, acknowledgeAlert, resolveAlert,
  snoozeAlert, type AlertKind,
  connectProvider, verifyConnection, revokeConnection, setAuthoritativeSource,
  importEvents, csvToEvents, revertSyncRun, type Provider, type SourceDomain,
  generateBrief, saveBrief,
  listActivationDefinitions,
} from "@retainos/analytics";
import { db } from "./db.ts";
import { requireProject, requirePermission } from "./session.ts";

type ActionResult = { error?: string; ok?: string };

function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
}
function int(fd: FormData, name: string, fallback: number): number {
  const n = Number(str(fd, name));
  return Number.isFinite(n) ? n : fallback;
}
function dec(fd: FormData, name: string, fallback: number): number {
  const n = Number(str(fd, name));
  return Number.isFinite(n) ? n : fallback;
}
function bool(fd: FormData, name: string): boolean {
  return fd.get(name) === "on" || fd.get(name) === "true";
}

async function guard(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

/** Shared project context plus the ids every engine takes. */
async function ctxWithIds() {
  const ctx = await requireProject();
  return {
    ctx,
    handle: db(),
    ids: { orgId: ctx.org.id, projectId: ctx.project.id, userId: ctx.user.id },
  };
}

function activationEventFor(handle: ReturnType<typeof db>, projectId: string): string | undefined {
  const definitions = listActivationDefinitions(handle, projectId);
  return (definitions.find((d) => d.isPrimary) ?? definitions[0])?.activationEvent;
}

// --- FrictionGraph ---------------------------------------------------------

export async function refreshFrictionAction(): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "analytics:read");
    const result = refreshFrictionGraph(handle, ids, {
      timezone: ctx.project.timezone,
      lookbackDays: 28,
    });
    revalidatePath("/friction");
    revalidatePath("/opportunities");
    return {
      ok: `${result.detected} case(s) detected, ${result.created} new, ${result.updated} updated. ` +
        "Existing statuses and dismissals were left alone.",
    };
  });
}

export async function transitionCaseAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "improvement:manage");
    const r = transitionCase(handle, ids, str(fd, "caseId"), str(fd, "status") as FrictionStatus,
      str(fd, "note") || undefined);
    if (!r.ok) return { error: r.error.message };
    writeAudit(handle, {
      orgId: ctx.org.id,
      actorUserId: ctx.user.id,
      action: "friction_case.transition",
      targetKind: "friction_case",
      targetId: str(fd, "caseId"),
      detail: { projectId: ctx.project.id, to: str(fd, "status") },
    });
    revalidatePath("/friction");
    revalidatePath(`/friction/${str(fd, "caseId")}`);
    return { ok: "Status updated." };
  });
}

export async function linkCaseAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle } = await ctxWithIds();
    requirePermission(ctx.org.role, "improvement:manage");
    const r = linkCaseToImprovement(handle, ctx.project.id, str(fd, "caseId"), str(fd, "improvementId"));
    if (!r.ok) return { error: r.error.message };
    revalidatePath(`/friction/${str(fd, "caseId")}`);
    return { ok: "Linked to the improvement." };
  });
}

// --- Opportunity engine ----------------------------------------------------

export async function setWeightsAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const weights = {} as FactorWeights;
    for (const factor of Object.keys(DEFAULT_WEIGHTS) as Array<keyof FactorWeights>) {
      weights[factor] = dec(fd, factor, DEFAULT_WEIGHTS[factor]);
    }
    const r = setWeights(handle, ids, weights);
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/opportunities");
    return { ok: "Weights saved. The ranking has been recomputed with them." };
  });
}

export async function setEstimateAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "improvement:manage");
    const r = setEstimate(handle, ids, str(fd, "caseId"), {
      engineeringEffort: str(fd, "effort") || null,
      strategicImportance: str(fd, "importance") || null,
      hasWorkaround: str(fd, "hasWorkaround") === "" ? null : bool(fd, "hasWorkaround"),
      note: str(fd, "note") || null,
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/opportunities");
    revalidatePath(`/friction/${str(fd, "caseId")}`);
    return { ok: "Estimate saved. Only the factors you answered now count." };
  });
}

export async function rerankAction(): Promise<ActionResult> {
  return guard(async () => {
    const { handle, ids } = await ctxWithIds();
    const ranked = rankOpportunities(handle, ids);
    revalidatePath("/opportunities");
    return { ok: `${ranked.length} case(s) ranked.` };
  });
}

// --- Instrumentation Doctor ------------------------------------------------

export async function runDoctorAction(): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    const report = runInstrumentationDoctor(handle, ctx.project.id, {
      timezone: ctx.project.timezone,
    });
    const stored = persistFindings(handle, ids, report);
    revalidatePath("/settings/instrumentation");
    return {
      ok: `${report.checksRun} checks run. ${stored.created} new finding(s), ${stored.resolved} resolved.`,
    };
  });
}

// --- Revenue Impact Studio -------------------------------------------------

export async function recordObservedImpactAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "improvement:manage");
    const entitlement = entitlementFor(handle, ctx.org.id);
    if (!entitlement.features.revenueImpactStudio) {
      return { error: "The Revenue Impact Studio is part of the Growth plan and above." };
    }

    const caseId = str(fd, "caseId");
    const days = int(fd, "windowDays", 30);
    const to = Date.now();
    const from = to - days * 86_400_000;

    // The cohort is the users the case actually affected, read from the case's
    // own membership rather than supplied by whoever wants the number.
    const identityIds = caseIdentityIds(handle, ctx.project.id, caseId);

    const movements = observedMovementForIdentities(handle, ctx.project.id, identityIds, from, to);
    if (movements.length === 0) {
      return {
        error: "No subscriptions belong to the users this case affected, so there is no observed movement " +
          "to record. That is a finding in itself, not an error to work around.",
      };
    }

    let recorded = 0;
    for (const movement of movements) {
      const r = recordImpact(handle, ids, {
        label: `Churned MRR among users affected by this case (${movement.currency})`,
        classification: "observed",
        basis: {
          billingRecordsForExactEntities: true,
          randomisedExperimentId: null,
          experimentConclusive: false,
          assumptions: [],
          observationalComparison: false,
          entityCount: movement.entityCount,
        },
        amountMinor: movement.churnedMinor,
        currency: movement.currency,
        periodStart: from,
        periodEnd: to,
        method:
          `Sum of monthly recurring revenue at the start of the window for subscriptions belonging to the ` +
          `${movement.entityCount} user(s) this case affected, where that revenue was zero by the end. ` +
          `Those users were paying ${movement.startMrrMinor} minor units between them at the start of the ` +
          `window and ${movement.endMrrMinor} at the end. Annual plans divided by 12. No model, no ` +
          "extrapolation.",
        limitations: movement.churnedMinor === 0
          ? [
            "Nothing has actually been lost yet. This is a measurement of zero, not an absence of a " +
            "measurement, and it says the revenue attached to this case is still being paid.",
          ]
          : [
            "An observed amount is not a causal claim: these users stopped paying, and this case affected " +
            "them, but the case is not proven to be why.",
          ],
        caseId,
      });
      if (!r.ok) return { error: r.error.message };
      recorded++;
    }
    revalidatePath("/revenue/impact");
    revalidatePath(`/friction/${caseId}`);
    return { ok: `${recorded} observed record(s) stored, one per currency.` };
  });
}

export async function recordEstimateAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "improvement:manage");
    const entitlement = entitlementFor(handle, ctx.org.id);
    if (!entitlement.features.revenueImpactStudio) {
      return { error: "The Revenue Impact Studio is part of the Growth plan and above." };
    }

    const estimate = estimateMonthlyRevenue({
      label: str(fd, "label") || "Estimated monthly revenue effect",
      affectedUsers: int(fd, "affectedUsers", 0),
      conversionDelta: dec(fd, "conversionDelta", 0) / 100,
      conversionDeltaSource: (str(fd, "deltaSource") || "user_supplied") as never,
      arpuMinor: int(fd, "arpuMinor", 0),
      arpuSource: (str(fd, "arpuSource") || "user_supplied") as never,
      currency: str(fd, "currency") || "INR",
      horizonMonths: int(fd, "horizonMonths", 12),
    });

    const r = recordImpact(handle, ids, {
      label: estimate.label,
      classification: estimate.classification,
      basis: {
        billingRecordsForExactEntities: false,
        randomisedExperimentId: null,
        experimentConclusive: false,
        assumptions: estimate.assumptions,
        observationalComparison: false,
        entityCount: int(fd, "affectedUsers", 0),
      },
      amountMinor: estimate.amountMinor,
      currency: estimate.currency,
      method: estimate.method,
      limitations: estimate.limitations,
      caseId: str(fd, "caseId") || null,
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/revenue/impact");
    return {
      ok: estimate.amountMinor === null
        ? "Recorded as insufficient evidence: an input was zero, so no figure was produced."
        : `Recorded as an estimate, with a range of ${estimate.rangeMinor![0]} to ${estimate.rangeMinor![1]}.`,
    };
  });
}

// --- Customer health ------------------------------------------------------

export async function saveHealthDefinitionAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const signals = (["recent_activity", "activity_trend", "breadth_of_use", "activation_reached",
      "seat_engagement", "error_exposure", "unresolved_feedback", "billing_status"] as const)
      .map((signal) => ({ signal, weight: dec(fd, signal, 1) }));
    const r = upsertHealthDefinition(handle, ids, {
      name: str(fd, "name") || "Default", signals, isPrimary: true,
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/health");
    return { ok: "Saved. The same observations are now weighed differently." };
  });
}

export async function snapshotHealthAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    const definitions = listHealthDefinitions(handle, ctx.project.id);
    const definition = definitions.find((d) => d.isPrimary) ?? definitions[0];
    if (!definition) return { error: "Save a health definition first, so the snapshot has something to record against." };

    const kind = (str(fd, "kind") || "account") as "identity" | "account";
    const subjectId = str(fd, "subjectId");
    const assessment = assessHealth(handle, ctx.project.id, { kind, id: subjectId }, {
      activationEvent: activationEventFor(handle, ctx.project.id),
      coreEvents: str(fd, "coreEvents").split(/[\s,]+/).filter(Boolean),
    });
    const stored = recordHealthObservation(handle, ids, definition.id, assessment);
    revalidatePath("/health");
    revalidatePath(`/health/${encodeURIComponent(subjectId)}`);
    return {
      ok: stored.created
        ? `Recorded as "${assessment.state}".`
        : "That exact observation was already recorded.",
    };
  });
}

// --- Playbooks -------------------------------------------------------------

export async function savePlaybookAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const entitlement = entitlementFor(handle, ctx.org.id);
    if (!entitlement.features.playbooks) {
      return { error: "Retention playbooks are part of the Growth plan and above." };
    }
    const r = upsertPlaybook(handle, ids, {
      id: str(fd, "id") || undefined,
      name: str(fd, "name"),
      kind: str(fd, "kind") as PlaybookKind,
      description: str(fd, "description"),
      triggerKind: str(fd, "triggerKind") as TriggerKind,
      triggerConfig: parseTriggerConfig(fd),
      delayHours: int(fd, "delayHours", 24),
      channel: str(fd, "channel") as Channel,
      messageTitle: str(fd, "messageTitle"),
      messageBody: str(fd, "messageBody"),
      helpUrl: str(fd, "helpUrl") || null,
      maxPerUserTotal: int(fd, "maxPerUserTotal", 1),
      maxPerUserDays: int(fd, "maxPerUserDays", 30),
      quietHoursStart: str(fd, "quietHoursStart") === "" ? null : int(fd, "quietHoursStart", 21),
      quietHoursEnd: str(fd, "quietHoursEnd") === "" ? null : int(fd, "quietHoursEnd", 8),
      holdoutPercent: dec(fd, "holdoutPercent", 10) / 100,
      stopOnEvent: str(fd, "stopOnEvent") || null,
      primaryMetricEvent: str(fd, "primaryMetricEvent") || null,
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/playbooks");
    return {
      ok: "Saved as a draft. It enrols nobody until a person approves it, and editing it later will " +
        "return it to draft.",
    };
  });
}

function parseTriggerConfig(fd: FormData): Record<string, unknown> {
  const kind = str(fd, "triggerKind");
  if (kind === "funnel_stalled") {
    return { fromEvent: str(fd, "fromEvent"), toEvent: str(fd, "toEvent") };
  }
  if (kind === "event_occurred" || kind === "event_absent") {
    return { event: str(fd, "triggerEvent") };
  }
  if (kind === "subscription_state") return { state: str(fd, "subscriptionState") || "cancelled" };
  if (kind === "health_state") return { state: str(fd, "healthState") || "attention_suggested" };
  return {};
}

export async function approvePlaybookAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const r = approvePlaybook(handle, { projectId: ctx.project.id, userId: ctx.user.id }, str(fd, "id"));
    if (!r.ok) return { error: r.error.message };
    writeAudit(handle, {
      orgId: ctx.org.id,
      actorUserId: ctx.user.id,
      action: "playbook.approve",
      targetKind: "retention_playbook",
      targetId: str(fd, "id"),
      detail: { projectId: ctx.project.id },
    });
    revalidatePath("/playbooks");
    return { ok: "Approved, and your name is recorded against it. It still needs activating." };
  });
}

export async function setPlaybookStatusAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const r = setPlaybookStatus(handle, ctx.project.id, str(fd, "id"),
      str(fd, "status") as "active" | "paused" | "archived");
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/playbooks");
    return { ok: `Playbook ${str(fd, "status")}.` };
  });
}

export async function enrolPlaybookAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const playbook = getPlaybook(handle, ctx.project.id, str(fd, "id"));
    if (!playbook) return { error: "Playbook not found." };

    // The audience is computed from the trigger, never typed in by hand.
    const config = playbook.triggerConfig as Record<string, string>;
    let identityIds: string[] = [];
    if (playbook.triggerKind === "funnel_stalled" && config.fromEvent && config.toEvent) {
      identityIds = handle.all<{ identity_id: string }>(
        `SELECT DISTINCT a.identity_id FROM analytics_events a
          WHERE a.project_id = ? AND a.name = ?
            AND NOT EXISTS (
              SELECT 1 FROM analytics_events b
               WHERE b.project_id = a.project_id AND b.identity_id = a.identity_id AND b.name = ?
            )
          LIMIT 2000`,
        [ctx.project.id, config.fromEvent, config.toEvent],
      ).map((r) => r.identity_id);
    } else if (playbook.triggerKind === "event_absent" && config.event) {
      identityIds = handle.all<{ id: string }>(
        `SELECT i.id FROM identities i
          WHERE i.project_id = ? AND i.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM analytics_events e
               WHERE e.project_id = i.project_id AND e.identity_id = i.id AND e.name = ?
            )
          LIMIT 2000`,
        [ctx.project.id, config.event],
      ).map((r) => r.id);
    } else if (playbook.triggerKind === "event_occurred" && config.event) {
      identityIds = handle.all<{ identity_id: string }>(
        `SELECT DISTINCT identity_id FROM analytics_events
          WHERE project_id = ? AND name = ? LIMIT 2000`,
        [ctx.project.id, config.event],
      ).map((r) => r.identity_id);
    } else if (playbook.triggerKind === "subscription_state") {
      identityIds = handle.all<{ identity_id: string }>(
        `SELECT DISTINCT identity_id FROM customer_subscriptions
          WHERE project_id = ? AND status = ? AND identity_id IS NOT NULL LIMIT 2000`,
        [ctx.project.id, config.state ?? "cancelled"],
      ).map((r) => r.identity_id);
    } else {
      return {
        error: `Enrolment for the "${playbook.triggerKind}" trigger is not wired up yet, so nothing was ` +
          "enrolled. RetainOS does not guess at an audience.",
      };
    }

    const r = enrolIdentities(handle, ids, playbook, identityIds);
    if (!r.ok) return { error: r.error.message };
    const reasons = new Map<string, number>();
    for (const s of r.value.suppressed) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    const detail = [...reasons.entries()].map(([reason, n]) => `${n} ${reason}`).join(", ");
    revalidatePath("/playbooks");
    return {
      ok: `${r.value.enrolled} enrolled, ${r.value.holdout} held out` +
        (detail ? `, and ${r.value.suppressed.length} skipped (${detail}).` : "."),
    };
  });
}

export async function measurePlaybookAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle } = await ctxWithIds();
    const playbook = getPlaybook(handle, ctx.project.id, str(fd, "id"));
    if (!playbook) return { error: "Playbook not found." };
    const outcome = measurePlaybook(handle, ctx.project.id, playbook, {
      outcomeWindowDays: int(fd, "outcomeWindowDays", 14),
    });
    revalidatePath("/playbooks");
    return { ok: outcome.interpretation };
  });
}

export async function setConsentAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const r = setMessagingConsent(handle, ids, str(fd, "identityId"),
      str(fd, "channel") as "in_app" | "email", bool(fd, "granted"), str(fd, "basis"));
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/playbooks");
    return { ok: "Consent recorded, with its basis." };
  });
}

// --- Alerts ----------------------------------------------------------------

export async function saveAlertRuleAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const r = upsertAlertRule(handle, ids, {
      kind: str(fd, "kind") as AlertKind,
      enabled: bool(fd, "enabled"),
      threshold: dec(fd, "threshold", 0.1),
      minAffectedUsers: int(fd, "minAffectedUsers", 50),
      comparisonDays: int(fd, "comparisonDays", 7),
      cooldownHours: int(fd, "cooldownHours", 24),
      quietHoursStart: str(fd, "quietHoursStart") === "" ? null : int(fd, "quietHoursStart", 21),
      quietHoursEnd: str(fd, "quietHoursEnd") === "" ? null : int(fd, "quietHoursEnd", 8),
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/alerts");
    return { ok: "Rule saved." };
  });
}

export async function installDefaultRulesAction(): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const created = ensureDefaultAlertRules(handle, ids);
    revalidatePath("/alerts");
    return { ok: created === 0 ? "Every rule already exists." : `${created} rule(s) installed.` };
  });
}

export async function runAlertsAction(): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    const result = runAlertChecks(handle, ids, { timezone: ctx.project.timezone });
    revalidatePath("/alerts");
    if (result.candidates === 0) {
      return { ok: "Every check ran and nothing crossed its threshold." };
    }
    const held = result.suppressed.map((s) => s.reason);
    return {
      ok: `${result.fired.length} alert(s) fired` +
        (held.length > 0 ? `; ${held.length} withheld (${[...new Set(held)].join(", ")}).` : "."),
    };
  });
}

export async function alertLifecycleAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle } = await ctxWithIds();
    const id = str(fd, "id");
    const what = str(fd, "what");
    if (what === "acknowledge") {
      acknowledgeAlert(handle, ctx.project.id, id);
    } else if (what === "resolve") {
      resolveAlert(handle, ctx.project.id, id);
    } else if (what === "snooze") {
      const r = snoozeAlert(handle, ctx.project.id, id, Date.now() + int(fd, "days", 7) * 86_400_000);
      if (!r.ok) return { error: r.error.message };
    }
    revalidatePath("/alerts");
    return { ok: `Alert ${what}d.` };
  });
}

// --- Integrations ----------------------------------------------------------

export async function connectProviderAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const config: Record<string, unknown> = {};
    const host = str(fd, "host");
    const projectRef = str(fd, "projectRef");
    if (host) config.host = host;
    if (projectRef) config.projectRef = projectRef;
    const r = connectProvider(handle, ids, { provider: str(fd, "provider") as Provider, config });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings/sources");
    return {
      ok: "Registered. It stays disconnected until a check against the provider actually succeeds — " +
        "RetainOS will not show a live integration it has not verified.",
    };
  });
}

export async function verifyProviderAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const provider = str(fd, "provider") as Provider;
    // The probe is the only thing that can mark a connection connected, and it
    // needs a credential from the environment. Without one, say so plainly
    // rather than reporting a working integration.
    const r = await verifyConnection(handle, ctx.project.id, provider, async () => {
      const envVar = `RETAINOS_${provider.toUpperCase()}_API_KEY`;
      const credential = process.env[envVar] ?? process.env[`RETAINOS_${provider.toUpperCase()}_TOKEN`];
      if (!credential) {
        return {
          ok: false as const,
          error: `No credential found. Set ${envVar} in the server environment and try again.`,
        };
      }
      return { ok: false as const, error: "No live probe is implemented for this provider yet." };
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings/sources");
    return r.value.status === "connected"
      ? { ok: "Verified and connected." }
      : { error: "The check did not succeed, so the connection is marked as errored. Nothing is being read." };
  });
}

export async function revokeProviderAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    revokeConnection(handle, ctx.project.id, str(fd, "provider") as Provider);
    revalidatePath("/settings/sources");
    return { ok: "Revoked. Nothing further is read from it." };
  });
}

export async function setSourceAuthorityAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const r = setAuthoritativeSource(handle, ids, {
      domain: str(fd, "domain") as SourceDomain,
      entity: str(fd, "entity") || undefined,
      source: str(fd, "source"),
      note: str(fd, "note") || undefined,
    });
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings/sources");
    return {
      ok: "Saved. Records for the same thing from any other source will be refused at import rather " +
        "than counted twice.",
    };
  });
}

export async function importCsvAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const text = str(fd, "csv");
    if (!text) return { error: "Paste some CSV first." };

    const parsed = csvToEvents(text);
    if (parsed.missingColumns.length > 0) {
      return { error: `Missing column(s): ${parsed.missingColumns.join(", ")}.` };
    }
    if (parsed.records.length === 0) {
      return {
        error: parsed.problems.length > 0
          ? `No usable rows. First problem, row ${parsed.problems[0]!.row}: ${parsed.problems[0]!.detail}`
          : "No rows found below the header.",
      };
    }

    const connection = connectProvider(handle, ids, { provider: "csv" });
    if (!connection.ok) return { error: connection.error.message };

    const r = importEvents(handle, ids, { source: "csv", records: parsed.records });
    if (!r.ok) return { error: r.error.message };
    const result = r.value;
    const firstRejection = result.rejections[0];
    revalidatePath("/settings/sources");
    return {
      ok: `${result.imported} imported, ${result.duplicate} already present, ${result.rejected} rejected` +
        (firstRejection ? ` (first: row ${firstRejection.row}, ${firstRejection.reason}).` : ".") +
        (parsed.problems.length > 0 ? ` ${parsed.problems.length} row(s) could not be parsed.` : "") +
        (result.propertiesScrubbed > 0
          ? ` ${result.propertiesScrubbed} sensitive propert(ies) were removed on the way in.`
          : ""),
    };
  });
}

export async function revertImportAction(_p: unknown, fd: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle } = await ctxWithIds();
    requirePermission(ctx.org.role, "project:manage");
    const r = revertSyncRun(handle, ctx.project.id, str(fd, "syncRunId"));
    if (!r.ok) return { error: r.error.message };
    revalidatePath("/settings/sources");
    return { ok: `${r.value.removed} imported event(s) removed. Events from other sources were untouched.` };
  });
}

// --- Command centre --------------------------------------------------------

export async function saveBriefAction(): Promise<ActionResult> {
  return guard(async () => {
    const { ctx, handle, ids } = await ctxWithIds();
    const brief = generateBrief(handle, ctx.project.id, {
      timezone: ctx.project.timezone,
      activationEvent: activationEventFor(handle, ctx.project.id),
    });
    saveBrief(handle, ids, brief);
    revalidatePath("/command");
    return { ok: "Brief saved." };
  });
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ingestBatch, authenticateWriteKey, submitFeedback, listFeedback, setFeedbackStatus,
  createImprovement, attachEvidence, transitionImprovement, getImprovement, impactTimeline,
  createRelease, addChangelogEntry, applyProviderEvent, eraseSubject, exportProject,
  recentEvents, issueSecretKey, authenticateSecretKey, resolveProjectScope, entitlementFor,
  listProjects, createProject, createUser, addMember, resolveOrgScope, updateProjectSettings,
} from "../packages/database/src/index.ts";
import {
  computeFunnel, upsertActivationDefinition, activationFunnel, listActivationDefinitions,
  computeRetention, mrrSnapshot, mrrMovement, draftIssue, createIssueDraft, approveIssueDraft,
  getIssueLink, recordDispatchResult, createExperiment, startExperiment, assignVariant,
  recordExposure, getExperiment, analyseExperiment, saveAnalysis, beforeAfter,
  saveImpactMeasurement, generateInsights, persistInsights, listInsights, weeklyBrief,
  briefToMarkdown, rebuildClusters, drainJobs, recomputeDay, ask,
} from "../packages/analytics/src/index.ts";
import { newTenant, must, mustFail, backfill, PASSWORD, DAY, HOUR } from "./helpers.ts";

/**
 * The complete founder journey, end to end.
 *
 * This is the workflow the whole product exists to support: a measured problem
 * becomes a development task, ships, and gets verified. Each step asserts on
 * real state, so a regression anywhere along the chain fails here.
 */
describe("the full RetainOS journey", () => {
  test("from first event to a verified improvement", () => {
    const NOW = Date.UTC(2026, 5, 1, 12);
    const t = newTenant({ timezone: "UTC" });

    // --- 1-7. Project, key, SDK, first event, inspector ---------------------
    assert.equal(listProjects(t.db, t.orgScope).length, 1);
    assert.ok(t.publicKey.startsWith("rpk_"));

    const first = must(ingestBatch(t.db, t.ingest, {
      events: [{ name: "signup_completed", userId: "journey-user-1", consent: true }],
    }, NOW));
    assert.equal(first.accepted, 1);
    assert.equal(recentEvents(t.db, t.projectId).length, 1);

    // --- 8. Configure activation -------------------------------------------
    must(upsertActivationDefinition(t.db, { orgId: t.orgId, projectId: t.projectId }, {
      name: "First project", activationEvent: "project_created",
      signupEvent: "signup_completed", windowDays: 7, isPrimary: true,
    }));
    assert.equal(listActivationDefinitions(t.db, t.projectId)[0]!.activationEvent, "project_created");

    // --- history: a real funnel with a deliberate drop ----------------------
    const RELEASE_AT = NOW - 30 * DAY;
    for (let i = 0; i < 400; i++) {
      // Half before the release, half after; completion improves afterwards.
      const before = i < 200;
      const at = before ? RELEASE_AT - (200 - i) * HOUR : RELEASE_AT + (i - 200) * HOUR;
      const user = `u${i}`;
      backfill(t, user, "signup_completed", at, {}, { plan: i % 5 === 0 ? "growth" : "free", source: "docs" });
      backfill(t, user, "onboarding_started", at + HOUR, {}, { source: "docs" });
      const completes = before ? i % 10 < 4 : i % 10 < 8; // 40% then 80%
      if (!completes) continue;
      backfill(t, user, "onboarding_completed", at + 2 * HOUR, {}, { source: "docs" });
      backfill(t, user, "project_created", at + 3 * HOUR, { is_first: true }, { source: "docs" });
      // Some come back later, so retention has something to measure.
      if (i % 3 === 0) backfill(t, user, "core_action_completed", at + 7 * DAY + HOUR, {}, { source: "docs" });
    }

    // --- 9-10. Build a funnel and read conversion ---------------------------
    const steps = [
      { event: "signup_completed" }, { event: "onboarding_started" },
      { event: "onboarding_completed" }, { event: "project_created" },
    ];
    const funnel = must(computeFunnel(t.db, t.projectId, {
      steps, from: NOW - 120 * DAY, to: NOW, conversionWindowHours: 168,
    }));
    // 400 backfilled users plus the one real user ingested in step 1.
    assert.equal(funnel.entered, 401);
    assert.equal(funnel.completed, 240, "40% of the first 200 plus 80% of the second 200");
    assert.ok(funnel.largestDropOff, "a drop-off must be identified");
    assert.equal(funnel.largestDropOff!.fromIndex, 1, "the loss is between started and completed");

    // --- 11. Retention cohorts ---------------------------------------------
    const retention = computeRetention(t.db, t.projectId, {
      from: NOW - 120 * DAY, to: NOW, timezone: "UTC", periods: [0, 7], now: NOW,
    });
    assert.ok(retention.cohorts.length > 0);
    const d7 = retention.averageByPeriod.find((p) => p.period === 7)!;
    assert.ok(d7.rate !== null && d7.rate > 0, "some users returned on day 7");

    // --- 12. Churn metric configuration ------------------------------------
    must(updateProjectSettings(t.db, t.scope, { inactivityDays: 21 }));
    assert.equal(
      t.db.get<{ inactivity_days: number }>("SELECT inactivity_days FROM projects WHERE id = ?", [t.projectId])!.inactivity_days,
      21,
    );

    // --- 13-15. Feedback, inbox, evidence ----------------------------------
    const reports = [
      ["Onboarding template step is confusing", "I could not finish onboarding, the template step is confusing"],
      ["Confusing template choice in onboarding", "The onboarding template step is confusing and I gave up"],
      ["Template step blocked my onboarding", "Onboarding is blocked at the confusing template step"],
    ] as const;
    const feedbackIds = reports.map(([title, body]) =>
      must(submitFeedback(t.db, { orgId: t.orgId, projectId: t.projectId },
        { kind: "confusion", title, body, source: "widget" }, NOW - 20 * DAY)).id,
    );
    assert.equal(listFeedback(t.db, t.scope).length, 3);
    const clustered = rebuildClusters(t.db, { orgId: t.orgId, projectId: t.projectId }, {}, NOW);
    assert.equal(clustered.clusters, 1, "three reports about the same thing form one theme");

    // --- 16. Create the improvement with its evidence ----------------------
    const improvement = must(createImprovement(t.db, t.scope, {
      title: "Reduce drop-off at the onboarding template step",
      description: `${funnel.largestDropOff!.lostUsers} users were lost between onboarding_started and onboarding_completed.`,
      hypothesis: "The template step may be unclear.",
      acceptanceCriteria: "Onboarding can be completed without choosing a template.",
      primaryMetric: "onboarding_completed conversion",
      priority: "high",
    }));
    must(attachEvidence(t.db, t.scope, improvement.id, {
      kind: "funnel_step",
      summary: `onboarding_started → onboarding_completed: ${(funnel.largestDropOff!.conversionRate * 100).toFixed(1)}%`,
      snapshot: {
        lostUsers: funnel.largestDropOff!.lostUsers,
        conversionRate: funnel.largestDropOff!.conversionRate,
      },
    }));
    for (const id of feedbackIds) {
      must(attachEvidence(t.db, t.scope, improvement.id, {
        kind: "feedback_item", referenceId: id, summary: "Customer report about the template step",
      }));
    }
    assert.equal(getImprovement(t.db, t.scope, improvement.id)!.evidence.length, 4);

    // --- 17-18. Draft a GitHub issue and require approval ------------------
    const draft = must(draftIssue(t.db, t.projectId, improvement.id));
    assert.match(draft.title, /template step/);
    assert.match(draft.body, /## Evidence/);
    assert.match(draft.body, /hypothesis, not a diagnosis/);
    assert.match(draft.body, /RetainOS does not have reproduction steps/);
    assert.ok(draft.labels.includes("customer-reported"));

    const link = must(createIssueDraft(t.db, { orgId: t.orgId, projectId: t.projectId, userId: t.userId }, {
      improvementId: improvement.id, repository: "acme/app", draft,
    }));
    assert.equal(String(getIssueLink(t.db, t.projectId, link.id)!.dispatch_state), "draft",
      "a draft must not be dispatchable before approval");

    must(approveIssueDraft(t.db, { orgId: t.orgId, projectId: t.projectId, userId: t.userId }, link.id));
    assert.equal(String(getIssueLink(t.db, t.projectId, link.id)!.dispatch_state), "approved");

    // --- 19. Simulate the integration locally -------------------------------
    recordDispatchResult(t.db, link.id, {
      issueNumber: 412, issueUrl: "https://github.com/acme/app/issues/412", state: "open",
    }, NOW);
    assert.equal(String(getIssueLink(t.db, t.projectId, link.id)!.dispatch_state), "dispatched");
    // A second draft for the same repository is refused.
    assert.equal(mustFail(createIssueDraft(t.db, { orgId: t.orgId, projectId: t.projectId, userId: t.userId }, {
      improvementId: improvement.id, repository: "acme/app", draft,
    })).code, "conflict");

    // --- 20-21. Ship it, linked to the improvement -------------------------
    for (const next of ["investigating", "validated", "planned", "approved", "in_development", "in_review"] as const) {
      must(transitionImprovement(t.db, t.scope, improvement.id, next));
    }
    const release = must(createRelease(t.db, t.scope, {
      name: "Clearer onboarding", version: "2.3.0", releasedAt: RELEASE_AT,
      improvementIds: [improvement.id],
    }));
    must(transitionImprovement(t.db, t.scope, improvement.id, "released"));
    must(addChangelogEntry(t.db, t.scope, {
      releaseId: release.id, category: "improvement",
      title: "Onboarding no longer requires a template", isPublic: true,
    }));

    // --- 22. Measure before and after --------------------------------------
    const measured = must(beforeAfter(t.db, t.projectId, {
      releaseAt: RELEASE_AT, windowDays: 8, metricKind: "funnel_step",
      metricLabel: "Onboarding completion",
      funnelSteps: [{ event: "onboarding_started" }, { event: "onboarding_completed" }],
      funnelStepIndex: 1, timezone: "UTC", now: NOW,
    }));
    assert.ok(measured.before.rate !== null && measured.after.rate !== null);
    assert.ok(measured.after.rate! > measured.before.rate!, "completion improved after the release");
    assert.equal(measured.causalClaim, "none", "a before/after never claims causation");
    assert.ok(measured.confounders.length >= 6, "every confounder category is reported");
    assert.ok(measured.interpretation.includes("controlled experiment"));
    saveImpactMeasurement(t.db, { orgId: t.orgId, projectId: t.projectId }, {
      improvementId: improvement.id, releaseId: release.id, method: "before_after",
      metricKind: "funnel_step", windowDays: 8, result: measured,
    }, NOW);
    must(transitionImprovement(t.db, t.scope, improvement.id, "measuring"));

    // --- 23-24. Run an experiment that actually settles it -----------------
    const experiment = must(createExperiment(t.db, { orgId: t.orgId, projectId: t.projectId, userId: t.userId }, {
      key: "optional-template", name: "Optional template step",
      primaryMetricEvent: "onboarding_completed", minExposuresPerVariant: 100,
      improvementId: improvement.id,
      variants: [
        { key: "control", name: "Required", isControl: true, weight: 0.5 },
        { key: "treatment", name: "Optional", weight: 0.5 },
      ],
    }));
    must(startExperiment(t.db, t.projectId, experiment.id, NOW - 60 * DAY));
    const config = getExperiment(t.db, t.projectId, experiment.id)!;

    const identities = t.db.all<{ id: string }>(
      "SELECT id FROM identities WHERE project_id = ? ORDER BY id LIMIT 400", [t.projectId],
    );
    for (const row of identities) {
      const variant = assignVariant(t.db, { orgId: t.orgId, projectId: t.projectId }, config, row.id, NOW - 59 * DAY);
      recordExposure(t.db, { orgId: t.orgId, projectId: t.projectId }, experiment.id, row.id, variant, NOW - 59 * DAY);
    }
    const analysis = must(analyseExperiment(t.db, t.projectId, experiment.id, { now: NOW }));
    assert.ok(analysis.checks.every((c) => c.severity !== "blocking" || c.passed),
      `blocking checks failed: ${analysis.checks.filter((c) => !c.passed).map((c) => c.id).join(", ")}`);
    assert.ok(["improvement_supported", "no_clear_difference", "worse_outcome"].includes(analysis.verdict),
      `expected a readable verdict, got ${analysis.verdict}`);
    assert.equal(analysis.srm!.mismatch, false);
    saveAnalysis(t.db, t.orgId, analysis, NOW);

    // --- the impact timeline ties it all together --------------------------
    const timeline = impactTimeline(t.db, t.scope, improvement.id);
    assert.ok(timeline.history.length >= 8, "every status change is recorded");
    assert.equal(timeline.githubIssues.length, 1);
    assert.equal(timeline.githubIssues[0]!.issue_number, 412);
    assert.equal(timeline.releases.length, 1);
    assert.equal(timeline.releases[0]!.version, "2.3.0");
    assert.equal(timeline.measurements.length, 1);

    // --- 25. RetainAI produces grounded analysis ---------------------------
    const generated = generateInsights(t.db, t.projectId, { timezone: "UTC", now: NOW });
    const persisted = persistInsights(t.db, { orgId: t.orgId, projectId: t.projectId }, generated, NOW);
    assert.ok(persisted.created > 0, "findings were produced from real data");
    assert.ok(listInsights(t.db, t.projectId).length > 0);
    for (const insight of generated) {
      assert.equal(insight.generator, "rules_v1");
      assert.ok(insight.limitations.length > 0, `${insight.kind} must state its limitations`);
      assert.ok(insight.metricDefinition.length > 0, `${insight.kind} must state how it was measured`);
    }

    const answer = ask(t.db, t.projectId, {
      question: "Where do users drop off during onboarding?", timezone: "UTC", now: NOW,
    });
    assert.equal(answer.generator, "deterministic_templates");
    assert.ok(answer.figures.every((f) => f.definition.length > 0), "every figure carries its definition");
    assert.match(answer.answer, /where users stop, not why/);

    // --- 26. The weekly brief ----------------------------------------------
    const brief = weeklyBrief(t.db, t.projectId, { timezone: "UTC", now: NOW });
    const markdown = briefToMarkdown(brief, "Acme App");
    assert.match(markdown, /# Weekly retention brief/);
    assert.match(markdown, /Nothing in this report establishes a cause/);
    assert.ok(brief.gaps.length > 0, "the brief lists what it could not compute");

    // --- 30. Export ---------------------------------------------------------
    const bundle = must(exportProject(t.db, t.scope, { includeRawEvents: true }));
    assert.ok(bundle.counts.improvement_tasks > 0);
    assert.ok(bundle.counts.feedback_items > 0);
    assert.ok((bundle.tables.analytics_events?.length ?? 0) > 0);

    // --- 31-32. Erase a user and verify removal ----------------------------
    const before = t.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ?", [t.projectId],
    )!.n;
    const erased = must(eraseSubject(t.db, t.scope, { kind: "external_id", value: "u1" }, NOW));
    assert.equal(erased.report.identitiesDeleted, 1);
    assert.ok(erased.report.eventsDeleted > 0);
    const after = t.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ?", [t.projectId],
    )!.n;
    assert.equal(after, before - erased.report.eventsDeleted);
    assert.equal(
      t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM identities WHERE external_id = 'u1'")!.n, 0,
    );
    // The aggregates for the affected days are queued for recomputation.
    assert.ok(
      t.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM aggregation_jobs WHERE kind = 'recompute_day' AND status = 'pending'",
      )!.n > 0,
      "erasure must queue aggregate recomputation so the numbers stay consistent",
    );
    const drained = drainJobs(t.db, { now: NOW });
    assert.ok(drained.every((r) => r.ok), "queued recomputation must succeed");

    t.db.close();
  });
});

describe("subscription entitlements across the journey", () => {
  test("a free organization is blocked from paid capability but keeps its data", () => {
    const t = newTenant({ plan: "free" });
    const entitlement = entitlementFor(t.db, t.orgId);
    assert.equal(entitlement.features.experiments, false);
    assert.equal(entitlement.features.dataExport, true, "export is never withheld");
    // The free plan allows one project, and the fixture already made it.
    assert.equal(mustFail(createProject(t.db, t.orgScope, { name: "Second" })).code, "entitlement_exceeded");
    t.db.close();
  });

  test("a growth organization reaches the paid capability", () => {
    const t = newTenant({ plan: "growth" });
    const entitlement = entitlementFor(t.db, t.orgId);
    assert.equal(entitlement.features.experiments, true);
    assert.equal(entitlement.features.revenueIntelligence, true);
    t.db.close();
  });
});

describe("revenue through the journey", () => {
  test("verified billing events produce reconciling MRR", () => {
    const NOW = Date.UTC(2026, 5, 1, 12);
    const t = newTenant();
    let seq = 0;
    const send = (sub: string, type: string, at: number, amount: number) =>
      must(applyProviderEvent(t.db, { orgId: t.orgId, projectId: t.projectId }, {
        provider: "simulator", externalEventId: `e${seq++}`, externalSubscriptionId: sub,
        type: type as never, occurredAt: at, amountMinor: amount, currency: "INR",
        interval: "month", planName: "starter",
      }));

    const MONTH_START = Date.UTC(2026, 4, 1);
    const MONTH_END = Date.UTC(2026, 4, 31, 23, 59, 59, 999);
    send("a", "subscription_started", Date.UTC(2026, 3, 1), 99_900);
    send("b", "subscription_started", Date.UTC(2026, 3, 1), 99_900);
    send("a", "upgraded", Date.UTC(2026, 4, 10), 249_900);
    send("b", "cancelled", Date.UTC(2026, 4, 15), 99_900);
    send("c", "subscription_started", Date.UTC(2026, 4, 20), 99_900);

    const movement = mrrMovement(t.db, t.projectId, {
      periodStart: MONTH_START, periodEnd: MONTH_END, currency: "INR",
    });
    assert.equal(movement.startMrrMinor, 199_800);
    assert.equal(movement.expansionMinor, 150_000);
    assert.equal(movement.churnMinor, 99_900);
    assert.equal(movement.newMinor, 99_900);
    assert.equal(movement.endMrrMinor, 349_800);
    // The decomposition must reconcile.
    assert.equal(
      movement.startMrrMinor + movement.newMinor + movement.reactivationMinor +
      movement.expansionMinor - movement.contractionMinor - movement.churnMinor,
      movement.endMrrMinor,
    );
    assert.equal(mrrSnapshot(t.db, t.projectId, NOW)[0]!.mrrMinor, 349_800);
    t.db.close();
  });
});

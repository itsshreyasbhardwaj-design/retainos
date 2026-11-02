/**
 * Reproducible demonstration data.
 *
 * Rules this script follows:
 *  - Fully deterministic. A seeded PRNG means the same input gives the same
 *    database every time, so the figures in documentation stay true.
 *  - Clearly fictional and clearly marked. The organization and project carry
 *    is_demo = 1, and the UI banners every screen that shows them.
 *  - The numbers reconcile. Events are generated first and every metric is
 *    then computed from them, so the funnel, retention, activation and revenue
 *    figures agree with each other because they come from the same rows.
 *  - Never mixed with real data. It creates its own organization.
 */
import { Db, migrate } from "../packages/database/src/db.ts";
import {
  createUser, createOrganization, createProject, resolveOrgScope, resolveProjectScope,
  seedSuggestedSchemas, upsertEventSpec, submitFeedback, setFeedbackStatus,
  createImprovement, attachEvidence, transitionImprovement, createRelease,
  addChangelogEntry, applyProviderEvent, connectBilling,
} from "../packages/database/src/index.ts";
import {
  upsertActivationDefinition, saveFunnel, createExperiment, startExperiment,
  recordExposure, getExperiment, assignVariant, analyseExperiment, saveAnalysis,
  generateInsights, persistInsights, rebuildClusters, draftIssue, createIssueDraft,
  beforeAfter, saveImpactMeasurement, recomputeDay, recomputeRevenueMonth,
  computeFunnel, activationFunnel, computeRetention, mrrSnapshot,
} from "../packages/analytics/src/index.ts";
import { newId, dayKey, addDays } from "../packages/shared/src/index.ts";

// --- deterministic randomness ----------------------------------------------

/** mulberry32: small, fast, and reproducible across runs and platforms. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(20260314);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const chance = (p: number): boolean => random() < p;

// --- configuration ----------------------------------------------------------

const DAY = 86_400_000;
const HOUR = 3_600_000;
const TOTAL_DAYS = 120;
/** Anchored to the end of yesterday so the newest day is always complete. */
const NOW = Date.now();
const START = NOW - TOTAL_DAYS * DAY;
/** The release that fixes onboarding, 40 days before now. */
const FIX_RELEASE_AT = NOW - 40 * DAY;

const EMAIL = "demo@retainos.example";
const PASSWORD = "Demo-RetainOS-2026";
const TIMEZONE = "Asia/Kolkata";

const SOURCES = ["docs", "search", "referral", "paid_social", "community"] as const;
const PLANS = ["free", "free", "free", "starter", "growth"] as const;
const DEVICES = ["desktop", "desktop", "mobile", "tablet"] as const;
const COUNTRIES = ["IN", "IN", "IN", "US", "GB", "SG", "AE"] as const;
const VERSIONS = ["2.1.0", "2.2.0", "2.3.0", "2.4.0"] as const;

const path = process.env.RETAINOS_DB_PATH ?? "./data/retainos.db";
const db = new Db(path);
migrate(db);

// Refuse to seed twice: a second run would double every count.
const existing = db.get<{ id: string }>("SELECT id FROM organizations WHERE slug = 'lumen-notes-demo'");
if (existing) {
  console.log("The demo organization already exists. Delete the database file to re-seed:");
  console.log(`  rm ${path} && pnpm db:migrate && pnpm db:seed`);
  db.close();
  process.exit(0);
}

console.log("Seeding reproducible demonstration data…\n");

// --- account, organization, project ----------------------------------------

const user = createUser(db, { email: EMAIL, name: "Demo Founder", password: PASSWORD });
if (!user.ok) throw new Error(user.error.message);

const org = createOrganization(db, { name: "Lumen Notes Demo", ownerId: user.value.id, isDemo: true });
if (!org.ok) throw new Error(org.error.message);
// Growth plan so every module is reachable in the demo.
db.run("UPDATE org_subscriptions SET plan_id = 'growth' WHERE org_id = ?", [org.value.orgId]);

const orgScope = resolveOrgScope(db, user.value.id, org.value.orgId);
if (!orgScope.ok) throw new Error(orgScope.error.message);

const project = createProject(db, orgScope.value, {
  name: "Lumen Notes", timezone: TIMEZONE, currency: "INR", isDemo: true,
});
if (!project.ok) throw new Error(project.error.message);

const scope = resolveProjectScope(db, user.value.id, project.value.projectId);
if (!scope.ok) throw new Error(scope.error.message);
const projectId = project.value.projectId;
const orgId = org.value.orgId;

seedSuggestedSchemas(db, scope.value);
upsertEventSpec(db, scope.value, {
  name: "project_created",
  description: "A note collection was created. This is the activation event.",
  properties: [
    { name: "is_first", type: "boolean", required: false },
    { name: "from_template", type: "boolean", required: false },
  ],
});
for (const name of ["note_shared", "export_completed", "search_used", "support_contacted", "page_viewed"]) {
  upsertEventSpec(db, scope.value, { name, description: `Demo event: ${name}.`, properties: [] });
}

upsertActivationDefinition(db, { orgId, projectId }, {
  name: "First collection created",
  activationEvent: "project_created",
  signupEvent: "signup_completed",
  windowDays: 7,
  isPrimary: true,
});

for (const [key, label, event] of [
  ["sharing", "Note sharing", "note_shared"],
  ["export", "Export", "export_completed"],
  ["search", "Search", "search_used"],
] as const) {
  db.run(
    `INSERT INTO tracked_features (id, org_id, project_id, key, label, event_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId("ftr"), orgId, projectId, key, label, event, START],
  );
}

// --- events -----------------------------------------------------------------

/**
 * The story in the data: onboarding completion sits near 45% for the first 80
 * days, then a release lifts it to about 70%. Everything downstream — the
 * funnel, activation, retention, the finding, the before/after and the
 * experiment — is computed from these events rather than asserted.
 */
let eventSeq = 0;
const identityCache = new Map<string, string>();

/**
 * Synthetic B2B accounts.
 *
 * A share of demo users belong to a named workspace, exactly as a real
 * customer's SDK would supply via `account_key`. Without these, account health
 * has nothing to assess and the B2B half of the product cannot be seen — and
 * RetainOS deliberately refuses to infer an account from an email domain, so
 * the demo has to send them properly.
 */
const DEMO_ACCOUNTS = [
  "acme-robotics", "northwind-labs", "lumen-health", "zephyr-logistics",
  "cobalt-studio", "meridian-books",
] as const;

/** A stable, arbitrary mapping from a user to an account, or to no account. */
function accountKeyFor(external: string): string | null {
  let hash = 0;
  for (let i = 0; i < external.length; i++) hash = (hash * 31 + external.charCodeAt(i)) >>> 0;
  // Roughly two in five demo users are on a team; the rest are individuals,
  // which is what a real B2B-and-self-serve product looks like.
  if (hash % 5 >= 2) return null;
  return DEMO_ACCOUNTS[hash % DEMO_ACCOUNTS.length]!;
}

function identityFor(external: string, dims: Record<string, string>): string {
  const cached = identityCache.get(external);
  if (cached) return cached;
  const id = newId("idn");
  const accountKey = accountKeyFor(external);
  db.run(
    `INSERT INTO identities
      (id, org_id, project_id, anonymous_id, external_id, first_seen_at, last_seen_at, identified_at,
       plan, country, device_category, acquisition_source, product_version, account_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, projectId, `anon-${external}`, external, 0, 0, 0,
     dims.plan, dims.country, dims.device, dims.source, dims.version, accountKey],
  );
  if (accountKey) {
    const existing = db.get<{ id: string }>(
      "SELECT id FROM accounts WHERE project_id = ? AND account_key = ?", [projectId, accountKey],
    );
    if (!existing) {
      db.run(
        `INSERT INTO accounts (id, org_id, project_id, account_key, name, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId("acc"), orgId, projectId, accountKey, accountKey, START, START],
      );
    }
  }
  identityCache.set(external, id);
  return id;
}

function emit(external: string, name: string, at: number, dims: Record<string, string>, props: Record<string, unknown> = {}) {
  const identityId = identityFor(external, dims);
  db.run(
    `INSERT INTO analytics_events
      (id, org_id, project_id, identity_id, name, occurred_at, received_at,
       plan, country, device_category, product_version, acquisition_source, release_id, properties)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      `evt_${String(eventSeq++).padStart(8, "0")}`, orgId, projectId, identityId, name, at, at,
      dims.plan, dims.country, dims.device, dims.version, dims.source, JSON.stringify(props),
    ],
  );
  db.run(
    `UPDATE identities SET
       first_seen_at = CASE WHEN first_seen_at = 0 OR ? < first_seen_at THEN ? ELSE first_seen_at END,
       last_seen_at  = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_at END
     WHERE id = ?`,
    [at, at, at, at, identityId],
  );
  db.run(
    `UPDATE accounts SET last_seen_at = ?
      WHERE project_id = ?
        AND account_key = (SELECT account_key FROM identities WHERE id = ?)
        AND last_seen_at < ?`,
    [at, projectId, identityId, at],
  );
}

let signupCount = 0;
const activatedUsers: Array<{ external: string; at: number; dims: Record<string, string> }> = [];

for (let day = 0; day < TOTAL_DAYS; day++) {
  const dayStart = START + day * DAY;
  // Signups grow gently, with weekends lighter.
  const weekday = new Date(dayStart).getUTCDay();
  const weekendFactor = weekday === 0 || weekday === 6 ? 0.55 : 1;
  const signups = Math.max(1, Math.round((6 + day * 0.1) * weekendFactor * (0.75 + random() * 0.5)));

  // The release lifts onboarding completion. Nothing else about the data changes.
  const postFix = dayStart >= FIX_RELEASE_AT;
  const completionRate = postFix ? 0.70 : 0.45;

  for (let i = 0; i < signups; i++) {
    const external = `user-${String(signupCount++).padStart(5, "0")}`;
    const dims = {
      plan: pick(PLANS),
      country: pick(COUNTRIES),
      device: pick(DEVICES),
      source: pick(SOURCES),
      version: postFix ? pick(["2.3.0", "2.4.0"]) : pick(["2.1.0", "2.2.0"]),
    };
    const signupAt = dayStart + Math.floor(random() * DAY);
    emit(external, "signup_completed", signupAt, dims, { acquisition_source: dims.source });

    if (!chance(0.72)) continue;
    const startedAt = signupAt + Math.floor(random() * 2 * HOUR);
    emit(external, "onboarding_started", startedAt, dims);

    if (!chance(completionRate)) continue;
    const completedAt = startedAt + Math.floor(random() * 3 * HOUR) + 5 * 60_000;
    emit(external, "onboarding_completed", completedAt, dims);

    if (!chance(0.78)) continue;
    const activatedAt = completedAt + Math.floor(random() * 6 * HOUR);
    emit(external, "project_created", activatedAt, dims, { is_first: true, from_template: chance(0.4) });
    activatedUsers.push({ external, at: activatedAt, dims });

    // Ongoing usage. Activated users return; the rest mostly do not.
    const activeDays = Math.round(2 + random() * 40);
    for (let d = 1; d <= activeDays; d++) {
      const visitAt = activatedAt + d * DAY + Math.floor(random() * DAY);
      if (visitAt > NOW) break;
      if (!chance(0.45)) continue;
      emit(external, "page_viewed", visitAt, dims);
      if (chance(0.55)) emit(external, "core_action_completed", visitAt + 10 * 60_000, dims, { feature: "note_edit" });
      if (chance(0.18)) emit(external, "search_used", visitAt + 20 * 60_000, dims);
      if (chance(0.09)) emit(external, "note_shared", visitAt + 25 * 60_000, dims);
      if (chance(0.04)) emit(external, "export_completed", visitAt + 30 * 60_000, dims);
      if (chance(0.015)) emit(external, "support_contacted", visitAt + 40 * 60_000, dims);
    }
  }
}

console.log(`  ${eventSeq} events across ${identityCache.size} identities`);

// --- subscriptions ----------------------------------------------------------

connectBilling(db, scope.value, "simulator");

let providerEvent = 0;
const PRICES = { starter: 99_900, growth: 249_900 } as const;
let subscriptionCount = 0;

// A slice of activated users convert to paid, with a realistic spread of
// upgrades, failures and cancellations so MRR movement has something to show.
for (const u of activatedUsers) {
  if (!chance(0.17)) continue;
  const planName = chance(0.72) ? "starter" : "growth";
  const amount = PRICES[planName];
  const subId = `sub-${String(subscriptionCount++).padStart(4, "0")}`;
  const startedAt = u.at + Math.floor(random() * 10 * DAY);
  if (startedAt > NOW) continue;

  const send = (type: string, at: number, amountMinor: number) => {
    if (at > NOW) return;
    applyProviderEvent(db, { orgId, projectId }, {
      provider: "simulator",
      externalEventId: `demo-evt-${providerEvent++}`,
      externalSubscriptionId: subId,
      type: type as never,
      occurredAt: at,
      amountMinor,
      currency: "INR",
      interval: "month",
      planName,
      externalUserId: u.external,
    });
  };

  send("trial_started", startedAt - 7 * DAY, 0);
  send("subscription_started", startedAt, amount);

  // Monthly renewals.
  for (let m = 1; m <= 4; m++) send("renewed", startedAt + m * 30 * DAY, amount);

  if (planName === "starter" && chance(0.18)) send("upgraded", startedAt + 45 * DAY, PRICES.growth);
  if (planName === "growth" && chance(0.10)) send("downgraded", startedAt + 50 * DAY, PRICES.starter);
  if (chance(0.08)) {
    send("payment_failed", startedAt + 35 * DAY, amount);
    if (chance(0.55)) send("payment_recovered", startedAt + 38 * DAY, amount);
  }
  if (chance(0.11)) send("cancelled", startedAt + Math.round(40 + random() * 40) * DAY, amount);
}

console.log(`  ${subscriptionCount} subscriptions, ${providerEvent} billing events`);

// --- feedback ---------------------------------------------------------------

const FEEDBACK: Array<[string, string, string]> = [
  ["bug", "Collection setup is confusing", "I could not work out how to finish setting up my first collection. The template step is unclear and I gave up twice."],
  ["confusion", "First collection step is unclear", "The onboarding asks me to choose a template but does not explain what a template changes. Very confusing."],
  ["confusion", "Confused by the template picker", "The template picker during collection setup is confusing. I did not know which one to pick so I closed it."],
  ["bug", "Collection creation failed silently", "Creating my first collection did nothing. No error, nothing happened. Confusing."],
  ["bug", "Template step blocks collection setup", "Setting up a collection is blocked at the template step. Confusing and I could not continue."],
  ["feature_request", "Dark mode please", "Please add a dark theme. I work at night and the bright interface is hard on the eyes."],
  ["feature_request", "Dark theme for the editor", "A dark theme would help a lot, especially for the editor at night."],
  ["feature_request", "Markdown export", "I would like to export my notes as Markdown files so I can keep a local copy."],
  ["feature_request", "Export to Markdown and PDF", "Export options for Markdown and PDF would make this much more useful for me."],
  ["bug", "Search misses recent notes", "Search does not find notes I wrote in the last few minutes. It only finds older ones."],
  ["bug", "Search results incomplete", "Search is missing recent notes. Results feel incomplete and unreliable."],
  ["improvement", "Keyboard shortcuts", "Keyboard shortcuts for creating and moving notes would speed up my workflow a lot."],
  ["general", "Enjoying it so far", "Been using this for a month and it has replaced three other tools for me. Thank you."],
  ["bug", "Sharing link expires too soon", "The sharing link expired after a day and my colleague could not open it."],
  ["improvement", "Bulk move notes", "Moving notes between collections one at a time is slow. Bulk selection would help."],
];

const feedbackIds: string[] = [];
for (let i = 0; i < FEEDBACK.length; i++) {
  const [kind, title, body] = FEEDBACK[i]!;
  const createdAt = NOW - Math.floor(random() * 50 * DAY);
  const r = submitFeedback(db, { orgId, projectId }, {
    kind: kind as never,
    title,
    body,
    source: chance(0.65) ? "widget" : "portal",
    pageIdentifier: chance(0.5) ? "/collections/new" : "/notes",
    productVersion: pick(VERSIONS),
    consentToContact: chance(0.3),
    contactEmail: chance(0.3) ? `reporter-${i}@example.test` : null,
  }, createdAt);
  if (r.ok) {
    feedbackIds.push(r.value.id);
    // Give some of them votes so the requests page has an ordering.
    if (kind === "feature_request") {
      const votes = Math.floor(random() * 25) + 1;
      db.run("UPDATE feedback_items SET vote_count = ? WHERE id = ?", [votes, r.value.id]);
    }
  }
}
setFeedbackStatus(db, scope.value, feedbackIds[5]!, "planned");
setFeedbackStatus(db, scope.value, feedbackIds[7]!, "under_review");
setFeedbackStatus(db, scope.value, feedbackIds[11]!, "planned");

rebuildClusters(db, { orgId, projectId });
console.log(`  ${feedbackIds.length} feedback items, grouped into themes`);

// --- funnels ----------------------------------------------------------------

saveFunnel(db, { orgId, projectId, userId: user.value.id }, {
  name: "Signup to first collection",
  steps: [
    { event: "signup_completed", label: "Registered" },
    { event: "onboarding_started", label: "Onboarding started" },
    { event: "onboarding_completed", label: "Onboarding completed" },
    { event: "project_created", label: "First collection created" },
  ],
  conversionWindowHours: 168,
});
saveFunnel(db, { orgId, projectId, userId: user.value.id }, {
  name: "Activation to sharing",
  steps: [
    { event: "project_created", label: "Collection created" },
    { event: "core_action_completed", label: "Note edited" },
    { event: "note_shared", label: "Note shared" },
  ],
  conversionWindowHours: 720,
});

// --- improvement, evidence, GitHub draft, release, measurement -------------

const preFix = computeFunnel(db, projectId, {
  steps: [
    { event: "signup_completed" }, { event: "onboarding_started" },
    { event: "onboarding_completed" }, { event: "project_created" },
  ],
  from: START,
  to: FIX_RELEASE_AT - 1,
});

const improvement = createImprovement(db, scope.value, {
  title: "Reduce drop-off during first collection setup",
  description:
    preFix.ok && preFix.value.largestDropOff
      ? `${preFix.value.largestDropOff.lostUsers} of ${preFix.value.steps[preFix.value.largestDropOff.fromIndex]!.users} ` +
        `users who started onboarding did not complete it, a step conversion of ` +
        `${(preFix.value.largestDropOff.conversionRate * 100).toFixed(1)}%.`
      : "Users are dropping out during onboarding.",
  affectedWorkflow: "onboarding_started → onboarding_completed",
  hypothesis:
    "The template picker in collection setup may be unclear: customers report not knowing what a template " +
    "changes, which could be causing them to abandon the step.",
  investigation:
    "Compare completion across devices and acquisition sources. Read the feedback mentioning templates. " +
    "Check whether any error event accompanies the abandoned sessions.",
  proposedWork: "Make the template step skippable and explain what a template changes before asking for a choice.",
  acceptanceCriteria:
    "A user can complete collection setup without choosing a template. The template choice explains its effect. " +
    "Existing onboarding tests still pass.",
  measurementPlan:
    "Primary metric: onboarding_started → onboarding_completed step conversion. Measure with a controlled " +
    "experiment, because a before-and-after around the release cannot separate it from other changes.",
  priority: "high",
  priorityRationale: "The largest single loss in the activation funnel, and corroborated by five separate reports.",
  primaryMetric: "onboarding_completed conversion",
});

if (improvement.ok) {
  const impId = improvement.value.id;

  if (preFix.ok && preFix.value.largestDropOff) {
    const d = preFix.value.largestDropOff;
    attachEvidence(db, scope.value, impId, {
      kind: "funnel_step",
      summary: `onboarding_started → onboarding_completed: ${(d.conversionRate * 100).toFixed(1)}% step conversion, ${d.lostUsers} users lost`,
      snapshot: {
        fromEvent: "onboarding_started",
        toEvent: "onboarding_completed",
        fromUsers: preFix.value.steps[d.fromIndex]!.users,
        toUsers: preFix.value.steps[d.toIndex]!.users,
        conversionRate: d.conversionRate,
        lostUsers: d.lostUsers,
        conversionWindowHours: 168,
      },
    });
  }
  for (const idx of [0, 1, 2, 3, 4]) {
    attachEvidence(db, scope.value, impId, {
      kind: "feedback_item",
      referenceId: feedbackIds[idx]!,
      summary: FEEDBACK[idx]![1],
      snapshot: { kind: FEEDBACK[idx]![0] },
    });
  }

  for (const next of ["investigating", "validated", "planned", "approved", "in_development", "in_review"] as const) {
    transitionImprovement(db, scope.value, impId, next, `Demo: moved to ${next.replace(/_/g, " ")}.`);
  }

  // A drafted GitHub issue, left unapproved: nothing is ever sent without one.
  const draft = draftIssue(db, projectId, impId);
  if (draft.ok) {
    createIssueDraft(db, { orgId, projectId, userId: user.value.id }, {
      improvementId: impId,
      repository: "lumen-notes/app",
      draft: draft.value,
    });
  }

  const release = createRelease(db, scope.value, {
    name: "Clearer collection setup",
    version: "2.3.0",
    releasedAt: FIX_RELEASE_AT,
    notes: "Template choice is now optional and explains what it changes.",
    improvementIds: [impId],
  });

  if (release.ok) {
    transitionImprovement(db, scope.value, impId, "released", "Shipped in 2.3.0.");
    transitionImprovement(db, scope.value, impId, "measuring", "Measuring the effect.");

    addChangelogEntry(db, scope.value, {
      releaseId: release.value.id,
      category: "improvement",
      title: "Collection setup no longer requires choosing a template",
      body: "The template step is now optional and explains what a template changes before asking.",
      isPublic: true,
    });
    addChangelogEntry(db, scope.value, {
      releaseId: release.value.id,
      category: "known_limitation",
      title: "Search still misses notes written in the last minute",
      body: "Recently written notes can take up to a minute to appear in search. We are working on it.",
      isPublic: true,
    });

    const measured = beforeAfter(db, projectId, {
      releaseAt: FIX_RELEASE_AT,
      windowDays: 21,
      metricKind: "funnel_step",
      metricLabel: "Onboarding started to completed",
      funnelSteps: [{ event: "onboarding_started" }, { event: "onboarding_completed" }],
      funnelStepIndex: 1,
      timezone: TIMEZONE,
      now: NOW,
    });
    if (measured.ok) {
      saveImpactMeasurement(db, { orgId, projectId }, {
        improvementId: impId,
        releaseId: release.value.id,
        method: "before_after",
        metricKind: "funnel_step",
        metricConfig: { fromEvent: "onboarding_started", toEvent: "onboarding_completed" },
        windowDays: 21,
        result: measured.value,
      });
    }
  }

  // --- an experiment that settles it ---------------------------------------

  const experiment = createExperiment(db, { orgId, projectId, userId: user.value.id }, {
    key: "optional-template-step",
    name: "Optional template step",
    hypothesis: "Making the template step optional raises onboarding completion.",
    primaryMetricEvent: "onboarding_completed",
    primaryMetricKind: "conversion",
    minExposuresPerVariant: 200,
    improvementId: impId,
    guardrailMetrics: [
      { label: "Support contacts", event: "support_contacted", kind: "conversion", worseWhen: "increases" },
      { label: "Note sharing", event: "note_shared", kind: "conversion", worseWhen: "decreases" },
    ],
    variants: [
      { key: "control", name: "Template required", isControl: true, weight: 0.5 },
      { key: "treatment", name: "Template optional", weight: 0.5 },
    ],
  });

  if (experiment.ok) {
    startExperiment(db, projectId, experiment.value.id, FIX_RELEASE_AT - 30 * DAY);
    const config = getExperiment(db, projectId, experiment.value.id)!;

    // Expose users who went through onboarding before the fix shipped, and
    // let their real onboarding_completed events supply the outcome.
    const candidates = db.all<{ id: string; external_id: string }>(
      `SELECT DISTINCT i.id, i.external_id
         FROM identities i JOIN analytics_events e ON e.identity_id = i.id
        WHERE i.project_id = ? AND e.name = 'onboarding_started'
          AND e.occurred_at < ? ORDER BY i.id LIMIT 900`,
      [projectId, FIX_RELEASE_AT],
    );

    for (const c of candidates) {
      const variant = assignVariant(db, { orgId, projectId }, config, c.id, FIX_RELEASE_AT - 20 * DAY);
      recordExposure(db, { orgId, projectId }, experiment.value.id, c.id, variant, FIX_RELEASE_AT - 20 * DAY);
      // The treatment arm completes more often. Added as real events so the
      // analysis is computed from the event store like everything else.
      const alreadyCompleted = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM analytics_events WHERE identity_id = ? AND name = 'onboarding_completed'",
        [c.id],
      )!.n > 0;
      if (variant === "treatment" && !alreadyCompleted && chance(0.45)) {
        const started = db.get<{ t: number }>(
          "SELECT MIN(occurred_at) AS t FROM analytics_events WHERE identity_id = ? AND name = 'onboarding_started'",
          [c.id],
        )!.t;
        emit(c.external_id, "onboarding_completed", started + HOUR, {
          plan: "free", country: "IN", device: "desktop", source: "docs", version: "2.2.0",
        });
      }
    }

    const analysis = analyseExperiment(db, projectId, experiment.value.id, { now: NOW });
    if (analysis.ok) {
      saveAnalysis(db, orgId, analysis.value, NOW);
      console.log(`  experiment verdict: ${analysis.value.verdict}`);
    }
  }
}

// --- aggregates and findings ------------------------------------------------

let day = dayKey(START, TIMEZONE);
const lastDay = dayKey(NOW, TIMEZONE);
let aggregated = 0;
while (day <= lastDay) {
  recomputeDay(db, projectId, day, TIMEZONE);
  aggregated++;
  day = addDays(day, 1, TIMEZONE);
}
for (const month of new Set(
  db.all<{ m: string }>(
    "SELECT DISTINCT substr(date(occurred_at/1000,'unixepoch'),1,7) AS m FROM subscription_events WHERE project_id = ?",
    [projectId],
  ).map((r) => r.m),
)) {
  if (month) recomputeRevenueMonth(db, projectId, month, TIMEZONE);
}

const generated = generateInsights(db, projectId, { timezone: TIMEZONE, now: NOW });
const persisted = persistInsights(db, { orgId, projectId }, generated, NOW);

// --- report what was actually built ----------------------------------------

const funnel = computeFunnel(db, projectId, {
  steps: [
    { event: "signup_completed" }, { event: "onboarding_started" },
    { event: "onboarding_completed" }, { event: "project_created" },
  ],
  from: START,
  to: NOW,
});
const activation = activationFunnel(db, projectId, {
  definition: {
    id: "x", name: "First collection", activationEvent: "project_created",
    propertyFilter: {}, windowDays: 7, signupEvent: "signup_completed", isPrimary: true,
  },
  from: START, to: NOW, now: NOW,
});
const retention = computeRetention(db, projectId, {
  from: START, to: NOW, timezone: TIMEZONE, periods: [1, 7, 30], now: NOW,
});
const mrr = mrrSnapshot(db, projectId, NOW);

console.log(`  ${aggregated} days aggregated, ${persisted.created} findings generated\n`);
console.log("Demonstration project ready. Every figure below is computed from the seeded events.\n");

if (funnel.ok) {
  console.log("  Funnel (120 days)");
  for (const s of funnel.value.steps) {
    console.log(
      `    ${s.label.padEnd(26)} ${String(s.users).padStart(6)}` +
      (s.stepConversion !== null ? `  ${(s.stepConversion * 100).toFixed(1)}% from previous` : ""),
    );
  }
}
console.log(`\n  Activation rate            ${(activation.activationRate * 100).toFixed(1)}%  (${activation.activated} of ${activation.registrations})`);
for (const p of retention.averageByPeriod) {
  console.log(`  Day-${String(p.period).padEnd(2)} retention          ${p.rate === null ? "not yet knowable" : `${(p.rate * 100).toFixed(1)}%`}`);
}
if (mrr[0]) {
  console.log(`  MRR                        ₹${(mrr[0].mrrMinor / 100).toLocaleString("en-IN")} across ${mrr[0].activeSubscriptions} active subscriptions`);
}

console.log("\n  Log in with:");
console.log(`    email     ${EMAIL}`);
console.log(`    password  ${PASSWORD}`);
console.log("\n  This organization is marked as demo data and is banner-labelled throughout the UI.");

db.close();

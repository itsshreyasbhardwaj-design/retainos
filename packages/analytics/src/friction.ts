import { type Db, jsonParse } from "@retainos/database";
import { errorGroups, identitiesForFingerprint } from "@retainos/database";
import { newId, dayKey, ok, err, domainError, type Result, type DomainError } from "@retainos/shared";
import { assessConfidence, type ConfidenceLabel } from "./confidence.ts";
import { computeFunnel } from "./funnels.ts";
import { activationFunnel, listActivationDefinitions } from "./activation.ts";
import { computeRetention } from "./retention.ts";
import { normaliseToMrr, type Interval } from "./revenue.ts";

/**
 * FrictionGraph.
 *
 * The product's central claim is that a funnel drop-off, eleven feedback
 * reports, an error cluster and last Tuesday's release are often one problem
 * wearing four costumes. This engine is what joins them.
 *
 * The hard constraint is honesty about the join. A line drawn between two
 * signals is a claim, so every relationship here comes from a **shared key
 * that actually exists in the data** — the same users, the same workflow, the
 * same error fingerprint — and records the rule that produced it in plain
 * language. Nothing is linked because it "feels related", and nothing is
 * linked by correlation alone.
 */

export type FrictionKind =
  | "reliability" | "activation_friction" | "retention_friction" | "billing_friction"
  | "feedback_volume" | "adoption" | "performance" | "usability" | "unverified";

export type FrictionStatus =
  | "detected" | "investigating" | "evidence_collected" | "validated" | "approved"
  | "in_development" | "released" | "measuring" | "resolved" | "inconclusive" | "dismissed";

export const FRICTION_STATUSES: FrictionStatus[] = [
  "detected", "investigating", "evidence_collected", "validated", "approved",
  "in_development", "released", "measuring", "resolved", "inconclusive", "dismissed",
];

export type EvidenceKind =
  | "funnel_step" | "activation_metric" | "retention_cohort" | "feature_adoption"
  | "feedback_item" | "feedback_cluster" | "error_group" | "release"
  | "subscription_event" | "performance" | "note";

export type RelationshipKind =
  | "same_workflow" | "same_product_version" | "same_release_window"
  | "same_error_fingerprint" | "same_feedback_theme" | "same_account"
  | "shared_affected_users" | "temporal_proximity";

/**
 * How much each kind of link is worth, 0..1.
 *
 * Shared users is by far the strongest: the same people hit both signals, which
 * is a fact rather than an inference. Temporal proximity is the weakest and is
 * only ever recorded alongside something else — two things happening in the
 * same week is almost no evidence at all.
 */
export const RELATIONSHIP_STRENGTH: Record<RelationshipKind, number> = {
  shared_affected_users: 0.90,
  same_error_fingerprint: 0.85,
  same_workflow: 0.70,
  same_feedback_theme: 0.60,
  same_account: 0.55,
  same_product_version: 0.45,
  same_release_window: 0.40,
  temporal_proximity: 0.20,
};

/** A signal, with everything needed to decide whether it relates to another. */
export interface EvidenceItem {
  localId: string;
  kind: EvidenceKind;
  referenceId: string | null;
  source: "retainos" | "posthog" | "amplitude" | "sentry" | "csv" | "manual";
  summary: string;
  snapshot: Record<string, unknown>;
  observedAt: number;
  /** The identities this signal actually touched. The basis for the strongest link. */
  userIds: Set<string>;
  workflow?: string | null;
  productVersions?: string[];
  errorFingerprint?: string | null;
  feedbackClusterId?: string | null;
  accountKeys?: Set<string>;
}

export interface EvidenceRelationship {
  fromLocalId: string;
  toLocalId: string;
  relationship: RelationshipKind;
  sharedKey: string | null;
  basis: string;
  strength: number;
}

export interface FrictionCandidate {
  kind: FrictionKind;
  title: string;
  productArea: string | null;
  affectedWorkflow: string | null;
  observation: string;
  hypotheses: string[];
  recommendedInvestigations: string[];
  limitations: string[];
  periodStart: number;
  periodEnd: number;
  affectedUserIds: Set<string>;
  evidence: EvidenceItem[];
  relationships: EvidenceRelationship[];
  affectedSegments: Array<{ dimension: string; value: string; users: number; share: number }>;
  revenueExposureMinor: number | null;
  revenueCurrency: string | null;
  evidenceQuality: ConfidenceLabel;
  evidenceBasis: string;
  dedupeKey: string;
}

// ---------------------------------------------------------------------------
// Relationship inference
// ---------------------------------------------------------------------------

/** Jaccard-style overlap on identity sets. Returns the shared ids. */
function sharedUsers(a: Set<string>, b: Set<string>): string[] {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const shared: string[] = [];
  for (const id of small) if (large.has(id)) shared.push(id);
  return shared;
}

/**
 * Derive relationships between evidence items.
 *
 * Every rule below requires a concrete shared value. There is deliberately no
 * rule of the form "these look similar", and no rule that fires on correlation
 * between two time series.
 */
export function deriveRelationships(
  items: EvidenceItem[],
  opts: { releaseWindowMs?: number; temporalWindowMs?: number; minSharedUsers?: number } = {},
): EvidenceRelationship[] {
  const releaseWindow = opts.releaseWindowMs ?? 7 * 86_400_000;
  const temporalWindow = opts.temporalWindowMs ?? 7 * 86_400_000;
  const minShared = opts.minSharedUsers ?? 1;
  const out: EvidenceRelationship[] = [];

  const push = (
    from: EvidenceItem, to: EvidenceItem,
    relationship: RelationshipKind, sharedKey: string | null, basis: string,
  ) => {
    out.push({
      fromLocalId: from.localId,
      toLocalId: to.localId,
      relationship,
      sharedKey,
      basis,
      strength: RELATIONSHIP_STRENGTH[relationship],
    });
  };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;

      // The strongest link: the same people are in both signals.
      const shared = sharedUsers(a.userIds, b.userIds);
      if (shared.length >= minShared) {
        const smaller = Math.min(a.userIds.size, b.userIds.size);
        const share = smaller === 0 ? 0 : shared.length / smaller;
        push(a, b, "shared_affected_users", String(shared.length),
          `${shared.length} of the ${smaller} users in the smaller signal appear in both ` +
          `(${(share * 100).toFixed(0)}% overlap). These are the same people, not a correlation.`);
      }

      if (a.errorFingerprint && a.errorFingerprint === b.errorFingerprint) {
        push(a, b, "same_error_fingerprint", a.errorFingerprint,
          `Both refer to error fingerprint "${a.errorFingerprint}", which is the sender's own ` +
          "grouping key rather than anything RetainOS inferred.");
      }

      if (a.workflow && b.workflow && a.workflow === b.workflow) {
        push(a, b, "same_workflow", a.workflow,
          `Both are tagged with the workflow "${a.workflow}".`);
      }

      if (a.feedbackClusterId && a.feedbackClusterId === b.feedbackClusterId) {
        push(a, b, "same_feedback_theme", a.feedbackClusterId,
          "Both belong to the same feedback theme, grouped by shared terms. " +
          "Shared vocabulary is not shared meaning, so this link is worth checking by hand.");
      }

      if (a.accountKeys && b.accountKeys) {
        const sharedAccounts = sharedUsers(a.accountKeys, b.accountKeys);
        if (sharedAccounts.length > 0) {
          push(a, b, "same_account", String(sharedAccounts.length),
            `${sharedAccounts.length} customer account(s) appear in both signals.`);
        }
      }

      const versionOverlap = (a.productVersions ?? []).filter((v) => (b.productVersions ?? []).includes(v));
      if (versionOverlap.length > 0) {
        push(a, b, "same_product_version", versionOverlap.join(", "),
          `Both were observed on product version ${versionOverlap.join(", ")}.`);
      }

      if (a.kind === "release" || b.kind === "release") {
        const release = a.kind === "release" ? a : b;
        const other = a.kind === "release" ? b : a;
        const delta = other.observedAt - release.observedAt;
        if (delta >= 0 && delta <= releaseWindow) {
          push(release, other, "same_release_window", String(Math.round(delta / 86_400_000)),
            `Observed ${Math.round(delta / 86_400_000)} day(s) after this release. ` +
            "Proximity to a release is not evidence that the release caused it.");
        }
      } else if (Math.abs(a.observedAt - b.observedAt) <= temporalWindow) {
        // Only recorded when nothing stronger connects them, so the graph is
        // not flooded with links that mean almost nothing.
        const alreadyLinked = out.some(
          (r) => (r.fromLocalId === a.localId && r.toLocalId === b.localId) ||
                 (r.fromLocalId === b.localId && r.toLocalId === a.localId),
        );
        if (!alreadyLinked) {
          push(a, b, "temporal_proximity", null,
            `Both occurred within ${Math.round(temporalWindow / 86_400_000)} days of each other. ` +
            "This is the weakest kind of link and on its own means very little.");
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** MRR attached to a set of identities. Exposure, never predicted loss. */
export function revenueExposureFor(
  db: Db,
  projectId: string,
  identityIds: Set<string>,
): { amountMinor: number; currency: string | null; subscriptions: number } {
  if (identityIds.size === 0) return { amountMinor: 0, currency: null, subscriptions: 0 };
  const ids = [...identityIds];
  let total = 0;
  let subscriptions = 0;
  const currencies = new Map<string, number>();
  const CHUNK = 400;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = db.all<{ amount_minor: number; interval: string; currency: string }>(
      `SELECT amount_minor, interval, currency FROM customer_subscriptions
        WHERE project_id = ? AND status IN ('active','past_due')
          AND identity_id IN (${chunk.map(() => "?").join(",")})`,
      [projectId, ...chunk],
    );
    for (const r of rows) {
      const mrr = normaliseToMrr(r.amount_minor, (r.interval as Interval) ?? "month");
      total += mrr;
      subscriptions++;
      currencies.set(r.currency, (currencies.get(r.currency) ?? 0) + mrr);
    }
  }
  // Currencies are never summed together. Report the largest and let the UI
  // say so when more than one is present.
  const dominant = [...currencies.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    amountMinor: dominant ? Math.round(dominant[1]) : 0,
    currency: dominant?.[0] ?? null,
    subscriptions,
  };
}

/**
 * The share of affected users on one dimension value above which the
 * concentration is worth mentioning. Deliberately above an even two-way split.
 */
export const CONCENTRATION_THRESHOLD = 0.6;

/** Where a problem is concentrated, across the approved segment dimensions. */
export function segmentConcentration(
  db: Db,
  projectId: string,
  identityIds: Set<string>,
  limit = 4,
): Array<{ dimension: string; value: string; users: number; share: number }> {
  if (identityIds.size === 0) return [];
  const ids = [...identityIds];
  const out: Array<{ dimension: string; value: string; users: number; share: number }> = [];
  const dimensions = ["plan", "country", "device_category", "product_version", "acquisition_source"] as const;

  for (const dimension of dimensions) {
    const counts = new Map<string, number>();
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      // `dimension` comes from the closed list above, never from input.
      const rows = db.all<{ value: string | null; n: number }>(
        `SELECT ${dimension} AS value, COUNT(*) AS n FROM identities
          WHERE project_id = ? AND id IN (${chunk.map(() => "?").join(",")})
          GROUP BY ${dimension}`,
        [projectId, ...chunk],
      );
      for (const r of rows) {
        if (!r.value) continue;
        counts.set(r.value, (counts.get(r.value) ?? 0) + r.n);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) continue;
    const share = top[1] / identityIds.size;
    /*
     * Only report a dimension where the problem is genuinely concentrated.
     *
     * The threshold sits above what an even split produces: with two values a
     * 50/50 share is exactly what chance gives you, and reporting it as a
     * pattern would manufacture a finding out of nothing.
     *
     * Even above the threshold this is only suggestive. "70% of affected users
     * are on mobile" means nothing if 70% of all users are on mobile, which is
     * why the share travels with the figure so a reader can judge it.
     */
    if (share > CONCENTRATION_THRESHOLD && counts.size > 1) {
      out.push({ dimension, value: top[0], users: top[1], share });
    }
  }
  return out.sort((a, b) => b.share - a.share).slice(0, limit);
}

export function identitiesForEvent(
  db: Db, projectId: string, eventName: string, from: number, to: number,
): Set<string> {
  return new Set(
    db.allFast<{ identity_id: string }>(
      `SELECT DISTINCT identity_id FROM analytics_events
        WHERE project_id = ? AND name = ? AND occurred_at >= ? AND occurred_at <= ?`,
      [projectId, eventName, from, to],
    ).map((r) => r.identity_id),
  );
}

/**
 * Users who reached one event but not a later one in the window.
 * This is the identity set behind a funnel drop-off, which is what makes the
 * drop-off linkable to anything else.
 */
export function identitiesWhoStalled(
  db: Db, projectId: string, fromEvent: string, toEvent: string, from: number, to: number,
): Set<string> {
  const reached = identitiesForEvent(db, projectId, fromEvent, from, to);
  const continued = identitiesForEvent(db, projectId, toEvent, from, to);
  const stalled = new Set<string>();
  for (const id of reached) if (!continued.has(id)) stalled.add(id);
  return stalled;
}

function accountKeysFor(db: Db, projectId: string, identityIds: Set<string>): Set<string> {
  if (identityIds.size === 0) return new Set();
  const ids = [...identityIds];
  const keys = new Set<string>();
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    for (const r of db.all<{ account_key: string | null }>(
      `SELECT DISTINCT account_key FROM identities
        WHERE project_id = ? AND account_key IS NOT NULL AND id IN (${chunk.map(() => "?").join(",")})`,
      [projectId, ...chunk],
    )) {
      if (r.account_key) keys.add(r.account_key);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Corroboration
// ---------------------------------------------------------------------------

/**
 * Find other signals that touch the same users as a candidate's primary
 * evidence, and attach them.
 *
 * This is the step that turns a lone funnel number into a case. It looks only
 * for *actual overlap*: feedback submitted by the affected users, errors those
 * users hit, releases inside the window, and subscriptions those users hold.
 */
function gatherCorroboratingEvidence(
  db: Db,
  projectId: string,
  candidate: {
    affectedUserIds: Set<string>;
    periodStart: number;
    periodEnd: number;
    workflow: string | null;
  },
): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const affected = candidate.affectedUserIds;
  if (affected.size === 0) return out;

  const ids = [...affected];
  const CHUNK = 400;

  // --- feedback submitted by the affected users ---
  const feedbackRows: Array<{ id: string; title: string; kind: string; cluster_id: string | null; created_at: number; identity_id: string; product_version: string | null }> = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    feedbackRows.push(...db.all<(typeof feedbackRows)[number]>(
      `SELECT id, title, kind, cluster_id, created_at, identity_id, product_version
         FROM feedback_items
        WHERE project_id = ? AND deleted_at IS NULL
          AND identity_id IN (${chunk.map(() => "?").join(",")})
        ORDER BY created_at DESC LIMIT 25`,
      [projectId, ...chunk],
    ));
  }
  // Group by theme where one exists, so a case carries "nine reports about X"
  // rather than nine separate rows.
  const byCluster = new Map<string, typeof feedbackRows>();
  const unclustered: typeof feedbackRows = [];
  for (const f of feedbackRows) {
    if (f.cluster_id) {
      const list = byCluster.get(f.cluster_id) ?? [];
      list.push(f);
      byCluster.set(f.cluster_id, list);
    } else {
      unclustered.push(f);
    }
  }
  for (const [clusterId, items] of byCluster) {
    const cluster = db.get<{ label: string }>("SELECT label FROM feedback_clusters WHERE id = ?", [clusterId]);
    out.push({
      localId: `feedback_cluster:${clusterId}`,
      kind: "feedback_cluster",
      referenceId: clusterId,
      source: "retainos",
      summary: `${items.length} report(s) from affected users in the theme "${cluster?.label ?? "ungrouped"}"`,
      snapshot: {
        theme: cluster?.label ?? null,
        reportCount: items.length,
        examples: items.slice(0, 3).map((i) => i.title),
      },
      observedAt: Math.max(...items.map((i) => i.created_at)),
      userIds: new Set(items.map((i) => i.identity_id)),
      workflow: candidate.workflow,
      productVersions: [...new Set(items.map((i) => i.product_version).filter((v): v is string => Boolean(v)))],
      feedbackClusterId: clusterId,
      accountKeys: accountKeysFor(db, projectId, new Set(items.map((i) => i.identity_id))),
    });
  }
  for (const f of unclustered.slice(0, 5)) {
    out.push({
      localId: `feedback_item:${f.id}`,
      kind: "feedback_item",
      referenceId: f.id,
      source: "retainos",
      summary: f.title,
      snapshot: { kind: f.kind, title: f.title },
      observedAt: f.created_at,
      userIds: new Set([f.identity_id]),
      workflow: candidate.workflow,
      productVersions: f.product_version ? [f.product_version] : [],
      feedbackClusterId: null,
    });
  }

  // --- errors hit by the affected users ---
  const errorRows: Array<{ fingerprint: string; title: string; workflow: string | null; n: number; last_seen: number; versions: string | null }> = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    errorRows.push(...db.all<(typeof errorRows)[number]>(
      `SELECT fingerprint, MAX(title) AS title, MAX(workflow) AS workflow,
              COUNT(*) AS n, MAX(occurred_at) AS last_seen,
              GROUP_CONCAT(DISTINCT product_version) AS versions
         FROM error_events
        WHERE project_id = ? AND occurred_at >= ? AND occurred_at <= ?
          AND identity_id IN (${chunk.map(() => "?").join(",")})
        GROUP BY fingerprint ORDER BY n DESC LIMIT 5`,
      [projectId, candidate.periodStart, candidate.periodEnd, ...chunk],
    ));
  }
  const mergedErrors = new Map<string, (typeof errorRows)[number]>();
  for (const e of errorRows) {
    const existing = mergedErrors.get(e.fingerprint);
    if (existing) existing.n += e.n;
    else mergedErrors.set(e.fingerprint, { ...e });
  }
  for (const e of [...mergedErrors.values()].sort((a, b) => b.n - a.n).slice(0, 4)) {
    const errorUsers = new Set(
      identitiesForFingerprint(db, projectId, e.fingerprint, candidate.periodStart, candidate.periodEnd),
    );
    const overlapping = new Set([...errorUsers].filter((u) => affected.has(u)));
    if (overlapping.size === 0) continue;
    out.push({
      localId: `error_group:${e.fingerprint}`,
      kind: "error_group",
      referenceId: e.fingerprint,
      source: "retainos",
      summary: `${e.n} occurrence(s) of "${e.title}" affecting ${overlapping.size} of these users`,
      snapshot: {
        fingerprint: e.fingerprint,
        title: e.title,
        occurrences: e.n,
        affectedUsersInCase: overlapping.size,
      },
      observedAt: e.last_seen,
      userIds: overlapping,
      workflow: e.workflow ?? candidate.workflow,
      productVersions: (e.versions ?? "").split(",").filter(Boolean),
      errorFingerprint: e.fingerprint,
    });
  }

  // --- releases inside the window ---
  for (const r of db.all<{ id: string; name: string; version: string; released_at: number }>(
    `SELECT id, name, version, released_at FROM releases
      WHERE project_id = ? AND released_at >= ? AND released_at <= ?
      ORDER BY released_at DESC LIMIT 3`,
    [projectId, candidate.periodStart - 7 * 86_400_000, candidate.periodEnd],
  )) {
    out.push({
      localId: `release:${r.id}`,
      kind: "release",
      referenceId: r.id,
      source: "retainos",
      summary: `Release ${r.version} (${r.name}) shipped during or just before this window`,
      snapshot: { version: r.version, name: r.name, releasedAt: r.released_at },
      observedAt: r.released_at,
      // A release touches everyone, so it carries no user set: linking it by
      // "shared users" would connect it to literally everything.
      userIds: new Set(),
      workflow: null,
      productVersions: [r.version],
    });
  }

  // --- subscriptions held by the affected users ---
  const exposure = revenueExposureFor(db, projectId, affected);
  if (exposure.subscriptions > 0) {
    const payingUsers = new Set<string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      for (const r of db.all<{ identity_id: string }>(
        `SELECT DISTINCT identity_id FROM customer_subscriptions
          WHERE project_id = ? AND status IN ('active','past_due')
            AND identity_id IN (${chunk.map(() => "?").join(",")})`,
        [projectId, ...chunk],
      )) payingUsers.add(r.identity_id);
    }
    out.push({
      localId: "subscription_event:exposure",
      kind: "subscription_event",
      referenceId: null,
      source: "retainos",
      summary:
        `${exposure.subscriptions} paying subscription(s) belong to affected users, ` +
        `carrying ${(exposure.amountMinor / 100).toFixed(0)} ${exposure.currency} of MRR`,
      snapshot: { ...exposure },
      observedAt: candidate.periodEnd,
      userIds: payingUsers,
      workflow: null,
      accountKeys: accountKeysFor(db, projectId, payingUsers),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

export interface DetectInput {
  timezone: string;
  now?: number;
  lookbackDays?: number;
  /** Minimum affected users before a candidate is worth raising at all. */
  minAffectedUsers?: number;
}

/**
 * Detect friction cases across every signal source.
 *
 * Each detector finds a candidate and, critically, the **set of identities**
 * behind it. That set is what makes corroboration possible: without it, a
 * funnel number and a feedback theme can only be related by guesswork.
 */
export function detectFrictionCases(db: Db, projectId: string, input: DetectInput): FrictionCandidate[] {
  const now = input.now ?? Date.now();
  const lookback = input.lookbackDays ?? 28;
  const periodStart = now - lookback * 86_400_000;
  const periodEnd = now;
  const minUsers = input.minAffectedUsers ?? 5;
  const ctx = { db, projectId, periodStart, periodEnd, now, minUsers, timezone: input.timezone };

  const candidates: FrictionCandidate[] = [
    ...detectActivationFriction(ctx),
    ...detectReliability(ctx),
    ...detectFeedbackVolume(ctx),
    ...detectBillingFriction(ctx),
    ...detectRetentionFriction(ctx),
  ];

  // Finish each candidate: corroborate, relate, quantify.
  return candidates.map((candidate) => finaliseCandidate(db, projectId, candidate)).filter(
    (c) => c.affectedUserIds.size >= minUsers || c.kind === "billing_friction",
  );
}

interface DetectorContext {
  db: Db;
  projectId: string;
  periodStart: number;
  periodEnd: number;
  now: number;
  minUsers: number;
  timezone: string;
}

function finaliseCandidate(db: Db, projectId: string, candidate: FrictionCandidate): FrictionCandidate {
  const corroborating = gatherCorroboratingEvidence(db, projectId, {
    affectedUserIds: candidate.affectedUserIds,
    periodStart: candidate.periodStart,
    periodEnd: candidate.periodEnd,
    workflow: candidate.affectedWorkflow,
  });
  const evidence = [...candidate.evidence, ...corroborating];
  const relationships = deriveRelationships(evidence);
  const exposure = revenueExposureFor(db, projectId, candidate.affectedUserIds);
  const segments = segmentConcentration(db, projectId, candidate.affectedUserIds);

  // Corroboration from an independent source raises confidence; a lone signal
  // does not. "Independent" means a different kind of evidence, not a second
  // reading of the same number.
  const independentKinds = new Set(
    corroborating.filter((e) => e.kind !== "release").map((e) => e.kind),
  );
  const corroborated = independentKinds.size > 0;

  const assessment = assessConfidence({
    affectedUsers: candidate.affectedUserIds.size,
    effectSize: typeof candidate.evidence[0]?.snapshot.effectSize === "number"
      ? (candidate.evidence[0]!.snapshot.effectSize as number)
      : undefined,
    corroborated,
    periodComplete: true,
  });

  const limitations = [...candidate.limitations];
  if (!corroborated) {
    limitations.push(
      "This case rests on a single kind of evidence. Nothing independent corroborates it yet.",
    );
  }
  if (segments.length > 0) {
    limitations.push(
      "Segment concentration is shown as a share of affected users. Compare it against the share of " +
      "all users on that dimension before reading it as a pattern.",
    );
  }
  if (exposure.subscriptions > 0) {
    limitations.push(
      "Revenue exposure is MRR currently attached to affected accounts. It is not predicted loss, and " +
      "no part of it is promised recoverable.",
    );
  }

  return {
    ...candidate,
    evidence,
    relationships,
    affectedSegments: segments,
    revenueExposureMinor: exposure.subscriptions > 0 ? exposure.amountMinor : null,
    revenueCurrency: exposure.currency,
    evidenceQuality: assessment.label,
    evidenceBasis: assessment.basis,
    limitations,
  };
}

/** The largest loss in the activation funnel, with the users behind it. */
function detectActivationFriction(ctx: DetectorContext): FrictionCandidate[] {
  const { db, projectId, periodStart, periodEnd } = ctx;
  const defs = listActivationDefinitions(db, projectId);
  const def = defs.find((d) => d.isPrimary) ?? defs[0];
  if (!def) return [];

  const steps = [
    { event: def.signupEvent, label: "Registered" },
    { event: "onboarding_started", label: "Onboarding started" },
    { event: "onboarding_completed", label: "Onboarding completed" },
    { event: def.activationEvent, label: `Activated (${def.activationEvent})` },
  ];
  const funnel = computeFunnel(db, projectId, {
    steps, from: periodStart, to: periodEnd, conversionWindowHours: def.windowDays * 24,
  });
  if (!funnel.ok || !funnel.value.largestDropOff) return [];

  const drop = funnel.value.largestDropOff;
  const fromStep = funnel.value.steps[drop.fromIndex]!;
  const toStep = funnel.value.steps[drop.toIndex]!;
  if (drop.lostUsers < ctx.minUsers) return [];

  const stalled = identitiesWhoStalled(db, projectId, fromStep.event, toStep.event, periodStart, periodEnd);
  const workflow = `${fromStep.event} → ${toStep.event}`;
  const lossRate = fromStep.users === 0 ? 0 : drop.lostUsers / fromStep.users;

  return [{
    kind: "activation_friction",
    title: `Users stall between ${fromStep.label} and ${toStep.label}`,
    productArea: "Onboarding",
    affectedWorkflow: workflow,
    observation:
      `${drop.lostUsers} of ${fromStep.users} users who reached "${fromStep.label}" did not reach ` +
      `"${toStep.label}" within ${def.windowDays} days. Step conversion was ` +
      `${(drop.conversionRate * 100).toFixed(1)}%, the largest absolute loss in the activation funnel.`,
    hypotheses: [
      `The "${toStep.label}" step may be harder or less obvious than intended.`,
      "Users may be hitting an error, a slow response, or a requirement they cannot satisfy.",
      "Some of these users may not have needed this step yet.",
    ],
    recommendedInvestigations: [
      "Read the feedback attached to this case: it comes from these same users.",
      "Check whether the error groups below overlap with the users who stalled.",
      "Compare this step's conversion across plan, device and acquisition source.",
    ],
    limitations: [
      "A funnel drop-off shows where users stopped, not why. Nothing here establishes a cause.",
      funnel.value.definition.windowSemantics,
    ],
    periodStart, periodEnd,
    affectedUserIds: stalled,
    evidence: [{
      localId: "funnel_step:primary",
      kind: "funnel_step",
      referenceId: null,
      source: "retainos",
      summary: `${fromStep.label} → ${toStep.label}: ${(drop.conversionRate * 100).toFixed(1)}% step conversion, ${drop.lostUsers} users lost`,
      snapshot: {
        fromEvent: fromStep.event, toEvent: toStep.event,
        fromUsers: fromStep.users, toUsers: toStep.users,
        conversionRate: drop.conversionRate, lostUsers: drop.lostUsers,
        effectSize: lossRate,
      },
      observedAt: periodEnd,
      userIds: stalled,
      workflow,
    }],
    relationships: [],
    affectedSegments: [],
    revenueExposureMinor: null,
    revenueCurrency: null,
    evidenceQuality: "insufficient_data",
    evidenceBasis: "",
    dedupeKey: `activation_friction:${fromStep.event}:${toStep.event}`,
  }];
}

/** Error clusters affecting enough distinct users to matter. */
function detectReliability(ctx: DetectorContext): FrictionCandidate[] {
  const { db, projectId, periodStart, periodEnd } = ctx;
  const groups = errorGroups(db, projectId, periodStart, periodEnd, 10);

  return groups
    .filter((g) => g.affectedUsers >= ctx.minUsers && g.level !== "warning")
    .slice(0, 5)
    .map((g) => {
      const users = new Set(identitiesForFingerprint(db, projectId, g.fingerprint, periodStart, periodEnd));
      return {
        kind: "reliability" as FrictionKind,
        title: `Repeated failure: ${g.title}`,
        productArea: g.workflow ?? null,
        affectedWorkflow: g.workflow,
        observation:
          `${g.occurrences} occurrence(s) of "${g.title}" affected ${g.affectedUsers} distinct users ` +
          `between ${dayKey(g.firstSeen, ctx.timezone)} and ${dayKey(g.lastSeen, ctx.timezone)}` +
          (g.productVersions.length > 0 ? ` on version ${g.productVersions.join(", ")}` : "") + ".",
        hypotheses: [
          "A recent change may have introduced or exposed this failure.",
          "It may affect a specific configuration, plan or client version rather than everyone.",
          "Users hitting it may be abandoning the workflow rather than retrying.",
        ],
        recommendedInvestigations: [
          "Check whether the users hitting this error overlap with a funnel drop-off.",
          "Compare the error's volume before and after the releases linked to this case.",
          "Look for feedback from these same users describing the symptom.",
        ],
        limitations: [
          "RetainOS stores an error fingerprint, title and workflow only. It is not an error monitor and " +
          "has no stack traces, so it cannot tell you the technical cause.",
          "Error volume depends on what the application chooses to report.",
        ],
        periodStart, periodEnd,
        affectedUserIds: users,
        evidence: [{
          localId: `error_group:${g.fingerprint}`,
          kind: "error_group" as EvidenceKind,
          referenceId: g.fingerprint,
          source: (g.sources.includes("sentry") ? "sentry" : "retainos") as EvidenceItem["source"],
          summary: `${g.occurrences} occurrences, ${g.affectedUsers} users affected`,
          snapshot: {
            fingerprint: g.fingerprint, title: g.title, occurrences: g.occurrences,
            affectedUsers: g.affectedUsers, level: g.level, culprit: g.culprit,
          },
          observedAt: g.lastSeen,
          userIds: users,
          workflow: g.workflow,
          productVersions: g.productVersions,
          errorFingerprint: g.fingerprint,
        }],
        relationships: [],
        affectedSegments: [],
        revenueExposureMinor: null,
        revenueCurrency: null,
        evidenceQuality: "insufficient_data" as ConfidenceLabel,
        evidenceBasis: "",
        dedupeKey: `reliability:${g.fingerprint}`,
      };
    });
}

/** Feedback themes with enough independent reporters to be a signal. */
function detectFeedbackVolume(ctx: DetectorContext): FrictionCandidate[] {
  const { db, projectId, periodStart, periodEnd } = ctx;
  const clusters = db.all<{ id: string; label: string; keywords: string; n: number }>(
    `SELECT c.id, c.label, c.keywords,
            (SELECT COUNT(*) FROM feedback_items f
              WHERE f.cluster_id = c.id AND f.deleted_at IS NULL
                AND f.created_at >= ? AND f.created_at <= ?) AS n
       FROM feedback_clusters c WHERE c.project_id = ?
      ORDER BY n DESC LIMIT 5`,
    [periodStart, periodEnd, projectId],
  ).filter((c) => c.n >= 3);

  return clusters.map((c) => {
    const items = db.all<{ id: string; title: string; kind: string; identity_id: string | null; created_at: number; product_version: string | null }>(
      `SELECT id, title, kind, identity_id, created_at, product_version FROM feedback_items
        WHERE cluster_id = ? AND deleted_at IS NULL AND created_at >= ? AND created_at <= ?`,
      [c.id, periodStart, periodEnd],
    );
    const users = new Set(items.map((i) => i.identity_id).filter((v): v is string => Boolean(v)));
    return {
      kind: "feedback_volume" as FrictionKind,
      title: `${c.n} reports about: ${c.label}`,
      productArea: null,
      affectedWorkflow: null,
      observation:
        `${c.n} feedback items submitted in this period share the terms "${c.label}", from ` +
        `${users.size} identified user(s). Examples: ${items.slice(0, 3).map((i) => `"${i.title}"`).join("; ")}.`,
      hypotheses: [
        "These reports may describe one underlying problem.",
        "They may be separate problems that happen to share vocabulary.",
        "The grouping itself may be wrong; it is based on shared words, not meaning.",
      ],
      recommendedInvestigations: [
        "Read the grouped items and confirm they are genuinely the same issue.",
        "Check whether these reporters also appear in a funnel drop-off or an error group.",
        "Count distinct reporters, not reports: one vocal user is not a trend.",
      ],
      limitations: [
        "Report volume reflects who chose to write in, not how many users are affected.",
        "Clustering is by shared terms rather than meaning, and should be corrected by hand.",
        users.size < items.length
          ? `${items.length - users.size} of these reports have no identified user, so they cannot be linked to product behaviour.`
          : "",
      ].filter(Boolean),
      periodStart, periodEnd,
      affectedUserIds: users,
      evidence: [{
        localId: `feedback_cluster:${c.id}`,
        kind: "feedback_cluster" as EvidenceKind,
        referenceId: c.id,
        source: "retainos" as const,
        summary: `${c.n} reports in the theme "${c.label}"`,
        snapshot: {
          theme: c.label, keywords: jsonParse<string[]>(c.keywords, []),
          reportCount: c.n, distinctReporters: users.size,
        },
        observedAt: Math.max(...items.map((i) => i.created_at), periodStart),
        userIds: users,
        workflow: null,
        feedbackClusterId: c.id,
        productVersions: [...new Set(items.map((i) => i.product_version).filter((v): v is string => Boolean(v)))],
      }],
      relationships: [],
      affectedSegments: [],
      revenueExposureMinor: null,
      revenueCurrency: null,
      evidenceQuality: "insufficient_data" as ConfidenceLabel,
      evidenceBasis: "",
      dedupeKey: `feedback_volume:${c.id}`,
    };
  });
}

/** Failed payments. Separated from voluntary cancellation on purpose. */
function detectBillingFriction(ctx: DetectorContext): FrictionCandidate[] {
  const { db, projectId, periodStart, periodEnd } = ctx;
  const pastDue = db.all<{ identity_id: string | null; amount_minor: number; interval: string; currency: string }>(
    `SELECT identity_id, amount_minor, interval, currency FROM customer_subscriptions
      WHERE project_id = ? AND status = 'past_due'`,
    [projectId],
  );
  if (pastDue.length === 0) return [];

  const users = new Set(pastDue.map((p) => p.identity_id).filter((v): v is string => Boolean(v)));
  const total = pastDue.reduce((s, p) => s + normaliseToMrr(p.amount_minor, (p.interval as Interval) ?? "month"), 0);
  const currency = pastDue[0]!.currency;

  return [{
    kind: "billing_friction",
    title: `${pastDue.length} subscription(s) in a failed-payment state`,
    productArea: "Billing",
    affectedWorkflow: "payment",
    observation:
      `${pastDue.length} subscription(s) are currently past due, carrying ` +
      `${(total / 100).toFixed(0)} ${currency} of MRR. This is a verified billing state from provider ` +
      "events, not an inference from product usage.",
    hypotheses: [
      "Most failed payments are an expired or replaced card rather than a decision to leave.",
      "A dunning process may not be running, or its messages may not be reaching customers.",
      "Some of these customers may have already moved on.",
    ],
    recommendedInvestigations: [
      "Confirm the provider's dunning process is actually running and its messages deliver.",
      "Check whether these accounts are still using the product: an active account with a failed card is a very different situation from a dormant one.",
      "Review whether the payment-update path works on mobile.",
    ],
    limitations: [
      "Past due is an observed state, not a prediction. Many recover without any intervention.",
      "RetainOS does not handle payment credentials and cannot retry a payment.",
    ],
    periodStart, periodEnd,
    affectedUserIds: users,
    evidence: [{
      localId: "subscription_event:past_due",
      kind: "subscription_event",
      referenceId: null,
      source: "retainos",
      summary: `${pastDue.length} past-due subscriptions, ${(total / 100).toFixed(0)} ${currency} MRR`,
      snapshot: { count: pastDue.length, mrrMinor: Math.round(total), currency },
      observedAt: periodEnd,
      userIds: users,
      workflow: "payment",
      accountKeys: accountKeysFor(db, projectId, users),
    }],
    relationships: [],
    affectedSegments: [],
    revenueExposureMinor: null,
    revenueCurrency: null,
    evidenceQuality: "insufficient_data",
    evidenceBasis: "",
    dedupeKey: "billing_friction:past_due",
  }];
}

/** A material fall in day-7 retention between adjacent periods. */
function detectRetentionFriction(ctx: DetectorContext): FrictionCandidate[] {
  const { db, projectId, periodStart, periodEnd, now, timezone } = ctx;
  const span = periodEnd - periodStart;
  const current = computeRetention(db, projectId, {
    from: periodStart, to: periodEnd, timezone, periods: [7], now,
  });
  const prior = computeRetention(db, projectId, {
    from: periodStart - span, to: periodStart - 1, timezone, periods: [7], now,
  });
  const c = current.averageByPeriod.find((p) => p.period === 7);
  const p = prior.averageByPeriod.find((p) => p.period === 7);
  if (!c?.rate || !p?.rate || c.usersCounted < 20 || p.usersCounted < 20) return [];

  const delta = c.rate - p.rate;
  if (delta >= -0.05) return [];

  // The users behind it: this period's cohort members who did not return.
  const cohortIds = new Set<string>();
  for (const cohort of current.cohorts) {
    for (const cell of cohort.cells) {
      if (cell.period === 7 && cell.complete && cell.rate < 1) {
        // Cohort membership is known; non-returners are the complement.
      }
    }
  }
  const returned = identitiesForEvent(db, projectId, "core_action_completed", periodStart, periodEnd + 14 * 86_400_000);
  const signedUp = identitiesForEvent(db, projectId, "signup_completed", periodStart, periodEnd);
  for (const id of signedUp) if (!returned.has(id)) cohortIds.add(id);

  return [{
    kind: "retention_friction",
    title: `Day-7 retention fell by ${(Math.abs(delta) * 100).toFixed(1)} points`,
    productArea: null,
    affectedWorkflow: null,
    observation:
      `Day-7 retention was ${(p.rate * 100).toFixed(1)}% across ${p.usersCounted} users in the previous ` +
      `period and ${(c.rate * 100).toFixed(1)}% across ${c.usersCounted} users in this one. Only cohorts ` +
      "whose day-7 window has fully elapsed are included.",
    hypotheses: [
      "Users may be reaching the product's value later, or not at all.",
      "A change may have broken or complicated a routine task users return for.",
      "The cohorts may simply be made up of different kinds of user.",
    ],
    recommendedInvestigations: [
      "Compare the two cohorts' activation rates: retention usually follows activation.",
      "Check whether the errors or feedback attached here come from the cohort that did not return.",
      "Compare retention by acquisition source to rule out a traffic-mix change.",
    ],
    limitations: [
      "Cohort comparisons are observational. A difference between cohorts is not an effect of anything in particular.",
      current.definition.denominator,
    ],
    periodStart, periodEnd,
    affectedUserIds: cohortIds,
    evidence: [{
      localId: "retention_cohort:d7",
      kind: "retention_cohort",
      referenceId: null,
      source: "retainos",
      summary: `Day-7 retention ${(p.rate * 100).toFixed(1)}% → ${(c.rate * 100).toFixed(1)}%`,
      snapshot: {
        priorRate: p.rate, currentRate: c.rate,
        priorUsers: p.usersCounted, currentUsers: c.usersCounted,
        effectSize: Math.abs(delta),
      },
      observedAt: periodEnd,
      userIds: cohortIds,
      workflow: null,
    }],
    relationships: [],
    affectedSegments: [],
    revenueExposureMinor: null,
    revenueCurrency: null,
    evidenceQuality: "insufficient_data",
    evidenceBasis: "",
    dedupeKey: `retention_friction:d7:${dayKey(periodStart, timezone)}`,
  }];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistResult {
  created: number;
  updated: number;
  caseIds: string[];
}

/**
 * Store detected cases.
 *
 * A case that already exists is **updated in place**, keeping its id, its
 * status and any human decision attached to it. Re-running detection must
 * never resurrect a dismissed case or reset an investigation someone is in the
 * middle of.
 */
export function persistFrictionCases(
  db: Db,
  ids: { orgId: string; projectId: string },
  candidates: FrictionCandidate[],
  now = Date.now(),
): PersistResult {
  let created = 0;
  let updated = 0;
  const caseIds: string[] = [];

  for (const candidate of candidates) {
    const existing = db.get<{ id: string; status: string }>(
      "SELECT id, status FROM friction_cases WHERE project_id = ? AND dedupe_key = ?",
      [ids.projectId, candidate.dedupeKey],
    );

    const caseId = existing?.id ?? newId("fcs");
    const shared = [
      candidate.title, candidate.productArea, candidate.affectedWorkflow, candidate.kind,
      candidate.periodStart, candidate.periodEnd, candidate.affectedUserIds.size,
      JSON.stringify(candidate.affectedSegments),
      candidate.revenueExposureMinor, candidate.revenueCurrency,
      candidate.evidenceQuality, candidate.evidenceBasis, candidate.observation,
      JSON.stringify(candidate.hypotheses),
      JSON.stringify(candidate.recommendedInvestigations),
      JSON.stringify(candidate.limitations),
      now,
    ];

    if (existing) {
      // Status and improvement_id are deliberately absent from this UPDATE.
      db.run(
        `UPDATE friction_cases SET
           title = ?, product_area = ?, affected_workflow = ?, kind = ?,
           period_start = ?, period_end = ?, affected_users = ?, affected_segments = ?,
           revenue_exposure_minor = ?, revenue_currency = ?,
           evidence_quality = ?, evidence_basis = ?, observation = ?,
           hypotheses = ?, recommended_investigations = ?, limitations = ?, updated_at = ?
         WHERE id = ?`,
        [...shared, caseId],
      );
      updated++;
    } else {
      db.run(
        `INSERT INTO friction_cases
          (id, org_id, project_id, title, product_area, affected_workflow, kind,
           period_start, period_end, affected_users, affected_segments,
           revenue_exposure_minor, revenue_currency, evidence_quality, evidence_basis,
           observation, hypotheses, recommended_investigations, limitations, updated_at,
           status, detector, dedupe_key, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detected', 'rules_v1', ?, ?)`,
        [caseId, ids.orgId, ids.projectId, ...shared, candidate.dedupeKey, now],
      );
      db.run(
        `INSERT INTO friction_status_history (id, org_id, case_id, from_status, to_status, note, changed_at)
         VALUES (?, ?, ?, NULL, 'detected', 'Detected automatically', ?)`,
        [newId("fsh"), ids.orgId, caseId, now],
      );
      created++;
    }

    // Evidence and relationships are a snapshot of the latest detection, so
    // they are replaced wholesale rather than accumulated.
    db.run("DELETE FROM friction_relationships WHERE case_id = ?", [caseId]);
    db.run("DELETE FROM friction_evidence WHERE case_id = ?", [caseId]);

    const localToDb = new Map<string, string>();
    for (const e of candidate.evidence) {
      const evidenceId = newId("fev");
      localToDb.set(e.localId, evidenceId);
      db.run(
        `INSERT INTO friction_evidence
          (id, org_id, case_id, kind, reference_id, source, summary, snapshot, observed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          evidenceId, ids.orgId, caseId, e.kind, e.referenceId, e.source, e.summary,
          JSON.stringify({ ...e.snapshot, affectedUsersInSignal: e.userIds.size }),
          e.observedAt, now,
        ],
      );
    }

    for (const r of candidate.relationships) {
      const from = localToDb.get(r.fromLocalId);
      const to = localToDb.get(r.toLocalId);
      if (!from || !to) continue;
      db.run(
        `INSERT OR IGNORE INTO friction_relationships
          (id, org_id, case_id, from_evidence_id, to_evidence_id, relationship, shared_key, basis, strength, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId("frl"), ids.orgId, caseId, from, to, r.relationship, r.sharedKey, r.basis, r.strength, now],
      );
    }

    caseIds.push(caseId);
  }

  return { created, updated, caseIds };
}

/** Detect and persist in one step. The worker's entry point. */
export function refreshFrictionGraph(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: DetectInput,
): PersistResult & { detected: number } {
  const candidates = detectFrictionCases(db, ids.projectId, input);
  const result = persistFrictionCases(db, ids, candidates, input.now ?? Date.now());
  return { ...result, detected: candidates.length };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function listFrictionCases(
  db: Db,
  projectId: string,
  filter: { status?: FrictionStatus[]; kind?: FrictionKind[]; limit?: number } = {},
) {
  const where = ["c.project_id = ?"];
  const params: unknown[] = [projectId];
  if (filter.status?.length) {
    where.push(`c.status IN (${filter.status.map(() => "?").join(",")})`);
    params.push(...filter.status);
  }
  if (filter.kind?.length) {
    where.push(`c.kind IN (${filter.kind.map(() => "?").join(",")})`);
    params.push(...filter.kind);
  }
  params.push(Math.min(filter.limit ?? 50, 200));

  return db.all<Record<string, unknown>>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM friction_evidence e WHERE e.case_id = c.id) AS evidence_count,
            (SELECT COUNT(*) FROM friction_relationships r WHERE r.case_id = c.id) AS relationship_count,
            (SELECT COUNT(DISTINCT e.kind) FROM friction_evidence e WHERE e.case_id = c.id) AS evidence_kinds,
            (SELECT s.score FROM opportunity_scores s WHERE s.case_id = c.id
              ORDER BY s.computed_at DESC LIMIT 1) AS score,
            (SELECT s.rank FROM opportunity_scores s WHERE s.case_id = c.id
              ORDER BY s.computed_at DESC LIMIT 1) AS rank
       FROM friction_cases c
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE((SELECT s.rank FROM opportunity_scores s WHERE s.case_id = c.id
                          ORDER BY s.computed_at DESC LIMIT 1), 9999) ASC,
               c.detected_at DESC
      LIMIT ?`,
    params,
  );
}

export interface FrictionCaseDetail {
  record: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
  score: Record<string, unknown> | null;
  factors: Array<Record<string, unknown>>;
  estimate: Record<string, unknown> | null;
}

export function getFrictionCase(db: Db, projectId: string, caseId: string): FrictionCaseDetail | null {
  const record = db.get<Record<string, unknown>>(
    "SELECT * FROM friction_cases WHERE id = ? AND project_id = ?", [caseId, projectId],
  );
  if (!record) return null;

  const score = db.get<Record<string, unknown>>(
    "SELECT * FROM opportunity_scores WHERE case_id = ? ORDER BY computed_at DESC LIMIT 1", [caseId],
  ) ?? null;

  return {
    record,
    evidence: db.all("SELECT * FROM friction_evidence WHERE case_id = ? ORDER BY observed_at ASC", [caseId]),
    // Relationships join through to both evidence rows so the UI can render a
    // readable sentence rather than two opaque ids.
    relationships: db.all(
      `SELECT r.*, a.summary AS from_summary, a.kind AS from_kind,
              b.summary AS to_summary, b.kind AS to_kind
         FROM friction_relationships r
         JOIN friction_evidence a ON a.id = r.from_evidence_id
         JOIN friction_evidence b ON b.id = r.to_evidence_id
        WHERE r.case_id = ? ORDER BY r.strength DESC`,
      [caseId],
    ),
    history: db.all("SELECT * FROM friction_status_history WHERE case_id = ? ORDER BY changed_at ASC", [caseId]),
    score,
    factors: score
      ? db.all("SELECT * FROM opportunity_score_factors WHERE score_id = ? ORDER BY contribution DESC", [score.id])
      : [],
    estimate: db.get("SELECT * FROM opportunity_estimates WHERE case_id = ?", [caseId]) ?? null,
  };
}

/** Permitted status moves. A case cannot skip straight from detected to resolved. */
const FRICTION_TRANSITIONS: Record<FrictionStatus, FrictionStatus[]> = {
  detected: ["investigating", "dismissed"],
  investigating: ["evidence_collected", "detected", "dismissed", "inconclusive"],
  evidence_collected: ["validated", "investigating", "dismissed", "inconclusive"],
  validated: ["approved", "evidence_collected", "dismissed"],
  approved: ["in_development", "validated", "dismissed"],
  in_development: ["released", "approved"],
  released: ["measuring"],
  measuring: ["resolved", "inconclusive"],
  resolved: ["measuring"],
  inconclusive: ["investigating", "dismissed"],
  dismissed: ["detected"],
};

export function canTransitionCase(from: FrictionStatus, to: FrictionStatus): boolean {
  return FRICTION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionCase(
  db: Db,
  ids: { orgId: string; projectId: string; userId: string },
  caseId: string,
  to: FrictionStatus,
  note?: string,
  now = Date.now(),
): Result<true, DomainError> {
  const row = db.get<{ status: FrictionStatus }>(
    "SELECT status FROM friction_cases WHERE id = ? AND project_id = ?", [caseId, ids.projectId],
  );
  if (!row) return err(domainError("not_found", "Friction case not found."));
  if (row.status === to) return ok(true);
  if (!canTransitionCase(row.status, to)) {
    return err(domainError("conflict", `Cannot move a case from '${row.status}' to '${to}'.`, {
      from: row.status, to, allowed: FRICTION_TRANSITIONS[row.status],
    }));
  }
  db.run(
    "UPDATE friction_cases SET status = ?, updated_at = ?, dismissed_reason = CASE WHEN ? = 'dismissed' THEN ? ELSE dismissed_reason END WHERE id = ?",
    [to, now, to, note ?? null, caseId],
  );
  db.run(
    `INSERT INTO friction_status_history (id, org_id, case_id, from_status, to_status, note, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId("fsh"), ids.orgId, caseId, row.status, to, note ?? null, ids.userId, now],
  );
  return ok(true);
}

/** Attach a case to a FixFlow improvement, carrying its evidence across. */
export function linkCaseToImprovement(
  db: Db, projectId: string, caseId: string, improvementId: string, now = Date.now(),
): Result<true, DomainError> {
  const owned = db.get("SELECT 1 FROM improvement_tasks WHERE id = ? AND project_id = ?", [improvementId, projectId]);
  if (!owned) return err(domainError("not_found", "Improvement task not found in this project."));
  const r = db.run(
    "UPDATE friction_cases SET improvement_id = ?, updated_at = ? WHERE id = ? AND project_id = ?",
    [improvementId, now, caseId, projectId],
  );
  return r.changes === 0 ? err(domainError("not_found", "Friction case not found.")) : ok(true);
}

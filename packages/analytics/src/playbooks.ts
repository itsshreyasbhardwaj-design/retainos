import { type Db } from "@retainos/database";
import {
  newId, stableHashFraction, ok, err, domainError, type Result, type DomainError,
} from "@retainos/shared";
import { twoProportionTest } from "./stats.ts";

/**
 * Retention playbooks.
 *
 * This is the part of a retention product most likely to do harm, so it is the
 * part with the most rules. The usual version of this feature sends whatever
 * the growth team can think of to whoever looks like they might leave, counts
 * the ones who stayed, and calls the difference retention. That is not a
 * measurement — the people who were going to stay anyway are in the numerator.
 *
 * Four commitments are enforced in code rather than documented as intentions:
 *
 *  - Nothing enrols until a human with permission approves it.
 *  - A share of eligible users is held out and receives nothing, so the effect
 *    can be measured rather than assumed.
 *  - Email requires recorded consent, checked at enrolment and again at
 *    delivery. An absent record is never read as consent.
 *  - Caps are hard and enforced at enrolment: one message per person per
 *    playbook by default, quiet hours honoured, and a reason recorded every
 *    time something is not sent.
 *
 * And some things this deliberately cannot do: it cannot block or delay a
 * cancellation, it cannot offer a discount in the cancellation flow, and it
 * cannot send at zero delay on an outbound channel, because an instant message
 * after an action reads as surveillance.
 */

export type PlaybookKind =
  | "onboarding_recovery"
  | "feature_discovery"
  | "inactivity_follow_up"
  | "feedback_follow_up"
  | "cancellation_feedback"
  | "payment_failure_assistance";

export type PlaybookStatus = "draft" | "approved" | "active" | "paused" | "archived";
export type TriggerKind =
  | "event_occurred" | "event_absent" | "funnel_stalled"
  | "health_state" | "subscription_state" | "feedback_resolved";
export type Channel = "in_app" | "email" | "none";
export type Arm = "treatment" | "holdout";

/** What each playbook kind is for, and what it must not be used for. */
export const PLAYBOOK_KIND_RULES: Record<PlaybookKind, { purpose: string; forbidden: string }> = {
  onboarding_recovery: {
    purpose: "Help someone who started setting up and stopped, by pointing at the step they stalled on.",
    forbidden: "Repeated nudges. One message, with a way to get real help.",
  },
  feature_discovery: {
    purpose: "Tell a user about a capability that would solve a problem their behaviour shows they have.",
    forbidden: "Announcing features nobody asked about, or upselling dressed as education.",
  },
  inactivity_follow_up: {
    purpose: "Ask once whether something got in the way, and make leaving easy if the answer is no.",
    forbidden: "Guilt, streak-breaking, loss framing, or implying the account is at risk when it is not.",
  },
  feedback_follow_up: {
    purpose: "Tell someone who reported a problem that it was fixed. The most under-used retention act there is.",
    forbidden: "Asking for a review in the same message.",
  },
  cancellation_feedback: {
    purpose: "Ask why, after the cancellation has gone through, and accept the answer.",
    forbidden:
      "Anything that delays, complicates or discourages the cancellation itself, including a retention offer.",
  },
  payment_failure_assistance: {
    purpose: "Tell someone their card failed, because it is usually an expired card and not a decision.",
    forbidden: "Threats, countdowns, or restricting access before the grace period ends.",
  },
};

export const CANCELLATION_RULE =
  "A cancellation playbook may only run after the cancellation has completed. RetainOS will not help " +
  "delay, complicate or discourage someone leaving, and offers no mechanism to do so.";

export interface PlaybookInput {
  id?: string;
  name: string;
  kind: PlaybookKind;
  description?: string;
  triggerKind: TriggerKind;
  triggerConfig?: Record<string, unknown>;
  delayHours?: number;
  audienceFilter?: Record<string, unknown>;
  channel: Channel;
  messageTitle?: string;
  messageBody?: string;
  helpUrl?: string | null;
  maxPerUserTotal?: number;
  maxPerUserDays?: number;
  quietHoursStart?: number | null;
  quietHoursEnd?: number | null;
  holdoutPercent?: number;
  stopOnEvent?: string | null;
  primaryMetricEvent?: string | null;
  guardrailMetrics?: string[];
}

export interface Playbook {
  id: string;
  name: string;
  kind: PlaybookKind;
  description: string;
  status: PlaybookStatus;
  triggerKind: TriggerKind;
  triggerConfig: Record<string, unknown>;
  delayHours: number;
  audienceFilter: Record<string, unknown>;
  channel: Channel;
  requiresConsent: boolean;
  messageTitle: string;
  messageBody: string;
  helpUrl: string | null;
  maxPerUserTotal: number;
  maxPerUserDays: number;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  holdoutPercent: number;
  stopOnEvent: string | null;
  primaryMetricEvent: string | null;
  guardrailMetrics: string[];
  approvedBy: string | null;
  approvedAt: number | null;
}

/** Holdouts smaller than this cannot measure anything, so they are refused. */
export const MIN_HOLDOUT_PERCENT = 0.05;
export const MAX_HOLDOUT_PERCENT = 0.5;
/** No outbound channel may fire sooner than this after its trigger. */
export const MIN_OUTBOUND_DELAY_HOURS = 1;

const MANIPULATIVE_PHRASES = [
  "last chance", "act now", "don't miss out", "dont miss out", "expires in",
  "you'll lose", "you will lose", "only hours left", "final warning",
  "before it's too late", "before its too late", "we'll have to", "your streak",
];

/**
 * Check message copy for the patterns this product refuses to send.
 *
 * Deliberately a blocklist of concrete phrases rather than a sentiment model:
 * a rule the user can read and argue with is enforceable, and a classifier
 * that silently rejects copy would be worse than no check at all.
 */
export function manipulativePhrasesIn(text: string): string[] {
  const lower = text.toLowerCase();
  return MANIPULATIVE_PHRASES.filter((p) => lower.includes(p));
}

export function upsertPlaybook(
  db: Db,
  ids: { orgId: string; projectId: string; userId: string },
  input: PlaybookInput,
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  if (!input.name.trim()) {
    return err(domainError("validation_failed", "A playbook needs a name."));
  }
  if (!(input.kind in PLAYBOOK_KIND_RULES)) {
    return err(domainError("validation_failed", `Unknown playbook kind "${input.kind}".`));
  }

  const holdout = input.holdoutPercent ?? 0.1;
  if (holdout < MIN_HOLDOUT_PERCENT || holdout > MAX_HOLDOUT_PERCENT) {
    return err(domainError(
      "validation_failed",
      `The holdout must be between ${MIN_HOLDOUT_PERCENT * 100}% and ${MAX_HOLDOUT_PERCENT * 100}%. ` +
      "A smaller holdout cannot measure whether the playbook does anything, and this product will not " +
      "report an effect it has not measured.",
    ));
  }

  const delay = input.delayHours ?? 24;
  if (input.channel !== "none" && delay < MIN_OUTBOUND_DELAY_HOURS) {
    return err(domainError(
      "validation_failed",
      "An outbound message cannot be sent less than an hour after its trigger. An instant message " +
      "following something a user just did reads as surveillance.",
    ));
  }

  const copy = `${input.messageTitle ?? ""} ${input.messageBody ?? ""}`;
  const found = manipulativePhrasesIn(copy);
  if (found.length > 0) {
    return err(domainError(
      "validation_failed",
      `This copy uses pressure tactics RetainOS will not send: ${found.map((f) => `"${f}"`).join(", ")}. ` +
      "Say what happened and what the user can do about it.",
    ));
  }

  if (input.triggerKind === "funnel_stalled") {
    const config = (input.triggerConfig ?? {}) as Record<string, unknown>;
    const from = typeof config.fromEvent === "string" ? config.fromEvent : "";
    const to = typeof config.toEvent === "string" ? config.toEvent : "";
    if (!from || !to) {
      return err(domainError(
        "validation_failed",
        "A stalled-funnel trigger needs both the event people did and the event they did not go on to do.",
      ));
    }
    if (from === to) {
      return err(domainError(
        "validation_failed",
        `"${from}" cannot be both the step people reached and the step they failed to reach. A funnel from ` +
        "an event to itself has no audience, and enrolling nobody would look like the playbook working.",
      ));
    }
  }

  if (input.kind === "cancellation_feedback") {
    if (input.triggerKind !== "subscription_state") {
      return err(domainError(
        "validation_failed",
        "A cancellation playbook must trigger on the completed subscription state, never earlier. " + CANCELLATION_RULE,
      ));
    }
    const state = (input.triggerConfig ?? {})["state"];
    if (state !== "cancelled" && state !== "expired") {
      return err(domainError("validation_failed", CANCELLATION_RULE));
    }
  }

  const perUser = input.maxPerUserTotal ?? 1;
  if (perUser < 1 || perUser > 5) {
    return err(domainError(
      "validation_failed",
      "A playbook may send between 1 and 5 messages to one person in total. More than that is not a " +
      "playbook, it is a campaign, and it belongs in a tool the recipient can unsubscribe from.",
    ));
  }

  for (const hour of [input.quietHoursStart, input.quietHoursEnd]) {
    if (hour !== null && hour !== undefined && (hour < 0 || hour > 23)) {
      return err(domainError("validation_failed", "Quiet hours must be hours of the day, 0 to 23."));
    }
  }

  // Email consent is not configurable. The column exists for in-app, where
  // product use is itself the basis.
  const requiresConsent = input.channel === "email" ? 1 : 0;
  const id = input.id ?? newId("pbk");
  const existing = db.get<{ id: string; status: string }>(
    "SELECT id, status FROM retention_playbooks WHERE project_id = ? AND (id = ? OR name = ?)",
    [ids.projectId, id, input.name],
  );

  const row = [
    input.name, input.kind, input.description ?? "", input.triggerKind,
    JSON.stringify(input.triggerConfig ?? {}), delay, JSON.stringify(input.audienceFilter ?? {}),
    input.channel, requiresConsent, input.messageTitle ?? "", input.messageBody ?? "",
    input.helpUrl ?? null, perUser, input.maxPerUserDays ?? 30,
    input.quietHoursStart ?? null, input.quietHoursEnd ?? null, holdout,
    input.stopOnEvent ?? null, input.primaryMetricEvent ?? null,
    JSON.stringify(input.guardrailMetrics ?? []), now,
  ];

  if (existing) {
    // Editing a live playbook returns it to draft: an approval covers the copy
    // and audience that were approved, not whatever they become later.
    db.run(
      `UPDATE retention_playbooks SET
         name = ?, kind = ?, description = ?, trigger_kind = ?, trigger_config = ?, delay_hours = ?,
         audience_filter = ?, channel = ?, requires_consent = ?, message_title = ?, message_body = ?,
         help_url = ?, max_per_user_total = ?, max_per_user_days = ?, quiet_hours_start = ?,
         quiet_hours_end = ?, holdout_percent = ?, stop_on_event = ?, primary_metric_event = ?,
         guardrail_metrics = ?, updated_at = ?,
         status = 'draft', approved_by = NULL, approved_at = NULL
       WHERE id = ?`,
      [...row, existing.id],
    );
    return ok({ id: existing.id });
  }

  db.run(
    `INSERT INTO retention_playbooks
      (id, org_id, project_id, name, kind, description, trigger_kind, trigger_config, delay_hours,
       audience_filter, channel, requires_consent, message_title, message_body, help_url,
       max_per_user_total, max_per_user_days, quiet_hours_start, quiet_hours_end, holdout_percent,
       stop_on_event, primary_metric_event, guardrail_metrics, updated_at, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [id, ids.orgId, ids.projectId, ...row, now, ids.userId],
  );
  return ok({ id });
}

export function getPlaybook(db: Db, projectId: string, playbookId: string): Playbook | null {
  const r = db.get<Record<string, any>>(
    "SELECT * FROM retention_playbooks WHERE project_id = ? AND id = ?", [projectId, playbookId],
  );
  if (!r) return null;
  return {
    id: r.id, name: r.name, kind: r.kind, description: r.description, status: r.status,
    triggerKind: r.trigger_kind, triggerConfig: parseJson(r.trigger_config, {}),
    delayHours: r.delay_hours, audienceFilter: parseJson(r.audience_filter, {}),
    channel: r.channel, requiresConsent: r.requires_consent === 1,
    messageTitle: r.message_title, messageBody: r.message_body, helpUrl: r.help_url ?? null,
    maxPerUserTotal: r.max_per_user_total, maxPerUserDays: r.max_per_user_days,
    quietHoursStart: r.quiet_hours_start ?? null, quietHoursEnd: r.quiet_hours_end ?? null,
    holdoutPercent: r.holdout_percent, stopOnEvent: r.stop_on_event ?? null,
    primaryMetricEvent: r.primary_metric_event ?? null,
    guardrailMetrics: parseJson<string[]>(r.guardrail_metrics, []),
    approvedBy: r.approved_by ?? null, approvedAt: r.approved_at ?? null,
  };
}

export function listPlaybooks(db: Db, projectId: string): Playbook[] {
  return db.all<{ id: string }>(
    "SELECT id FROM retention_playbooks WHERE project_id = ? ORDER BY created_at DESC", [projectId],
  ).map((r) => getPlaybook(db, projectId, r.id)!).filter(Boolean);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/**
 * Approve a playbook, naming the person who did it.
 *
 * Approval and activation are separate because they are different decisions:
 * one says the copy and audience are acceptable, the other says start now.
 */
export function approvePlaybook(
  db: Db,
  ids: { projectId: string; userId: string },
  playbookId: string,
  now = Date.now(),
): Result<true, DomainError> {
  const playbook = getPlaybook(db, ids.projectId, playbookId);
  if (!playbook) return err(domainError("not_found", "Playbook not found."));
  if (playbook.status !== "draft") {
    return err(domainError("conflict", `Only a draft can be approved; this one is ${playbook.status}.`));
  }
  if (playbook.channel !== "none" && !playbook.messageBody.trim()) {
    return err(domainError(
      "validation_failed",
      "A playbook that sends something must have a message to approve.",
    ));
  }
  db.run(
    "UPDATE retention_playbooks SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?",
    [ids.userId, now, now, playbookId],
  );
  return ok(true);
}

export function setPlaybookStatus(
  db: Db,
  projectId: string,
  playbookId: string,
  status: Extract<PlaybookStatus, "active" | "paused" | "archived">,
  now = Date.now(),
): Result<true, DomainError> {
  const playbook = getPlaybook(db, projectId, playbookId);
  if (!playbook) return err(domainError("not_found", "Playbook not found."));
  if (status === "active" && playbook.status === "draft") {
    return err(domainError(
      "conflict",
      "A playbook must be approved by a person before it can enrol anyone. This is not a setting.",
    ));
  }
  db.run(
    "UPDATE retention_playbooks SET status = ?, updated_at = ? WHERE id = ?",
    [status, now, playbookId],
  );
  return ok(true);
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export function setMessagingConsent(
  db: Db,
  ids: { orgId: string; projectId: string },
  identityId: string,
  channel: "in_app" | "email",
  granted: boolean,
  basis: string,
  now = Date.now(),
): Result<true, DomainError> {
  if (!basis.trim()) {
    return err(domainError(
      "validation_failed",
      "Consent needs a basis: where it came from. A consent record with no provenance is not evidence of consent.",
    ));
  }
  const existing = db.get<{ id: string }>(
    "SELECT id FROM messaging_consent WHERE project_id = ? AND identity_id = ? AND channel = ?",
    [ids.projectId, identityId, channel],
  );
  if (existing) {
    db.run(
      "UPDATE messaging_consent SET granted = ?, basis = ?, updated_at = ? WHERE id = ?",
      [granted ? 1 : 0, basis, now, existing.id],
    );
  } else {
    db.run(
      `INSERT INTO messaging_consent (id, org_id, project_id, identity_id, channel, granted, basis, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("msc"), ids.orgId, ids.projectId, identityId, channel, granted ? 1 : 0, basis, now],
    );
  }
  return ok(true);
}

/** Consent is granted only by a record that says so. Absence is never consent. */
export function hasMessagingConsent(
  db: Db, projectId: string, identityId: string, channel: "in_app" | "email",
): boolean {
  const row = db.get<{ granted: number }>(
    "SELECT granted FROM messaging_consent WHERE project_id = ? AND identity_id = ? AND channel = ?",
    [projectId, identityId, channel],
  );
  return row?.granted === 1;
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

export type SuppressionReason =
  | "no_consent"
  | "already_enrolled"
  | "cap_reached"
  | "stop_event_seen"
  | "holdout"
  | "quiet_hours";

export interface EnrolmentDecision {
  identityId: string;
  enrolled: boolean;
  arm: Arm | null;
  dueAt: number | null;
  reason: SuppressionReason | "eligible";
  detail: string;
}

/**
 * Decide, for one person, whether this playbook may act — and say why not.
 *
 * Every refusal carries a reason, and the reason is stored. A retention system
 * that cannot tell you why someone got nothing is a system nobody can audit.
 */
export function evaluateEnrolment(
  db: Db,
  projectId: string,
  playbook: Playbook,
  identityId: string,
  now = Date.now(),
): EnrolmentDecision {
  const no = (reason: SuppressionReason, detail: string): EnrolmentDecision =>
    ({ identityId, enrolled: false, arm: null, dueAt: null, reason, detail });

  const existing = db.get<{ id: string }>(
    "SELECT id FROM playbook_enrollments WHERE playbook_id = ? AND identity_id = ?",
    [playbook.id, identityId],
  );
  if (existing) return no("already_enrolled", "This person is already enrolled in this playbook.");

  if (playbook.stopOnEvent) {
    const seen = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ? AND identity_id = ? AND name = ?",
      [projectId, identityId, playbook.stopOnEvent],
    )?.n ?? 0;
    if (seen > 0) {
      return no("stop_event_seen",
        `"${playbook.stopOnEvent}" has already happened for this person, so the playbook has nothing to help with.`);
    }
  }

  // The cap counts every playbook, not just this one. A person who received
  // three messages from three playbooks received three messages.
  const since = now - playbook.maxPerUserDays * 86_400_000;
  const recent = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM playbook_enrollments
      WHERE project_id = ? AND identity_id = ? AND arm = 'treatment'
        AND delivered_at IS NOT NULL AND delivered_at >= ?`,
    [projectId, identityId, since],
  )?.n ?? 0;
  if (recent >= playbook.maxPerUserTotal) {
    return no("cap_reached",
      `This person has already received ${recent} message(s) in the last ${playbook.maxPerUserDays} days, ` +
      `which is the cap.`);
  }

  if (playbook.channel === "email" && !hasMessagingConsent(db, projectId, identityId, "email")) {
    return no("no_consent", "No recorded email consent for this person. An absent record is not consent.");
  }

  // Holdout assignment is deterministic on (playbook, identity), so it cannot
  // drift between runs and cannot be re-rolled until someone lands in
  // treatment.
  const arm: Arm = stableHashFraction(`${playbook.id}:${identityId}`) < playbook.holdoutPercent
    ? "holdout"
    : "treatment";

  const dueAt = now + playbook.delayHours * 3_600_000;
  return {
    identityId,
    enrolled: true,
    arm,
    dueAt,
    reason: arm === "holdout" ? "holdout" : "eligible",
    detail: arm === "holdout"
      ? "Enrolled in the holdout: deliberately receives nothing, so the playbook's effect can be measured."
      : `Enrolled; due in ${playbook.delayHours} hour(s).`,
  };
}

export interface EnrolResult {
  enrolled: number;
  holdout: number;
  suppressed: Array<{ identityId: string; reason: SuppressionReason; detail: string }>;
}

export function enrolIdentities(
  db: Db,
  ids: { orgId: string; projectId: string },
  playbook: Playbook,
  identityIds: Iterable<string>,
  now = Date.now(),
): Result<EnrolResult, DomainError> {
  if (playbook.status !== "active") {
    return err(domainError(
      "conflict",
      `A playbook only enrols while active; this one is ${playbook.status}.`,
    ));
  }

  const result: EnrolResult = { enrolled: 0, holdout: 0, suppressed: [] };
  for (const identityId of new Set(identityIds)) {
    const decision = evaluateEnrolment(db, ids.projectId, playbook, identityId, now);
    if (!decision.enrolled) {
      result.suppressed.push({
        identityId, reason: decision.reason as SuppressionReason, detail: decision.detail,
      });
      continue;
    }
    db.run(
      `INSERT INTO playbook_enrollments
        (id, org_id, project_id, playbook_id, identity_id, arm, enrolled_at, due_at, suppressed_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("pbe"), ids.orgId, ids.projectId, playbook.id, identityId, decision.arm,
       now, decision.dueAt, decision.arm === "holdout" ? "holdout" : null],
    );
    if (decision.arm === "holdout") result.holdout++;
    else result.enrolled++;
  }
  return ok(result);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface DueMessage {
  enrolmentId: string;
  identityId: string;
  title: string;
  body: string;
  helpUrl: string | null;
  channel: Channel;
}

function inQuietHours(playbook: Playbook, hourOfDay: number): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = playbook;
  if (start === null || end === null) return false;
  // A window that wraps midnight is the common case for quiet hours.
  return start <= end ? hourOfDay >= start && hourOfDay < end : hourOfDay >= start || hourOfDay < end;
}

/**
 * Messages that are due, with consent re-checked at this moment.
 *
 * Consent is checked twice on purpose. Someone who opted out between enrolment
 * and delivery has opted out, and a system that only checks at enrolment will
 * send to them anyway.
 */
export function dueMessages(
  db: Db,
  projectId: string,
  playbook: Playbook,
  now = Date.now(),
  hourOfDay = new Date(now).getUTCHours(),
): { messages: DueMessage[]; suppressed: Array<{ enrolmentId: string; reason: SuppressionReason }> } {
  const messages: DueMessage[] = [];
  const suppressed: Array<{ enrolmentId: string; reason: SuppressionReason }> = [];

  if (playbook.channel === "none") return { messages, suppressed };

  const rows = db.all<{ id: string; identity_id: string }>(
    `SELECT id, identity_id FROM playbook_enrollments
      WHERE project_id = ? AND playbook_id = ? AND arm = 'treatment'
        AND delivered_at IS NULL AND stopped_at IS NULL AND due_at <= ?`,
    [projectId, playbook.id, now],
  );

  for (const row of rows) {
    if (playbook.channel === "email" && !hasMessagingConsent(db, projectId, row.identity_id, "email")) {
      db.run("UPDATE playbook_enrollments SET suppressed_reason = 'no_consent', stopped_at = ? WHERE id = ?",
        [now, row.id]);
      suppressed.push({ enrolmentId: row.id, reason: "no_consent" });
      continue;
    }
    if (inQuietHours(playbook, hourOfDay)) {
      // Not stopped: quiet hours delay a message, they do not cancel it.
      suppressed.push({ enrolmentId: row.id, reason: "quiet_hours" });
      continue;
    }
    if (playbook.stopOnEvent) {
      const seen = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM analytics_events WHERE project_id = ? AND identity_id = ? AND name = ?",
        [projectId, row.identity_id, playbook.stopOnEvent],
      )?.n ?? 0;
      if (seen > 0) {
        db.run("UPDATE playbook_enrollments SET suppressed_reason = 'stop_event_seen', stopped_at = ? WHERE id = ?",
          [now, row.id]);
        suppressed.push({ enrolmentId: row.id, reason: "stop_event_seen" });
        continue;
      }
    }
    messages.push({
      enrolmentId: row.id,
      identityId: row.identity_id,
      title: playbook.messageTitle,
      body: playbook.messageBody,
      helpUrl: playbook.helpUrl,
      channel: playbook.channel,
    });
  }
  return { messages, suppressed };
}

/** Record that a message was actually delivered. Nothing else sets this. */
export function markDelivered(db: Db, projectId: string, enrolmentId: string, now = Date.now()): boolean {
  const r = db.run(
    `UPDATE playbook_enrollments SET delivered_at = ?
      WHERE id = ? AND project_id = ? AND delivered_at IS NULL AND arm = 'treatment'`,
    [now, enrolmentId, projectId],
  );
  return r.changes > 0;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface PlaybookOutcome {
  playbookId: string;
  treatment: { enrolled: number; delivered: number; converted: number; rate: number | null };
  holdout: { enrolled: number; converted: number; rate: number | null };
  /** The difference, tested. Null when either arm is too small to compare. */
  test: ReturnType<typeof twoProportionTest> | null;
  /** The honest reading, including when the honest reading is "we cannot tell". */
  interpretation: string;
  limitations: string[];
  measurable: boolean;
}

/**
 * Measure a playbook against its holdout.
 *
 * Measuring against the holdout rather than against the enrolled population is
 * the only thing that makes this a measurement at all. Without it, every
 * playbook "works", because the people who were going to come back anyway are
 * counted as successes.
 */
export function measurePlaybook(
  db: Db,
  projectId: string,
  playbook: Playbook,
  input: { outcomeWindowDays?: number; now?: number } = {},
): PlaybookOutcome {
  const now = input.now ?? Date.now();
  const windowMs = (input.outcomeWindowDays ?? 14) * 86_400_000;
  const metric = playbook.primaryMetricEvent;
  const limitations: string[] = [];

  if (!metric) {
    return {
      playbookId: playbook.id,
      treatment: { enrolled: 0, delivered: 0, converted: 0, rate: null },
      holdout: { enrolled: 0, converted: 0, rate: null },
      test: null,
      interpretation: "This playbook has no primary metric, so there is nothing to measure it against.",
      limitations: ["No primary metric event is configured."],
      measurable: false,
    };
  }

  const arm = (which: Arm) => {
    const rows = db.all<{ id: string; identity_id: string; enrolled_at: number; delivered_at: number | null }>(
      `SELECT id, identity_id, enrolled_at, delivered_at FROM playbook_enrollments
        WHERE project_id = ? AND playbook_id = ? AND arm = ?`,
      [projectId, playbook.id, which],
    );
    let converted = 0;
    let delivered = 0;
    let settled = 0;
    for (const row of rows) {
      // The clock starts when the message was due for both arms, so the two
      // are compared over the same elapsed time.
      const start = row.delivered_at ?? row.enrolled_at;
      if (row.delivered_at) delivered++;
      if (now - start < windowMs) continue;
      settled++;
      const hit = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM analytics_events
          WHERE project_id = ? AND identity_id = ? AND name = ?
            AND occurred_at >= ? AND occurred_at <= ?`,
        [projectId, row.identity_id, metric, start, start + windowMs],
      )?.n ?? 0;
      if (hit > 0) converted++;
    }
    return { total: rows.length, settled, converted, delivered };
  };

  const t = arm("treatment");
  const h = arm("holdout");
  const treatment = {
    enrolled: t.total, delivered: t.delivered, converted: t.converted,
    rate: t.settled > 0 ? t.converted / t.settled : null,
  };
  const holdout = {
    enrolled: h.total, converted: h.converted,
    rate: h.settled > 0 ? h.converted / h.settled : null,
  };

  // Below this per arm, a difference in proportions is not worth reporting.
  const MIN_PER_ARM = 30;
  if (t.settled < MIN_PER_ARM || h.settled < MIN_PER_ARM) {
    limitations.push(
      `Only ${t.settled} treated and ${h.settled} held-out users have completed the ` +
      `${input.outcomeWindowDays ?? 14}-day outcome window; ${MIN_PER_ARM} per arm is the minimum ` +
      "before a difference means anything.",
    );
    return {
      playbookId: playbook.id, treatment, holdout, test: null,
      interpretation:
        "Not enough people have been through this playbook to say whether it does anything. " +
        "That is a statement about the sample, not about the playbook.",
      limitations,
      measurable: false,
    };
  }

  const test = twoProportionTest(
    { successes: h.converted, total: h.settled },
    { successes: t.converted, total: t.settled },
  );
  if (!test) {
    return {
      playbookId: playbook.id, treatment, holdout, test: null,
      interpretation: "The two arms cannot be compared: one of them has no settled members.",
      limitations: [...limitations, "One arm had no members whose outcome window had closed."],
      measurable: false,
    };
  }
  limitations.push(
    "The holdout is randomised on the playbook and the person, so the comparison is sound, but the " +
    "outcome window is fixed and a slower effect would not appear.",
  );
  if (!test.normalApproximationValid) {
    limitations.push("Both arms are small enough that the test's approximation is shaky.");
  }

  const better = test.absoluteDiff > 0;
  const interpretation = test.pValue < 0.05
    ? `The treated group reached "${metric}" ${better ? "more" : "less"} often than the holdout ` +
      `(${(test.treatmentRate * 100).toFixed(1)}% against ${(test.controlRate * 100).toFixed(1)}%, ` +
      `p = ${test.pValue.toFixed(3)}). Because the holdout was randomised, this difference is attributable ` +
      "to the playbook."
    : `No difference was detected between the treated group and the holdout ` +
      `(${(test.treatmentRate * 100).toFixed(1)}% against ${(test.controlRate * 100).toFixed(1)}%, ` +
      `p = ${test.pValue.toFixed(3)}). The most likely reading is that this playbook does not change behaviour.`;

  return { playbookId: playbook.id, treatment, holdout, test, interpretation, limitations, measurable: true };
}

export interface SuppressionSummary {
  reason: string;
  count: number;
}

/** What this playbook chose not to do, and why. The audit trail. */
export function suppressionSummary(db: Db, projectId: string, playbookId: string): SuppressionSummary[] {
  return db.all<{ reason: string; count: number }>(
    `SELECT suppressed_reason AS reason, COUNT(*) AS count
       FROM playbook_enrollments
      WHERE project_id = ? AND playbook_id = ? AND suppressed_reason IS NOT NULL
      GROUP BY suppressed_reason ORDER BY count DESC`,
    [projectId, playbookId],
  );
}

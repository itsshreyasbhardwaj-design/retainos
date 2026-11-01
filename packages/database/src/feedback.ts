import {
  newId, ok, err, domainError, FEEDBACK_STATUSES, FEEDBACK_KINDS,
  type Result, type DomainError, type FeedbackKind, type FeedbackStatus,
} from "@retainos/shared";

// Re-exported so existing server-side imports keep working; the definitions
// now live in @retainos/shared so the browser can use them too.
export { FEEDBACK_STATUSES, FEEDBACK_KINDS };
export type { FeedbackKind, FeedbackStatus };
import { createHash } from "node:crypto";
import type { Db } from "./db.ts";
import { type ProjectScope, require_ } from "./scope.ts";
import { writeAudit } from "./audit.ts";

const MAX_TITLE = 200;
const MAX_BODY = 8_000;

export interface SubmitFeedbackInput {
  kind: FeedbackKind;
  title: string;
  body: string;
  source: "widget" | "portal" | "manual" | "import" | "survey" | "integration";
  contactEmail?: string | null;
  consentToContact?: boolean;
  pageIdentifier?: string | null;
  productVersion?: string | null;
  identityId?: string | null;
  severityReported?: string | null;
}

/**
 * Submit feedback. Callable from the public widget and portal, so it validates
 * defensively and stores contact details only with explicit consent.
 */
export function submitFeedback(
  db: Db,
  ids: { orgId: string; projectId: string },
  input: SubmitFeedbackInput,
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length < 3 || title.length > MAX_TITLE) {
    return err(domainError("validation_failed", `Title must be between 3 and ${MAX_TITLE} characters.`));
  }
  if (body.length > MAX_BODY) {
    return err(domainError("validation_failed", `Description must be at most ${MAX_BODY} characters.`));
  }
  if (!FEEDBACK_KINDS.some((k) => k.id === input.kind)) {
    return err(domainError("validation_failed", "Unknown feedback type."));
  }
  // Contact details are discarded unless the reporter ticked the consent box.
  const consent = input.consentToContact === true;
  const email = consent && input.contactEmail ? input.contactEmail.trim().toLowerCase() : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return err(domainError("validation_failed", "Enter a valid contact email or leave it blank."));
  }

  const id = newId("fbk");
  db.run(
    `INSERT INTO feedback_items
      (id, org_id, project_id, source, kind, status, title, body, contact_email, consent_to_contact,
       page_identifier, product_version, identity_id, severity_reported, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, ids.orgId, ids.projectId, input.source, input.kind, title, body, email, consent ? 1 : 0,
      input.pageIdentifier?.slice(0, 300) ?? null, input.productVersion?.slice(0, 60) ?? null,
      input.identityId ?? null, input.severityReported ?? null, now, now,
    ],
  );
  return ok({ id });
}

export interface FeedbackQuery {
  status?: FeedbackStatus[];
  kind?: FeedbackKind[];
  search?: string;
  tagIds?: string[];
  assignedTo?: string;
  limit?: number;
  offset?: number;
}

export function listFeedback(db: Db, scope: ProjectScope, query: FeedbackQuery = {}) {
  const where: string[] = ["f.project_id = ?", "f.deleted_at IS NULL"];
  const params: unknown[] = [scope.projectId];
  if (query.status?.length) {
    where.push(`f.status IN (${query.status.map(() => "?").join(",")})`);
    params.push(...query.status);
  }
  if (query.kind?.length) {
    where.push(`f.kind IN (${query.kind.map(() => "?").join(",")})`);
    params.push(...query.kind);
  }
  if (query.search) {
    where.push("(f.title LIKE ? OR f.body LIKE ?)");
    const like = `%${query.search.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (query.assignedTo) {
    where.push("f.assigned_to = ?");
    params.push(query.assignedTo);
  }
  if (query.tagIds?.length) {
    where.push(
      `EXISTS (SELECT 1 FROM feedback_item_tags t WHERE t.feedback_id = f.id AND t.tag_id IN (${query.tagIds.map(() => "?").join(",")}))`,
    );
    params.push(...query.tagIds);
  }
  const limit = Math.min(query.limit ?? 50, 200);
  params.push(limit, query.offset ?? 0);
  return db.all(
    `SELECT f.*, (SELECT COUNT(*) FROM feedback_comments c WHERE c.feedback_id = f.id) AS comment_count
       FROM feedback_items f
      WHERE ${where.join(" AND ")}
      ORDER BY f.vote_count DESC, f.created_at DESC
      LIMIT ? OFFSET ?`,
    params,
  );
}

export function countFeedbackByStatus(db: Db, scope: ProjectScope) {
  const rows = db.all<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM feedback_items WHERE project_id = ? AND deleted_at IS NULL GROUP BY status",
    [scope.projectId],
  );
  const out: Record<string, number> = {};
  for (const s of FEEDBACK_STATUSES) out[s] = 0;
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export function setFeedbackStatus(
  db: Db,
  scope: ProjectScope,
  feedbackId: string,
  status: FeedbackStatus,
  now = Date.now(),
): Result<true, DomainError> {
  const allowed = require_(scope, "feedback:manage");
  if (!allowed.ok) return allowed;
  if (!FEEDBACK_STATUSES.includes(status)) return err(domainError("validation_failed", "Unknown status."));
  const r = db.run(
    "UPDATE feedback_items SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?",
    [status, now, feedbackId, scope.projectId],
  );
  if (r.changes === 0) return err(domainError("not_found", "Feedback item not found."));
  return ok(true);
}

export function mergeDuplicate(
  db: Db,
  scope: ProjectScope,
  duplicateId: string,
  canonicalId: string,
  now = Date.now(),
): Result<true, DomainError> {
  const allowed = require_(scope, "feedback:manage");
  if (!allowed.ok) return allowed;
  if (duplicateId === canonicalId) {
    return err(domainError("validation_failed", "An item cannot be a duplicate of itself."));
  }
  const both = db.all<{ id: string }>(
    "SELECT id FROM feedback_items WHERE project_id = ? AND id IN (?, ?) AND deleted_at IS NULL",
    [scope.projectId, duplicateId, canonicalId],
  );
  if (both.length !== 2) return err(domainError("not_found", "Both feedback items must exist in this project."));
  // Prevent duplicate chains: if the canonical item is itself a duplicate,
  // point at its canonical instead.
  const canonicalRow = db.get<{ duplicate_of: string | null }>(
    "SELECT duplicate_of FROM feedback_items WHERE id = ?", [canonicalId],
  );
  const target = canonicalRow?.duplicate_of ?? canonicalId;
  if (target === duplicateId) return err(domainError("conflict", "That merge would create a duplicate loop."));
  return db.tx(() => {
    db.run(
      "UPDATE feedback_items SET status = 'duplicate', duplicate_of = ?, updated_at = ? WHERE id = ?",
      [target, now, duplicateId],
    );
    // Votes follow the merge, deduplicated by voter.
    db.run(
      `INSERT OR IGNORE INTO feedback_votes (id, org_id, feedback_id, voter_key, created_at)
       SELECT ?, org_id, ?, voter_key, created_at FROM feedback_votes WHERE feedback_id = ?`,
      [newId("vot"), target, duplicateId],
    );
    recountVotes(db, target);
    recountVotes(db, duplicateId);
    return ok(true);
  });
}

export function addComment(
  db: Db,
  scope: ProjectScope,
  feedbackId: string,
  body: string,
  isInternal: boolean,
  now = Date.now(),
): Result<{ id: string }, DomainError> {
  const allowed = require_(scope, "feedback:manage");
  if (!allowed.ok) return allowed;
  const text = body.trim();
  if (text.length === 0 || text.length > MAX_BODY) {
    return err(domainError("validation_failed", "Comment must be between 1 and 8000 characters."));
  }
  if (!db.get("SELECT 1 FROM feedback_items WHERE id = ? AND project_id = ?", [feedbackId, scope.projectId])) {
    return err(domainError("not_found", "Feedback item not found."));
  }
  const id = newId("fbc");
  db.run(
    `INSERT INTO feedback_comments (id, org_id, feedback_id, author_id, body, is_internal, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, scope.orgId, feedbackId, scope.userId, text, isInternal ? 1 : 0, now],
  );
  return ok({ id });
}

/** Public-portal comments only. Internal notes are filtered out in SQL, not in the UI. */
export function publicComments(db: Db, feedbackId: string) {
  return db.all(
    "SELECT id, body, created_at FROM feedback_comments WHERE feedback_id = ? AND is_internal = 0 ORDER BY created_at ASC",
    [feedbackId],
  );
}

function recountVotes(db: Db, feedbackId: string): void {
  db.run(
    "UPDATE feedback_items SET vote_count = (SELECT COUNT(*) FROM feedback_votes WHERE feedback_id = ?) WHERE id = ?",
    [feedbackId, feedbackId],
  );
}

/**
 * Vote on a public feature request.
 *
 * The voter key is a salted hash of a stable per-voter token, so the portal can
 * stop the same person voting twice without storing who they are. A vote is a
 * signal of interest, never evidence of verified demand; the UI says so.
 */
export function voteFeedback(
  db: Db,
  ids: { orgId: string; projectId: string },
  feedbackId: string,
  voterToken: string,
  salt: string,
  now = Date.now(),
): Result<{ votes: number }, DomainError> {
  const item = db.get<{ id: string; duplicate_of: string | null }>(
    "SELECT id, duplicate_of FROM feedback_items WHERE id = ? AND project_id = ? AND deleted_at IS NULL",
    [feedbackId, ids.projectId],
  );
  if (!item) return err(domainError("not_found", "Feedback item not found."));
  const target = item.duplicate_of ?? item.id;
  const voterKey = createHash("sha256").update(`${salt}:${ids.projectId}:${voterToken}`).digest("hex");
  const existing = db.get("SELECT 1 FROM feedback_votes WHERE feedback_id = ? AND voter_key = ?", [target, voterKey]);
  if (existing) {
    const votes = db.get<{ n: number }>("SELECT vote_count AS n FROM feedback_items WHERE id = ?", [target])?.n ?? 0;
    return err(domainError("conflict", "You have already voted for this request.", { votes }));
  }
  db.run(
    "INSERT INTO feedback_votes (id, org_id, feedback_id, voter_key, created_at) VALUES (?, ?, ?, ?, ?)",
    [newId("vot"), ids.orgId, target, voterKey, now],
  );
  recountVotes(db, target);
  const votes = db.get<{ n: number }>("SELECT vote_count AS n FROM feedback_items WHERE id = ?", [target])?.n ?? 0;
  return ok({ votes });
}

export function upsertTag(db: Db, scope: ProjectScope, label: string, color = "slate"): Result<{ id: string }, DomainError> {
  const allowed = require_(scope, "feedback:manage");
  if (!allowed.ok) return allowed;
  const clean = label.trim().slice(0, 40);
  if (!clean) return err(domainError("validation_failed", "Tag label cannot be empty."));
  const existing = db.get<{ id: string }>(
    "SELECT id FROM feedback_tags WHERE project_id = ? AND label = ?", [scope.projectId, clean],
  );
  if (existing) return ok({ id: existing.id });
  const id = newId("tag");
  db.run("INSERT INTO feedback_tags (id, org_id, project_id, label, color) VALUES (?, ?, ?, ?, ?)",
    [id, scope.orgId, scope.projectId, clean, color]);
  return ok({ id });
}

export function tagFeedback(db: Db, scope: ProjectScope, feedbackId: string, tagId: string): Result<true, DomainError> {
  const allowed = require_(scope, "feedback:manage");
  if (!allowed.ok) return allowed;
  const okItem = db.get("SELECT 1 FROM feedback_items WHERE id = ? AND project_id = ?", [feedbackId, scope.projectId]);
  const okTag = db.get("SELECT 1 FROM feedback_tags WHERE id = ? AND project_id = ?", [tagId, scope.projectId]);
  if (!okItem || !okTag) return err(domainError("not_found", "Feedback item or tag not found in this project."));
  db.run("INSERT OR IGNORE INTO feedback_item_tags (feedback_id, tag_id) VALUES (?, ?)", [feedbackId, tagId]);
  return ok(true);
}

export function softDeleteFeedback(
  db: Db, scope: ProjectScope, feedbackId: string, now = Date.now(),
): Result<true, DomainError> {
  const allowed = require_(scope, "feedback:manage");
  if (!allowed.ok) return allowed;
  const r = db.run(
    "UPDATE feedback_items SET deleted_at = ?, contact_email = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND deleted_at IS NULL",
    [now, now, feedbackId, scope.projectId],
  );
  if (r.changes === 0) return err(domainError("not_found", "Feedback item not found."));
  writeAudit(db, {
    orgId: scope.orgId, actorUserId: scope.userId, action: "feedback.deleted",
    targetKind: "feedback_item", targetId: feedbackId,
  }, now);
  return ok(true);
}

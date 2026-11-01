import { newId } from "@retainos/shared";
import type { Db } from "./db.ts";

export interface AuditInput {
  orgId: string | null;
  actorUserId?: string | null;
  actorKind?: "user" | "system" | "api_key";
  action: string;
  targetKind?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Called for every state change that a customer could
 * later need to explain: permission changes, key issuance, GitHub dispatches,
 * data deletion, plan changes.
 */
export function writeAudit(db: Db, input: AuditInput, now = Date.now()): string {
  const id = newId("aud");
  db.run(
    `INSERT INTO audit_events
      (id, org_id, actor_user_id, actor_kind, action, target_kind, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.orgId, input.actorUserId ?? null, input.actorKind ?? "user", input.action,
      input.targetKind ?? null, input.targetId ?? null, JSON.stringify(input.detail ?? {}), now,
    ],
  );
  return id;
}

export function listAudit(db: Db, orgId: string, limit = 100): Array<Record<string, unknown>> {
  return db.all(
    "SELECT * FROM audit_events WHERE org_id = ? ORDER BY created_at DESC LIMIT ?",
    [orgId, Math.min(limit, 500)],
  );
}

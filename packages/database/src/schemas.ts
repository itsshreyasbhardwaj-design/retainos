import {
  newId, ok, err, domainError, EVENT_NAME_RE, PROPERTY_NAME_RE, MAX_EVENT_NAME_LENGTH,
  eventNameAdvice, type EventSpec, type PropertySpec, type Result, type DomainError,
} from "@retainos/shared";
import type { Db } from "./db.ts";
import { jsonParse } from "./db.ts";
import { type ProjectScope, require_ } from "./scope.ts";

/** Starter registry offered when a project is created. Suggestions, not defaults. */
export const SUGGESTED_EVENTS: Array<Omit<EventSpec, "version"> & { description: string }> = [
  { name: "signup_completed", description: "A new account finished registration.", properties: [{ name: "acquisition_source", type: "string", required: false }] },
  { name: "onboarding_started", description: "The user began the onboarding flow.", properties: [] },
  { name: "onboarding_completed", description: "The user finished every required onboarding step.", properties: [] },
  { name: "project_created", description: "The user created their first unit of work.", properties: [{ name: "is_first", type: "boolean", required: false }] },
  { name: "core_action_completed", description: "The user performed the product's core value action.", properties: [{ name: "feature", type: "string", required: true }] },
  { name: "subscription_started", description: "A paid subscription began.", properties: [{ name: "plan", type: "string", required: true }] },
  { name: "subscription_cancelled", description: "A paid subscription was cancelled.", properties: [{ name: "plan", type: "string", required: false }] },
];

export function rowToSpec(row: Record<string, unknown>): EventSpec {
  return {
    name: row.name as string,
    version: row.version as number,
    description: (row.description as string) ?? undefined,
    properties: jsonParse<PropertySpec[]>(row.properties, []),
    allowUnknownProperties: (row.allow_unknown as number) === 1,
    deprecated: (row.deprecated as number) === 1,
  };
}

export function getEventSpec(db: Db, projectId: string, name: string): EventSpec | null {
  const row = db.get("SELECT * FROM event_schemas WHERE project_id = ? AND name = ?", [projectId, name]);
  return row ? rowToSpec(row) : null;
}

export function listEventSpecs(db: Db, projectId: string): EventSpec[] {
  return db.all("SELECT * FROM event_schemas WHERE project_id = ? ORDER BY name", [projectId]).map(rowToSpec);
}

function validateSpecShape(input: { name: string; properties: PropertySpec[] }): Result<true, DomainError> {
  if (input.name.length > MAX_EVENT_NAME_LENGTH) {
    return err(domainError("validation_failed", `Event name must be at most ${MAX_EVENT_NAME_LENGTH} characters.`));
  }
  if (!EVENT_NAME_RE.test(input.name)) {
    return err(domainError("validation_failed", "Event name must be lower_snake_case.", {
      advice: eventNameAdvice(input.name),
    }));
  }
  const seen = new Set<string>();
  for (const p of input.properties) {
    if (!PROPERTY_NAME_RE.test(p.name)) {
      return err(domainError("validation_failed", `Property '${p.name}' must be lower_snake_case.`));
    }
    if (seen.has(p.name)) {
      return err(domainError("validation_failed", `Property '${p.name}' is declared twice.`));
    }
    seen.add(p.name);
    if (!["string", "number", "boolean", "timestamp"].includes(p.type)) {
      return err(domainError("validation_failed", `Property '${p.name}' has an unsupported type.`));
    }
  }
  return ok(true);
}

export function upsertEventSpec(
  db: Db,
  scope: ProjectScope,
  input: {
    name: string;
    description?: string;
    properties: PropertySpec[];
    allowUnknownProperties?: boolean;
    deprecated?: boolean;
    deprecationNote?: string;
  },
  now = Date.now(),
): Result<{ id: string; version: number }, DomainError> {
  const allowed = require_(scope, "schema:manage");
  if (!allowed.ok) return allowed;
  const shape = validateSpecShape(input);
  if (!shape.ok) return shape;

  const existing = db.get<{ id: string; version: number; properties: string }>(
    "SELECT id, version, properties FROM event_schemas WHERE project_id = ? AND name = ?",
    [scope.projectId, input.name],
  );
  const propsJson = JSON.stringify(input.properties);

  if (existing) {
    // A property change is a schema change, so the version increments. Consumers
    // can then tell whether a metric definition shifted underneath them.
    const changed = existing.properties !== propsJson;
    const version = changed ? existing.version + 1 : existing.version;
    db.run(
      `UPDATE event_schemas SET description = ?, properties = ?, allow_unknown = ?,
              deprecated = ?, deprecation_note = ?, version = ?, updated_at = ?
         WHERE id = ?`,
      [
        input.description ?? null, propsJson, input.allowUnknownProperties === false ? 0 : 1,
        input.deprecated ? 1 : 0, input.deprecationNote ?? null, version, now, existing.id,
      ],
    );
    return ok({ id: existing.id, version });
  }

  const id = newId("evs");
  db.run(
    `INSERT INTO event_schemas
      (id, org_id, project_id, name, version, description, properties, allow_unknown, deprecated, deprecation_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, scope.orgId, scope.projectId, input.name, input.description ?? null, propsJson,
      input.allowUnknownProperties === false ? 0 : 1, input.deprecated ? 1 : 0,
      input.deprecationNote ?? null, now, now,
    ],
  );
  return ok({ id, version: 1 });
}

export function seedSuggestedSchemas(db: Db, scope: ProjectScope, now = Date.now()): number {
  let created = 0;
  for (const s of SUGGESTED_EVENTS) {
    const r = upsertEventSpec(db, scope, {
      name: s.name, description: s.description, properties: s.properties, allowUnknownProperties: true,
    }, now);
    if (r.ok) created++;
  }
  return created;
}

export function deleteEventSpec(
  db: Db,
  scope: ProjectScope,
  name: string,
): Result<true, DomainError> {
  const allowed = require_(scope, "schema:manage");
  if (!allowed.ok) return allowed;
  const r = db.run("DELETE FROM event_schemas WHERE project_id = ? AND name = ?", [scope.projectId, name]);
  if (r.changes === 0) return err(domainError("not_found", "Event schema not found."));
  return ok(true);
}

/** Events seen in the data that have no registered schema. Drives the UI nudge. */
export function undeclaredEvents(db: Db, projectId: string, limit = 50) {
  return db.all<{ name: string; event_count: number; last_seen: number }>(
    `SELECT e.name, COUNT(*) AS event_count, MAX(e.occurred_at) AS last_seen
       FROM analytics_events e
       LEFT JOIN event_schemas s ON s.project_id = e.project_id AND s.name = e.name
      WHERE e.project_id = ? AND s.id IS NULL
      GROUP BY e.name ORDER BY event_count DESC LIMIT ?`,
    [projectId, limit],
  );
}

import { type Result, ok, err, domainError, type DomainError } from "./result.ts";

export type PropertyType = "string" | "number" | "boolean" | "timestamp";

export interface PropertySpec {
  name: string;
  type: PropertyType;
  required: boolean;
  /** Optional closed set of permitted values, for low-cardinality enums. */
  allowed?: string[];
  description?: string;
}

export interface EventSpec {
  name: string;
  version: number;
  description?: string;
  properties: PropertySpec[];
  deprecated?: boolean;
  /** When false, properties outside the spec are rejected rather than ignored. */
  allowUnknownProperties?: boolean;
}

export const EVENT_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const PROPERTY_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const MAX_PROPERTY_COUNT = 64;
export const MAX_STRING_LENGTH = 1024;
export const MAX_EVENT_NAME_LENGTH = 80;

export interface ValidationIssue {
  field: string;
  problem: string;
}

/** Event naming guidance surfaced in the UI; advisory, never blocking. */
export function eventNameAdvice(name: string): string[] {
  const notes: string[] = [];
  if (!EVENT_NAME_RE.test(name)) {
    notes.push("Use lower_snake_case: letters, digits and single underscores.");
  }
  if (/[A-Z]/.test(name)) notes.push("Avoid capital letters; casing differences create duplicate events.");
  if (name.includes("-") || name.includes(" ")) notes.push("Avoid spaces and hyphens; use underscores.");
  if (/^(click|clicked|press|tap)/.test(name)) {
    notes.push("Prefer outcome names over interaction names, e.g. 'project_created' over 'clicked_create'.");
  }
  if (!/_(completed|started|created|updated|deleted|failed|viewed|submitted|cancelled|succeeded)$/.test(name)) {
    notes.push("Consider an explicit past-tense suffix, e.g. '_completed' or '_created'.");
  }
  return notes;
}

function typeOf(value: unknown): PropertyType | "unsupported" {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "unsupported";
  return "unsupported";
}

/**
 * Validate raw event properties against a registry spec.
 *
 * Behaviour is deliberately strict: malformed, oversized and unknown-typed
 * payloads are rejected rather than coerced, so analytics never silently
 * depends on a value RetainOS guessed at.
 */
export function validateProperties(
  props: Record<string, unknown>,
  spec: EventSpec | null,
): Result<Record<string, string | number | boolean>, DomainError> {
  const issues: ValidationIssue[] = [];
  const out: Record<string, string | number | boolean> = {};
  const entries = Object.entries(props);

  if (entries.length > MAX_PROPERTY_COUNT) {
    return err(
      domainError("validation_failed", `Event has ${entries.length} properties; the limit is ${MAX_PROPERTY_COUNT}.`, {
        issues: [{ field: "properties", problem: "too_many_properties" }],
      }),
    );
  }

  const specByName = new Map((spec?.properties ?? []).map((p) => [p.name, p]));

  for (const [key, value] of entries) {
    if (!PROPERTY_NAME_RE.test(key)) {
      issues.push({ field: key, problem: "property name must be lower_snake_case" });
      continue;
    }
    if (value === null || value === undefined) continue; // absent, not an error
    const actual = typeOf(value);
    if (actual === "unsupported") {
      issues.push({ field: key, problem: "only string, number and boolean values are accepted" });
      continue;
    }
    if (actual === "string" && (value as string).length > MAX_STRING_LENGTH) {
      issues.push({ field: key, problem: `string exceeds ${MAX_STRING_LENGTH} characters` });
      continue;
    }

    const ps = specByName.get(key);
    if (!ps) {
      if (spec && spec.allowUnknownProperties === false) {
        issues.push({ field: key, problem: "property is not declared in the event schema" });
        continue;
      }
      out[key] = value as string | number | boolean;
      continue;
    }
    const wanted = ps.type === "timestamp" ? "number" : ps.type;
    if (actual !== wanted) {
      issues.push({ field: key, problem: `expected ${ps.type}, received ${actual}` });
      continue;
    }
    if (ps.allowed && ps.allowed.length > 0 && !ps.allowed.includes(String(value))) {
      issues.push({ field: key, problem: `value is not in the allowed set` });
      continue;
    }
    out[key] = value as string | number | boolean;
  }

  for (const ps of spec?.properties ?? []) {
    if (ps.required && !(ps.name in out)) {
      issues.push({ field: ps.name, problem: "required property is missing" });
    }
  }

  if (issues.length > 0) {
    return err(domainError("validation_failed", "Event properties failed schema validation.", { issues }));
  }
  return ok(out);
}

import type { Db } from "@retainos/database";

/**
 * Segmentation.
 *
 * Only these dimensions can be filtered on. The list is closed on purpose:
 *  - They are promoted to real columns, so filtering is an index lookup rather
 *    than a JSON scan over the whole event table.
 *  - It keeps RetainOS away from demographic and sensitive segmentation. There
 *    is no age, gender, income or precise-location dimension, and no way to add
 *    one through the API.
 */
export const SEGMENT_DIMENSIONS = [
  "plan", "country", "device_category", "product_version", "acquisition_source", "release_id",
] as const;
export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];

export type SegmentFilter = Partial<Record<SegmentDimension, string | string[]>>;

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/**
 * Build a SQL predicate for a segment filter, aliased to `alias`.
 * Returns an empty fragment when the filter is empty, so callers can always
 * concatenate without special-casing.
 */
export function segmentPredicate(filter: SegmentFilter | undefined, alias = "e"): SqlFragment {
  if (!filter) return { sql: "", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const dim of SEGMENT_DIMENSIONS) {
    const value = filter[dim];
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value.filter((v) => v !== "") : [value];
    if (values.length === 0) continue;
    // `dim` comes from the closed SEGMENT_DIMENSIONS list, never from input.
    clauses.push(`${alias}.${dim} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  }
  return clauses.length === 0 ? { sql: "", params: [] } : { sql: ` AND ${clauses.join(" AND ")}`, params };
}

/** Equality filter over JSON event properties, for step-level conditions. */
export function propertyPredicate(
  filter: Record<string, string | number | boolean> | undefined,
  alias = "e",
): SqlFragment {
  if (!filter) return { sql: "", params: [] };
  const entries = Object.entries(filter);
  if (entries.length === 0) return { sql: "", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of entries) {
    // Property names are validated at ingestion, but validate again here so a
    // crafted saved-query cannot inject a JSON path expression.
    if (!/^[a-z][a-z0-9_]*$/.test(key)) continue;
    clauses.push(`json_extract(${alias}.properties, '$.${key}') = ?`);
    params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  return clauses.length === 0 ? { sql: "", params: [] } : { sql: ` AND ${clauses.join(" AND ")}`, params };
}

export function listSegments(db: Db, projectId: string) {
  return db.all("SELECT id, name, filter FROM user_segments WHERE project_id = ? ORDER BY name", [projectId]);
}

/** Distinct values actually present for a dimension, for building filter UIs. */
export function dimensionValues(db: Db, projectId: string, dimension: SegmentDimension, limit = 50) {
  return db.all<{ value: string; n: number }>(
    `SELECT ${dimension} AS value, COUNT(*) AS n FROM analytics_events
      WHERE project_id = ? AND ${dimension} IS NOT NULL
      GROUP BY ${dimension} ORDER BY n DESC LIMIT ?`,
    [projectId, limit],
  );
}

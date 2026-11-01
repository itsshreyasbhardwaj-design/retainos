# Database

## Conventions

- **Timestamps** are integer milliseconds since the Unix epoch, UTC. Never local
  time, never a string. Only *reporting buckets* are computed in a local
  timezone.
- **Money** is an integer in minor units (paise, cents) plus an explicit
  three-letter currency. There is no floating-point money anywhere.
- **Identifiers** are prefixed strings (`prj_`, `evt_`, `imp_`) with a
  millisecond prefix, so they sort chronologically and a stray id in a log is
  immediately recognisable.
- **Tenancy** — every tenant-owned table carries `org_id`, `project_id` or both.
  A test asserts this and fails if a new table is added without one.

## Schema

59 tables across 4 migrations.

| Migration | Covers |
|---|---|
| `001_identity_and_projects` | users, sessions, organizations, memberships, invitations, projects, keys, event schemas, activation definitions, tracked features |
| `002_events_and_identity` | identities, identity links, ingest batches, analytics events, rejections, aggregates, jobs, funnels, segments |
| `003_feedback_and_improvements` | feedback, tags, comments, clusters, votes, improvements, evidence, history, GitHub links, releases, changelog, onboarding |
| `004_revenue_experiments_saas` | billing connections, subscriptions, subscription events, revenue snapshots, experiments, variants, assignments, exposures, results, impact measurements, insights, plans, usage, audit, deletion requests |

Migrations are applied in filename order, exactly once, inside a transaction,
and recorded in `schema_migrations`. Running `pnpm db:migrate` twice is a no-op.

## Tenancy

The enforcement point is `resolveProjectScope`:

```ts
const scope = resolveProjectScope(db, userId, projectId);
if (!scope.ok) return scope;         // not_found, never forbidden
listFeedback(db, scope.value, …);    // every repository demands a scope
```

Two deliberate choices:

- It returns **`not_found`, not `forbidden`**, for a project the caller cannot
  see. `forbidden` would confirm the id exists, turning the endpoint into an
  enumeration oracle.
- A `ProjectScope` **cannot be constructed by a caller**. It carries the
  verified `orgId`, `role`, reporting timezone and currency, so no query can
  forget which timezone a project reports in.

`IngestScope` is deliberately a different type. It comes from a public write
key, carries no `userId` or `role`, and there is no function anywhere that turns
one into a `ProjectScope`.

## Indexes

The three access patterns that matter, and the indexes that serve them:

| Pattern | Index |
|---|---|
| Time-ranged scan for one project | `idx_events_project_time (project_id, occurred_at)` |
| The same, filtered by event name | `idx_events_project_name_time (project_id, name, occurred_at)` |
| One user's ordered timeline, for funnels | `idx_events_identity_time (project_id, identity_id, occurred_at)` |

Six segmentation dimensions are promoted from JSON to real columns (`plan`,
`country`, `device_category`, `product_version`, `acquisition_source`,
`release_id`) so filtering is an index lookup rather than a JSON scan. Anything
else lives in the `properties` JSON column and is queried with `json_extract`,
which maps to JSONB in PostgreSQL.

## SQLite now, PostgreSQL later

Local development uses `node:sqlite`, which ships with Node. No daemon, no
native build, no Docker. `pnpm test` works on a clean machine.

The SQL is written to be portable. Four differences matter when moving:

1. **`INTEGER PRIMARY KEY` vs `TEXT`** — RetainOS already uses `TEXT` ids
   everywhere, so nothing changes.
2. **`ON CONFLICT … DO UPDATE`** — used for upserts; identical syntax in
   PostgreSQL 9.5+.
3. **Partial unique indexes** — `idx_jobs_dedupe` is partial. PostgreSQL
   supports these, but `ON CONFLICT` cannot target a partial index without
   repeating its predicate, which is why `enqueueJob` does an explicit
   `SELECT`-then-`INSERT` rather than an upsert.
4. **`json_extract(x, '$.k')`** becomes `x -> 'k'` or `x ->> 'k'`. Confined to
   `segments.ts`, in one function.

For production at volume, additionally:

- Range-partition `analytics_events` by month on `occurred_at`. The indexes
  already lead with `project_id`, so partition pruning composes with them.
- Enable row-level security on tenant tables as defence in depth behind the
  scope checks, rather than instead of them.
- Move `usage_counters` increments to an atomic `UPDATE … RETURNING`.

## Retention and erasure

Each project sets `raw_retention_days`. A worker job deletes raw events past the
window while leaving `daily_active_aggregates` and `event_daily_aggregates`
intact, so history survives without retaining individual event rows.

Erasing one end user deletes their events, identity, experiment records and
onboarding progress; anonymises their feedback rather than destroying the
product signal; and detaches their subscription rows while leaving the financial
records. It then queues recomputation for every affected day, so aggregates stay
consistent with the raw store instead of quietly disagreeing with it. The
journey test asserts both the deletion and the queued recomputation.

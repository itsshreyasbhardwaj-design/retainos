# Architecture

## Shape

A modular monolith with hard internal boundaries, chosen so the ingestion and
aggregation paths can be pulled out later without rewriting anything else.

```
apps/web ──────────────┐
                       │  imports
workers/analytics ─────┼──────────▶ packages/analytics ──▶ packages/database ──▶ packages/shared
                       │                                          │                     ▲
apps/demo-app ─────────┘                                          └─────────────────────┘
      │
      └──▶ packages/sdk (depends on nothing at all)
```

Dependencies point one way. `shared` imports nothing. `sdk` imports nothing,
not even `shared`, because it ships to a browser and must stay small enough
that adding it is never a conversation.

## Why these boundaries

**`packages/shared`** holds the things both sides of the network need: result
types, timezone-correct bucketing, the privacy denylist, role permissions, plan
definitions and domain vocabulary. It is the only package a client component
may import from, and only via a specific module path — importing its barrel
would drag `node:crypto` into a browser bundle, so client components import
`@retainos/shared/roles`, not `@retainos/shared`.

**`packages/database`** owns the schema, tenancy and ingestion. Its most
important export is not a query helper but `resolveProjectScope`: the only
producer of a `ProjectScope`, and the only thing that verifies membership. Every
repository function demands a scope it cannot fabricate, which makes the
dangerous mistake — querying by a project id taken straight from a URL —
structurally hard to write.

**`packages/analytics`** holds every metric engine and the statistics behind
them. Nothing here touches HTTP, sessions or React. Each engine is a function of
`(db, projectId, input)` returning both the numbers and the definitions that
produced them, which is why a chart in the UI can always explain itself.

**`packages/sdk`** is standalone and dependency-free. It never imports from the
monorepo, so it can be published and consumed by applications that have never
heard of RetainOS's server.

## Data flow

```
Browser / server SDK
   │  POST /api/v1/ingest  (public write key)
   ▼
authenticateWriteKey ──▶ origin allowlist ──▶ rate limit ──▶ payload caps
   ▼
per event: name ▸ consent ▸ size ▸ clock skew ▸ privacy scrub ▸ schema ▸ identity ▸ quota ▸ dedupe
   ▼
analytics_events (raw, the source of truth)
   │
   ├──▶ aggregation_jobs  ──▶ worker ──▶ daily_active_aggregates, revenue_snapshots, insights
   └──▶ read directly by the analytics engines
```

Raw events are the source of truth. Every aggregate can be rebuilt from them,
which is what makes the worker's jobs safe to re-run and makes erasure able to
restore consistency rather than leaving aggregates quietly disagreeing with the
rows beneath them.

## Design decisions worth arguing with

**Engines read raw events rather than only aggregates.** It is slower, and it
was chosen anyway: a funnel over pre-aggregated counts cannot honour per-user
ordering or a conversion window. Aggregates exist for the cheap questions
(active users per day) and the engines compute the expensive ones directly.
`PERFORMANCE.md` has the measurements and the point at which this stops being
viable.

**The queue is a table.** No Redis, no managed queue. Claiming a job is a
conditional `UPDATE`, so two workers racing for the same job cannot both win.
This keeps the whole system runnable on one machine with nothing installed,
which is the point. It also means the rate limiter is per-process — stated
plainly in `EVENT_INGESTION.md` rather than discovered in production.

**Statistics are implemented from scratch.** Every number RetainOS shows a
founder is used to make a product decision, so being able to say exactly how it
was computed matters more than the dependency it saves. The normal, Student's t,
chi-square and incomplete beta functions are all tested against published
reference values.

**Metric definitions travel with the numbers.** `computeFunnel` returns a
`definition` block; `computeRetention` returns four. The UI renders them next to
the chart. A percentage without its denominator is not a measurement, and the
type system makes the definition non-optional on the metric tile component.

## Scaling path

The boundaries are drawn where the seams would be:

1. **Ingestion first.** `ingestBatch` is already a pure function of
   `(db, scope, request)`. Moving it behind a queue means replacing one call
   site, and the shared rate limiter becomes a shared counter.
2. **PostgreSQL next.** The SQL is written to be portable; `DATABASE.md` lists
   the four dialect differences that matter.
3. **Partition the event table.** Monthly range partitions on `occurred_at`,
   which the indexes already assume.
4. **A column store only when the workload justifies it.** Not before. A
   founder with 200,000 events does not need ClickHouse, and introducing it
   early would make local development impossible.

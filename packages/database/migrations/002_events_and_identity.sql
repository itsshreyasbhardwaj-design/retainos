-- RetainOS migration 002: event ingestion, identity resolution, aggregates.

CREATE TABLE IF NOT EXISTS identities (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The SDK's anonymous id. Random, per-device, resettable on logout.
  anonymous_id    TEXT,
  -- The customer's own user id, supplied via identify(). Pseudonymous as far as
  -- RetainOS is concerned: we never require an email or name here.
  external_id     TEXT,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  identified_at   INTEGER,
  -- Denormalised segmentation dimensions, last-write-wins. Kept deliberately
  -- coarse: no raw user agent, no precise location, no free-form PII.
  plan            TEXT,
  country         TEXT,
  device_category TEXT,
  acquisition_source TEXT,
  product_version TEXT,
  deleted_at      INTEGER,
  UNIQUE(project_id, anonymous_id),
  UNIQUE(project_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_project_first_seen ON identities(project_id, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_identities_project_last_seen ON identities(project_id, last_seen_at);

-- Explicit, auditable record of anonymous -> identified transitions. RetainOS
-- only ever merges on an explicit identify() call; never on inferred signals.
CREATE TABLE IF NOT EXISTS identity_links (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  identity_id   TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  anonymous_id  TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  linked_at     INTEGER NOT NULL,
  reason        TEXT NOT NULL DEFAULT 'explicit_identify'
);
CREATE INDEX IF NOT EXISTS idx_identity_links_project ON identity_links(project_id, anonymous_id);

CREATE TABLE IF NOT EXISTS ingest_batches (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Client-supplied idempotency key. A repeat with the same key is a no-op.
  idempotency_key TEXT,
  received_at     INTEGER NOT NULL,
  event_count     INTEGER NOT NULL,
  accepted_count  INTEGER NOT NULL,
  rejected_count  INTEGER NOT NULL,
  sdk_name        TEXT,
  sdk_version     TEXT,
  UNIQUE(project_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  identity_id     TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- When the event happened on the client (client clock, may be skewed).
  occurred_at     INTEGER NOT NULL,
  -- When the server received it. Used to detect skew and late arrivals.
  received_at     INTEGER NOT NULL,
  -- Client-supplied event id, used for exactly-once ingestion on retry.
  client_event_id TEXT,
  batch_id        TEXT REFERENCES ingest_batches(id) ON DELETE SET NULL,
  -- Indexed segmentation dimensions, promoted to columns for fast filtering.
  plan            TEXT,
  country         TEXT,
  device_category TEXT,
  product_version TEXT,
  acquisition_source TEXT,
  release_id      TEXT,
  -- Everything else, validated against the event schema, as a JSON object.
  properties      TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_id, client_event_id)
);
-- The three access patterns that matter: time-ranged scans per project, the
-- same filtered by event name, and per-identity timelines for funnels.
CREATE INDEX IF NOT EXISTS idx_events_project_time ON analytics_events(project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_project_name_time ON analytics_events(project_id, name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_identity_time ON analytics_events(project_id, identity_id, occurred_at);

-- Rejected events are counted and sampled, never silently dropped, so a
-- developer can see why their instrumentation is not showing up.
CREATE TABLE IF NOT EXISTS event_rejections (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  received_at   INTEGER NOT NULL,
  event_name    TEXT,
  reason        TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_rejections_project_time ON event_rejections(project_id, received_at);

-- ---------------------------------------------------------------------------
-- Aggregates. Recomputed idempotently by the worker; raw events stay the
-- source of truth, so an aggregate can always be rebuilt from scratch.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS daily_active_aggregates (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day_key       TEXT NOT NULL,
  active_users  INTEGER NOT NULL,
  new_users     INTEGER NOT NULL,
  returning_users INTEGER NOT NULL,
  event_count   INTEGER NOT NULL,
  computed_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, day_key)
);

CREATE TABLE IF NOT EXISTS event_daily_aggregates (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day_key       TEXT NOT NULL,
  event_name    TEXT NOT NULL,
  event_count   INTEGER NOT NULL,
  unique_users  INTEGER NOT NULL,
  computed_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, day_key, event_name)
);

CREATE TABLE IF NOT EXISTS aggregation_jobs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  -- Idempotency: a job with the same dedupe_key is never enqueued twice while
  -- still pending, so a crash-and-retry cannot double-process.
  dedupe_key    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','done','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  run_after     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON aggregation_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON aggregation_jobs(status, run_after);

CREATE TABLE IF NOT EXISTS funnel_definitions (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- JSON array of {event, filter?} in required order.
  steps           TEXT NOT NULL,
  conversion_window_hours INTEGER NOT NULL DEFAULT 168,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  created_by      TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_funnels_project ON funnel_definitions(project_id);

CREATE TABLE IF NOT EXISTS user_segments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- JSON: {plan?, country?, device_category?, product_version?, acquisition_source?}
  filter        TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Event provenance
--
-- Additive and reversible: existing rows keep the default, every query that
-- ignores the column behaves exactly as before, and dropping the column would
-- restore the previous schema.
--
-- The point is to be able to answer "where did this number come from?". An
-- event imported from PostHog and an event sent by the SDK are both real, but
-- they are not interchangeable: they can arrive twice for the same action, and
-- a team deciding whether to trust a figure needs to know which system it came
-- from.
-- ---------------------------------------------------------------------------

ALTER TABLE analytics_events ADD COLUMN source TEXT NOT NULL DEFAULT 'sdk';

-- Imports are read per source far more often than per anything else: "what
-- did this sync bring in", "exclude the CSV backfill from this comparison".
CREATE INDEX IF NOT EXISTS idx_events_source ON analytics_events(project_id, source, occurred_at);

-- Which sync run brought a record in, so an import can be audited or undone.
ALTER TABLE analytics_events ADD COLUMN sync_run_id TEXT;

-- Per-row rejections from an import, kept so a failed CSV can be fixed rather
-- than guessed at. Separate from event_rejections, which is about live
-- ingestion and is sampled; an import's rejections are all retained because a
-- person is sitting there waiting to fix them.
CREATE TABLE IF NOT EXISTS import_rejections (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sync_run_id   TEXT NOT NULL REFERENCES provider_sync_runs(id) ON DELETE CASCADE,
  row_number    INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_rejections ON import_rejections(sync_run_id, row_number);

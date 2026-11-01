-- RetainOS migration 005: FrictionGraph, the Opportunity Engine, and the
-- signal sources they join across.
--
-- Additive only. No existing table is altered, so this migration is safe to
-- apply to a database carrying real customer data.

-- ---------------------------------------------------------------------------
-- Error events
--
-- FrictionGraph needs a reliability signal. Errors arrive either from the SDK
-- or from an authorised provider (Sentry). They are grouped by a fingerprint
-- the sender supplies, because RetainOS cannot reliably derive one from a
-- message string, and guessing would merge unrelated failures.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS error_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Stable grouping key. Supplied by the sender; never inferred.
  fingerprint     TEXT NOT NULL,
  -- A short, non-sensitive label. Stack traces are NOT stored: they routinely
  -- contain file paths, query strings and user data.
  title           TEXT NOT NULL,
  culprit         TEXT,
  level           TEXT NOT NULL DEFAULT 'error'
                    CHECK (level IN ('warning','error','fatal')),
  occurred_at     INTEGER NOT NULL,
  received_at     INTEGER NOT NULL,
  identity_id     TEXT REFERENCES identities(id) ON DELETE SET NULL,
  -- The workflow this failure belongs to, when the sender can say.
  workflow        TEXT,
  product_version TEXT,
  release_id      TEXT REFERENCES releases(id) ON DELETE SET NULL,
  -- Where this record came from, for provenance and deduplication.
  source          TEXT NOT NULL DEFAULT 'sdk'
                    CHECK (source IN ('sdk','sentry','import','manual')),
  source_event_id TEXT,
  UNIQUE(project_id, source, source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_errors_project_time ON error_events(project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON error_events(project_id, fingerprint, occurred_at);

-- ---------------------------------------------------------------------------
-- FrictionGraph
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS friction_cases (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  product_area      TEXT,
  affected_workflow TEXT,
  kind              TEXT NOT NULL CHECK (kind IN (
                      'reliability','activation_friction','retention_friction',
                      'billing_friction','feedback_volume','adoption','performance',
                      'usability','unverified')),
  status            TEXT NOT NULL DEFAULT 'detected' CHECK (status IN (
                      'detected','investigating','evidence_collected','validated',
                      'approved','in_development','released','measuring','resolved',
                      'inconclusive','dismissed')),
  period_start      INTEGER NOT NULL,
  period_end        INTEGER NOT NULL,
  -- Distinct users the evidence actually covers. Never an extrapolation.
  affected_users    INTEGER NOT NULL DEFAULT 0,
  -- JSON: segments where the problem is concentrated, with their figures.
  affected_segments TEXT NOT NULL DEFAULT '[]',
  -- MRR attached to affected accounts. Exposure, never predicted loss.
  revenue_exposure_minor INTEGER,
  revenue_currency  TEXT,
  -- How good the evidence is, from the same rules the insight engine uses.
  evidence_quality  TEXT NOT NULL DEFAULT 'insufficient_data' CHECK (evidence_quality IN (
                      'strong_supporting_evidence','moderate_supporting_evidence',
                      'preliminary_observation','insufficient_data')),
  evidence_basis    TEXT NOT NULL DEFAULT '',
  -- Observations, hypotheses and limitations are stored apart on purpose.
  observation       TEXT NOT NULL DEFAULT '',
  hypotheses        TEXT NOT NULL DEFAULT '[]',
  recommended_investigations TEXT NOT NULL DEFAULT '[]',
  limitations       TEXT NOT NULL DEFAULT '[]',
  -- Set when a human promotes the case into development work.
  improvement_id    TEXT REFERENCES improvement_tasks(id) ON DELETE SET NULL,
  dismissed_reason  TEXT,
  detector          TEXT NOT NULL DEFAULT 'rules_v1',
  dedupe_key        TEXT,
  detected_at       INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(project_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_friction_project ON friction_cases(project_id, status, detected_at);

CREATE TABLE IF NOT EXISTS friction_evidence (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id       TEXT NOT NULL REFERENCES friction_cases(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'funnel_step','activation_metric','retention_cohort','feature_adoption',
                  'feedback_item','feedback_cluster','error_group','release',
                  'subscription_event','performance','note')),
  reference_id  TEXT,
  -- Which system this came from, so a figure can always be traced back.
  source        TEXT NOT NULL DEFAULT 'retainos'
                  CHECK (source IN ('retainos','posthog','amplitude','sentry','csv','manual')),
  summary       TEXT NOT NULL,
  -- Frozen numbers at attachment time, so the case survives the data moving on.
  snapshot      TEXT NOT NULL DEFAULT '{}',
  observed_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_friction_evidence ON friction_evidence(case_id, observed_at);

-- Explicit, typed links between two pieces of evidence.
--
-- Every relationship records the rule that produced it, because an
-- unexplained line between two signals is a claim nobody can check.
CREATE TABLE IF NOT EXISTS friction_relationships (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id           TEXT NOT NULL REFERENCES friction_cases(id) ON DELETE CASCADE,
  from_evidence_id  TEXT NOT NULL REFERENCES friction_evidence(id) ON DELETE CASCADE,
  to_evidence_id    TEXT NOT NULL REFERENCES friction_evidence(id) ON DELETE CASCADE,
  relationship      TEXT NOT NULL CHECK (relationship IN (
                      'same_workflow','same_product_version','same_release_window',
                      'same_error_fingerprint','same_feedback_theme','same_account',
                      'shared_affected_users','temporal_proximity')),
  -- The shared value that produced the link, e.g. the version or workflow name.
  shared_key        TEXT,
  -- Plain-language statement of the rule. Rendered in the UI next to the link.
  basis             TEXT NOT NULL,
  -- How much the rule is worth, 0..1. A shared workflow is stronger evidence
  -- than two things happening in the same week.
  strength          REAL NOT NULL DEFAULT 0.5,
  created_at        INTEGER NOT NULL,
  UNIQUE(case_id, from_evidence_id, to_evidence_id, relationship)
);
CREATE INDEX IF NOT EXISTS idx_friction_rel_case ON friction_relationships(case_id);

CREATE TABLE IF NOT EXISTS friction_status_history (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id     TEXT NOT NULL REFERENCES friction_cases(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  changed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  changed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_friction_history ON friction_status_history(case_id, changed_at);

-- ---------------------------------------------------------------------------
-- Opportunity Engine
-- ---------------------------------------------------------------------------

-- Configurable weights per project. Scoring must be arguable, which means the
-- weights have to be visible and changeable.
CREATE TABLE IF NOT EXISTS opportunity_weights (
  project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- JSON map of factor name -> weight. Normalised at read time.
  weights           TEXT NOT NULL,
  updated_at        INTEGER NOT NULL,
  updated_by        TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS opportunity_scores (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  case_id       TEXT NOT NULL REFERENCES friction_cases(id) ON DELETE CASCADE,
  -- 0..100, but only ever as an ordering device. Never presented as a
  -- probability or a confidence.
  score         REAL NOT NULL,
  -- Lower is more urgent. Recomputed for the whole project together.
  rank          INTEGER NOT NULL,
  -- The weakest input, so the UI can say what would most improve the score's
  -- trustworthiness.
  weakest_factor TEXT,
  computed_at   INTEGER NOT NULL,
  UNIQUE(case_id, computed_at)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_project ON opportunity_scores(project_id, computed_at, rank);

CREATE TABLE IF NOT EXISTS opportunity_score_factors (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  score_id      TEXT NOT NULL REFERENCES opportunity_scores(id) ON DELETE CASCADE,
  factor        TEXT NOT NULL,
  -- The underlying measurement, in its own units.
  raw_value     REAL,
  raw_unit      TEXT,
  -- Normalised to 0..1 by an explicit, documented transform.
  normalised    REAL NOT NULL,
  weight        REAL NOT NULL,
  contribution  REAL NOT NULL,
  -- 'measured' from data, 'user_estimate' typed in by a human, 'absent' when
  -- there was nothing to measure. The UI distinguishes all three.
  provenance    TEXT NOT NULL CHECK (provenance IN ('measured','user_estimate','absent')),
  explanation   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_score_factors ON opportunity_score_factors(score_id);

-- Human estimates that feed scoring: engineering effort, strategic importance.
-- Kept separate from measured values so the two are never confused.
CREATE TABLE IF NOT EXISTS opportunity_estimates (
  case_id             TEXT PRIMARY KEY REFERENCES friction_cases(id) ON DELETE CASCADE,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  engineering_effort  TEXT CHECK (engineering_effort IN ('small','medium','large','unknown')),
  strategic_importance TEXT CHECK (strategic_importance IN ('low','medium','high','unknown')),
  has_workaround      INTEGER,
  note                TEXT,
  estimated_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  estimated_at        INTEGER NOT NULL
);

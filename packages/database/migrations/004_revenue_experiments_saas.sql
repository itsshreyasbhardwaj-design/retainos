-- RetainOS migration 004: Revenue Intelligence, ImpactLab, RetainAI, SaaS ops.

CREATE TABLE IF NOT EXISTS billing_connections (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('razorpay','stripe','revenuecat','simulator','manual')),
  -- Webhook signing secrets live in the server environment, not in this table.
  -- This row records only that a connection exists and its current health.
  status        TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN
                  ('disconnected','connected','error')),
  last_event_at INTEGER,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(project_id, provider)
);

CREATE TABLE IF NOT EXISTS customer_subscriptions (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  -- The provider's own subscription id. Unique per project per provider.
  external_id     TEXT NOT NULL,
  identity_id     TEXT REFERENCES identities(id) ON DELETE SET NULL,
  plan_name       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('trialing','active','past_due','paused','cancelled','expired')),
  -- Amount per billing period, in minor units of `currency`.
  amount_minor    INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  interval        TEXT NOT NULL CHECK (interval IN ('month','quarter','year')),
  started_at      INTEGER NOT NULL,
  current_period_start INTEGER,
  current_period_end   INTEGER,
  trial_ends_at   INTEGER,
  cancelled_at    INTEGER,
  -- Only ever one of the enumerated verified reasons, or NULL. RetainOS does
  -- not infer why a customer left.
  cancellation_type TEXT CHECK (cancellation_type IN
                    ('voluntary','payment_failure','expiration','trial_expired','downgrade')),
  cancellation_reason_text TEXT,
  updated_at      INTEGER NOT NULL,
  UNIQUE(project_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_subs_project_status ON customer_subscriptions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_identity ON customer_subscriptions(identity_id);

CREATE TABLE IF NOT EXISTS subscription_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES customer_subscriptions(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  -- The provider's event id. Enforces idempotency against repeated webhook
  -- delivery, which every provider does at least once.
  external_event_id TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN
                    ('trial_started','subscription_started','renewed','upgraded','downgraded',
                     'payment_failed','payment_recovered','paused','resumed','cancelled',
                     'expired','reactivated','refunded')),
  occurred_at     INTEGER NOT NULL,
  received_at     INTEGER NOT NULL,
  amount_minor    INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL,
  previous_amount_minor INTEGER,
  interval        TEXT,
  -- Raw provider payload is NOT stored. Only the mapped fields above, so a
  -- provider payload cannot smuggle customer PII into RetainOS.
  payload_digest  TEXT,
  UNIQUE(project_id, provider, external_event_id)
);
CREATE INDEX IF NOT EXISTS idx_subevents_project_time ON subscription_events(project_id, occurred_at);

CREATE TABLE IF NOT EXISTS revenue_snapshots (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  month_key     TEXT NOT NULL,
  currency      TEXT NOT NULL,
  mrr_minor     INTEGER NOT NULL,
  new_minor     INTEGER NOT NULL,
  expansion_minor INTEGER NOT NULL,
  contraction_minor INTEGER NOT NULL,
  churn_minor   INTEGER NOT NULL,
  reactivation_minor INTEGER NOT NULL,
  active_subscriptions INTEGER NOT NULL,
  churned_customers INTEGER NOT NULL,
  computed_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, month_key, currency)
);

-- ---------------------------------------------------------------------------
-- ImpactLab: releases, before/after, controlled experiments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS experiments (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  hypothesis      TEXT NOT NULL DEFAULT '',
  improvement_id  TEXT REFERENCES improvement_tasks(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                    ('draft','running','stopped','analysed','archived')),
  -- Primary metric: the one the decision rests on.
  primary_metric_event TEXT NOT NULL,
  primary_metric_filter TEXT NOT NULL DEFAULT '{}',
  primary_metric_kind TEXT NOT NULL DEFAULT 'conversion'
                    CHECK (primary_metric_kind IN ('conversion','count_per_user')),
  -- Guardrails: metrics that must not get worse, analysed with a multiple-
  -- comparison correction so "one of six guardrails moved" is not called a find.
  guardrail_metrics TEXT NOT NULL DEFAULT '[]',
  -- Pre-registered. Peeking at results before this many exposures per variant
  -- is flagged as premature stopping.
  min_exposures_per_variant INTEGER NOT NULL DEFAULT 200,
  started_at      INTEGER,
  stopped_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(project_id, key)
);

CREATE TABLE IF NOT EXISTS experiment_variants (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  is_control    INTEGER NOT NULL DEFAULT 0,
  -- Target share of traffic, 0..1. Sum across variants must be 1.
  weight        REAL NOT NULL DEFAULT 0.5,
  UNIQUE(experiment_id, key)
);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  identity_id   TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  variant_key   TEXT NOT NULL,
  assigned_at   INTEGER NOT NULL,
  UNIQUE(experiment_id, identity_id)
);

-- Exposure is what makes an experiment analysable: a user counts only once we
-- know they actually saw the variant.
CREATE TABLE IF NOT EXISTS experiment_exposures (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  identity_id   TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  variant_key   TEXT NOT NULL,
  first_exposed_at INTEGER NOT NULL,
  exposure_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(experiment_id, identity_id)
);
CREATE INDEX IF NOT EXISTS idx_exposures_exp ON experiment_exposures(experiment_id, variant_key);

CREATE TABLE IF NOT EXISTS experiment_results (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  computed_at   INTEGER NOT NULL,
  -- Full analysis record: per-variant rates, test statistic, interval,
  -- validity checks and the resulting verdict. Stored so a decision can be
  -- audited later against exactly what was known at the time.
  analysis      TEXT NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN
                  ('improvement_supported','no_clear_difference','worse_outcome',
                   'inconclusive','invalid_experiment'))
);

CREATE TABLE IF NOT EXISTS impact_measurements (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  improvement_id  TEXT REFERENCES improvement_tasks(id) ON DELETE SET NULL,
  release_id      TEXT REFERENCES releases(id) ON DELETE SET NULL,
  experiment_id   TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  -- 'before_after' is observational and labelled as such everywhere it is
  -- shown. 'experiment' is the only method that supports a causal claim.
  method          TEXT NOT NULL CHECK (method IN ('before_after','experiment')),
  metric_kind     TEXT NOT NULL,
  metric_config   TEXT NOT NULL DEFAULT '{}',
  window_days     INTEGER NOT NULL DEFAULT 14,
  result          TEXT NOT NULL DEFAULT '{}',
  computed_at     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_impact_project ON impact_measurements(project_id, created_at);

-- ---------------------------------------------------------------------------
-- RetainAI: insights are rows, with evidence pointers, not prose
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS insights (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  observation   TEXT NOT NULL,
  -- Hypotheses are stored separately from observations and rendered with
  -- different language in the UI. An observation is a measurement; a
  -- hypothesis is a guess that needs checking.
  hypotheses    TEXT NOT NULL DEFAULT '[]',
  suggested_investigation TEXT NOT NULL DEFAULT '[]',
  limitations   TEXT NOT NULL DEFAULT '[]',
  confidence    TEXT NOT NULL CHECK (confidence IN
                  ('strong_supporting_evidence','moderate_supporting_evidence',
                   'preliminary_observation','insufficient_data')),
  confidence_basis TEXT NOT NULL DEFAULT '',
  severity      INTEGER NOT NULL DEFAULT 0,
  affected_users INTEGER,
  metric_definition TEXT NOT NULL DEFAULT '',
  period_start  INTEGER,
  period_end    INTEGER,
  comparison_start INTEGER,
  comparison_end INTEGER,
  -- Generated by the deterministic rule engine, or by an optional LLM adapter.
  -- Recorded truthfully so the UI never implies a model wrote a template.
  generator     TEXT NOT NULL DEFAULT 'rules_v1',
  dismissed_at  INTEGER,
  created_at    INTEGER NOT NULL,
  dedupe_key    TEXT,
  UNIQUE(project_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_insights_project ON insights(project_id, severity, created_at);

CREATE TABLE IF NOT EXISTS insight_evidence (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  insight_id  TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  reference_id TEXT,
  snapshot    TEXT NOT NULL DEFAULT '{}',
  summary     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insight_evidence ON insight_evidence(insight_id);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  insights_created INTEGER NOT NULL DEFAULT 0,
  generator     TEXT NOT NULL DEFAULT 'rules_v1',
  error         TEXT
);

-- ---------------------------------------------------------------------------
-- SaaS operations: plans, usage, billing, audit, privacy requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_subscriptions (
  org_id          TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id         TEXT NOT NULL DEFAULT 'free',
  interval        TEXT NOT NULL DEFAULT 'month' CHECK (interval IN ('month','year')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN
                    ('active','past_due','cancelled','trialing')),
  provider        TEXT NOT NULL DEFAULT 'simulator',
  external_id     TEXT,
  current_period_start INTEGER NOT NULL,
  current_period_end   INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_counters (
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_key  TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, period_key, metric)
);

CREATE TABLE IF NOT EXISTS billing_records (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- 'simulator' records are development-only and labelled as such in the UI.
  -- A simulated payment is never reported as a real one.
  provider      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('charge','refund','credit')),
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','refunded')),
  description   TEXT NOT NULL DEFAULT '',
  external_id   TEXT,
  is_simulated  INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  org_id        TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_kind    TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','system','api_key')),
  action        TEXT NOT NULL,
  target_kind   TEXT,
  target_id     TEXT,
  detail        TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_events(org_id, created_at);

CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Either an external user id or an anonymous id. Both are supported because
  -- a deletion request can arrive before or after identification.
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('external_id','anonymous_id')),
  subject_value TEXT NOT NULL,
  requested_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  requested_at  INTEGER NOT NULL,
  completed_at  INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  -- Counts of what was removed, for the audit trail.
  report        TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  period_start  INTEGER NOT NULL,
  period_end    INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_project ON reports(project_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  link          TEXT,
  read_at       INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS integrations (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  -- Non-secret configuration only (repository name, default labels, etc).
  -- Credentials are read from the server environment at dispatch time.
  config        TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'disconnected',
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(project_id, kind)
);

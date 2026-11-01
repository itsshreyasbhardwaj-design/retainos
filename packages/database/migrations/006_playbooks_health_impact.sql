-- RetainOS migration 006: Retention Playbooks, Customer Health, Revenue
-- Impact classification, instrumentation findings, provider connections,
-- and alerting. Additive only.

-- ---------------------------------------------------------------------------
-- B2B account key on identities.
--
-- ALTER TABLE ADD COLUMN is additive and non-destructive: existing rows get
-- NULL, which reads correctly as "no account known".
-- ---------------------------------------------------------------------------

ALTER TABLE identities ADD COLUMN account_key TEXT;
CREATE INDEX IF NOT EXISTS idx_identities_account ON identities(project_id, account_key);

-- ---------------------------------------------------------------------------
-- Retention Playbooks
--
-- Every design choice here exists to make a manipulative playbook impossible
-- to express: consent is required, frequency is capped, holdouts are
-- first-class, and nothing sends without approval.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS retention_playbooks (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'onboarding_recovery','feature_discovery','inactivity_follow_up',
                    'feedback_follow_up','cancellation_feedback','payment_failure_assistance')),
  description     TEXT NOT NULL DEFAULT '',
  -- Draft until a human with permission approves it. Only 'active' enrols.
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                    ('draft','approved','active','paused','archived')),
  -- Trigger definition: event, absence of event, or a friction/health state.
  trigger_kind    TEXT NOT NULL CHECK (trigger_kind IN (
                    'event_occurred','event_absent','funnel_stalled',
                    'health_state','subscription_state','feedback_resolved')),
  trigger_config  TEXT NOT NULL DEFAULT '{}',
  -- How long after the trigger before acting. Never zero for an outbound
  -- channel: an instant message after an action reads as surveillance.
  delay_hours     INTEGER NOT NULL DEFAULT 24,
  -- Audience conditions, as a segment filter.
  audience_filter TEXT NOT NULL DEFAULT '{}',
  -- 'in_app' needs no consent beyond product use. 'email' always does.
  channel         TEXT NOT NULL CHECK (channel IN ('in_app','email','none')),
  -- Requiring consent is the default and cannot be turned off for email.
  requires_consent INTEGER NOT NULL DEFAULT 1,
  message_title   TEXT NOT NULL DEFAULT '',
  message_body    TEXT NOT NULL DEFAULT '',
  help_url        TEXT,
  -- Hard caps, enforced at enrolment rather than at send time.
  max_per_user_total     INTEGER NOT NULL DEFAULT 1,
  max_per_user_days      INTEGER NOT NULL DEFAULT 30,
  quiet_hours_start      INTEGER,
  quiet_hours_end        INTEGER,
  -- A share of eligible users receives nothing, so the playbook's effect can
  -- be measured rather than assumed.
  holdout_percent        REAL NOT NULL DEFAULT 0.1,
  -- The playbook stops enrolling anyone once this event is seen for a user.
  stop_on_event          TEXT,
  primary_metric_event   TEXT,
  guardrail_metrics      TEXT NOT NULL DEFAULT '[]',
  approved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_playbooks_project ON retention_playbooks(project_id, status);

CREATE TABLE IF NOT EXISTS playbook_enrollments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  playbook_id   TEXT NOT NULL REFERENCES retention_playbooks(id) ON DELETE CASCADE,
  identity_id   TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  -- 'holdout' members are enrolled and deliberately receive nothing.
  arm           TEXT NOT NULL CHECK (arm IN ('treatment','holdout')),
  enrolled_at   INTEGER NOT NULL,
  -- Scheduled, not sent: delivery is a separate, explicit step.
  due_at        INTEGER NOT NULL,
  delivered_at  INTEGER,
  -- Why nothing was sent, when nothing was sent. Always recorded.
  suppressed_reason TEXT,
  -- The primary metric event, if the user went on to perform it.
  outcome_at    INTEGER,
  stopped_at    INTEGER,
  UNIQUE(playbook_id, identity_id)
);
CREATE INDEX IF NOT EXISTS idx_enrollments_due ON playbook_enrollments(playbook_id, due_at, delivered_at);

-- A standing, per-identity record of what a person has agreed to receive.
-- Checked at enrolment and again at delivery.
CREATE TABLE IF NOT EXISTS messaging_consent (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  identity_id   TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL CHECK (channel IN ('in_app','email')),
  granted       INTEGER NOT NULL,
  -- Where the consent came from. An absent record is never read as consent.
  basis         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(project_id, identity_id, channel)
);

-- ---------------------------------------------------------------------------
-- Customer and account health
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS health_definitions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- JSON array of {signal, weight, config}. Rule-based and visible; there is
  -- no model here and the UI does not pretend there is.
  signals       TEXT NOT NULL DEFAULT '[]',
  is_primary    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS health_observations (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL REFERENCES health_definitions(id) ON DELETE CASCADE,
  -- Either one person or a B2B account. Never conflated.
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('identity','account')),
  identity_id   TEXT REFERENCES identities(id) ON DELETE CASCADE,
  account_key   TEXT,
  -- Deliberately not a 0-100 score. These are categories a human can argue with.
  state         TEXT NOT NULL CHECK (state IN (
                  'strong_engagement','mixed_signals','attention_suggested','insufficient_information')),
  -- JSON array of {signal, observed, contributed, detail}.
  signal_detail TEXT NOT NULL DEFAULT '[]',
  observed_at   INTEGER NOT NULL,
  UNIQUE(definition_id, subject_kind, identity_id, account_key, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_health_project ON health_observations(project_id, observed_at, state);

-- B2B accounts, derived from an account key the SDK supplies.
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  account_key     TEXT NOT NULL,
  name            TEXT,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  UNIQUE(project_id, account_key)
);
CREATE INDEX IF NOT EXISTS idx_accounts_project ON accounts(project_id, last_seen_at);

-- ---------------------------------------------------------------------------
-- Revenue impact, with evidence classification
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS revenue_impact_records (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  case_id         TEXT REFERENCES friction_cases(id) ON DELETE SET NULL,
  improvement_id  TEXT REFERENCES improvement_tasks(id) ON DELETE SET NULL,
  release_id      TEXT REFERENCES releases(id) ON DELETE SET NULL,
  experiment_id   TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  label           TEXT NOT NULL,
  -- The classification is the whole point of this table. A figure without one
  -- cannot be stored, because the column is NOT NULL and constrained.
  classification  TEXT NOT NULL CHECK (classification IN (
                    'observed','estimated','associated','experiment_supported','insufficient_evidence')),
  amount_minor    INTEGER,
  currency        TEXT,
  period_start    INTEGER,
  period_end      INTEGER,
  -- JSON array of {name, value, unit, source}. An estimate without its
  -- assumptions is not storable in a usable way.
  assumptions     TEXT NOT NULL DEFAULT '[]',
  method          TEXT NOT NULL DEFAULT '',
  limitations     TEXT NOT NULL DEFAULT '[]',
  computed_at     INTEGER NOT NULL,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_revenue_impact ON revenue_impact_records(project_id, computed_at);

-- ---------------------------------------------------------------------------
-- Instrumentation Doctor
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instrumentation_findings (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  check_id      TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('blocking','warning','advisory')),
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  why_it_matters TEXT NOT NULL,
  suggested_fix TEXT NOT NULL,
  how_to_verify TEXT NOT NULL,
  evidence      TEXT NOT NULL DEFAULT '{}',
  detected_at   INTEGER NOT NULL,
  resolved_at   INTEGER,
  UNIQUE(project_id, check_id)
);
CREATE INDEX IF NOT EXISTS idx_instrumentation ON instrumentation_findings(project_id, severity, resolved_at);

-- ---------------------------------------------------------------------------
-- Provider connections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_connections (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN
                    ('posthog','amplitude','sentry','csv','github','razorpay','stripe','revenuecat')),
  -- Non-secret configuration only. Credentials live in the server environment
  -- or in a secret store, never in this table.
  config          TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN
                    ('disconnected','connected','error','revoked')),
  -- What this connection is allowed to do, verified at connection time.
  granted_scopes  TEXT NOT NULL DEFAULT '[]',
  last_sync_at    INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(project_id, provider)
);

CREATE TABLE IF NOT EXISTS provider_sync_runs (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id   TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
  records_seen    INTEGER NOT NULL DEFAULT 0,
  records_imported INTEGER NOT NULL DEFAULT 0,
  records_duplicate INTEGER NOT NULL DEFAULT 0,
  records_rejected INTEGER NOT NULL DEFAULT 0,
  detail          TEXT NOT NULL DEFAULT '{}',
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs ON provider_sync_runs(connection_id, started_at);

-- Which system is authoritative for which metric, so the same event arriving
-- from two places is counted once.
CREATE TABLE IF NOT EXISTS source_mappings (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The metric family, e.g. 'events', 'errors', 'subscriptions'.
  domain          TEXT NOT NULL,
  -- The event or entity name, or '*' for the whole domain.
  entity          TEXT NOT NULL DEFAULT '*',
  authoritative_source TEXT NOT NULL,
  note            TEXT,
  updated_at      INTEGER NOT NULL,
  UNIQUE(project_id, domain, entity)
);

-- ---------------------------------------------------------------------------
-- Alerting
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS alert_rules (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'activation_regression','error_spike','retention_change','feedback_theme',
                    'cancellation_increase','ingestion_failure','experiment_guardrail')),
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- The change required before this is worth telling anyone about.
  threshold       REAL NOT NULL,
  -- Minimum affected users. Below this the rule stays silent regardless.
  min_affected_users INTEGER NOT NULL DEFAULT 20,
  comparison_days INTEGER NOT NULL DEFAULT 7,
  -- Nothing fires twice inside this window.
  cooldown_hours  INTEGER NOT NULL DEFAULT 24,
  quiet_hours_start INTEGER,
  quiet_hours_end INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(project_id, kind)
);

CREATE TABLE IF NOT EXISTS alert_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule_id         TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  severity        TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  title           TEXT NOT NULL,
  -- Every alert must carry all of these. The columns are NOT NULL so an alert
  -- without its supporting evidence cannot be written.
  triggering_rule TEXT NOT NULL,
  metric_detail   TEXT NOT NULL,
  comparison_detail TEXT NOT NULL,
  data_quality    TEXT NOT NULL,
  suggested_action TEXT NOT NULL,
  affected_users  INTEGER,
  case_id         TEXT REFERENCES friction_cases(id) ON DELETE SET NULL,
  fired_at        INTEGER NOT NULL,
  acknowledged_at INTEGER,
  resolved_at     INTEGER,
  snoozed_until   INTEGER,
  dedupe_key      TEXT,
  UNIQUE(project_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_alerts_project ON alert_events(project_id, fired_at, resolved_at);

-- ---------------------------------------------------------------------------
-- Executive briefs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS executive_briefs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_start  INTEGER NOT NULL,
  period_end    INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  generator     TEXT NOT NULL DEFAULT 'rules_v1',
  created_at    INTEGER NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_briefs_project ON executive_briefs(project_id, created_at);

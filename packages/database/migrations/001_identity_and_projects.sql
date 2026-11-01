-- RetainOS migration 001: identity, organizations, projects, credentials.
--
-- Dialect notes (see docs/DATABASE.md):
--   * Written for SQLite (local development) and PostgreSQL (production).
--   * Timestamps are INTEGER epoch milliseconds, UTC. Never local time.
--   * Money is INTEGER minor units (paise/cents) plus an explicit currency.
--   * Every tenant-owned table carries org_id so row access can be scoped and,
--     under PostgreSQL, protected with row-level security.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  -- Soft-lock after repeated failed logins; cleared on success.
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  user_agent_category TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- Demo organizations are clearly marked so fictional data can never be
  -- confused with a customer's real product data.
  is_demo       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_membership_user ON organization_memberships(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  invited_by    TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  revoked_at    INTEGER,
  UNIQUE(org_id, email)
);

CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  -- IANA name. All reporting buckets are computed in this zone.
  reporting_timezone  TEXT NOT NULL DEFAULT 'UTC',
  currency            TEXT NOT NULL DEFAULT 'INR',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  archived_at         INTEGER,
  -- Ingestion policy
  require_consent     INTEGER NOT NULL DEFAULT 1,
  strict_schema       INTEGER NOT NULL DEFAULT 0,
  allowed_origins     TEXT NOT NULL DEFAULT '[]',
  raw_retention_days  INTEGER NOT NULL DEFAULT 90,
  -- Inactivity thresholds are per-product, because "inactive" means nothing
  -- without knowing how often the product is meant to be used.
  inactivity_days     INTEGER NOT NULL DEFAULT 14,
  is_demo             INTEGER NOT NULL DEFAULT 0,
  UNIQUE(org_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

CREATE TABLE IF NOT EXISTS project_keys (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 'public_write' keys are not secrets: they ship in browser bundles and may
  -- only append events. 'secret_admin' keys are hashed and never shown again.
  kind          TEXT NOT NULL CHECK (kind IN ('public_write','secret_admin')),
  name          TEXT NOT NULL,
  public_key    TEXT UNIQUE,
  secret_hash   TEXT,
  secret_preview TEXT,
  created_at    INTEGER NOT NULL,
  created_by    TEXT REFERENCES users(id),
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_keys_project ON project_keys(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_keys_secret ON project_keys(secret_hash);

CREATE TABLE IF NOT EXISTS event_schemas (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  description   TEXT,
  -- JSON array of {name,type,required,allowed,description}
  properties    TEXT NOT NULL DEFAULT '[]',
  allow_unknown INTEGER NOT NULL DEFAULT 1,
  deprecated    INTEGER NOT NULL DEFAULT 0,
  deprecation_note TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS activation_definitions (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- The single event that means "this user reached first real value".
  activation_event TEXT NOT NULL,
  -- Optional JSON property filter, e.g. {"feature":"first_project"}
  property_filter TEXT NOT NULL DEFAULT '{}',
  -- Window, in days, within which activation must happen to count.
  window_days     INTEGER NOT NULL DEFAULT 7,
  signup_event    TEXT NOT NULL DEFAULT 'signup_completed',
  is_primary      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activation_project ON activation_definitions(project_id);

CREATE TABLE IF NOT EXISTS tracked_features (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  event_name    TEXT NOT NULL,
  property_filter TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  UNIQUE(project_id, key)
);

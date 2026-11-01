-- RetainOS migration 003: FeedbackOS, FixFlow, ReleaseHub, OnboardOS.

CREATE TABLE IF NOT EXISTS feedback_items (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN
                  ('widget','portal','manual','import','survey','integration')),
  kind          TEXT NOT NULL CHECK (kind IN
                  ('bug','feature_request','improvement','confusion','general')),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN
                  ('new','under_review','planned','in_progress','released','closed','duplicate')),
  priority      TEXT CHECK (priority IN ('low','medium','high','critical')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  -- Optional, consented contact details. Absent unless the reporter opted in.
  contact_email TEXT,
  consent_to_contact INTEGER NOT NULL DEFAULT 0,
  -- Product context captured with the report, never page contents.
  page_identifier TEXT,
  product_version TEXT,
  identity_id   TEXT REFERENCES identities(id) ON DELETE SET NULL,
  severity_reported TEXT,
  cluster_id    TEXT,
  duplicate_of  TEXT REFERENCES feedback_items(id) ON DELETE SET NULL,
  assigned_to   TEXT REFERENCES users(id) ON DELETE SET NULL,
  vote_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feedback_project_status ON feedback_items(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_cluster ON feedback_items(cluster_id);

CREATE TABLE IF NOT EXISTS feedback_tags (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT 'slate',
  UNIQUE(project_id, label)
);

CREATE TABLE IF NOT EXISTS feedback_item_tags (
  feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES feedback_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (feedback_id, tag_id)
);

CREATE TABLE IF NOT EXISTS feedback_comments (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  -- Internal notes are never exposed on the public portal.
  is_internal INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_comments ON feedback_comments(feedback_id, created_at);

CREATE TABLE IF NOT EXISTS feedback_attachments (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_clusters (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  -- JSON array of the terms that define the cluster. Editable by a human,
  -- because an automatic grouping is a suggestion, not a verdict.
  keywords    TEXT NOT NULL DEFAULT '[]',
  item_count  INTEGER NOT NULL DEFAULT 0,
  method      TEXT NOT NULL DEFAULT 'term_overlap',
  edited_by_human INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_votes (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  -- One vote per voter key per item. The voter key is a salted hash, so the
  -- portal can prevent duplicate votes without storing who voted.
  voter_key   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(feedback_id, voter_key)
);

-- ---------------------------------------------------------------------------
-- FixFlow: evidence -> development task -> release -> measurement
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS improvement_tasks (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  affected_workflow TEXT,
  -- Explicitly separated: what we observed vs what we think vs what we propose.
  hypothesis      TEXT,
  investigation   TEXT,
  proposed_work   TEXT,
  acceptance_criteria TEXT,
  measurement_plan TEXT,
  priority        TEXT CHECK (priority IN ('low','medium','high','critical')),
  priority_rationale TEXT,
  status          TEXT NOT NULL DEFAULT 'detected' CHECK (status IN
                    ('detected','investigating','validated','planned','approved',
                     'in_development','in_review','released','measuring','resolved',
                     'not_effective','closed')),
  primary_metric  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at     INTEGER,
  release_id      TEXT,
  -- Set only by a human decision or an experiment result, never inferred.
  outcome         TEXT CHECK (outcome IN
                    ('improvement_supported','no_clear_difference','worse_outcome',
                     'inconclusive','invalid_experiment'))
);
CREATE INDEX IF NOT EXISTS idx_improvements_project ON improvement_tasks(project_id, status, updated_at);

CREATE TABLE IF NOT EXISTS improvement_evidence (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  improvement_id TEXT NOT NULL REFERENCES improvement_tasks(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('funnel_step','retention_cohort','feedback_item','feedback_cluster',
                   'event_metric','activation_metric','revenue_metric','insight','note')),
  -- Reference into whichever table `kind` names. Nullable for free-text notes.
  reference_id  TEXT,
  -- A frozen, privacy-safe snapshot of the numbers at the time of linking, so
  -- the task still makes sense after the underlying data moves on.
  snapshot      TEXT NOT NULL DEFAULT '{}',
  summary       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_improvement ON improvement_evidence(improvement_id);

CREATE TABLE IF NOT EXISTS improvement_status_history (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  improvement_id TEXT NOT NULL REFERENCES improvement_tasks(id) ON DELETE CASCADE,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  note          TEXT,
  changed_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  changed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_improvement_history ON improvement_status_history(improvement_id, changed_at);

CREATE TABLE IF NOT EXISTS github_issue_links (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  improvement_id  TEXT NOT NULL REFERENCES improvement_tasks(id) ON DELETE CASCADE,
  repository      TEXT NOT NULL,
  issue_number    INTEGER,
  issue_url       TEXT,
  issue_state     TEXT,
  -- 'draft' until a human approves; nothing is sent to GitHub before that.
  dispatch_state  TEXT NOT NULL DEFAULT 'draft' CHECK (dispatch_state IN
                    ('draft','approved','dispatched','failed','unlinked')),
  draft_title     TEXT NOT NULL,
  draft_body      TEXT NOT NULL,
  labels          TEXT NOT NULL DEFAULT '[]',
  approved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at     INTEGER,
  dispatched_at   INTEGER,
  last_synced_at  INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE(improvement_id, repository, issue_number)
);

-- ---------------------------------------------------------------------------
-- ReleaseHub
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS releases (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  released_at   INTEGER NOT NULL,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_releases_project ON releases(project_id, released_at);

CREATE TABLE IF NOT EXISTS release_improvements (
  release_id      TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  improvement_id  TEXT NOT NULL REFERENCES improvement_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (release_id, improvement_id)
);

CREATE TABLE IF NOT EXISTS changelog_entries (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_id    TEXT REFERENCES releases(id) ON DELETE CASCADE,
  category      TEXT NOT NULL CHECK (category IN
                  ('new_feature','improvement','bug_fix','performance','known_limitation')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  is_public     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changelog_project ON changelog_entries(project_id, created_at);

-- ---------------------------------------------------------------------------
-- OnboardOS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS onboarding_flows (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  is_active     INTEGER NOT NULL DEFAULT 0,
  -- Users can always dismiss. Non-dismissible onboarding is a dark pattern.
  dismissible   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_steps (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  flow_id       TEXT NOT NULL REFERENCES onboarding_flows(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  help_text     TEXT NOT NULL DEFAULT '',
  help_url      TEXT,
  -- The step is complete when this event arrives for the user.
  completion_event TEXT NOT NULL,
  completion_filter TEXT NOT NULL DEFAULT '{}',
  UNIQUE(flow_id, position)
);

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  flow_id       TEXT NOT NULL REFERENCES onboarding_flows(id) ON DELETE CASCADE,
  identity_id   TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  started_at    INTEGER,
  completed_at  INTEGER,
  dismissed_at  INTEGER,
  -- JSON map of step_id -> completion timestamp.
  step_state    TEXT NOT NULL DEFAULT '{}',
  updated_at    INTEGER NOT NULL,
  UNIQUE(flow_id, identity_id)
);

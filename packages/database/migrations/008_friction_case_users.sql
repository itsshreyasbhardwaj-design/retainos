-- ---------------------------------------------------------------------------
-- The people a friction case is about
--
-- Until now a case stored how many users it covered but not which ones, so it
-- could not answer the question everything downstream asks: show me these
-- people. Revenue impact needs their subscriptions, a playbook needs their
-- identities to enrol, and health needs to know an account was affected.
--
-- Recomputing the set later is not an option: the case freezes its evidence on
-- purpose, and a re-run of the detector would answer about today's data rather
-- than the data the case was raised on.
--
-- Additive: nothing reads this column set yet, and ON DELETE CASCADE means a
-- user's erasure removes their membership along with their identity, so the
-- privacy guarantees are unchanged.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS friction_case_users (
  -- Tenancy is carried on the row rather than inherited, so export, erasure
  -- and every cross-tenant check treat it like any other owned table.
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  case_id     TEXT NOT NULL REFERENCES friction_cases(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  -- Which signal brought this person into the case, when it is known. A case
  -- built from three signals can then say who came from which.
  evidence_id TEXT REFERENCES friction_evidence(id) ON DELETE SET NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (case_id, identity_id)
);
CREATE INDEX IF NOT EXISTS idx_case_users_identity ON friction_case_users(identity_id);

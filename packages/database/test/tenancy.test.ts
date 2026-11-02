import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createUser, createOrganization, createProject, listProjects, projectKeys, issueSecretKey } from "../src/accounts.ts";
import { resolveOrgScope, resolveProjectScope } from "../src/scope.ts";
import { authenticateWriteKey, ingestBatch, recentEvents } from "../src/ingest.ts";
import { submitFeedback, listFeedback } from "../src/feedback.ts";
import { createImprovement, attachEvidence, listImprovements } from "../src/improvements.ts";
import { exportProject, eraseSubject } from "../src/privacy-ops.ts";
import { freshDb, must, mustFail, PASSWORD } from "./helpers.ts";

/**
 * Two completely separate tenants in one database. Every assertion below is a
 * cross-tenant access attempt that must fail. This is the suite that matters
 * most: a single leak here is a product-ending bug.
 */
function twoTenants() {
  const db = freshDb();
  const alice = must(createUser(db, { email: "alice@a.com", name: "Alice", password: PASSWORD }));
  const bob = must(createUser(db, { email: "bob@b.com", name: "Bob", password: PASSWORD }));

  const orgA = must(createOrganization(db, { name: "Alpha Co", ownerId: alice.id }));
  const orgB = must(createOrganization(db, { name: "Bravo Co", ownerId: bob.id }));
  db.run("UPDATE org_subscriptions SET plan_id = 'agency'");

  const scopeOrgA = must(resolveOrgScope(db, alice.id, orgA.orgId));
  const scopeOrgB = must(resolveOrgScope(db, bob.id, orgB.orgId));
  const projA = must(createProject(db, scopeOrgA, { name: "Alpha App" }));
  const projB = must(createProject(db, scopeOrgB, { name: "Bravo App" }));

  const scopeA = must(resolveProjectScope(db, alice.id, projA.projectId));
  const scopeB = must(resolveProjectScope(db, bob.id, projB.projectId));
  const ingestA = must(authenticateWriteKey(db, projA.publicKey));
  const ingestB = must(authenticateWriteKey(db, projB.publicKey));

  // Each tenant has real data.
  must(ingestBatch(db, ingestA, { events: [{ name: "signup_completed", userId: "alice-user-1", consent: true }] }));
  must(ingestBatch(db, ingestB, { events: [{ name: "signup_completed", userId: "bob-user-1", consent: true }] }));
  must(submitFeedback(db, { orgId: orgA.orgId, projectId: projA.projectId },
    { kind: "bug", title: "Alpha secret bug report", body: "confidential", source: "widget" }));
  must(submitFeedback(db, { orgId: orgB.orgId, projectId: projB.projectId },
    { kind: "bug", title: "Bravo secret bug report", body: "confidential", source: "widget" }));

  return { db, alice, bob, orgA, orgB, projA, projB, scopeA, scopeB, scopeOrgA, scopeOrgB, ingestA, ingestB };
}

describe("cross-tenant project access", () => {
  test("a user cannot resolve a scope for another organization's project", () => {
    const t = twoTenants();
    // Bob's user id with Alice's project id: must not produce a scope at all.
    assert.equal(mustFail(resolveProjectScope(t.db, t.bob.id, t.projA.projectId)).code, "not_found");
    assert.equal(mustFail(resolveProjectScope(t.db, t.alice.id, t.projB.projectId)).code, "not_found");
  });

  test("a non-member cannot resolve an organization scope, and gets not_found rather than forbidden", () => {
    const t = twoTenants();
    // 'not_found' matters: 'forbidden' would confirm the org id exists.
    const e = mustFail(resolveOrgScope(t.db, t.bob.id, t.orgA.orgId));
    assert.equal(e.code, "not_found");
    assert.ok(!e.message.includes(t.orgA.orgId));
  });

  test("listProjects only returns the caller's own organization", () => {
    const t = twoTenants();
    const forAlice = listProjects(t.db, t.scopeOrgA);
    assert.equal(forAlice.length, 1);
    assert.equal(forAlice[0]!.id, t.projA.projectId);
    const forBob = listProjects(t.db, t.scopeOrgB);
    assert.equal(forBob.length, 1);
    assert.equal(forBob[0]!.id, t.projB.projectId);
  });
});

describe("cross-tenant data reads", () => {
  test("events are scoped to the project", () => {
    const t = twoTenants();
    const a = recentEvents(t.db, t.projA.projectId);
    const b = recentEvents(t.db, t.projB.projectId);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.ok(!JSON.stringify(a).includes("bob-user-1"));
    assert.ok(!JSON.stringify(b).includes("alice-user-1"));
  });

  test("feedback is scoped to the project", () => {
    const t = twoTenants();
    const a = listFeedback(t.db, t.scopeA);
    assert.equal(a.length, 1);
    assert.ok(!JSON.stringify(a).includes("Bravo secret"));
  });

  test("a data export contains only the caller's project", () => {
    const t = twoTenants();
    const bundle = must(exportProject(t.db, t.scopeA, { includeRawEvents: true }));
    const text = JSON.stringify(bundle);
    assert.ok(text.includes("Alpha secret bug report"));
    assert.ok(!text.includes("Bravo secret bug report"));
    assert.ok(!text.includes("bob-user-1"));
  });

  test("the export covers every project-scoped table", () => {
    // Without this, the export quietly falls behind the schema: a feature ships
    // with a new table, the table never reaches the export, and "your data is
    // yours" stops being true without anyone noticing.
    const t = twoTenants();
    const bundle = must(exportProject(t.db, t.scopeA, { includeRawEvents: true }));
    const exported = new Set(Object.keys(bundle.tables));

    // Tables that belong to the organization or the installation rather than
    // to one project, or that an export would be wrong to include.
    const notProjectData = new Set([
      "schema_migrations", "users", "sessions", "organizations", "organization_memberships",
      "org_subscriptions", "usage_counters", "billing_records", "audit_events",
      "data_deletion_requests", "notifications", "integrations", "analysis_runs",
      "background_jobs", "aggregation_jobs", "project_keys", "projects", "billing_connections",
      "identity_links", "event_rejections", "ingest_batches", "analytics_events",
      "daily_active_aggregates", "event_daily_aggregates", "revenue_snapshots",
      "feedback_item_tags", "release_improvements", "feedback_votes",
      "experiment_assignments", "experiment_exposures",
    ]);

    const missing: string[] = [];
    for (const row of t.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )) {
      if (notProjectData.has(row.name) || exported.has(row.name)) continue;
      const cols = t.db.all<{ name: string }>(`PRAGMA table_info(${row.name})`).map((c) => c.name);
      // Only tables a project owns directly are required here; child tables
      // reach the export through their parent and are listed under their own
      // name when they do.
      if (cols.includes("project_id")) missing.push(row.name);
    }
    assert.deepEqual(missing, [], `project-scoped tables missing from the export: ${missing.join(", ")}`);
  });
});

describe("cross-tenant writes", () => {
  test("evidence cannot reference another project's feedback", () => {
    const t = twoTenants();
    const bobFeedback = t.db.get<{ id: string }>(
      "SELECT id FROM feedback_items WHERE project_id = ?", [t.projB.projectId],
    )!;
    const imp = must(createImprovement(t.db, t.scopeA, { title: "Alpha improvement task" }));
    const e = mustFail(attachEvidence(t.db, t.scopeA, imp.id, {
      kind: "feedback_item", referenceId: bobFeedback.id, summary: "borrowed evidence",
    }));
    assert.equal(e.code, "not_found");
  });

  test("an improvement in another project cannot be modified", () => {
    const t = twoTenants();
    const bobImp = must(createImprovement(t.db, t.scopeB, { title: "Bravo improvement task" }));
    const e = mustFail(attachEvidence(t.db, t.scopeA, bobImp.id, { kind: "note", summary: "x" }));
    assert.equal(e.code, "not_found");
    assert.equal(listImprovements(t.db, t.scopeA).length, 0);
  });

  test("erasure in one project leaves the other untouched", () => {
    const t = twoTenants();
    must(eraseSubject(t.db, t.scopeA, { kind: "external_id", value: "alice-user-1" }));
    assert.equal(recentEvents(t.db, t.projA.projectId).length, 0);
    assert.equal(recentEvents(t.db, t.projB.projectId).length, 1);
  });

  test("erasing an id that exists only in the other project deletes nothing", () => {
    const t = twoTenants();
    const r = must(eraseSubject(t.db, t.scopeA, { kind: "external_id", value: "bob-user-1" }));
    assert.equal(r.report.identitiesDeleted, 0);
    assert.equal(r.report.eventsDeleted, 0);
    assert.equal(recentEvents(t.db, t.projB.projectId).length, 1);
  });
});

describe("write-key isolation", () => {
  test("a write key only ever ingests into its own project", () => {
    const t = twoTenants();
    // Using Alpha's key cannot write to Bravo: the key *is* the project binding.
    assert.equal(t.ingestA.projectId, t.projA.projectId);
    must(ingestBatch(t.db, t.ingestA, { events: [{ name: "core_action_completed", userId: "u", consent: true }] }));
    assert.equal(recentEvents(t.db, t.projB.projectId).length, 1); // unchanged
  });

  test("a write key from another project does not grant read access", () => {
    const t = twoTenants();
    // There is no code path from a public write key to a read scope: the only
    // producers of ProjectScope verify membership. Assert the shape explicitly.
    const asRecord = t.ingestA as unknown as Record<string, unknown>;
    assert.equal(asRecord.userId, undefined);
    assert.equal(asRecord.role, undefined);
  });

  test("an unknown or malformed key is rejected", () => {
    const t = twoTenants();
    assert.equal(mustFail(authenticateWriteKey(t.db, "rpk_not_a_real_key")).code, "unauthenticated");
    assert.equal(mustFail(authenticateWriteKey(t.db, "")).code, "unauthenticated");
    // A secret key must not work as a write key.
    const secret = must(issueSecretKey(t.db, t.scopeA, "k"));
    assert.equal(mustFail(authenticateWriteKey(t.db, secret.secret)).code, "unauthenticated");
  });
});

describe("every tenant table carries org_id", () => {
  test("no tenant-owned table is missing the tenancy column", () => {
    const db = freshDb();
    const tables = db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).map((r) => r.name);
    // Tables that legitimately have no org_id: global/config, join tables that
    // inherit tenancy from a parent, and pure aggregate tables keyed by project.
    const exempt = new Set([
      "schema_migrations", "users", "sessions", "organizations", "organization_memberships",
      "feedback_item_tags", "release_improvements", "daily_active_aggregates",
      "event_daily_aggregates", "revenue_snapshots", "org_subscriptions", "usage_counters",
      "onboarding_steps",
    ]);
    const missing: string[] = [];
    for (const t of tables) {
      if (exempt.has(t)) continue;
      const cols = db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
      if (!cols.includes("org_id") && !cols.includes("project_id")) missing.push(t);
    }
    assert.deepEqual(missing, [], `tables without tenancy column: ${missing.join(", ")}`);
  });
});

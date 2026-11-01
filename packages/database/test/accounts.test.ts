import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createUser, authenticate, createSession, sessionUser, revokeSession,
  createOrganization, createProject, addMember, listProjects, projectKeys,
  issueSecretKey, revokeKey, updateProjectSettings, slugify, normaliseEmail,
} from "../src/accounts.ts";
import { resolveOrgScope, resolveProjectScope } from "../src/scope.ts";
import { authenticateWriteKey, authenticateSecretKey } from "../src/ingest.ts";
import { freshDb, fixture, must, mustFail, PASSWORD } from "./helpers.ts";

describe("row normalisation", () => {
  test("rows come back as plain objects, so they can cross to a client component", () => {
    const f = fixture();
    const rows = f.db.all("SELECT id, name FROM projects");
    assert.equal(rows.length, 1);
    // node:sqlite returns null-prototype objects. React Server Components
    // refuse to serialise those to a client component, failing at runtime
    // rather than at compile time, so Db.all normalises them.
    assert.equal(Object.getPrototypeOf(rows[0]!), Object.prototype);
    assert.equal(Object.getPrototypeOf(f.db.get("SELECT id FROM projects")!), Object.prototype);
    // deepEqual against an object literal works as a consequence.
    assert.deepEqual(f.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM projects"), [{ n: 1 }]);
  });

  test("allFast deliberately skips normalisation for the engine hot paths", () => {
    const f = fixture();
    const rows = f.db.allFast("SELECT id FROM projects");
    // Documented escape hatch: never hand one of these to a client component.
    assert.equal(Object.getPrototypeOf(rows[0]!), null);
  });
});

describe("createUser", () => {
  test("creates a user and normalises the email", () => {
    const db = freshDb();
    const u = must(createUser(db, { email: "  Founder@Example.COM ", name: "Founder", password: PASSWORD }));
    assert.equal(u.email, "founder@example.com");
    assert.equal(normaliseEmail(" A@B.CO "), "a@b.co");
  });

  test("rejects a weak password", () => {
    const db = freshDb();
    assert.equal(mustFail(createUser(db, { email: "a@b.co", name: "A", password: "short" })).code, "validation_failed");
    assert.equal(mustFail(createUser(db, { email: "a@b.co", name: "A", password: "password12345" })).code, "validation_failed");
  });

  test("rejects an invalid email", () => {
    const db = freshDb();
    assert.equal(mustFail(createUser(db, { email: "not-an-email", name: "A", password: PASSWORD })).code, "validation_failed");
  });

  test("rejects a duplicate email", () => {
    const db = freshDb();
    must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    assert.equal(mustFail(createUser(db, { email: "A@B.co", name: "A", password: PASSWORD })).code, "conflict");
  });

  test("never stores the password in plaintext", () => {
    const db = freshDb();
    must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    const row = db.get<{ password_hash: string }>("SELECT password_hash FROM users")!;
    assert.ok(row.password_hash.startsWith("scrypt$"));
    assert.ok(!row.password_hash.includes(PASSWORD));
  });
});

describe("authenticate", () => {
  test("accepts the right password", () => {
    const db = freshDb();
    const u = must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    assert.equal(must(authenticate(db, "a@b.co", PASSWORD)).id, u.id);
  });

  test("gives the same error for a wrong password and an unknown account", () => {
    const db = freshDb();
    must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    const wrong = mustFail(authenticate(db, "a@b.co", "Wrong-Password-123"));
    const unknown = mustFail(authenticate(db, "nobody@b.co", PASSWORD));
    assert.equal(wrong.message, unknown.message);
    assert.equal(wrong.code, unknown.code);
  });

  test("locks the account after repeated failures and unlocks after the window", () => {
    const db = freshDb();
    must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) authenticate(db, "a@b.co", "Wrong-Password-123", t0);
    assert.equal(mustFail(authenticate(db, "a@b.co", PASSWORD, t0)).code, "rate_limited");
    // After the lockout window the correct password works again.
    assert.ok(authenticate(db, "a@b.co", PASSWORD, t0 + 16 * 60_000).ok);
  });

  test("a successful login clears the failure counter", () => {
    const db = freshDb();
    must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    authenticate(db, "a@b.co", "Wrong-Password-123");
    must(authenticate(db, "a@b.co", PASSWORD));
    assert.equal(db.get<{ failed_logins: number }>("SELECT failed_logins FROM users")!.failed_logins, 0);
  });
});

describe("sessions", () => {
  test("a valid token resolves to its user, and the raw token is not stored", () => {
    const db = freshDb();
    const u = must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    const token = "opaque-session-token-value";
    createSession(db, u.id, token, { expiresAt: Date.now() + 60_000 });
    assert.equal(sessionUser(db, token)?.id, u.id);
    const stored = db.get<{ token_hash: string }>("SELECT token_hash FROM sessions")!;
    assert.notEqual(stored.token_hash, token);
  });

  test("an expired token does not resolve", () => {
    const db = freshDb();
    const u = must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    createSession(db, u.id, "t", { expiresAt: Date.now() - 1 });
    assert.equal(sessionUser(db, "t"), null);
  });

  test("a revoked token does not resolve", () => {
    const db = freshDb();
    const u = must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    createSession(db, u.id, "t", { expiresAt: Date.now() + 60_000 });
    revokeSession(db, "t");
    assert.equal(sessionUser(db, "t"), null);
  });
});

describe("organizations and projects", () => {
  test("the creator becomes owner and lands on the free plan", () => {
    const db = freshDb();
    const u = must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    const org = must(createOrganization(db, { name: "Acme Software", ownerId: u.id }));
    assert.equal(org.slug, "acme-software");
    const scope = must(resolveOrgScope(db, u.id, org.orgId));
    assert.equal(scope.role, "owner");
    assert.equal(db.get<{ plan_id: string }>("SELECT plan_id FROM org_subscriptions WHERE org_id = ?", [org.orgId])!.plan_id, "free");
  });

  test("slugs are de-duplicated", () => {
    const db = freshDb();
    const u = must(createUser(db, { email: "a@b.co", name: "A", password: PASSWORD }));
    const a = must(createOrganization(db, { name: "Acme", ownerId: u.id }));
    const b = must(createOrganization(db, { name: "Acme", ownerId: u.id }));
    assert.notEqual(a.slug, b.slug);
  });

  test("slugify handles punctuation and empty input", () => {
    assert.equal(slugify("Hello, World!"), "hello-world");
    assert.equal(slugify("   "), "workspace");
    assert.equal(slugify("---x---"), "x");
  });

  test("creating a project issues a usable public write key", () => {
    const f = fixture();
    const keys = must(projectKeys(f.db, f.scope));
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.kind, "public_write");
    assert.ok(keys[0]!.public_key!.startsWith("rpk_"));
    assert.ok(authenticateWriteKey(f.db, f.publicKey).ok);
  });

  test("an invalid timezone is rejected at creation", () => {
    const f = fixture();
    assert.equal(mustFail(createProject(f.db, f.orgScope, { name: "X", timezone: "Mars/Olympus" })).code, "validation_failed");
  });

  test("a viewer cannot create a project", () => {
    const f = fixture();
    const viewer = must(createUser(f.db, { email: "v@b.co", name: "V", password: PASSWORD }));
    must(addMember(f.db, f.orgScope, { userId: viewer.id, role: "viewer" }));
    const viewerScope = must(resolveOrgScope(f.db, viewer.id, f.orgId));
    assert.equal(mustFail(createProject(f.db, viewerScope, { name: "Nope" })).code, "forbidden");
  });

  test("only an owner can grant the owner role", () => {
    const f = fixture();
    const admin = must(createUser(f.db, { email: "ad@b.co", name: "Ad", password: PASSWORD }));
    must(addMember(f.db, f.orgScope, { userId: admin.id, role: "admin" }));
    const adminScope = must(resolveOrgScope(f.db, admin.id, f.orgId));
    const other = must(createUser(f.db, { email: "o@b.co", name: "O", password: PASSWORD }));
    assert.equal(mustFail(addMember(f.db, adminScope, { userId: other.id, role: "owner" })).code, "forbidden");
    assert.ok(addMember(f.db, adminScope, { userId: other.id, role: "developer" }).ok);
  });
});

describe("API keys", () => {
  test("a secret key is returned once and stored only as a hash", () => {
    const f = fixture();
    const issued = must(issueSecretKey(f.db, f.scope, "CI key"));
    assert.ok(issued.secret.startsWith("rsk_"));
    const row = f.db.get<{ secret_hash: string; secret_preview: string }>(
      "SELECT secret_hash, secret_preview FROM project_keys WHERE kind = 'secret_admin'",
    )!;
    assert.notEqual(row.secret_hash, issued.secret);
    assert.ok(!row.secret_preview.includes(issued.secret.slice(12, 24)));
    const auth = must(authenticateSecretKey(f.db, issued.secret));
    assert.equal(auth.projectId, f.projectId);
  });

  test("listing keys never exposes a secret", () => {
    const f = fixture();
    const issued = must(issueSecretKey(f.db, f.scope, "CI key"));
    const keys = must(projectKeys(f.db, f.scope));
    for (const k of keys) {
      assert.ok(!JSON.stringify(k).includes(issued.secret));
    }
  });

  test("a revoked write key stops authenticating", () => {
    const f = fixture();
    const keys = must(projectKeys(f.db, f.scope));
    must(revokeKey(f.db, f.scope, keys[0]!.id));
    assert.equal(mustFail(authenticateWriteKey(f.db, f.publicKey)).code, "unauthenticated");
  });

  test("a revoked secret key stops authenticating", () => {
    const f = fixture();
    const issued = must(issueSecretKey(f.db, f.scope, "CI key"));
    const key = f.db.get<{ id: string }>("SELECT id FROM project_keys WHERE kind = 'secret_admin'")!;
    must(revokeKey(f.db, f.scope, key.id));
    assert.equal(mustFail(authenticateSecretKey(f.db, issued.secret)).code, "unauthenticated");
  });

  test("an analyst cannot rotate keys", () => {
    const f = fixture();
    const analyst = must(createUser(f.db, { email: "an@b.co", name: "An", password: PASSWORD }));
    must(addMember(f.db, f.orgScope, { userId: analyst.id, role: "analyst" }));
    const s = must(resolveProjectScope(f.db, analyst.id, f.projectId));
    assert.equal(mustFail(issueSecretKey(f.db, s, "nope")).code, "forbidden");
  });
});

describe("project settings", () => {
  test("settings round-trip and validate", () => {
    const f = fixture();
    must(updateProjectSettings(f.db, f.scope, {
      timezone: "Asia/Kolkata", requireConsent: false, strictSchema: true,
      allowedOrigins: ["https://app.example.com"], rawRetentionDays: 120, inactivityDays: 7,
    }));
    const row = f.db.get<any>("SELECT * FROM projects WHERE id = ?", [f.projectId])!;
    assert.equal(row.reporting_timezone, "Asia/Kolkata");
    assert.equal(row.require_consent, 0);
    assert.equal(row.strict_schema, 1);
    assert.equal(row.raw_retention_days, 120);
    assert.equal(row.inactivity_days, 7);
  });

  test("out-of-range values are rejected", () => {
    const f = fixture();
    assert.equal(mustFail(updateProjectSettings(f.db, f.scope, { rawRetentionDays: 0 })).code, "validation_failed");
    assert.equal(mustFail(updateProjectSettings(f.db, f.scope, { inactivityDays: 500 })).code, "validation_failed");
    assert.equal(mustFail(updateProjectSettings(f.db, f.scope, { timezone: "Nowhere/Nothing" })).code, "validation_failed");
  });

  test("a developer cannot change project settings", () => {
    const f = fixture();
    const dev = must(createUser(f.db, { email: "d@b.co", name: "D", password: PASSWORD }));
    must(addMember(f.db, f.orgScope, { userId: dev.id, role: "developer" }));
    const s = must(resolveProjectScope(f.db, dev.id, f.projectId));
    assert.equal(mustFail(updateProjectSettings(f.db, s, { name: "Renamed" })).code, "forbidden");
  });
});

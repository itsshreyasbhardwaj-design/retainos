import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { harness, must, mustFail, DAY, HOUR, T0 } from "./helpers.ts";
import {
  connectProvider, verifyConnection, revokeConnection, getConnection, listConnections,
  setAuthoritativeSource, authoritativeSourceFor, sourceIsAuthoritative,
  startSyncRun, finishSyncRun, listSyncRuns,
  importEvents, parseCsv, csvToEvents, eventProvenance, revertSyncRun,
  secretLookingKeysIn, PROVIDER_CAPABILITIES, CSV_EVENT_COLUMNS,
  type ImportableEvent,
} from "../src/integrations.ts";

function connected(h: ReturnType<typeof harness>, provider: "posthog" | "csv" | "sentry" = "posthog") {
  must(connectProvider(h.db, h, { provider }, T0 - DAY));
  return getConnection(h.db, h.projectId, provider)!;
}

function user(h: ReturnType<typeof harness>, external: string) {
  h.event(external, "page_viewed", T0 - 200 * DAY);
  return h.db.get<{ id: string }>(
    "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, external],
  )!.id;
}

const record = (over: Partial<ImportableEvent> = {}): ImportableEvent => ({
  externalId: "ph-1",
  name: "project_published",
  occurredAt: T0 - 10 * DAY,
  userId: "u1",
  ...over,
});

// --- connections -----------------------------------------------------------

describe("connections", () => {
  test("a new connection is disconnected, never connected", () => {
    const h = harness();
    const r = must(connectProvider(h.db, h, { provider: "posthog" }, T0));
    assert.equal(r.status, "disconnected");
    assert.match(getConnection(h.db, h.projectId, "posthog")!.statusLine,
      /never verified. Nothing is being read/);
  });

  test("credentials in the config are refused, with the env var named", () => {
    const h = harness();
    const e = mustFail(connectProvider(h.db, h, {
      provider: "posthog", config: { host: "https://eu.posthog.com", apiKey: "phc_real_secret" },
    }, T0));
    assert.match(e.message, /never stored in the database/);
    assert.match(e.message, /RETAINOS_POSTHOG_API_KEY/);
  });

  test("a config key that merely names a variable is allowed", () => {
    const h = harness();
    must(connectProvider(h.db, h, {
      provider: "posthog", config: { host: "https://eu.posthog.com", apiKeyEnvVar: "RETAINOS_POSTHOG_API_KEY" },
    }, T0));
    assert.deepEqual(secretLookingKeysIn({ projectName: "acme", tokenEnvVar: "X" }), []);
    assert.deepEqual(secretLookingKeysIn({ secret: "x" }), ["secret"]);
  });

  test("only a successful probe marks a connection connected", async () => {
    const h = harness();
    connected(h);
    const result = must(await verifyConnection(h.db, h.projectId, "posthog",
      async () => ({ ok: true, scopes: ["event:read"] }), T0));
    assert.equal(result.status, "connected");
    const connection = getConnection(h.db, h.projectId, "posthog", T0)!;
    assert.deepEqual(connection.grantedScopes, ["event:read"]);
    assert.match(connection.statusLine, /connected but has never synced/);
  });

  test("a failed probe records the error rather than the intention", async () => {
    const h = harness();
    connected(h);
    must(await verifyConnection(h.db, h.projectId, "posthog",
      async () => ({ ok: false, error: "401 unauthorised" }), T0));
    const connection = getConnection(h.db, h.projectId, "posthog", T0)!;
    assert.equal(connection.status, "error");
    assert.match(connection.statusLine, /401 unauthorised/);
  });

  test("a probe that throws is an error, not a crash", async () => {
    const h = harness();
    connected(h);
    must(await verifyConnection(h.db, h.projectId, "posthog",
      async () => { throw new Error("getaddrinfo ENOTFOUND"); }, T0));
    assert.equal(getConnection(h.db, h.projectId, "posthog")!.status, "error");
  });

  test("the status line says what is actually happening, not what was configured", async () => {
    const h = harness();
    const connection = connected(h);
    must(await verifyConnection(h.db, h.projectId, "posthog", async () => ({ ok: true }), T0 - DAY));
    const run = startSyncRun(h.db, h, connection.id, T0 - 3 * HOUR);
    finishSyncRun(h.db, run.id, { seen: 10, imported: 10, duplicate: 0, rejected: 0 }, {}, T0 - 3 * HOUR);
    assert.match(getConnection(h.db, h.projectId, "posthog", T0)!.statusLine, /last synced 3 hour\(s\) ago/);
  });

  test("revoking says nothing is being read", () => {
    const h = harness();
    connected(h);
    assert.equal(revokeConnection(h.db, h.projectId, "posthog", T0), true);
    assert.match(getConnection(h.db, h.projectId, "posthog")!.statusLine, /Nothing is being read/);
  });

  test("every provider states what RetainOS cannot do with it", () => {
    for (const [provider, cap] of Object.entries(PROVIDER_CAPABILITIES)) {
      assert.ok(cap.reads.length > 0, `${provider} reads nothing`);
      assert.ok(cap.cannot.length > 0, `${provider} has no stated limits`);
    }
    assert.ok(PROVIDER_CAPABILITIES.sentry.cannot.some((c) => /stack traces/.test(c)));
    assert.ok(PROVIDER_CAPABILITIES.github.cannot.some((c) => /Push commits/.test(c)));
    assert.ok(PROVIDER_CAPABILITIES.stripe.cannot.some((c) => /refunds/.test(c)));
  });

  test("one project's connections are invisible to another", () => {
    const a = harness();
    const b = harness();
    connected(a);
    assert.deepEqual(listConnections(b.db, b.projectId), []);
  });
});

// --- source authority ------------------------------------------------------

describe("source authority", () => {
  test("with nothing decided, every source is accepted", () => {
    const h = harness();
    const check = sourceIsAuthoritative(h.db, h.projectId, "events", "project_published", "posthog");
    assert.equal(check.accepted, true);
    assert.match(check.detail, /every source is accepted/);
  });

  test("a domain-level decision excludes other sources", () => {
    const h = harness();
    must(setAuthoritativeSource(h.db, h, { domain: "events", source: "sdk" }, T0));
    const check = sourceIsAuthoritative(h.db, h.projectId, "events", "project_published", "posthog");
    assert.equal(check.accepted, false);
    assert.match(check.detail, /counted twice/);
  });

  test("an entity-level decision beats the domain-level one", () => {
    const h = harness();
    must(setAuthoritativeSource(h.db, h, { domain: "events", source: "sdk" }, T0));
    must(setAuthoritativeSource(h.db, h,
      { domain: "events", entity: "subscription_renewed", source: "posthog" }, T0));
    assert.equal(
      sourceIsAuthoritative(h.db, h.projectId, "events", "subscription_renewed", "posthog").accepted, true);
    assert.equal(
      sourceIsAuthoritative(h.db, h.projectId, "events", "project_published", "posthog").accepted, false);
    assert.equal(
      authoritativeSourceFor(h.db, h.projectId, "events", "subscription_renewed")!.scope, "entity");
  });

  test("a source with no name is refused", () => {
    const h = harness();
    const e = mustFail(setAuthoritativeSource(h.db, h, { domain: "events", source: "  " }, T0));
    assert.match(e.message, /needs a name/);
  });
});

// --- importing -------------------------------------------------------------

describe("importing", () => {
  test("an import without a registered connection is refused", () => {
    const h = harness();
    const e = mustFail(importEvents(h.db, h, { source: "posthog", records: [record()], now: T0 }));
    assert.match(e.message, /somewhere to record its provenance/);
  });

  test("an imported event carries the system it came from", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    const result = must(importEvents(h.db, h, { source: "posthog", records: [record()], now: T0 }));
    assert.equal(result.imported, 1);
    const row = h.db.get<{ source: string; sync_run_id: string }>(
      "SELECT source, sync_run_id FROM analytics_events WHERE client_event_id = 'posthog:ph-1'")!;
    assert.equal(row.source, "posthog");
    assert.equal(row.sync_run_id, result.syncRunId);
  });

  test("the same provider record imported twice is a duplicate, not a second event", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    must(importEvents(h.db, h, { source: "posthog", records: [record()], now: T0 }));
    const again = must(importEvents(h.db, h, { source: "posthog", records: [record()], now: T0 + HOUR }));
    assert.equal(again.imported, 0);
    assert.equal(again.duplicate, 1);
    const count = h.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM analytics_events WHERE client_event_id = 'posthog:ph-1'")!.n;
    assert.equal(count, 1);
  });

  test("a record with no provider id is refused, because dedupe would be impossible", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    const result = must(importEvents(h.db, h,
      { source: "posthog", records: [record({ externalId: "" })], now: T0 }));
    assert.equal(result.rejections[0]!.reason, "missing_external_id");
    assert.match(result.rejections[0]!.detail, /retry from a second event/);
  });

  test("a non-authoritative source is refused at the door", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    must(setAuthoritativeSource(h.db, h, { domain: "events", source: "sdk" }, T0));
    const result = must(importEvents(h.db, h, { source: "posthog", records: [record()], now: T0 }));
    assert.equal(result.imported, 0);
    assert.equal(result.rejections[0]!.reason, "not_authoritative");
  });

  test("an unmatched user is never attached to a plausible-looking person", () => {
    const h = harness();
    connected(h);
    user(h, "someone-else");
    const result = must(importEvents(h.db, h,
      { source: "posthog", records: [record({ userId: "unknown-person" })], now: T0 }));
    assert.equal(result.imported, 0);
    assert.equal(result.rejections[0]!.reason, "no_identity");
    assert.match(result.rejections[0]!.detail, /plausible-looking person/);
  });

  test("an anonymous id matches when the user id does not", () => {
    const h = harness();
    connected(h);
    const identityId = user(h, "u1");
    h.db.run("UPDATE identities SET anonymous_id = 'anon-9' WHERE id = ?", [identityId]);
    const result = must(importEvents(h.db, h, {
      source: "posthog", records: [record({ userId: null, anonymousId: "anon-9" })], now: T0,
    }));
    assert.equal(result.imported, 1);
  });

  test("a historical backfill is accepted where live ingestion would refuse it", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    // Two years old: live ingestion rejects anything over 30 days.
    const result = must(importEvents(h.db, h, {
      source: "posthog", records: [record({ occurredAt: T0 - 730 * DAY })], now: T0,
    }));
    assert.equal(result.imported, 1);
  });

  test("a future timestamp is refused rather than clamped", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    const result = must(importEvents(h.db, h, {
      source: "posthog", records: [record({ occurredAt: T0 + 400 * DAY })], now: T0,
    }));
    assert.equal(result.rejections[0]!.reason, "invalid_timestamp");
    assert.match(result.rejections[0]!.detail, /never clamped/);
  });

  test("a badly named event is refused with the name quoted", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    const result = must(importEvents(h.db, h,
      { source: "posthog", records: [record({ name: "Project Published" })], now: T0 }));
    assert.equal(result.rejections[0]!.reason, "invalid_event_name");
    assert.match(result.rejections[0]!.detail, /lower_snake_case/);
  });

  test("sensitive properties are stripped on import and counted", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    const result = must(importEvents(h.db, h, {
      source: "posthog",
      records: [record({ properties: { plan: "pro", password: "hunter2" } })],
      now: T0,
    }));
    assert.equal(result.imported, 1);
    assert.ok(result.propertiesScrubbed >= 1);
    const stored = h.db.get<{ properties: string }>(
      "SELECT properties FROM analytics_events WHERE client_event_id = 'posthog:ph-1'")!;
    const props = JSON.parse(stored.properties);
    assert.equal(props.plan, "pro");
    assert.equal(props.password, undefined);
  });

  test("every rejection is stored per row so the file can be fixed", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    must(importEvents(h.db, h, {
      source: "posthog",
      records: [record(), record({ externalId: "ph-2", name: "Bad Name" }),
                record({ externalId: "ph-3", userId: "nobody" })],
      now: T0,
    }));
    const rows = h.db.all<{ row_number: number; reason: string }>(
      "SELECT row_number, reason FROM import_rejections WHERE project_id = ? ORDER BY row_number",
      [h.projectId]);
    assert.deepEqual(rows.map((r) => r.row_number), [2, 3]);
    assert.deepEqual(rows.map((r) => r.reason), ["invalid_event_name", "no_identity"]);
  });

  test("a partly failed import is recorded as partial, not as success", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    const result = must(importEvents(h.db, h, {
      source: "posthog", records: [record(), record({ externalId: "ph-2", userId: "nobody" })], now: T0,
    }));
    const [run] = listSyncRuns(h.db, getConnection(h.db, h.projectId, "posthog")!.id) as Array<Record<string, any>>;
    assert.equal(run!.status, "partial");
    assert.equal(run!.records_imported, 1);
    assert.equal(run!.records_rejected, 1);
    assert.equal(result.seen, 2);
  });

  test("a clean import updates the connection's last sync", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    must(importEvents(h.db, h, { source: "posthog", records: [record()], now: T0 }));
    assert.equal(getConnection(h.db, h.projectId, "posthog")!.lastSyncAt, T0);
  });

  test("a failed sync marks the connection as broken", () => {
    const h = harness();
    const connection = connected(h);
    const run = startSyncRun(h.db, h, connection.id, T0);
    finishSyncRun(h.db, run.id, { seen: 0, imported: 0, duplicate: 0, rejected: 0 },
      { error: "rate limited" }, T0);
    const after = getConnection(h.db, h.projectId, "posthog")!;
    assert.equal(after.status, "error");
    assert.match(after.statusLine, /rate limited/);
  });
});

// --- provenance and reverting ---------------------------------------------

describe("provenance", () => {
  test("the project can say where its events came from", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    h.event("u1", "project_published", T0 - 5 * DAY);
    must(importEvents(h.db, h, {
      source: "posthog",
      records: [record(), record({ externalId: "ph-2", occurredAt: T0 - 9 * DAY })],
      now: T0,
    }));
    const provenance = eventProvenance(h.db, h.projectId);
    const bySource = new Map(provenance.map((p) => [p.source, p.events]));
    assert.equal(bySource.get("posthog"), 2);
    assert.equal(bySource.get("sdk"), 2);
  });

  test("an import can be undone", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    const result = must(importEvents(h.db, h, {
      source: "posthog", records: [record(), record({ externalId: "ph-2" })], now: T0,
    }));
    const reverted = must(revertSyncRun(h.db, h.projectId, result.syncRunId));
    assert.equal(reverted.removed, 2);
    assert.equal(eventProvenance(h.db, h.projectId).find((p) => p.source === "posthog"), undefined);
  });

  test("reverting leaves events from other sources alone", () => {
    const h = harness();
    connected(h);
    user(h, "u1");
    h.event("u1", "project_published", T0 - 5 * DAY);
    const result = must(importEvents(h.db, h, { source: "posthog", records: [record()], now: T0 }));
    must(revertSyncRun(h.db, h.projectId, result.syncRunId));
    assert.equal(eventProvenance(h.db, h.projectId).find((p) => p.source === "sdk")!.events, 2);
  });

  test("a running sync cannot be reverted", () => {
    const h = harness();
    const connection = connected(h);
    const run = startSyncRun(h.db, h, connection.id, T0);
    const e = mustFail(revertSyncRun(h.db, h.projectId, run.id));
    assert.match(e.message, /still running/);
  });

  test("another project's sync run cannot be reverted", () => {
    const a = harness();
    const b = harness();
    const connection = connected(a);
    const run = startSyncRun(a.db, a, connection.id, T0);
    finishSyncRun(a.db, run.id, { seen: 0, imported: 0, duplicate: 0, rejected: 0 }, {}, T0);
    const e = mustFail(revertSyncRun(b.db, b.projectId, run.id));
    assert.equal(e.code, "not_found");
  });
});

// --- CSV -------------------------------------------------------------------

describe("CSV", () => {
  test("quoted fields, escaped quotes and CRLF all parse", () => {
    const { header, rows } = parseCsv(
      'a,b,c\r\n1,"two, with comma","say ""hi"""\r\n3,4,5\r\n');
    assert.deepEqual(header, ["a", "b", "c"]);
    assert.deepEqual(rows[0], ["1", "two, with comma", 'say "hi"']);
    assert.deepEqual(rows[1], ["3", "4", "5"]);
  });

  test("blank lines are ignored rather than becoming empty rows", () => {
    const { rows } = parseCsv("a,b\n1,2\n\n3,4\n\n");
    assert.equal(rows.length, 2);
  });

  test("missing columns are named instead of a vague failure", () => {
    const result = csvToEvents("external_id,event_name\nx,project_published\n");
    assert.deepEqual(result.missingColumns, ["occurred_at", "user_id"]);
    assert.equal(result.records.length, 0);
  });

  test("an ISO date and an epoch value are both accepted", () => {
    const csv = [
      CSV_EVENT_COLUMNS.join(","),
      `a,project_published,2026-03-01T10:00:00Z,u1`,
      `b,project_published,${T0 - DAY},u1`,
    ].join("\n");
    const result = csvToEvents(csv);
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0]!.occurredAt, Date.parse("2026-03-01T10:00:00Z"));
    assert.equal(result.records[1]!.occurredAt, T0 - DAY);
  });

  test("an unparseable date is reported with its spreadsheet row number", () => {
    const csv = [
      CSV_EVENT_COLUMNS.join(","),
      `a,project_published,yesterday,u1`,
    ].join("\n");
    const result = csvToEvents(csv);
    assert.equal(result.records.length, 0);
    assert.equal(result.problems[0]!.row, 2);
    assert.match(result.problems[0]!.detail, /"yesterday"/);
  });

  test("extra columns become event properties", () => {
    const csv = [
      [...CSV_EVENT_COLUMNS, "plan", "account_key"].join(","),
      `a,project_published,${T0 - DAY},u1,pro,acme`,
    ].join("\n");
    const result = csvToEvents(csv);
    assert.deepEqual(result.records[0]!.properties, { plan: "pro" });
    assert.equal(result.records[0]!.accountKey, "acme");
  });

  test("a CSV round-trips into imported events with csv as the source", () => {
    const h = harness();
    connected(h, "csv");
    user(h, "u1");
    const csv = [
      CSV_EVENT_COLUMNS.join(","),
      `row-1,project_published,${T0 - 400 * DAY},u1`,
      `row-2,project_published,${T0 - 399 * DAY},u1`,
    ].join("\n");
    const { records } = csvToEvents(csv);
    const result = must(importEvents(h.db, h, { source: "csv", records, now: T0 }));
    assert.equal(result.imported, 2);
    assert.equal(eventProvenance(h.db, h.projectId).find((p) => p.source === "csv")!.events, 2);
  });
});

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ingestBatch, authenticateWriteKey, resolveIdentity, originAllowed,
  recentRejections, ingestHealth, ingestLimiter, MAX_BATCH_EVENTS,
} from "../src/ingest.ts";
import { upsertEventSpec, undeclaredEvents } from "../src/schemas.ts";
import { updateProjectSettings } from "../src/accounts.ts";
import { fixture, unlimited, must, mustFail, type Fixture } from "./helpers.ts";

const NOW = Date.UTC(2026, 2, 14, 12, 0, 0);
const ev = (over: Record<string, unknown> = {}) => ({
  name: "core_action_completed", userId: "user-1", consent: true, ...over,
});

function f(): Fixture {
  ingestLimiter.reset();
  return unlimited(fixture());
}

describe("valid ingestion", () => {
  test("accepts a well-formed single event", () => {
    const t = f();
    const r = must(ingestBatch(t.db, t.ingest, { events: [ev()] }, NOW));
    assert.equal(r.accepted, 1);
    assert.equal(r.rejected, 0);
    assert.equal(r.outcomes[0]!.status, "accepted");
    const row = t.db.get<any>("SELECT * FROM analytics_events")!;
    assert.equal(row.name, "core_action_completed");
    assert.equal(row.occurred_at, NOW);
    assert.equal(row.project_id, t.projectId);
  });

  test("accepts a batch and judges each event independently", () => {
    const t = f();
    const r = must(ingestBatch(t.db, t.ingest, {
      events: [ev(), ev({ name: "NOT_VALID" }), ev({ name: "signup_completed" })],
    }, NOW));
    assert.equal(r.accepted, 2);
    assert.equal(r.rejected, 1);
    assert.equal(r.outcomes[1]!.reason, "invalid_event_name");
    assert.equal(r.outcomes[1]!.index, 1);
  });

  test("stores the client timestamp, not the receipt time", () => {
    const t = f();
    const clientTime = NOW - 3 * 3_600_000;
    must(ingestBatch(t.db, t.ingest, { events: [ev({ timestamp: clientTime })] }, NOW));
    const row = t.db.get<any>("SELECT occurred_at, received_at FROM analytics_events")!;
    assert.equal(row.occurred_at, clientTime);
    assert.equal(row.received_at, NOW);
  });

  test("defaults the timestamp to receipt time when absent", () => {
    const t = f();
    must(ingestBatch(t.db, t.ingest, { events: [ev({ timestamp: undefined })] }, NOW));
    assert.equal(t.db.get<any>("SELECT occurred_at FROM analytics_events")!.occurred_at, NOW);
  });

  test("promotes known segmentation dimensions to columns", () => {
    const t = f();
    must(ingestBatch(t.db, t.ingest, {
      events: [ev({ properties: { plan: "growth", product_version: "2.4.1", acquisition_source: "docs" } })],
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148",
      country: "in",
    }, NOW));
    const row = t.db.get<any>("SELECT * FROM analytics_events")!;
    assert.equal(row.plan, "growth");
    assert.equal(row.product_version, "2.4.1");
    assert.equal(row.acquisition_source, "docs");
    assert.equal(row.device_category, "mobile");
    assert.equal(row.country, "IN");
    // The raw user agent is never persisted anywhere.
    assert.ok(!JSON.stringify(row).includes("Mozilla"));
  });
});

describe("authentication and authorisation", () => {
  test("an unknown project key is rejected", () => {
    const t = f();
    assert.equal(mustFail(authenticateWriteKey(t.db, "rpk_bogus")).code, "unauthenticated");
  });

  test("origin allowlist is enforced server-side once configured", () => {
    const t = f();
    must(updateProjectSettings(t.db, t.scope, { allowedOrigins: ["https://app.example.com"] }));
    const scope = must(authenticateWriteKey(t.db, t.publicKey));
    assert.equal(mustFail(ingestBatch(t.db, scope, { events: [ev()], origin: "https://evil.example" }, NOW)).code, "forbidden");
    assert.ok(ingestBatch(t.db, scope, { events: [ev()], origin: "https://app.example.com" }, NOW).ok);
    // A missing Origin header is refused once an allowlist exists.
    assert.equal(mustFail(ingestBatch(t.db, scope, { events: [ev()], origin: null }, NOW)).code, "forbidden");
  });

  test("an empty allowlist allows any origin", () => {
    const t = f();
    assert.equal(originAllowed(t.ingest, null), true);
    assert.equal(originAllowed(t.ingest, "https://anything"), true);
  });

  test("wildcard subdomain patterns work", () => {
    const scope = { ...f().ingest, allowedOrigins: ["*.example.com"] };
    assert.equal(originAllowed(scope, "https://app.example.com"), true);
    assert.equal(originAllowed(scope, "https://example.com"), true);
    assert.equal(originAllowed(scope, "https://example.com.evil.net"), false);
  });
});

describe("rejection matrix", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["missing event name", { userId: "u", consent: true }, "missing_event_name"],
    ["non-string event name", { name: 42, userId: "u", consent: true }, "missing_event_name"],
    ["empty event name", { name: "", userId: "u", consent: true }, "missing_event_name"],
    ["uppercase event name", { name: "SignupCompleted", userId: "u", consent: true }, "invalid_event_name"],
    ["hyphenated event name", { name: "signup-completed", userId: "u", consent: true }, "invalid_event_name"],
    ["over-long event name", { name: "a".repeat(81), userId: "u", consent: true }, "invalid_event_name"],
    ["no identity at all", { name: "signup_completed", consent: true }, "no_identity"],
  ];
  for (const [label, raw, reason] of cases) {
    test(`rejects ${label}`, () => {
      const t = f();
      const r = must(ingestBatch(t.db, t.ingest, { events: [raw] }, NOW));
      assert.equal(r.rejected, 1, `expected rejection for ${label}`);
      assert.equal(r.outcomes[0]!.reason, reason);
      assert.equal(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_events")!.n, 0);
    });
  }

  test("rejects an oversized event", () => {
    const t = f();
    const r = must(ingestBatch(t.db, t.ingest, {
      events: [ev({ properties: { note: "x".repeat(20_000) } })],
    }, NOW));
    assert.equal(r.outcomes[0]!.reason, "event_too_large");
  });

  test("rejects a batch over the batch limit without processing any of it", () => {
    const t = f();
    const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => ev());
    assert.equal(mustFail(ingestBatch(t.db, t.ingest, { events }, NOW)).code, "payload_too_large");
    assert.equal(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_events")!.n, 0);
  });

  test("rejects an empty batch and a non-array payload", () => {
    const t = f();
    assert.equal(mustFail(ingestBatch(t.db, t.ingest, { events: [] }, NOW)).code, "validation_failed");
    assert.equal(mustFail(ingestBatch(t.db, t.ingest, { events: "nope" as never }, NOW)).code, "validation_failed");
  });

  test("rejects timestamps far in the future or past rather than clamping them", () => {
    const t = f();
    const future = must(ingestBatch(t.db, t.ingest, { events: [ev({ timestamp: NOW + 7 * 86_400_000 })] }, NOW));
    assert.equal(future.outcomes[0]!.reason, "timestamp_out_of_range");
    const past = must(ingestBatch(t.db, t.ingest, { events: [ev({ timestamp: NOW - 400 * 86_400_000 })] }, NOW));
    assert.equal(past.outcomes[0]!.reason, "timestamp_out_of_range");
    // A modest skew inside tolerance is accepted unchanged.
    const ok = must(ingestBatch(t.db, t.ingest, { events: [ev({ timestamp: NOW + 30 * 60_000 })] }, NOW));
    assert.equal(ok.accepted, 1);
  });

  test("records every rejection with a reason for the inspector", () => {
    const t = f();
    must(ingestBatch(t.db, t.ingest, { events: [{ name: "Bad Name", userId: "u", consent: true }] }, NOW));
    const rows = recentRejections(t.db, t.projectId);
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as any).reason, "invalid_event_name");
  });
});

describe("consent", () => {
  test("rejects events without explicit consent when the project requires it", () => {
    const t = f(); // require_consent defaults to 1
    const r = must(ingestBatch(t.db, t.ingest, { events: [ev({ consent: undefined })] }, NOW));
    assert.equal(r.outcomes[0]!.reason, "consent_not_granted");
  });

  test("treats a falsy or missing consent flag as no consent, not as consent", () => {
    const t = f();
    for (const consent of [false, 0, "", null, "true"]) {
      const r = must(ingestBatch(t.db, t.ingest, { events: [ev({ consent })] }, NOW));
      assert.equal(r.outcomes[0]!.reason, "consent_not_granted", `consent=${JSON.stringify(consent)}`);
    }
  });

  test("accepts without a consent flag when the project does not require it", () => {
    const t = f();
    must(updateProjectSettings(t.db, t.scope, { requireConsent: false }));
    const scope = must(authenticateWriteKey(t.db, t.publicKey));
    assert.equal(must(ingestBatch(t.db, scope, { events: [ev({ consent: undefined })] }, NOW)).accepted, 1);
  });
});

describe("schema validation", () => {
  test("validates against a registered schema", () => {
    const t = f();
    must(upsertEventSpec(t.db, t.scope, {
      name: "core_action_completed",
      properties: [{ name: "feature", type: "string", required: true }],
      allowUnknownProperties: false,
    }));
    const bad = must(ingestBatch(t.db, t.ingest, { events: [ev({ properties: {} })] }, NOW));
    assert.equal(bad.outcomes[0]!.reason, "schema_validation_failed");
    const good = must(ingestBatch(t.db, t.ingest, { events: [ev({ properties: { feature: "x" } })] }, NOW));
    assert.equal(good.accepted, 1);
  });

  test("strict schema mode rejects unregistered events", () => {
    const t = f();
    must(updateProjectSettings(t.db, t.scope, { strictSchema: true }));
    const scope = must(authenticateWriteKey(t.db, t.publicKey));
    const r = must(ingestBatch(t.db, scope, { events: [ev({ name: "never_registered" })] }, NOW));
    assert.equal(r.outcomes[0]!.reason, "schema_validation_failed");
  });

  test("warns on a deprecated event but still accepts it", () => {
    const t = f();
    must(upsertEventSpec(t.db, t.scope, {
      name: "core_action_completed", properties: [], deprecated: true, deprecationNote: "Use feature_used",
    }));
    const r = must(ingestBatch(t.db, t.ingest, { events: [ev()] }, NOW));
    assert.equal(r.accepted, 1);
    assert.ok(r.outcomes[0]!.warnings?.some((w) => /deprecated/.test(w)));
  });

  test("surfaces events seen in the data that have no schema", () => {
    const t = f();
    must(ingestBatch(t.db, t.ingest, { events: [ev({ name: "undeclared_thing" })] }, NOW));
    const rows = undeclaredEvents(t.db, t.projectId);
    assert.ok(rows.some((r) => r.name === "undeclared_thing"));
  });
});

describe("privacy enforcement at ingestion", () => {
  test("strips sensitive properties, keeps the event, and reports what was removed", () => {
    const t = f();
    const r = must(ingestBatch(t.db, t.ingest, {
      events: [ev({ properties: { plan: "free", password: "hunter2", api_key: "sk_live_abcdef123456" } })],
    }, NOW));
    assert.equal(r.accepted, 1);
    assert.ok(r.outcomes[0]!.warnings?.[0]?.includes("password"));
    const row = t.db.get<any>("SELECT properties FROM analytics_events")!;
    assert.ok(!row.properties.includes("hunter2"));
    assert.ok(!row.properties.includes("password"));
    assert.ok(row.properties.includes("free"));
  });

  test("a credential value under an innocent key is still removed", () => {
    const t = f();
    must(ingestBatch(t.db, t.ingest, {
      events: [ev({ properties: { note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig1234567890" } })],
    }, NOW));
    const row = t.db.get<any>("SELECT properties FROM analytics_events")!;
    assert.ok(!row.properties.includes("eyJhbGci"));
  });
});

describe("idempotency and duplicates", () => {
  test("a duplicate client event id is not stored twice", () => {
    const t = f();
    must(ingestBatch(t.db, t.ingest, { events: [ev({ eventId: "cid-1" })] }, NOW));
    const second = must(ingestBatch(t.db, t.ingest, { events: [ev({ eventId: "cid-1" })] }, NOW));
    assert.equal(second.accepted, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(second.outcomes[0]!.status, "duplicate");
    assert.equal(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_events")!.n, 1);
  });

  test("a replayed batch idempotency key returns the original result without double-counting", () => {
    const t = f();
    const first = must(ingestBatch(t.db, t.ingest, { events: [ev(), ev()], idempotencyKey: "batch-1" }, NOW));
    assert.equal(first.accepted, 2);
    assert.equal(first.replayed, false);
    const replay = must(ingestBatch(t.db, t.ingest, { events: [ev(), ev()], idempotencyKey: "batch-1" }, NOW));
    assert.equal(replay.replayed, true);
    assert.equal(replay.accepted, 2);
    assert.equal(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_events")!.n, 2);
  });

  test("events without client ids are not deduplicated against each other", () => {
    const t = f();
    // Two genuine occurrences of the same action must both count.
    const r = must(ingestBatch(t.db, t.ingest, { events: [ev(), ev()] }, NOW));
    assert.equal(r.accepted, 2);
  });
});

describe("rate limiting", () => {
  test("refuses a project that exceeds its per-minute rate", () => {
    const t = f();
    // Shrink the window by exhausting it: the shared limiter default is 600/min.
    for (let i = 0; i < 6; i++) {
      must(ingestBatch(t.db, t.ingest, { events: Array.from({ length: 100 }, () => ev()) }, NOW));
    }
    assert.equal(mustFail(ingestBatch(t.db, t.ingest, { events: [ev()] }, NOW)).code, "rate_limited");
    // The window resets.
    assert.ok(ingestBatch(t.db, t.ingest, { events: [ev()] }, NOW + 61_000).ok);
  });
});

describe("identity resolution", () => {
  test("creates one identity per anonymous id", () => {
    const t = f();
    resolveIdentity(t.db, t.ingest, { anonymousId: "anon-1" }, NOW);
    resolveIdentity(t.db, t.ingest, { anonymousId: "anon-1" }, NOW);
    assert.equal(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM identities")!.n, 1);
  });

  test("an explicit identify promotes the anonymous identity and keeps its history", () => {
    const t = f();
    must(ingestBatch(t.db, t.ingest, { events: [{ name: "signup_completed", anonymousId: "anon-1", consent: true }] }, NOW));
    must(ingestBatch(t.db, t.ingest, {
      events: [{ name: "core_action_completed", anonymousId: "anon-1", userId: "user-9", consent: true }],
    }, NOW + 1000));
    assert.equal(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM identities")!.n, 1);
    const id = t.db.get<any>("SELECT * FROM identities")!;
    assert.equal(id.anonymous_id, "anon-1");
    assert.equal(id.external_id, "user-9");
    assert.ok(id.identified_at);
    // Both events belong to the same identity, so pre-signup history survives.
    assert.equal(t.db.get<{ n: number }>("SELECT COUNT(DISTINCT identity_id) AS n FROM analytics_events")!.n, 1);
    // The transition is recorded explicitly.
    assert.equal(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM identity_links")!.n, 1);
  });

  test("an anonymous id already claimed by one user is never stolen by another", () => {
    const t = f();
    resolveIdentity(t.db, t.ingest, { anonymousId: "shared-device", externalId: "user-a" }, NOW);
    resolveIdentity(t.db, t.ingest, { anonymousId: "shared-device", externalId: "user-b" }, NOW + 1);
    const rows = t.db.all<any>("SELECT external_id, anonymous_id FROM identities ORDER BY external_id");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.external_id, "user-a");
    assert.equal(rows[0]!.anonymous_id, "shared-device");
    // user-b gets their own identity with no anonymous id, rather than taking
    // over user-a's device history.
    assert.equal(rows[1]!.external_id, "user-b");
    assert.equal(rows[1]!.anonymous_id, null);
  });

  test("two identified users are never merged", () => {
    const t = f();
    resolveIdentity(t.db, t.ingest, { externalId: "user-a" }, NOW);
    resolveIdentity(t.db, t.ingest, { externalId: "user-b" }, NOW);
    assert.equal(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM identities")!.n, 2);
  });

  test("an identify after logout and re-login reuses the same identity", () => {
    const t = f();
    const first = resolveIdentity(t.db, t.ingest, { anonymousId: "anon-1", externalId: "user-9" }, NOW);
    // New anonymous id after reset, same user id.
    const second = resolveIdentity(t.db, t.ingest, { anonymousId: "anon-2", externalId: "user-9" }, NOW + 1);
    assert.equal(first, second);
  });

  test("returns null when neither identifier is supplied", () => {
    const t = f();
    assert.equal(resolveIdentity(t.db, t.ingest, {}, NOW), null);
    assert.equal(resolveIdentity(t.db, t.ingest, { anonymousId: "  ", externalId: "" }, NOW), null);
  });
});

describe("ingest health", () => {
  test("reports acceptance rate and rejection breakdown", () => {
    const t = f();
    must(ingestBatch(t.db, t.ingest, { events: [ev(), ev({ name: "BAD" }), ev({ consent: false })] }, NOW));
    const h = ingestHealth(t.db, t.projectId, NOW - 1000);
    assert.equal(h.accepted, 1);
    assert.equal(h.rejected, 2);
    assert.equal(h.acceptanceRate, 1 / 3);
    const reasons = h.byReason.map((r) => r.reason).sort();
    assert.deepEqual(reasons, ["consent_not_granted", "invalid_event_name"]);
  });

  test("acceptance rate is null rather than 0 when nothing has been seen", () => {
    const t = f();
    assert.equal(ingestHealth(t.db, t.projectId, NOW).acceptanceRate, null);
  });
});

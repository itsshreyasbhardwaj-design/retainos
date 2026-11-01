import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RetainOS, RetainOSClient } from "../src/index.ts";
import { recordingTransport } from "../src/transport.ts";
import { memoryStorage } from "../src/storage.ts";
import { sanitiseProperties, isSensitiveKey } from "../src/privacy.ts";
import type { TransportPayload } from "../src/types.ts";

const NOW = Date.UTC(2026, 2, 14, 12);

function client(over: Record<string, unknown> = {}) {
  const { transport, sent } = recordingTransport(
    (over.responder as ((p: TransportPayload) => { status: number }) | undefined) ?? undefined,
  );
  delete over.responder;
  const c = RetainOS.init({
    projectKey: "rpk_test",
    endpoint: "https://retain.example.com/",
    transport,
    storage: memoryStorage(),
    now: () => NOW,
    requireConsent: false,
    batchSize: 10,
    ...over,
  });
  return { c, sent };
}

const allEvents = (sent: TransportPayload[]) => sent.flatMap((p) => p.events);

describe("initialisation", () => {
  test("requires a project key and an endpoint", () => {
    assert.throws(() => new RetainOSClient({ projectKey: "", endpoint: "https://x" }), /projectKey/);
    assert.throws(() => new RetainOSClient({ projectKey: "k", endpoint: "" }), /endpoint/);
  });

  test("reports its version", () => {
    const { c } = client();
    assert.equal(c.version, RetainOS.version);
    assert.match(c.version, /^\d+\.\d+\.\d+$/);
  });

  test("generates and persists an anonymous id", () => {
    const storage = memoryStorage();
    const { transport } = recordingTransport();
    const a = RetainOS.init({ projectKey: "k", endpoint: "https://x", transport, storage, requireConsent: false });
    const first = a.diagnostics().anonymousId;
    assert.ok(first);
    const b = RetainOS.init({ projectKey: "k", endpoint: "https://x", transport, storage, requireConsent: false });
    assert.equal(b.diagnostics().anonymousId, first, "the anonymous id survives a reload");
    a.shutdown();
    b.shutdown();
  });

  test("sends the SDK name and version with every batch", async () => {
    const { c, sent } = client();
    c.track("signup_completed");
    await c.flush();
    assert.equal(sent[0]!.sdk.name, "@retainos/sdk");
    assert.match(sent[0]!.sdk.version, /^\d+\.\d+\.\d+$/);
    c.shutdown();
  });
});

describe("track", () => {
  test("queues and flushes a valid event", async () => {
    const { c, sent } = client();
    c.track("signup_completed", { acquisition_source: "docs" });
    assert.equal(c.diagnostics().queued, 1);
    await c.flush();
    assert.equal(c.diagnostics().queued, 0);
    assert.equal(c.diagnostics().sent, 1);
    const ev = allEvents(sent)[0]!;
    assert.equal(ev.name, "signup_completed");
    assert.equal(ev.properties.acquisition_source, "docs");
    assert.equal(ev.timestamp, NOW);
    assert.ok(ev.eventId);
    c.shutdown();
  });

  test("refuses event names that are not lower_snake_case", async () => {
    const { c, sent } = client();
    for (const bad of ["SignupCompleted", "signup-completed", "signup completed", "", "  ", "_signup", "9lives"]) {
      c.track(bad);
    }
    await c.flush();
    assert.equal(allEvents(sent).length, 0);
    c.shutdown();
  });

  test("merges global properties, with per-event values winning", async () => {
    const { c, sent } = client({ globalProperties: { product_version: "2.4.1", plan: "free" } });
    c.track("core_action_completed", { plan: "growth" });
    await c.flush();
    const ev = allEvents(sent)[0]!;
    assert.equal(ev.properties.product_version, "2.4.1");
    assert.equal(ev.properties.plan, "growth");
    c.shutdown();
  });

  test("flushes automatically once the batch size is reached", async () => {
    const { c, sent } = client({ batchSize: 3 });
    c.track("a_happened");
    c.track("b_happened");
    assert.equal(sent.length, 0);
    c.track("c_happened");
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.events.length, 3);
    c.shutdown();
  });

  test("splits a large queue into batches no bigger than the limit", async () => {
    const { c, sent } = client({ batchSize: 10, flushIntervalMs: 999_999 });
    for (let i = 0; i < 25; i++) c.track("a_happened");
    await c.flush();
    assert.ok(sent.every((p) => p.events.length <= 10));
    assert.equal(allEvents(sent).length, 25);
    c.shutdown();
  });

  test("never throws, even on hostile input", () => {
    const { c } = client();
    assert.doesNotThrow(() => {
      c.track(undefined as never);
      c.track(null as never);
      c.track("ok_event", { weird: Symbol("x") } as never);
      c.track("ok_event", { fn: () => 1 } as never);
      c.identify(undefined as never);
    });
    c.shutdown();
  });
});

describe("consent", () => {
  test("withholds events until consent is granted", async () => {
    const { c, sent } = client({ requireConsent: true });
    c.track("signup_completed");
    await c.flush();
    assert.equal(allEvents(sent).length, 0);
    assert.equal(c.hasConsent(), false);

    c.grantConsent();
    c.track("signup_completed");
    await c.flush();
    assert.equal(allEvents(sent).length, 1);
    c.shutdown();
  });

  test("consent persists across reloads", () => {
    const storage = memoryStorage();
    const { transport } = recordingTransport();
    const a = RetainOS.init({ projectKey: "k", endpoint: "https://x", transport, storage, requireConsent: true });
    a.grantConsent();
    a.shutdown();
    const b = RetainOS.init({ projectKey: "k", endpoint: "https://x", transport, storage, requireConsent: true });
    assert.equal(b.hasConsent(), true);
    b.shutdown();
  });

  test("revoking consent discards queued events rather than sending them", async () => {
    const { c, sent } = client({ requireConsent: true, flushIntervalMs: 999_999 });
    c.grantConsent();
    c.track("signup_completed");
    assert.equal(c.diagnostics().queued, 1);
    c.revokeConsent();
    assert.equal(c.diagnostics().queued, 0);
    await c.flush();
    assert.equal(allEvents(sent).length, 0);
    c.shutdown();
  });

  test("every sent event carries an explicit consent flag", async () => {
    const { c, sent } = client();
    c.track("signup_completed");
    await c.flush();
    assert.equal(allEvents(sent)[0]!.consent, true);
    c.shutdown();
  });
});

describe("opt-out", () => {
  test("opting out stops collection and forgets local identifiers", async () => {
    const { c, sent } = client();
    c.track("a_happened");
    c.optOut();
    c.track("b_happened");
    await c.flush();
    assert.equal(allEvents(sent).length, 0);
    assert.equal(c.diagnostics().anonymousId, null);
    assert.equal(c.isOptedOut(), true);
    c.shutdown();
  });

  test("opt-out survives a reload", () => {
    const storage = memoryStorage();
    const { transport } = recordingTransport();
    const a = RetainOS.init({ projectKey: "k", endpoint: "https://x", transport, storage, requireConsent: false });
    a.optOut();
    a.shutdown();
    const b = RetainOS.init({ projectKey: "k", endpoint: "https://x", transport, storage, requireConsent: false });
    assert.equal(b.isOptedOut(), true);
    assert.equal(b.diagnostics().anonymousId, null);
    b.shutdown();
  });

  test("opting back in issues a fresh anonymous id", () => {
    const { c } = client();
    const before = c.diagnostics().anonymousId;
    c.optOut();
    c.optIn();
    const after = c.diagnostics().anonymousId;
    assert.ok(after);
    assert.notEqual(after, before);
    c.shutdown();
  });
});

describe("identify and reset", () => {
  test("identify attaches the user id to later events", async () => {
    const { c, sent } = client();
    c.track("before_identify");
    c.identify("USER_123");
    c.track("after_identify");
    await c.flush();
    const events = allEvents(sent);
    assert.equal(events.find((e) => e.name === "before_identify")!.userId, null);
    assert.equal(events.find((e) => e.name === "after_identify")!.userId, "USER_123");
    // The anonymous id is still sent, so the server can link the two.
    assert.ok(events.find((e) => e.name === "after_identify")!.anonymousId);
    c.shutdown();
  });

  test("identify refuses an email address", async () => {
    const { c, sent } = client();
    c.identify("person@example.com");
    c.track("a_happened");
    await c.flush();
    assert.equal(allEvents(sent)[0]!.userId, null);
    assert.match(c.diagnostics().lastError ?? "", /email address/);
    c.shutdown();
  });

  test("identify rejects an empty or over-long id", () => {
    const { c } = client();
    c.identify("   ");
    assert.equal(c.diagnostics().userId, null);
    c.identify("x".repeat(201));
    assert.equal(c.diagnostics().userId, null);
    c.shutdown();
  });

  test("traits passed to identify go through normal validation", async () => {
    const { c, sent } = client();
    c.identify("USER_123", { plan: "growth", password: "hunter2" });
    await c.flush();
    const traitEvent = allEvents(sent).find((e) => e.name === "user_identified")!;
    assert.equal(traitEvent.properties.plan, "growth");
    assert.equal(traitEvent.properties.password, undefined);
    c.shutdown();
  });

  test("reset clears the user and rotates the anonymous id", async () => {
    const { c, sent } = client();
    c.identify("USER_123");
    const anonBefore = c.diagnostics().anonymousId;
    c.reset();
    assert.equal(c.diagnostics().userId, null);
    assert.notEqual(c.diagnostics().anonymousId, anonBefore);
    c.track("after_logout");
    await c.flush();
    const ev = allEvents(sent).find((e) => e.name === "after_logout")!;
    assert.equal(ev.userId, null);
    assert.notEqual(ev.anonymousId, anonBefore);
    c.shutdown();
  });

  test("identity persists across reloads", () => {
    const storage = memoryStorage();
    const { transport } = recordingTransport();
    const a = RetainOS.init({ projectKey: "k", endpoint: "https://x", transport, storage, requireConsent: false });
    a.identify("USER_9");
    a.shutdown();
    const b = RetainOS.init({ projectKey: "k", endpoint: "https://x", transport, storage, requireConsent: false });
    assert.equal(b.diagnostics().userId, "USER_9");
    b.shutdown();
  });
});

describe("privacy", () => {
  test("never sends properties with sensitive names", async () => {
    const { c, sent } = client();
    c.track("a_happened", {
      plan: "free", password: "hunter2", api_key: "x", session_id: "s",
      credit_card: "4111111111111111", ssn: "123-45-6789", latitude: 12.97,
    } as never);
    await c.flush();
    const props = allEvents(sent)[0]!.properties;
    assert.deepEqual(Object.keys(props), ["plan"]);
    const wire = JSON.stringify(sent);
    assert.ok(!wire.includes("hunter2"));
    assert.ok(!wire.includes("4111111111111111"));
    c.shutdown();
  });

  test("never sends credential-shaped values under innocent names", async () => {
    const { c, sent } = client();
    c.track("a_happened", { note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig1234567890" });
    await c.flush();
    assert.equal(allEvents(sent)[0]!.properties.note, undefined);
    c.shutdown();
  });

  test("drops non-scalar values instead of flattening them", async () => {
    const { c, sent } = client();
    c.track("a_happened", { user: { email: "a@b.co", name: "A" }, tags: ["x"] } as never);
    await c.flush();
    assert.deepEqual(allEvents(sent)[0]!.properties, {});
    assert.ok(!JSON.stringify(sent).includes("a@b.co"));
    c.shutdown();
  });

  test("honours a project property allowlist", async () => {
    const { c, sent } = client({ allowedProperties: ["plan", "feature"] });
    c.track("a_happened", { plan: "free", feature: "x", internal_note: "secret-ish" });
    await c.flush();
    assert.deepEqual(Object.keys(allEvents(sent)[0]!.properties).sort(), ["feature", "plan"]);
    c.shutdown();
  });

  test("page() sends the path but not the query string or fragment", async () => {
    const { c, sent } = client();
    c.page("/projects/new");
    await c.flush();
    const ev = allEvents(sent)[0]!;
    assert.equal(ev.name, "page_viewed");
    assert.equal(ev.properties.path, "/projects/new");
    c.shutdown();
  });

  test("truncates over-long strings rather than dropping them", () => {
    const { properties } = sanitiseProperties({ label: "x".repeat(5000) });
    assert.equal((properties.label as string).length, 1024);
  });

  test("rejects non-finite numbers", () => {
    const { properties, dropped } = sanitiseProperties({ a: NaN, b: Infinity, c: 1 });
    assert.deepEqual(properties, { c: 1 });
    assert.deepEqual(dropped.sort(), ["a", "b"]);
  });

  test("caps the property count", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) input[`p_${i}`] = i;
    const { properties, dropped } = sanitiseProperties(input);
    assert.equal(Object.keys(properties).length, 64);
    assert.equal(dropped.length, 36);
  });

  test("the sensitive-key list covers the categories the SDK promises to refuse", () => {
    for (const k of ["password", "apiKey", "session_id", "cvv", "aadhaar", "seed_phrase", "diagnosis", "longitude", "keystrokes"]) {
      assert.ok(isSensitiveKey(k), `${k} should be refused`);
    }
  });
});

describe("delivery and retries", () => {
  test("retries a server error and keeps events queued until success", async () => {
    let calls = 0;
    const { c, sent } = client({
      maxRetries: 2,
      responder: () => {
        calls++;
        return { status: calls < 3 ? 500 : 202 };
      },
    });
    c.track("a_happened");
    await c.flush();
    assert.equal(calls, 3);
    assert.equal(c.diagnostics().queued, 0);
    assert.equal(c.diagnostics().sent, 1);
    assert.equal(sent.length, 3, "the same batch is retried, not a different one");
    c.shutdown();
  });

  test("retries use the same idempotency key so the server can deduplicate", async () => {
    let calls = 0;
    const { c, sent } = client({ maxRetries: 2, responder: () => ({ status: ++calls < 2 ? 503 : 202 }) });
    c.track("a_happened");
    await c.flush();
    assert.equal(sent[0]!.idempotencyKey, sent[1]!.idempotencyKey);
    c.shutdown();
  });

  test("gives up after maxRetries and keeps the events for later", async () => {
    const { c } = client({ maxRetries: 1, responder: () => ({ status: 500 }), flushIntervalMs: 999_999 });
    c.track("a_happened");
    await c.flush();
    assert.equal(c.diagnostics().queued, 1);
    assert.ok((c.diagnostics().failed ?? 0) > 0);
    c.shutdown();
  });

  test("does not retry a 400: the payload will never be accepted", async () => {
    let calls = 0;
    const { c } = client({ responder: () => { calls++; return { status: 400 }; } });
    c.track("a_happened");
    await c.flush();
    assert.equal(calls, 1);
    assert.equal(c.diagnostics().queued, 0);
    assert.equal(c.diagnostics().dropped, 1);
    c.shutdown();
  });

  test("retries a 429 rather than discarding the batch", async () => {
    let calls = 0;
    const { c } = client({ maxRetries: 1, responder: () => { calls++; return { status: 429 }; } });
    c.track("a_happened");
    await c.flush();
    assert.equal(calls, 2);
    assert.equal(c.diagnostics().queued, 1);
    c.shutdown();
  });

  test("a transport that cannot reach the server leaves events queued", async () => {
    const { c } = client({ maxRetries: 0, responder: () => ({ status: 0 }), flushIntervalMs: 999_999 });
    c.track("a_happened");
    await c.flush();
    assert.equal(c.diagnostics().queued, 1);
    c.shutdown();
  });

  test("flush is a no-op when the queue is empty", async () => {
    const { c, sent } = client();
    await c.flush();
    assert.equal(sent.length, 0);
    c.shutdown();
  });
});

describe("queue limits", () => {
  test("drops the oldest events once the queue is full", async () => {
    const { c, sent } = client({
      maxQueueSize: 5, batchSize: 100, flushIntervalMs: 999_999,
      responder: () => ({ status: 202 }),
    });
    for (let i = 0; i < 8; i++) c.track(`event_${i}`);
    assert.equal(c.diagnostics().queued, 5);
    assert.equal(c.diagnostics().dropped, 3);
    await c.flush();
    const names = allEvents(sent).map((e) => e.name);
    assert.deepEqual(names, ["event_3", "event_4", "event_5", "event_6", "event_7"]);
    c.shutdown();
  });
});

describe("diagnostics", () => {
  test("reports a truthful picture of what happened", async () => {
    const { c } = client({ responder: () => ({ status: 202 }) });
    c.track("a_happened");
    c.track("BAD-NAME");
    await c.flush();
    const d = c.diagnostics();
    assert.equal(d.sent, 1);
    assert.equal(d.queued, 0);
    assert.match(d.lastError ?? "", /BAD-NAME/);
    c.shutdown();
  });
});

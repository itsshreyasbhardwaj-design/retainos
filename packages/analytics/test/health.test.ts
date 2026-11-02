import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { harness, must, mustFail, DAY, T0 } from "./helpers.ts";
import { newId } from "@retainos/shared";
import {
  assessHealth, accountHealthRoster, upsertHealthDefinition, listHealthDefinitions,
  weightsFromDefinition, recordHealthObservation, healthHistory,
  DEFAULT_SIGNAL_WEIGHTS, MINIMUM_SIGNALS_WITH_DATA, HEALTH_STATE_MEANING,
  type SignalId, type HealthAssessment,
} from "../src/health.ts";

const CORE = ["project_created", "report_exported", "member_invited", "integration_connected"];

function config(over: Record<string, unknown> = {}) {
  return {
    now: T0, windowDays: 28, activationEvent: "project_published", coreEvents: CORE, ...over,
  };
}

function identityOf(h: ReturnType<typeof harness>, external: string): string {
  return h.db.get<{ id: string }>(
    "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, external],
  )!.id;
}

function subscribe(h: ReturnType<typeof harness>, identityId: string, status: string, amountMinor = 900000) {
  h.db.run(
    `INSERT INTO customer_subscriptions
      (id, org_id, project_id, provider, external_id, identity_id, plan_name, status,
       amount_minor, currency, interval, started_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, 'Pro', ?, ?, 'INR', 'month', ?, ?)`,
    [newId("sub"), h.orgId, h.projectId, newId("ext"), identityId, status, amountMinor,
     T0 - 200 * DAY, T0 - DAY],
  );
}

function error(h: ReturnType<typeof harness>, identityId: string, at: number, fingerprint = "fp-1") {
  h.db.run(
    `INSERT INTO error_events
      (id, org_id, project_id, fingerprint, title, level, occurred_at, received_at, identity_id, source)
     VALUES (?, ?, ?, ?, 'Import failed', 'error', ?, ?, ?, 'sdk')`,
    [newId("err"), h.orgId, h.projectId, fingerprint, at, at, identityId],
  );
}

function feedback(h: ReturnType<typeof harness>, identityId: string, kind: string, status = "new") {
  h.db.run(
    `INSERT INTO feedback_items
      (id, org_id, project_id, source, kind, status, title, body, identity_id, created_at, updated_at)
     VALUES (?, ?, ?, 'widget', ?, ?, 'Something', 'Body text', ?, ?, ?)`,
    [newId("fbk"), h.orgId, h.projectId, kind, status, identityId, T0 - 5 * DAY, T0 - 5 * DAY],
  );
}

/** A customer who is clearly fine: active, broad, activated, paying. */
function healthyCustomer(h: ReturnType<typeof harness>, external = "good") {
  for (let d = 1; d <= 25; d++) {
    h.event(external, "page_viewed", T0 - d * DAY);
    h.event(external, "page_viewed", T0 - (d + 28) * DAY);
  }
  for (const name of CORE) h.event(external, name, T0 - 3 * DAY);
  h.event(external, "project_published", T0 - 120 * DAY);
  const id = identityOf(h, external);
  subscribe(h, id, "active");
  return id;
}

function signal(a: HealthAssessment, id: SignalId) {
  return a.signals.find((s) => s.signal === id)!;
}

// --- states ----------------------------------------------------------------

describe("state", () => {
  test("an active, activated, paying customer reads as strong engagement", () => {
    const h = harness();
    const id = healthyCustomer(h);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    assert.equal(a.state, "strong_engagement");
  });

  test("a silent customer with a failed payment suggests attention", () => {
    const h = harness();
    h.event("quiet", "page_viewed", T0 - 200 * DAY);
    const id = identityOf(h, "quiet");
    subscribe(h, id, "past_due");
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    assert.equal(a.state, "attention_suggested");
    assert.ok(a.reasoning.some((r) => /expired card rather than a decision/.test(r)));
  });

  test("a brand-new customer with almost no data is told so, not scored", () => {
    const h = harness();
    h.event("new", "page_viewed", T0 - 2 * DAY);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id: identityOf(h, "new") },
      config({ activationEvent: undefined, coreEvents: undefined }));
    assert.equal(a.state, "insufficient_information");
    assert.ok(a.reasoning[0]!.includes(`minimum of ${MINIMUM_SIGNALS_WITH_DATA}`));
  });

  test("a subject with no known users is assessed as insufficient information", () => {
    const h = harness();
    const a = assessHealth(h.db, h.projectId, { kind: "account", id: "acme" }, config());
    assert.equal(a.state, "insufficient_information");
    assert.equal(a.subjects, 0);
  });

  test("some good and some bad signals is mixed, not a warning", () => {
    const h = harness();
    const id = healthyCustomer(h);
    for (let i = 0; i < 6; i++) error(h, id, T0 - 2 * DAY);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    assert.equal(a.state, "mixed_signals");
    assert.match(HEALTH_STATE_MEANING.mixed_signals, /is not a warning/);
  });

  test("the state is never reported as a churn probability", () => {
    const h = harness();
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id: healthyCustomer(h) }, config());
    assert.match(a.disclaimer, /not a churn probability/);
  });
});

// --- individual signals ----------------------------------------------------

describe("signals", () => {
  test("no activity at all is concerning", () => {
    const h = harness();
    h.event("gone", "page_viewed", T0 - 200 * DAY);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id: identityOf(h, "gone") }, config());
    assert.equal(signal(a, "recent_activity").direction, "concerning");
  });

  test("a trend needs a usable earlier period", () => {
    const h = harness();
    const id = healthyCustomer(h, "u");
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    assert.equal(signal(a, "activity_trend").hasEnoughData, true);

    const h2 = harness();
    for (let d = 1; d <= 5; d++) h2.event("thin", "page_viewed", T0 - d * DAY);
    const b = assessHealth(h2.db, h2.projectId, { kind: "identity", id: identityOf(h2, "thin") }, config());
    const trend = signal(b, "activity_trend");
    assert.equal(trend.hasEnoughData, false);
    assert.equal(trend.direction, "unknown");
    assert.match(trend.detail, /at least 10 events/);
  });

  test("a halved activity level is concerning", () => {
    const h = harness();
    for (let i = 0; i < 40; i++) h.event("u", "page_viewed", T0 - 40 * DAY + i * 1000);
    for (let i = 0; i < 5; i++) h.event("u", "page_viewed", T0 - 5 * DAY + i * 1000);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id: identityOf(h, "u") }, config());
    assert.equal(signal(a, "activity_trend").direction, "concerning");
  });

  test("breadth cannot be assessed without configured core events", () => {
    const h = harness();
    const id = healthyCustomer(h);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config({ coreEvents: undefined }));
    const breadth = signal(a, "breadth_of_use");
    assert.equal(breadth.hasEnoughData, false);
    assert.match(breadth.whatWouldChangeIt, /really using the product/);
  });

  test("core events fall back to the project's tracked features", () => {
    const h = harness();
    const id = healthyCustomer(h);
    for (const [key, label, event] of [
      ["sharing", "Note sharing", "report_exported"],
      ["invites", "Invites", "member_invited"],
    ] as const) {
      h.db.run(
        `INSERT INTO tracked_features (id, org_id, project_id, key, label, event_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId("ftr"), h.orgId, h.projectId, key, label, event, T0 - 200 * DAY],
      );
    }
    // No coreEvents passed: the declared tracked features are used instead of
    // leaving half the product unconfigured.
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id },
      config({ coreEvents: undefined }));
    const breadth = signal(a, "breadth_of_use");
    assert.equal(breadth.hasEnoughData, true);
    assert.match(breadth.observed, /of 2 core feature/);
  });

  test("a customer who never activated is flagged", () => {
    const h = harness();
    for (let d = 1; d <= 25; d++) h.event("u", "page_viewed", T0 - d * DAY);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id: identityOf(h, "u") }, config());
    assert.equal(signal(a, "activation_reached").direction, "concerning");
  });

  test("activation cannot be assessed without a definition", () => {
    const h = harness();
    const id = healthyCustomer(h);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config({ activationEvent: undefined }));
    assert.equal(signal(a, "activation_reached").hasEnoughData, false);
  });

  test("an absence of errors proves nothing when nothing ever sends errors", () => {
    const h = harness();
    const id = healthyCustomer(h);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    const errors = signal(a, "error_exposure");
    assert.equal(errors.hasEnoughData, false);
    assert.match(errors.detail, /proves nothing/);
  });

  test("once errors are being reported, a clean record is a positive signal", () => {
    const h = harness();
    const id = healthyCustomer(h);
    const other = healthyCustomer(h, "someone-else");
    error(h, other, T0 - 2 * DAY);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    const errors = signal(a, "error_exposure");
    assert.equal(errors.hasEnoughData, true);
    assert.equal(errors.direction, "supporting");
  });

  test("silence from a customer is not treated as a signal either way", () => {
    const h = harness();
    const id = healthyCustomer(h);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    const fb = signal(a, "unresolved_feedback");
    assert.equal(fb.hasEnoughData, false);
    assert.match(fb.detail, /most people never report anything/);
  });

  test("two open bug reports from one customer is concerning", () => {
    const h = harness();
    const id = healthyCustomer(h);
    feedback(h, id, "bug");
    feedback(h, id, "bug");
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    assert.equal(signal(a, "unresolved_feedback").direction, "concerning");
  });

  test("closed feedback does not count against a customer", () => {
    const h = harness();
    const id = healthyCustomer(h);
    feedback(h, id, "bug", "released");
    feedback(h, id, "bug", "closed");
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    assert.equal(signal(a, "unresolved_feedback").hasEnoughData, false);
  });

  test("an unlinked subscription is reported as unknowable, not healthy", () => {
    const h = harness();
    for (let d = 1; d <= 25; d++) h.event("u", "page_viewed", T0 - d * DAY);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id: identityOf(h, "u") }, config());
    const billing = signal(a, "billing_status");
    assert.equal(billing.hasEnoughData, false);
    assert.match(billing.whatWouldChangeIt, /billing metadata/);
  });

  test("annual subscriptions are reported as monthly revenue", () => {
    const h = harness();
    const id = healthyCustomer(h);
    h.db.run("UPDATE customer_subscriptions SET interval = 'year', amount_minor = 12000000 WHERE identity_id = ?", [id]);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    assert.equal(signal(a, "billing_status").value, 1_000_000);
  });

  test("every signal says what would change it", () => {
    const h = harness();
    const id = healthyCustomer(h);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    for (const s of a.signals) {
      assert.ok(s.whatWouldChangeIt.length > 10, `${s.signal} has no actionable explanation`);
      assert.ok(s.detail.length > 10, `${s.signal} has no detail`);
    }
  });

  test("signals that could not be assessed are named in the reasoning", () => {
    const h = harness();
    const id = healthyCustomer(h);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    assert.ok(a.reasoning.some((r) => /could not be assessed/.test(r)));
  });
});

// --- accounts --------------------------------------------------------------

describe("accounts", () => {
  function account(h: ReturnType<typeof harness>, key: string, seats: string[], activeSeats: number) {
    h.db.run(
      `INSERT INTO accounts (id, org_id, project_id, account_key, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("acc"), h.orgId, h.projectId, key, T0 - 300 * DAY, T0 - DAY],
    );
    seats.forEach((seat, i) => {
      // Everyone has history; only the first `activeSeats` are active lately.
      for (let d = 30; d <= 50; d++) h.event(seat, "page_viewed", T0 - d * DAY, { accountKey: key });
      if (i < activeSeats) {
        for (let d = 1; d <= 20; d++) h.event(seat, "page_viewed", T0 - d * DAY, { accountKey: key });
        for (const name of CORE) h.event(seat, name, T0 - 3 * DAY, { accountKey: key });
        h.event(seat, "project_published", T0 - 100 * DAY, { accountKey: key });
      }
    });
  }

  test("an account's health covers every seat on it", () => {
    const h = harness();
    account(h, "acme", ["a1", "a2", "a3", "a4"], 4);
    const a = assessHealth(h.db, h.projectId, { kind: "account", id: "acme" }, config());
    assert.equal(a.subjects, 4);
    assert.equal(a.subjectKind, "account");
  });

  test("a multi-seat account used by one person is concerning", () => {
    const h = harness();
    account(h, "acme", ["a1", "a2", "a3", "a4"], 1);
    const a = assessHealth(h.db, h.projectId, { kind: "account", id: "acme" }, config());
    const seats = signal(a, "seat_engagement");
    assert.equal(seats.direction, "concerning");
    assert.match(seats.detail, /easy to cancel/);
  });

  test("seat engagement means nothing for a single-seat account", () => {
    const h = harness();
    account(h, "solo", ["s1"], 1);
    const a = assessHealth(h.db, h.projectId, { kind: "account", id: "solo" }, config());
    assert.equal(signal(a, "seat_engagement").hasEnoughData, false);
  });

  test("seat engagement is never claimed for an individual", () => {
    const h = harness();
    const id = healthyCustomer(h);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    const seats = signal(a, "seat_engagement");
    assert.equal(seats.hasEnoughData, false);
    assert.match(seats.detail, /B2B account/);
  });

  test("the roster puts accounts worth a conversation first", () => {
    const h = harness();
    account(h, "fine", ["f1", "f2", "f3"], 3);
    account(h, "worrying", ["w1", "w2", "w3", "w4"], 1);
    subscribe(h, identityOf(h, "f1"), "active", 500000);
    subscribe(h, identityOf(h, "w1"), "active", 900000);
    const roster = accountHealthRoster(h.db, h.projectId, config());
    // The account with a concern comes first even though the concern is not
    // severe enough on its own to override everything that looks fine.
    assert.equal(roster[0]!.subjectId, "worrying");
    assert.equal(roster[0]!.state, "mixed_signals");
    // Three of four seats going quiet shows up as both a seat problem and a
    // falling trend; the heaviest-weighted concern is surfaced first.
    assert.equal(roster[0]!.topConcern, "Activity trend");
    const concerns = assessHealth(h.db, h.projectId, { kind: "account", id: "worrying" }, config())
      .drivers.filter((d) => d.direction === "concerning").map((d) => d.label);
    assert.ok(concerns.includes("Seat engagement"));
    assert.equal(roster[1]!.subjectId, "fine");
    assert.equal(roster[1]!.state, "strong_engagement");
    assert.equal(roster[1]!.topConcern, null);
  });

  test("within the same state, the roster orders by revenue", () => {
    const h = harness();
    account(h, "small", ["s1", "s2", "s3", "s4"], 1);
    account(h, "large", ["l1", "l2", "l3", "l4"], 1);
    subscribe(h, identityOf(h, "s1"), "active", 200000);
    subscribe(h, identityOf(h, "l1"), "active", 2_000_000);
    const roster = accountHealthRoster(h.db, h.projectId, config());
    assert.equal(roster[0]!.subjectId, "large");
    assert.equal(roster[0]!.currency, "INR");
  });

  test("one project's accounts never appear in another's roster", () => {
    const a = harness();
    const b = harness();
    account(a, "acme", ["a1", "a2"], 2);
    assert.deepEqual(accountHealthRoster(b.db, b.projectId, config()), []);
  });
});

// --- definitions and history ----------------------------------------------

describe("definitions", () => {
  test("a definition stores its signal weights", () => {
    const h = harness();
    const def = must(upsertHealthDefinition(h.db, h, {
      name: "Enterprise", isPrimary: true,
      signals: [{ signal: "seat_engagement", weight: 3 }, { signal: "billing_status", weight: 2 }],
    }, T0));
    const [stored] = listHealthDefinitions(h.db, h.projectId);
    assert.equal(stored!.id, def.id);
    assert.equal(stored!.isPrimary, true);
    assert.deepEqual(weightsFromDefinition(stored!), { seat_engagement: 3, billing_status: 2 });
  });

  test("an unknown signal is refused", () => {
    const h = harness();
    const e = mustFail(upsertHealthDefinition(h.db, h, {
      name: "Bad", signals: [{ signal: "vibes" as never, weight: 1 }],
    }, T0));
    assert.match(e.message, /Unknown health signal/);
  });

  test("an absurd weight is refused", () => {
    const h = harness();
    const e = mustFail(upsertHealthDefinition(h.db, h, {
      name: "Bad", signals: [{ signal: "billing_status", weight: 99 }],
    }, T0));
    assert.match(e.message, /between 0 and 5/);
  });

  test("only one definition is primary", () => {
    const h = harness();
    must(upsertHealthDefinition(h.db, h, { name: "A", isPrimary: true, signals: [] }, T0));
    must(upsertHealthDefinition(h.db, h, { name: "B", isPrimary: true, signals: [] }, T0));
    const primary = listHealthDefinitions(h.db, h.projectId).filter((d) => d.isPrimary);
    assert.equal(primary.length, 1);
    assert.equal(primary[0]!.name, "B");
  });

  test("weights change the conclusion without changing any observation", () => {
    const h = harness();
    account(h, "acme", ["a1", "a2", "a3", "a4"], 1);
    const base = assessHealth(h.db, h.projectId, { kind: "account", id: "acme" }, config());
    assert.equal(base.state, "mixed_signals");

    // A business that sells per seat can say seat spread is what matters. The
    // observation is identical; only its weight changed, and the state follows.
    const reweighted = assessHealth(h.db, h.projectId, { kind: "account", id: "acme" }, config({
      weights: {
        seat_engagement: 5, recent_activity: 0.1, activity_trend: 0.1,
        breadth_of_use: 0.1, activation_reached: 0.1, billing_status: 0.1,
      },
    }));
    assert.equal(reweighted.state, "attention_suggested");
    assert.equal(
      signal(base, "seat_engagement").observed,
      signal(reweighted, "seat_engagement").observed,
    );
    assert.equal(
      signal(base, "seat_engagement").direction,
      signal(reweighted, "seat_engagement").direction,
    );
  });

  function account(h: ReturnType<typeof harness>, key: string, seats: string[], activeSeats: number) {
    h.db.run(
      `INSERT INTO accounts (id, org_id, project_id, account_key, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("acc"), h.orgId, h.projectId, key, T0 - 300 * DAY, T0 - DAY],
    );
    seats.forEach((seat, i) => {
      for (let d = 30; d <= 50; d++) h.event(seat, "page_viewed", T0 - d * DAY, { accountKey: key });
      if (i < activeSeats) {
        for (let d = 1; d <= 20; d++) h.event(seat, "page_viewed", T0 - d * DAY, { accountKey: key });
        for (const name of CORE) h.event(seat, name, T0 - 3 * DAY, { accountKey: key });
        h.event(seat, "project_published", T0 - 100 * DAY, { accountKey: key });
      }
    });
  }
});

describe("history", () => {
  test("observations are stored and read back newest first", () => {
    const h = harness();
    const def = must(upsertHealthDefinition(h.db, h, { name: "Default", isPrimary: true, signals: [] }, T0));
    const id = healthyCustomer(h);
    const first = assessHealth(h.db, h.projectId, { kind: "identity", id }, config({ now: T0 - 7 * DAY }));
    const second = assessHealth(h.db, h.projectId, { kind: "identity", id }, config({ now: T0 }));
    recordHealthObservation(h.db, h, def.id, first);
    recordHealthObservation(h.db, h, def.id, second);
    const history = healthHistory(h.db, h.projectId, { kind: "identity", id });
    assert.equal(history.length, 2);
    assert.equal(history[0]!.observedAt, T0);
  });

  test("recording the same observation twice does not duplicate it", () => {
    const h = harness();
    const def = must(upsertHealthDefinition(h.db, h, { name: "Default", signals: [] }, T0));
    const id = healthyCustomer(h);
    const a = assessHealth(h.db, h.projectId, { kind: "identity", id }, config());
    assert.equal(recordHealthObservation(h.db, h, def.id, a).created, true);
    assert.equal(recordHealthObservation(h.db, h, def.id, a).created, false);
    assert.equal(healthHistory(h.db, h.projectId, { kind: "identity", id }).length, 1);
  });

  test("the stored detail records what each signal contributed", () => {
    const h = harness();
    const def = must(upsertHealthDefinition(h.db, h, { name: "Default", signals: [] }, T0));
    const id = healthyCustomer(h);
    recordHealthObservation(h.db, h, def.id, assessHealth(h.db, h.projectId, { kind: "identity", id }, config()));
    const row = h.db.get<{ signal_detail: string }>(
      "SELECT signal_detail FROM health_observations WHERE project_id = ?", [h.projectId])!;
    const parsed = JSON.parse(row.signal_detail);
    assert.equal(parsed.length, Object.keys(DEFAULT_SIGNAL_WEIGHTS).length);
    for (const entry of parsed) {
      assert.ok(entry.signal && entry.observed && entry.contributed && entry.detail);
    }
  });
});

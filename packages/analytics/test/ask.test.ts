import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ask, parseQuestion, EXAMPLE_QUESTIONS } from "../src/ask.ts";
import { upsertActivationDefinition } from "../src/activation.ts";
import { harness, must, DAY, HOUR, T0 } from "./helpers.ts";

const NOW = T0 + 60 * DAY;

describe("parseQuestion", () => {
  test("recognises each supported intent", () => {
    const cases: Array<[string, string]> = [
      ["Where do users drop off during onboarding?", "activation_dropoff"],
      ["What is our activation rate this month?", "activation_rate"],
      ["What is our day-7 retention?", "retention"],
      ["How many active users do we have?", "active_users"],
      ["What are users reporting most often?", "feedback_summary"],
      ["Which features have low adoption?", "feature_adoption"],
      ["How many paid users cancelled this month?", "revenue_churn"],
      ["What is our MRR?", "revenue_mrr"],
      ["What changed after our last release?", "release_impact"],
      ["What should we investigate first?", "priority_findings"],
    ];
    for (const [question, expected] of cases) {
      assert.equal(parseQuestion(question).intent, expected, question);
    }
  });

  test("returns unknown for an unrelated question rather than guessing", () => {
    assert.equal(parseQuestion("What is the capital of France?").intent, "unknown");
    assert.equal(parseQuestion("").intent, "unknown");
  });

  test("extracts an explicit period", () => {
    assert.equal(parseQuestion("activation over the last 14 days").periodDays, 14);
    assert.equal(parseQuestion("activation over the last 3 weeks").periodDays, 21);
    assert.equal(parseQuestion("activation over the last 2 months").periodDays, 60);
    assert.equal(parseQuestion("activation this week").periodDays, 7);
    assert.equal(parseQuestion("activation this month").periodDays, 30);
  });

  test("clamps an absurd period", () => {
    assert.equal(parseQuestion("activation over the last 900 days").periodDays, 365);
  });

  test("reports what it matched on, so the UI can explain itself", () => {
    const p = parseQuestion("Where is the biggest drop-off in the last 14 days?");
    assert.ok(p.matchedOn.length >= 1);
    assert.ok(p.matchedOn.some((m) => /drop-off/i.test(m)));
  });

  test("every example question parses to a known intent", () => {
    for (const q of EXAMPLE_QUESTIONS) {
      assert.notEqual(parseQuestion(q).intent, "unknown", q);
    }
  });
});

describe("ask", () => {
  function populated() {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "First project", activationEvent: "project_created", windowDays: 7, isPrimary: true,
    }));
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 200; i++) {
      h.event(`u${i}`, "signup_completed", base + i * 1000);
      if (i < 120) h.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
      if (i < 50) h.event(`u${i}`, "project_created", base + i * 1000 + 2 * HOUR);
    }
    return h;
  }

  test("answers an activation question with computed figures", () => {
    const h = populated();
    const a = ask(h.db, h.projectId, { question: "What is our activation rate?", timezone: "UTC", now: NOW });
    assert.equal(a.intent, "activation_rate");
    assert.match(a.answer, /50 of 200 users/);
    assert.match(a.answer, /25\.0%/);
    assert.ok(a.figures.some((f) => f.label === "Activation rate" && f.value === "25.0%"));
    // Every quoted figure carries its definition.
    assert.ok(a.figures.every((f) => f.definition.length > 0));
  });

  test("always declares that templates, not a model, wrote the answer", () => {
    const h = populated();
    for (const q of EXAMPLE_QUESTIONS) {
      const a = ask(h.db, h.projectId, { question: q, timezone: "UTC", now: NOW });
      assert.equal(a.generator, "deterministic_templates");
    }
  });

  test("answers a drop-off question and refuses to assign a cause", () => {
    const h = populated();
    const a = ask(h.db, h.projectId, { question: "Where do users drop off?", timezone: "UTC", now: NOW });
    assert.equal(a.intent, "activation_dropoff");
    assert.match(a.answer, /largest drop-off/);
    assert.match(a.answer, /where users stop, not why/);
    assert.ok(a.limitations.some((l) => /a location, not a cause/.test(l)));
  });

  test("says plainly when there is no data to answer with", () => {
    const h = harness("UTC");
    const a = ask(h.db, h.projectId, { question: "What is our MRR?", timezone: "UTC", now: NOW });
    assert.match(a.answer, /No subscription data is connected/);
    assert.match(a.answer, /will not estimate revenue from product usage/);
    assert.deepEqual(a.figures, []);
  });

  test("says when activation is not configured rather than inventing a definition", () => {
    const h = harness("UTC");
    const a = ask(h.db, h.projectId, { question: "What is our activation rate?", timezone: "UTC", now: NOW });
    assert.match(a.answer, /No activation definition is configured/);
    assert.match(a.answer, /will not guess one/);
  });

  test("refuses an unrecognised question instead of answering it", () => {
    const h = populated();
    const a = ask(h.db, h.projectId, { question: "Should we raise a Series A?", timezone: "UTC", now: NOW });
    assert.equal(a.intent, "unknown");
    assert.match(a.answer, /could not match that question/);
    assert.match(a.answer, /will not answer a question by guessing/);
    assert.deepEqual(a.figures, []);
    // It offers questions it can actually answer.
    assert.ok(a.suggestedActions.length >= 3);
  });

  test("reports retention periods that are not yet knowable as such", () => {
    const h = harness("UTC");
    // A cohort from yesterday cannot have day-30 retention yet.
    h.event("u1", "signup_completed", NOW - DAY);
    const a = ask(h.db, h.projectId, { question: "What is our retention?", timezone: "UTC", now: NOW });
    assert.match(a.answer, /not yet knowable/);
    assert.match(a.answer, /would invent a decline/);
  });

  test("answers an active-users question", () => {
    const h = populated();
    const a = ask(h.db, h.projectId, { question: "How many active users do we have?", timezone: "UTC", now: NOW });
    assert.equal(a.intent, "active_users");
    assert.ok(a.figures.some((f) => f.label === "MAU"));
    assert.ok(a.limitations.some((l) => /not fully elapsed/.test(l)));
  });

  test("says absence of feedback is not evidence of satisfaction", () => {
    const h = populated();
    const a = ask(h.db, h.projectId, { question: "What are users reporting?", timezone: "UTC", now: NOW });
    assert.match(a.answer, /No feedback was submitted/);
    assert.ok(a.limitations.some((l) => /not evidence that users are satisfied/.test(l)));
  });

  test("suggests actions but never performs them", () => {
    const h = populated();
    const a = ask(h.db, h.projectId, { question: "Where do users drop off?", timezone: "UTC", now: NOW });
    assert.ok(a.suggestedActions.some((s) => s.kind === "create_improvement"));
    // Nothing was created: suggestions are inert.
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM improvement_tasks")!.n, 0);
  });

  test("a release question explains why before/after is not causal", () => {
    const h = populated();
    h.db.run(
      `INSERT INTO releases (id, org_id, project_id, name, version, released_at, created_at)
       VALUES ('rel_1', ?, ?, 'v2', '2.0.0', ?, ?)`,
      [h.orgId, h.projectId, NOW - 5 * DAY, NOW - 5 * DAY],
    );
    const a = ask(h.db, h.projectId, { question: "What changed after our last release?", timezone: "UTC", now: NOW });
    assert.match(a.answer, /2\.0\.0/);
    assert.match(a.answer, /cannot separate the release from/);
    assert.ok(a.limitations.some((l) => /do not establish causation/.test(l)));
  });
});

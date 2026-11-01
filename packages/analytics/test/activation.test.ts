import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { activationFunnel, upsertActivationDefinition, listActivationDefinitions, activationBySegment } from "../src/activation.ts";
import { harness, must, mustFail, DAY, HOUR, T0 } from "./helpers.ts";

const LATER = T0 + 200 * DAY;

const DEF = {
  id: "act_test",
  name: "First project created",
  activationEvent: "project_created",
  propertyFilter: {},
  windowDays: 7,
  signupEvent: "signup_completed",
  isPrimary: true,
};

describe("activation definitions", () => {
  test("stores and lists definitions", () => {
    const h = harness();
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "First project", activationEvent: "project_created", windowDays: 7, isPrimary: true,
    }));
    const defs = listActivationDefinitions(h.db, h.projectId);
    assert.equal(defs.length, 1);
    assert.equal(defs[0]!.activationEvent, "project_created");
    assert.equal(defs[0]!.isPrimary, true);
  });

  test("only one definition can be primary", () => {
    const h = harness();
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "A", activationEvent: "project_created", windowDays: 7, isPrimary: true,
    }));
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "B", activationEvent: "core_action_completed", windowDays: 14, isPrimary: true,
    }));
    const primaries = listActivationDefinitions(h.db, h.projectId).filter((d) => d.isPrimary);
    assert.equal(primaries.length, 1);
    assert.equal(primaries[0]!.name, "B");
  });

  test("rejects an invalid window or event name", () => {
    const h = harness();
    const ids = { orgId: h.orgId, projectId: h.projectId };
    assert.equal(mustFail(upsertActivationDefinition(h.db, ids, {
      name: "X", activationEvent: "project_created", windowDays: 0,
    })).code, "validation_failed");
    assert.equal(mustFail(upsertActivationDefinition(h.db, ids, {
      name: "X", activationEvent: "Project Created", windowDays: 7,
    })).code, "validation_failed");
  });
});

describe("activation funnel", () => {
  test("signup alone is never treated as activation", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.event(`u${i}`, "signup_completed", T0 + i * 1000);
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.registrations, 10);
    assert.equal(r.activated, 0);
    assert.equal(r.activationRate, 0);
  });

  test("computes the full funnel with the expected numbers", () => {
    const h = harness();
    // 100 signups, 70 start onboarding, 40 complete it, 25 activate.
    for (let i = 0; i < 100; i++) {
      h.event(`u${i}`, "signup_completed", T0 + i * 1000);
      if (i < 70) h.event(`u${i}`, "onboarding_started", T0 + i * 1000 + HOUR);
      if (i < 40) h.event(`u${i}`, "onboarding_completed", T0 + i * 1000 + 2 * HOUR);
      if (i < 25) h.event(`u${i}`, "project_created", T0 + i * 1000 + 3 * HOUR);
    }
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.registrations, 100);
    assert.equal(r.onboardingStarted, 70);
    assert.equal(r.onboardingCompleted, 40);
    assert.equal(r.activated, 25);
    assert.equal(r.activationRate, 0.25);
    assert.deepEqual(r.steps.map((s) => s.users), [100, 70, 40, 25]);
    assert.deepEqual(r.steps.map((s) => s.droppedFromPrevious), [0, 30, 30, 15]);
  });

  test("activation outside the window does not count", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "project_created", T0 + 3 * DAY); // inside 7 days
    h.event("u2", "signup_completed", T0);
    h.event("u2", "project_created", T0 + 10 * DAY); // outside 7 days
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.registrations, 2);
    assert.equal(r.activated, 1);
  });

  test("an activation before signup does not count", () => {
    const h = harness();
    h.event("u1", "project_created", T0);
    h.event("u1", "signup_completed", T0 + HOUR);
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.activated, 0);
  });

  test("a property filter narrows what counts as activation", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "project_created", T0 + HOUR, { properties: { has_task: true } });
    h.event("u2", "signup_completed", T0);
    h.event("u2", "project_created", T0 + HOUR, { properties: { has_task: false } });
    const def = { ...DEF, propertyFilter: { has_task: true } };
    const r = activationFunnel(h.db, h.projectId, { definition: def, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.registrations, 2);
    assert.equal(r.activated, 1, "only a project with an actionable task counts");
  });

  test("the earliest activation is used, not the latest", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "project_created", T0 + 2 * HOUR);
    h.event("u1", "project_created", T0 + 5 * DAY);
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.timeToValue.medianMs, 2 * HOUR);
  });
});

describe("time to value", () => {
  test("reports median and percentiles over activated users only", () => {
    const h = harness();
    // Activation delays of 1, 2, 3, 4 and 5 hours; one user never activates.
    const delays = [1, 2, 3, 4, 5];
    delays.forEach((hours, i) => {
      h.event(`u${i}`, "signup_completed", T0 + i * 1000);
      h.event(`u${i}`, "project_created", T0 + i * 1000 + hours * HOUR);
    });
    h.event("u9", "signup_completed", T0 + 9000);
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.timeToValue.count, 5, "only activated users contribute a duration");
    assert.equal(r.timeToValue.medianMs, 3 * HOUR);
    assert.equal(r.timeToValue.p25Ms, 2 * HOUR);
    assert.equal(r.timeToValue.p75Ms, 4 * HOUR);
    assert.equal(r.timeToValue.p90Ms, 5 * HOUR);
  });

  test("time to value is null when nobody has activated", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.timeToValue.medianMs, null);
    assert.equal(r.timeToValue.count, 0);
  });
});

describe("open activation windows", () => {
  test("reports how many users still have an open window", () => {
    const h = harness();
    // Three signed up long ago, two signed up yesterday.
    for (let i = 0; i < 3; i++) h.event(`old${i}`, "signup_completed", T0 - 30 * DAY + i * 1000);
    for (let i = 0; i < 2; i++) h.event(`new${i}`, "signup_completed", T0 - DAY + i * 1000);
    const r = activationFunnel(h.db, h.projectId, {
      definition: DEF, from: T0 - 60 * DAY, to: T0, now: T0,
    });
    assert.equal(r.registrations, 5);
    assert.equal(r.timeToValue.eligibleForWindow, 3);
    // Both caveats apply here and both must be reported.
    assert.ok(r.warnings.some((w) => /activation window is\s+still open/.test(w)), r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /Only 5 signups/.test(w)), r.warnings.join(" | "));
  });

  test("no open-window warning once every window has closed", () => {
    const h = harness();
    for (let i = 0; i < 40; i++) h.event(`u${i}`, "signup_completed", T0 + i * 1000);
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.timeToValue.eligibleForWindow, 40);
    assert.deepEqual(r.warnings, []);
  });

  test("warns on a sample too small to read", () => {
    const h = harness();
    for (let i = 0; i < 4; i++) h.event(`u${i}`, "signup_completed", T0 + i * 1000);
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.ok(r.warnings.some((w) => /Only 4 signups/.test(w)));
  });
});

describe("activation by segment", () => {
  test("breaks the rate out by a dimension", () => {
    const h = harness();
    for (let i = 0; i < 20; i++) {
      const plan = i < 10 ? "free" : "growth";
      h.event(`u${i}`, "signup_completed", T0 + i * 1000, { plan });
      // 2 of 10 free users activate; 8 of 10 paid users do.
      if ((plan === "free" && i < 2) || (plan === "growth" && i < 18)) {
        h.event(`u${i}`, "project_created", T0 + i * 1000 + HOUR, { plan });
      }
    }
    const rows = activationBySegment(h.db, h.projectId, {
      definition: DEF, from: T0 - DAY, to: T0 + DAY, dimension: "plan", now: LATER,
    });
    const free = rows.find((r) => r.value === "free")!;
    const growth = rows.find((r) => r.value === "growth")!;
    assert.equal(free.registrations, 10);
    assert.equal(free.activated, 2);
    assert.equal(free.activationRate, 0.2);
    assert.equal(growth.registrations, 10);
    assert.equal(growth.activated, 8);
    assert.equal(growth.activationRate, 0.8);
  });
});

describe("edge cases", () => {
  test("an empty project yields zeros rather than NaN", () => {
    const h = harness();
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.registrations, 0);
    assert.equal(r.activationRate, 0);
    assert.ok(r.steps.every((s) => Number.isFinite(s.conversionFromStart)));
    assert.deepEqual(r.warnings, ["No signups in the selected period, so there is nothing to interpret."]);
  });

  test("users who signed up outside the period are excluded", () => {
    const h = harness();
    h.event("old", "signup_completed", T0 - 40 * DAY);
    h.event("old", "project_created", T0 - 40 * DAY + HOUR);
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.registrations, 0);
  });

  test("states its own definition", () => {
    const h = harness();
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.match(r.definition, /Signup alone is never treated as activation/);
  });

  test("handles more users than the SQL chunk size", () => {
    const h = harness();
    for (let i = 0; i < 900; i++) {
      h.event(`u${i}`, "signup_completed", T0 + i);
      if (i % 3 === 0) h.event(`u${i}`, "project_created", T0 + i + HOUR);
    }
    const r = activationFunnel(h.db, h.projectId, { definition: DEF, from: T0 - DAY, to: T0 + DAY, now: LATER });
    assert.equal(r.registrations, 900);
    assert.equal(r.activated, 300);
  });
});

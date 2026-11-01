import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeFunnel, compareFunnelSegments, saveFunnel, listFunnels, getFunnel, deleteFunnel } from "../src/funnels.ts";
import { harness, must, mustFail, DAY, HOUR, T0 } from "./helpers.ts";

const STEPS = [
  { event: "signup_completed" },
  { event: "onboarding_started" },
  { event: "onboarding_completed" },
  { event: "core_action_completed" },
];

/**
 * The reference dataset from the product brief:
 *   1000 registered, 700 began onboarding, 350 completed, 200 activated.
 * Built explicitly so the expected numbers are arithmetic, not a guess.
 */
function referenceDataset() {
  const h = harness("UTC");
  for (let i = 0; i < 1000; i++) {
    const u = `u${i}`;
    h.event(u, "signup_completed", T0 + i * 1000);
    if (i < 700) h.event(u, "onboarding_started", T0 + i * 1000 + HOUR);
    if (i < 350) h.event(u, "onboarding_completed", T0 + i * 1000 + 2 * HOUR);
    if (i < 200) h.event(u, "core_action_completed", T0 + i * 1000 + 3 * HOUR);
  }
  return h;
}

describe("computeFunnel on the reference dataset", () => {
  test("reproduces the funnel exactly", () => {
    const h = referenceDataset();
    const r = must(computeFunnel(h.db, h.projectId, { steps: STEPS, from: T0 - DAY, to: T0 + 30 * DAY }));
    assert.deepEqual(r.steps.map((s) => s.users), [1000, 700, 350, 200]);
    assert.equal(r.entered, 1000);
    assert.equal(r.completed, 200);
    assert.equal(r.overallConversion, 0.2);
  });

  test("computes step and overall conversion correctly", () => {
    const h = referenceDataset();
    const r = must(computeFunnel(h.db, h.projectId, { steps: STEPS, from: T0 - DAY, to: T0 + 30 * DAY }));
    assert.equal(r.steps[0]!.stepConversion, null, "step 0 has no previous step");
    assert.equal(r.steps[1]!.stepConversion, 0.7);
    assert.equal(r.steps[2]!.stepConversion, 0.5);
    assert.equal(r.steps[3]!.stepConversion, 200 / 350);
    assert.equal(r.steps[2]!.overallConversion, 0.35);
  });

  test("identifies the largest drop-off by absolute users lost", () => {
    const h = referenceDataset();
    const r = must(computeFunnel(h.db, h.projectId, { steps: STEPS, from: T0 - DAY, to: T0 + 30 * DAY }));
    // Losses are 300, 350, 150. The biggest is onboarding_started -> completed.
    assert.equal(r.largestDropOff!.fromIndex, 1);
    assert.equal(r.largestDropOff!.toIndex, 2);
    assert.equal(r.largestDropOff!.lostUsers, 350);
  });

  test("reports its own counting rules alongside the numbers", () => {
    const h = referenceDataset();
    const r = must(computeFunnel(h.db, h.projectId, { steps: STEPS, from: T0 - DAY, to: T0 + 30 * DAY }));
    assert.match(r.definition.countingMethod, /Unique users/);
    assert.match(r.definition.windowSemantics, /first step/);
  });
});

describe("ordering semantics", () => {
  test("a step that fires before the previous step does not count", () => {
    const h = harness();
    // This user did the core action, then signed up. The funnel is ordered, so
    // the core action must not be credited.
    h.event("u1", "core_action_completed", T0);
    h.event("u1", "signup_completed", T0 + HOUR);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.equal(r.steps[0]!.users, 1);
    assert.equal(r.steps[1]!.users, 0);
  });

  test("a later qualifying occurrence does count", () => {
    const h = harness();
    h.event("u1", "core_action_completed", T0);
    h.event("u1", "signup_completed", T0 + HOUR);
    h.event("u1", "core_action_completed", T0 + 2 * HOUR);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.equal(r.steps[1]!.users, 1);
  });

  test("repeated events count a user only once per step", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.event("u1", "signup_completed", T0 + i * 1000);
    for (let i = 0; i < 9; i++) h.event("u1", "core_action_completed", T0 + HOUR + i * 1000);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.deepEqual(r.steps.map((s) => s.users), [1, 1]);
    assert.equal(r.overallConversion, 1);
  });

  test("the same event can appear twice in a funnel and needs two occurrences", () => {
    const h = harness();
    h.event("u1", "core_action_completed", T0);
    h.event("u2", "core_action_completed", T0);
    h.event("u2", "core_action_completed", T0 + HOUR);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "core_action_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.equal(r.steps[0]!.users, 2);
    assert.equal(r.steps[1]!.users, 1, "only the user with two occurrences completes");
  });

  test("same-millisecond events resolve deterministically", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "core_action_completed", T0); // identical timestamp, later id
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.equal(r.steps[1]!.users, 1);
    // Running it again gives the same answer.
    const again = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.deepEqual(again.steps.map((s) => s.users), r.steps.map((s) => s.users));
  });
});

describe("conversion window", () => {
  test("a step outside the window from the first step does not count", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "core_action_completed", T0 + 10 * DAY);
    const steps = [{ event: "signup_completed" }, { event: "core_action_completed" }];
    const tight = must(computeFunnel(h.db, h.projectId, {
      steps, from: T0 - DAY, to: T0 + 30 * DAY, conversionWindowHours: 24 * 7,
    }));
    assert.equal(tight.steps[1]!.users, 0);
    const loose = must(computeFunnel(h.db, h.projectId, {
      steps, from: T0 - DAY, to: T0 + 30 * DAY, conversionWindowHours: 24 * 14,
    }));
    assert.equal(loose.steps[1]!.users, 1);
  });

  test("the window is measured from the first step, not the previous step", () => {
    const h = harness();
    // Each hop is 4 days: under a per-step window both would pass, but the
    // total elapsed time is 8 days, which exceeds a 7-day window from step 0.
    h.event("u1", "signup_completed", T0);
    h.event("u1", "onboarding_started", T0 + 4 * DAY);
    h.event("u1", "core_action_completed", T0 + 8 * DAY);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "onboarding_started" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + 30 * DAY, conversionWindowHours: 24 * 7,
    }));
    assert.deepEqual(r.steps.map((s) => s.users), [1, 1, 0]);
  });

  test("an event exactly at the window boundary counts", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "core_action_completed", T0 + 7 * DAY);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + 30 * DAY, conversionWindowHours: 168,
    }));
    assert.equal(r.steps[1]!.users, 1);
  });
});

describe("step property filters", () => {
  test("only occurrences matching the filter count", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "core_action_completed", T0 + HOUR, { properties: { feature: "export" } });
    h.event("u2", "signup_completed", T0);
    h.event("u2", "core_action_completed", T0 + HOUR, { properties: { feature: "first_project" } });
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed", filter: { feature: "first_project" } }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.equal(r.steps[0]!.users, 2);
    assert.equal(r.steps[1]!.users, 1);
  });
});

describe("segmentation", () => {
  test("a segment filter narrows the whole funnel", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      const plan = i < 6 ? "free" : "growth";
      h.event(`u${i}`, "signup_completed", T0 + i * 1000, { plan });
      // Every paid user activates; only one free user does.
      if (plan === "growth" || i === 0) {
        h.event(`u${i}`, "core_action_completed", T0 + i * 1000 + HOUR, { plan });
      }
    }
    const steps = [{ event: "signup_completed" }, { event: "core_action_completed" }];
    const all = must(computeFunnel(h.db, h.projectId, { steps, from: T0 - DAY, to: T0 + DAY }));
    assert.equal(all.entered, 10);
    assert.equal(all.completed, 5);

    const paid = must(computeFunnel(h.db, h.projectId, { steps, from: T0 - DAY, to: T0 + DAY, segment: { plan: "growth" } }));
    assert.equal(paid.entered, 4);
    assert.equal(paid.completed, 4);
    assert.equal(paid.overallConversion, 1);

    const free = must(computeFunnel(h.db, h.projectId, { steps, from: T0 - DAY, to: T0 + DAY, segment: { plan: "free" } }));
    assert.equal(free.entered, 6);
    assert.equal(free.completed, 1);
  });

  test("compareFunnelSegments returns one result per segment", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0, { plan: "free" });
    h.event("u2", "signup_completed", T0, { plan: "growth" });
    h.event("u2", "core_action_completed", T0 + HOUR, { plan: "growth" });
    const out = must(compareFunnelSegments(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
      segments: [{ label: "Free", filter: { plan: "free" } }, { label: "Growth", filter: { plan: "growth" } }],
    }));
    assert.equal(out.length, 2);
    assert.equal(out[0]!.result.overallConversion, 0);
    assert.equal(out[1]!.result.overallConversion, 1);
  });

  test("a multi-value segment filter is an OR within the dimension", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0, { plan: "free" });
    h.event("u2", "signup_completed", T0, { plan: "starter" });
    h.event("u3", "signup_completed", T0, { plan: "growth" });
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY, segment: { plan: ["free", "starter"] },
    }));
    assert.equal(r.entered, 2);
  });
});

describe("edge cases", () => {
  test("an empty project yields zeros, not NaN", () => {
    const h = harness();
    const r = must(computeFunnel(h.db, h.projectId, { steps: STEPS, from: T0 - DAY, to: T0 + DAY }));
    assert.deepEqual(r.steps.map((s) => s.users), [0, 0, 0, 0]);
    assert.equal(r.overallConversion, 0);
    assert.equal(r.steps[1]!.stepConversion, 0);
    assert.ok(r.steps.every((s) => Number.isFinite(s.overallConversion)));
    assert.equal(r.largestDropOff, null);
    assert.match(r.sampleWarning!, /No users entered/);
  });

  test("warns on a sample too small to interpret", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.event(`u${i}`, "signup_completed", T0);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.match(r.sampleWarning!, /Only 5 users/);
  });

  test("no warning on a healthy sample", () => {
    const h = referenceDataset();
    const r = must(computeFunnel(h.db, h.projectId, { steps: STEPS, from: T0 - DAY, to: T0 + 30 * DAY }));
    assert.equal(r.sampleWarning, null);
  });

  test("rejects malformed funnel definitions", () => {
    const h = harness();
    assert.equal(mustFail(computeFunnel(h.db, h.projectId, { steps: [{ event: "a_b" }], from: T0, to: T0 + DAY })).code, "validation_failed");
    assert.equal(mustFail(computeFunnel(h.db, h.projectId, { steps: STEPS, from: T0 + DAY, to: T0 })).code, "validation_failed");
    assert.equal(mustFail(computeFunnel(h.db, h.projectId, {
      steps: STEPS, from: T0, to: T0 + DAY, conversionWindowHours: 0,
    })).code, "validation_failed");
    assert.equal(mustFail(computeFunnel(h.db, h.projectId, {
      steps: Array.from({ length: 13 }, () => ({ event: "a_b" })), from: T0, to: T0 + DAY,
    })).code, "validation_failed");
  });

  test("events outside the selected period are excluded", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0 - 10 * DAY);
    h.event("u1", "core_action_completed", T0 - 10 * DAY + HOUR);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.equal(r.entered, 0);
  });

  test("median time between steps is reported", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "core_action_completed", T0 + 2 * HOUR);
    h.event("u2", "signup_completed", T0);
    h.event("u2", "core_action_completed", T0 + 4 * HOUR);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    assert.equal(r.steps[1]!.medianMsFromPrevious, 3 * HOUR);
    assert.equal(r.steps[0]!.medianMsFromPrevious, null);
  });

  test("the step conversion interval widens on small samples", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0);
    h.event("u1", "core_action_completed", T0 + HOUR);
    const r = must(computeFunnel(h.db, h.projectId, {
      steps: [{ event: "signup_completed" }, { event: "core_action_completed" }],
      from: T0 - DAY, to: T0 + DAY,
    }));
    const [lo, hi] = r.steps[1]!.stepConversionInterval!;
    assert.ok(lo < 1 && hi === 1, `1/1 should not read as a certain 100%: got [${lo}, ${hi}]`);
    assert.ok(lo < 0.5, "a single observation must not imply confidence");
  });
});

describe("saved funnels", () => {
  test("round-trip save, list, get and delete", () => {
    const h = harness();
    const saved = must(saveFunnel(h.db, { orgId: h.orgId, projectId: h.projectId, userId: h.userId }, {
      name: "Onboarding", steps: STEPS, conversionWindowHours: 72,
    }));
    const list = listFunnels(h.db, h.projectId);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "Onboarding");
    assert.equal(list[0]!.steps.length, 4);
    const got = getFunnel(h.db, h.projectId, saved.id)!;
    assert.equal(got.conversion_window_hours, 72);
    assert.ok(deleteFunnel(h.db, h.projectId, saved.id).ok);
    assert.equal(listFunnels(h.db, h.projectId).length, 0);
    assert.equal(mustFail(deleteFunnel(h.db, h.projectId, saved.id)).code, "not_found");
  });

  test("a saved funnel needs at least two steps", () => {
    const h = harness();
    assert.equal(mustFail(saveFunnel(h.db, { orgId: h.orgId, projectId: h.projectId, userId: h.userId }, {
      name: "Bad", steps: [{ event: "a_b" }],
    })).code, "validation_failed");
  });
});

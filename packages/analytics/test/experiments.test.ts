import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createExperiment, startExperiment, stopExperiment, getExperiment,
  assignVariant, deterministicVariant, recordExposure, analyseExperiment, saveAnalysis,
} from "../src/experiments.ts";
import { harness, must, mustFail, DAY, T0 } from "./helpers.ts";

function setup(opts: { minExposures?: number; guardrails?: unknown[] } = {}) {
  const h = harness();
  const exp = must(createExperiment(h.db, { orgId: h.orgId, projectId: h.projectId, userId: h.userId }, {
    key: "new-onboarding",
    name: "Simplified onboarding",
    primaryMetricEvent: "project_created",
    primaryMetricKind: "conversion",
    minExposuresPerVariant: opts.minExposures ?? 200,
    guardrailMetrics: (opts.guardrails ?? []) as never,
    variants: [
      { key: "control", name: "Current", isControl: true, weight: 0.5 },
      { key: "treatment", name: "Simplified", weight: 0.5 },
    ],
  }));
  must(startExperiment(h.db, h.projectId, exp.id, T0));
  return { h, experimentId: exp.id };
}

/** Expose `n` users per arm, with `rate` of each arm converting. */
function populate(
  h: ReturnType<typeof harness>,
  experimentId: string,
  perArm: number,
  rates: { control: number; treatment: number },
) {
  const config = getExperiment(h.db, h.projectId, experimentId)!;
  for (const variant of ["control", "treatment"] as const) {
    const converts = Math.round(perArm * rates[variant]);
    for (let i = 0; i < perArm; i++) {
      const external = `${variant}-${i}`;
      h.event(external, "page_viewed", T0 + i);
      const identityId = h.db.get<{ id: string }>(
        "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, external],
      )!.id;
      recordExposure(h.db, { orgId: h.orgId, projectId: h.projectId }, experimentId, identityId, variant, T0 + i);
      if (i < converts) h.event(external, "project_created", T0 + i + 1000);
    }
  }
  return config;
}

describe("creation and validation", () => {
  test("creates an experiment with variants", () => {
    const { h, experimentId } = setup();
    const exp = getExperiment(h.db, h.projectId, experimentId)!;
    assert.equal(exp.key, "new-onboarding");
    assert.equal(exp.variants.length, 2);
    assert.equal(exp.variants.find((v) => v.isControl)!.key, "control");
    assert.equal(exp.status, "running");
  });

  test("requires exactly one control", () => {
    const h = harness();
    const ids = { orgId: h.orgId, projectId: h.projectId, userId: h.userId };
    const base = { key: "x", name: "X", primaryMetricEvent: "a_b" };
    assert.equal(mustFail(createExperiment(h.db, ids, {
      ...base, variants: [{ key: "a", name: "A", weight: 0.5 }, { key: "b", name: "B", weight: 0.5 }],
    })).code, "validation_failed");
    assert.equal(mustFail(createExperiment(h.db, ids, {
      ...base, variants: [
        { key: "a", name: "A", isControl: true, weight: 0.5 },
        { key: "b", name: "B", isControl: true, weight: 0.5 },
      ],
    })).code, "validation_failed");
  });

  test("requires weights that sum to 1", () => {
    const h = harness();
    assert.equal(mustFail(createExperiment(h.db, { orgId: h.orgId, projectId: h.projectId, userId: h.userId }, {
      key: "x", name: "X", primaryMetricEvent: "a_b",
      variants: [{ key: "a", name: "A", isControl: true, weight: 0.5 }, { key: "b", name: "B", weight: 0.3 }],
    })).code, "validation_failed");
  });

  test("rejects a duplicate key and at least two variants are required", () => {
    const { h } = setup();
    const ids = { orgId: h.orgId, projectId: h.projectId, userId: h.userId };
    assert.equal(mustFail(createExperiment(h.db, ids, {
      key: "new-onboarding", name: "Dup", primaryMetricEvent: "a_b",
      variants: [{ key: "c", name: "C", isControl: true, weight: 0.5 }, { key: "d", name: "D", weight: 0.5 }],
    })).code, "conflict");
    assert.equal(mustFail(createExperiment(h.db, ids, {
      key: "single", name: "S", primaryMetricEvent: "a_b",
      variants: [{ key: "a", name: "A", isControl: true, weight: 1 }],
    })).code, "validation_failed");
  });

  test("only a draft can start and only a running experiment can stop", () => {
    const { h, experimentId } = setup();
    assert.equal(mustFail(startExperiment(h.db, h.projectId, experimentId, T0)).code, "conflict");
    assert.ok(stopExperiment(h.db, h.projectId, experimentId, T0 + DAY).ok);
    assert.equal(mustFail(stopExperiment(h.db, h.projectId, experimentId, T0 + DAY)).code, "conflict");
  });
});

describe("assignment", () => {
  test("is stable for the same identity", () => {
    const variants = [
      { key: "control", name: "C", isControl: true, weight: 0.5 },
      { key: "treatment", name: "T", isControl: false, weight: 0.5 },
    ];
    for (let i = 0; i < 50; i++) {
      const a = deterministicVariant("exp-key", `user-${i}`, variants);
      const b = deterministicVariant("exp-key", `user-${i}`, variants);
      assert.equal(a, b);
    }
  });

  test("differs across experiments for the same user, so arms are independent", () => {
    const variants = [
      { key: "control", name: "C", isControl: true, weight: 0.5 },
      { key: "treatment", name: "T", isControl: false, weight: 0.5 },
    ];
    let differing = 0;
    for (let i = 0; i < 200; i++) {
      if (deterministicVariant("exp-a", `u${i}`, variants) !== deterministicVariant("exp-b", `u${i}`, variants)) {
        differing++;
      }
    }
    // Two independent 50/50 hashes should disagree roughly half the time.
    assert.ok(differing > 70 && differing < 130, `differing=${differing}`);
  });

  test("respects the configured weights across many users", () => {
    const variants = [
      { key: "control", name: "C", isControl: true, weight: 0.9 },
      { key: "treatment", name: "T", isControl: false, weight: 0.1 },
    ];
    let treatment = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      if (deterministicVariant("weighted", `user-${i}`, variants) === "treatment") treatment++;
    }
    const share = treatment / n;
    assert.ok(share > 0.085 && share < 0.115, `treatment share was ${share}`);
  });

  test("the stored assignment matches the pure function", () => {
    const { h, experimentId } = setup();
    const config = getExperiment(h.db, h.projectId, experimentId)!;
    h.event("u1", "page_viewed", T0);
    const identityId = h.db.get<{ id: string }>(
      "SELECT id FROM identities WHERE external_id = 'u1'",
    )!.id;
    const assigned = assignVariant(h.db, { orgId: h.orgId, projectId: h.projectId }, config, identityId, T0);
    assert.equal(assigned, deterministicVariant(config.key, identityId, config.variants));
    // Re-assigning returns the cached decision rather than re-rolling.
    assert.equal(assignVariant(h.db, { orgId: h.orgId, projectId: h.projectId }, config, identityId, T0), assigned);
  });
});

describe("exposure", () => {
  test("is recorded once per identity with a running count", () => {
    const { h, experimentId } = setup();
    h.event("u1", "page_viewed", T0);
    const identityId = h.db.get<{ id: string }>("SELECT id FROM identities WHERE external_id = 'u1'")!.id;
    recordExposure(h.db, { orgId: h.orgId, projectId: h.projectId }, experimentId, identityId, "control", T0);
    recordExposure(h.db, { orgId: h.orgId, projectId: h.projectId }, experimentId, identityId, "control", T0 + 1000);
    const row = h.db.get<{ exposure_count: number }>(
      "SELECT exposure_count FROM experiment_exposures WHERE experiment_id = ?", [experimentId],
    )!;
    assert.equal(row.exposure_count, 2);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM experiment_exposures")!.n, 1);
  });
});

describe("analysis", () => {
  test("states the verdict in readable units, not raw proportions", () => {
    const { h, experimentId } = setup({ minExposures: 200 });
    populate(h, experimentId, 1000, { control: 0.1, treatment: 0.16 });
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    const prose = a.reasoning.join(" ");
    // Percentage points, not "higher by 0.0600".
    assert.match(prose, /6\.00 percentage points/);
    // A tiny p-value must not round to "0.0000".
    assert.ok(!/p = 0\.0000\b/.test(prose), `p-value rounded to zero in: ${prose}`);
    assert.match(prose, /p = \d\.\de-\d+/);
    assert.match(prose, /95% interval of [\d.-]+ to [\d.]+ percentage points/);
  });

  test("detects a real improvement", () => {
    const { h, experimentId } = setup({ minExposures: 200 });
    populate(h, experimentId, 1000, { control: 0.1, treatment: 0.16 });
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.verdict, "improvement_supported");
    assert.equal(a.primary.significant, true);
    const test = a.primary.test!;
    assert.ok(Math.abs(test.absoluteDiff - 0.06) < 1e-9);
    assert.ok(test.pValue < 0.001, `p=${test.pValue}`);
    assert.ok(test.confidenceInterval[0] > 0, "a supported improvement must exclude zero");
  });

  test("detects a real regression", () => {
    const { h, experimentId } = setup({ minExposures: 200 });
    populate(h, experimentId, 1000, { control: 0.2, treatment: 0.12 });
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.verdict, "worse_outcome");
    assert.ok(a.reasoning[0]!.includes("lower"));
  });

  test("reports no clear difference rather than claiming equality", () => {
    const { h, experimentId } = setup({ minExposures: 200 });
    populate(h, experimentId, 1000, { control: 0.1, treatment: 0.105 });
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.verdict, "no_clear_difference");
    assert.equal(a.primary.significant, false);
    assert.match(a.reasoning[0]!, /not the same as proving the variants are equal/);
  });

  test("refuses to read a result before the pre-registered sample is reached", () => {
    const { h, experimentId } = setup({ minExposures: 500 });
    // A dramatic difference on a tiny sample. The honest answer is "too early",
    // not "we found a 3x improvement".
    populate(h, experimentId, 40, { control: 0.1, treatment: 0.45 });
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + DAY }));
    assert.equal(a.verdict, "invalid_experiment");
    const check = a.checks.find((c) => c.id === "minimum_sample")!;
    assert.equal(check.passed, false);
    assert.match(check.detail, /premature stopping/);
  });

  test("catches a sample ratio mismatch and voids the result", () => {
    const { h, experimentId } = setup({ minExposures: 200 });
    const config = getExperiment(h.db, h.projectId, experimentId)!;
    // Deliberately lopsided exposure against a configured 50/50 split.
    for (const [variant, n] of [["control", 6000], ["treatment", 4000]] as const) {
      for (let i = 0; i < n; i++) {
        const external = `${variant}-${i}`;
        h.event(external, "page_viewed", T0 + i);
        const identityId = h.db.get<{ id: string }>(
          "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, external],
        )!.id;
        recordExposure(h.db, { orgId: h.orgId, projectId: h.projectId }, experimentId, identityId, variant, T0 + i);
        if (i < n * 0.2) h.event(external, "project_created", T0 + i + 1000);
      }
    }
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.srm!.mismatch, true);
    assert.equal(a.verdict, "invalid_experiment");
    assert.match(a.checks.find((c) => c.id === "sample_ratio_mismatch")!.detail, /bug in assignment/);
  });

  test("passes the ratio check on a clean split", () => {
    const { h, experimentId } = setup({ minExposures: 200 });
    populate(h, experimentId, 1000, { control: 0.1, treatment: 0.12 });
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.srm!.mismatch, false);
    assert.equal(a.checks.find((c) => c.id === "sample_ratio_mismatch")!.passed, true);
  });

  test("an experiment with no exposures is invalid, not inconclusive", () => {
    const { h, experimentId } = setup();
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + DAY }));
    assert.equal(a.verdict, "invalid_experiment");
    assert.match(a.checks[0]!.detail, /No exposures/);
  });

  test("the schema makes two exposure rows for one user impossible", () => {
    const { h, experimentId } = setup({ minExposures: 1 });
    h.event("u1", "page_viewed", T0);
    const identityId = h.db.get<{ id: string }>("SELECT id FROM identities WHERE external_id = 'u1'")!.id;
    recordExposure(h.db, { orgId: h.orgId, projectId: h.projectId }, experimentId, identityId, "control", T0);
    assert.throws(
      () => h.db.run(
        `INSERT INTO experiment_exposures (id, org_id, project_id, experiment_id, identity_id, variant_key, first_exposed_at)
         VALUES ('exo_dup', ?, ?, ?, ?, 'treatment', ?)`,
        [h.orgId, h.projectId, experimentId, identityId, T0 + 1],
      ),
      /UNIQUE constraint failed/,
      "one identity may hold at most one exposure row per experiment",
    );
  });

  test("detects an exposure recorded under a variant the user was not assigned", () => {
    const { h, experimentId } = setup({ minExposures: 1 });
    const config = getExperiment(h.db, h.projectId, experimentId)!;
    h.event("u1", "page_viewed", T0);
    const identityId = h.db.get<{ id: string }>("SELECT id FROM identities WHERE external_id = 'u1'")!.id;
    const assigned = assignVariant(h.db, { orgId: h.orgId, projectId: h.projectId }, config, identityId, T0);
    const wrong = assigned === "control" ? "treatment" : "control";
    // A caller passing the wrong variant key: the user saw the other arm.
    recordExposure(h.db, { orgId: h.orgId, projectId: h.projectId }, experimentId, identityId, wrong, T0);
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    const check = a.checks.find((c) => c.id === "contamination")!;
    assert.equal(check.passed, false);
    assert.match(check.detail, /other than the one they were assigned/);
    assert.equal(a.verdict, "invalid_experiment");
  });

  test("passes the contamination check when exposure matches assignment", () => {
    const { h, experimentId } = setup({ minExposures: 1 });
    const config = getExperiment(h.db, h.projectId, experimentId)!;
    h.event("u1", "page_viewed", T0);
    const identityId = h.db.get<{ id: string }>("SELECT id FROM identities WHERE external_id = 'u1'")!.id;
    const assigned = assignVariant(h.db, { orgId: h.orgId, projectId: h.projectId }, config, identityId, T0);
    recordExposure(h.db, { orgId: h.orgId, projectId: h.projectId }, experimentId, identityId, assigned, T0);
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.checks.find((c) => c.id === "contamination")!.passed, true);
  });

  test("blocks a result when the normal approximation does not hold", () => {
    const { h, experimentId } = setup({ minExposures: 10 });
    // 300 per arm but only two conversions each: the z-test is not valid here.
    const config = getExperiment(h.db, h.projectId, experimentId)!;
    for (const variant of ["control", "treatment"] as const) {
      for (let i = 0; i < 300; i++) {
        const external = `${variant}-${i}`;
        h.event(external, "page_viewed", T0 + i);
        const identityId = h.db.get<{ id: string }>(
          "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, external],
        )!.id;
        recordExposure(h.db, { orgId: h.orgId, projectId: h.projectId }, experimentId, identityId, variant, T0 + i);
        if (i < 2) h.event(external, "project_created", T0 + i + 1000);
      }
    }
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.checks.find((c) => c.id === "normal_approximation")?.passed, false);
    assert.equal(a.verdict, "invalid_experiment");
  });

  test("flags a metric schema change during the run", () => {
    const { h, experimentId } = setup({ minExposures: 200 });
    populate(h, experimentId, 1000, { control: 0.1, treatment: 0.16 });
    // A schema version bump mid-experiment means the metric may have changed.
    h.db.run(
      `INSERT INTO event_schemas (id, org_id, project_id, name, version, properties, created_at, updated_at)
       VALUES ('evs_x', ?, ?, 'project_created', 2, '[]', ?, ?)`,
      [h.orgId, h.projectId, T0, T0 + DAY],
    );
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.checks.find((c) => c.id === "metric_schema_stable")!.passed, false);
    assert.equal(a.verdict, "invalid_experiment");
  });

  test("reports a recommended sample size from the observed baseline", () => {
    const { h, experimentId } = setup({ minExposures: 200 });
    populate(h, experimentId, 1000, { control: 0.1, treatment: 0.12 });
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.ok(a.recommendedSampleSizePerVariant! > 1000);
  });
});

describe("guardrails", () => {
  test("applies a multiple-comparison correction across guardrails", () => {
    const { h, experimentId } = setup({
      minExposures: 200,
      guardrails: [
        { label: "Support contacts", event: "support_contacted", kind: "conversion", worseWhen: "increases" },
        { label: "Session starts", event: "session_started", kind: "conversion", worseWhen: "decreases" },
        { label: "Exports", event: "export_completed", kind: "conversion", worseWhen: "decreases" },
      ],
    });
    populate(h, experimentId, 1000, { control: 0.1, treatment: 0.16 });
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.guardrails.length, 3);
    // With three tests, the strictest threshold must be alpha/3, not alpha.
    const thresholds = a.guardrails.map((g) => g.adjustedThreshold).sort((x, y) => x - y);
    assert.ok(Math.abs(thresholds[0]! - 0.05 / 3) < 1e-12, `tightest threshold was ${thresholds[0]}`);
  });

  test("notes a guardrail that moved the wrong way alongside a primary win", () => {
    const { h, experimentId } = setup({
      minExposures: 200,
      guardrails: [{ label: "Support contacts", event: "support_contacted", kind: "conversion", worseWhen: "increases" }],
    });
    populate(h, experimentId, 1000, { control: 0.1, treatment: 0.2 });
    // The treatment arm contacts support far more often.
    for (let i = 0; i < 300; i++) h.event(`treatment-${i}`, "support_contacted", T0 + i + 2000);
    for (let i = 0; i < 50; i++) h.event(`control-${i}`, "support_contacted", T0 + i + 2000);
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    assert.equal(a.verdict, "improvement_supported");
    assert.equal(a.guardrails[0]!.direction, "worse");
    assert.ok(a.reasoning.some((r) => /guardrail metric\(s\) moved the wrong way/.test(r)));
  });
});

describe("persistence", () => {
  test("saves an analysis with its verdict and marks the experiment analysed", () => {
    const { h, experimentId } = setup({ minExposures: 200 });
    populate(h, experimentId, 1000, { control: 0.1, treatment: 0.16 });
    const a = must(analyseExperiment(h.db, h.projectId, experimentId, { now: T0 + 30 * DAY }));
    saveAnalysis(h.db, h.orgId, a, T0 + 30 * DAY);
    const row = h.db.get<{ verdict: string; analysis: string }>(
      "SELECT verdict, analysis FROM experiment_results WHERE experiment_id = ?", [experimentId],
    )!;
    assert.equal(row.verdict, "improvement_supported");
    // The full analysis is stored so a past decision can be audited.
    assert.ok(JSON.parse(row.analysis).checks.length > 0);
    assert.equal(
      h.db.get<{ status: string }>("SELECT status FROM experiments WHERE id = ?", [experimentId])!.status,
      "analysed",
    );
  });

  test("an unknown experiment id is not found", () => {
    const { h } = setup();
    assert.equal(mustFail(analyseExperiment(h.db, h.projectId, "exp_nope")).code, "not_found");
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scoreOpportunity, rankOpportunities, getWeights, setWeights, setEstimate,
  DEFAULT_WEIGHTS, FACTOR_LABELS, SCORE_DISCLAIMER, type ScoringInput,
} from "../src/opportunity.ts";
import { refreshFrictionGraph, listFrictionCases, transitionCase } from "../src/friction.ts";
import { upsertActivationDefinition } from "../src/activation.ts";
import { recordError, applyProviderEvent } from "@retainos/database";
import { harness, must, mustFail, DAY, HOUR, T0 } from "./helpers.ts";

const NOW = T0 + 60 * DAY;

function input(over: Partial<ScoringInput> = {}): ScoringInput {
  return {
    caseId: "fcs_1",
    kind: "activation_friction",
    affectedUsers: 50,
    revenueExposureMinor: 100_000,
    evidenceQuality: "moderate_supporting_evidence",
    independentEvidenceKinds: 1,
    detectedAt: NOW - DAY,
    estimate: null,
    context: { activeUsers: 500, totalMrrMinor: 1_000_000, now: NOW },
    ...over,
  };
}

describe("scoreOpportunity transparency", () => {
  test("every factor reports its measurement, transform, weight and contribution", () => {
    const s = scoreOpportunity(input());
    assert.equal(s.factors.length, 9);
    for (const f of s.factors) {
      assert.ok(FACTOR_LABELS[f.factor], `${f.factor} needs a label`);
      assert.ok(f.explanation.length > 20, `${f.factor} must explain itself`);
      assert.ok(f.normalised >= 0 && f.normalised <= 1, `${f.factor} normalised out of range`);
      assert.ok(["measured", "user_estimate", "absent"].includes(f.provenance));
    }
  });

  test("the contributions sum to the score", () => {
    const s = scoreOpportunity(input());
    const sum = s.factors.reduce((t, f) => t + f.contribution, 0);
    assert.ok(Math.abs(sum * 100 - s.score) < 0.11, `factors sum to ${sum * 100}, score is ${s.score}`);
  });

  test("the score stays inside 0..100", () => {
    const max = scoreOpportunity(input({
      affectedUsers: 100_000, revenueExposureMinor: 10_000_000,
      evidenceQuality: "strong_supporting_evidence", independentEvidenceKinds: 5,
      detectedAt: NOW, kind: "reliability",
      estimate: { engineeringEffort: "small", strategicImportance: "high", hasWorkaround: false },
    }));
    const min = scoreOpportunity(input({
      affectedUsers: 0, revenueExposureMinor: null, evidenceQuality: "insufficient_data",
      independentEvidenceKinds: 0, detectedAt: NOW - 365 * DAY, kind: "unverified",
    }));
    assert.ok(max.score <= 100 && max.score >= 0, `max was ${max.score}`);
    assert.ok(min.score <= 100 && min.score >= 0, `min was ${min.score}`);
    assert.ok(max.score > min.score);
  });

  test("the disclaimer says what the number is not", () => {
    assert.match(SCORE_DISCLAIMER, /not a probability/);
    assert.match(SCORE_DISCLAIMER, /not a prediction of/);
  });
});

describe("missing inputs are never imputed", () => {
  test("an unestimated factor is absent, contributes nothing, and says so", () => {
    const s = scoreOpportunity(input({ estimate: null }));
    const effort = s.factors.find((f) => f.factor === "engineering_effort")!;
    assert.equal(effort.provenance, "absent");
    assert.equal(effort.contribution, 0);
    assert.equal(effort.rawValue, null);
    assert.match(effort.explanation, /will not guess/);
  });

  test("a case is not punished for an unanswered question", () => {
    // Identical cases; one simply has nobody's effort estimate yet. Removing
    // the absent weight from the denominator is what makes these comparable.
    const withoutEstimate = scoreOpportunity(input({ estimate: null }));
    const withNeutralEstimate = scoreOpportunity(input({
      estimate: { engineeringEffort: "medium", strategicImportance: "medium", hasWorkaround: false },
    }));
    // The unestimated one is not dragged towards zero.
    assert.ok(withoutEstimate.score > withNeutralEstimate.score * 0.75,
      `unestimated ${withoutEstimate.score} should not collapse against ${withNeutralEstimate.score}`);
  });

  test("absent revenue exposure contributes nothing rather than counting as zero exposure", () => {
    const s = scoreOpportunity(input({ revenueExposureMinor: null }));
    const revenue = s.factors.find((f) => f.factor === "revenue_exposure")!;
    assert.equal(revenue.provenance, "absent");
    assert.equal(revenue.contribution, 0);
    assert.match(revenue.explanation, /weight is removed/);
  });

  test("howToImprove names the missing inputs", () => {
    const s = scoreOpportunity(input({ estimate: null }));
    assert.match(s.howToImprove, /engineering effort/i);
    assert.match(s.howToImprove, /contribute nothing/);
  });

  test("with everything present, howToImprove names the weakest factor instead", () => {
    const s = scoreOpportunity(input({
      revenueExposureMinor: 50_000,
      estimate: { engineeringEffort: "large", strategicImportance: "high", hasWorkaround: false },
    }));
    assert.ok(!s.factors.some((f) => f.provenance === "absent"));
    assert.match(s.howToImprove, /weakest input/);
    assert.ok(s.weakestFactor);
  });
});

describe("factor behaviour", () => {
  test("reach uses diminishing returns rather than scaling linearly", () => {
    const ten = scoreOpportunity(input({ affectedUsers: 10 }));
    const hundred = scoreOpportunity(input({ affectedUsers: 100 }));
    const reach = (s: typeof ten) => s.factors.find((f) => f.factor === "affected_users")!.normalised;
    assert.ok(reach(hundred) > reach(ten));
    assert.ok(reach(hundred) < reach(ten) * 10,
      "100 users must not be scored as ten times 10 users");
  });

  test("evidence quality moves the score", () => {
    const strong = scoreOpportunity(input({ evidenceQuality: "strong_supporting_evidence" }));
    const weak = scoreOpportunity(input({ evidenceQuality: "insufficient_data" }));
    assert.ok(strong.score > weak.score,
      "acting confidently on weak evidence is the expensive mistake, so weak evidence must rank lower");
  });

  test("corroboration from independent sources raises the score", () => {
    const alone = scoreOpportunity(input({ independentEvidenceKinds: 0 }));
    const corroborated = scoreOpportunity(input({ independentEvidenceKinds: 3 }));
    assert.ok(corroborated.score > alone.score);
  });

  test("recency decays to nothing over the window", () => {
    const fresh = scoreOpportunity(input({ detectedAt: NOW }));
    const old = scoreOpportunity(input({ detectedAt: NOW - 60 * DAY }));
    assert.equal(old.factors.find((f) => f.factor === "recency")!.normalised, 0);
    assert.ok(fresh.score > old.score);
  });

  test("a reliability problem outranks an adoption gap at equal reach", () => {
    const reliability = scoreOpportunity(input({ kind: "reliability" }));
    const adoption = scoreOpportunity(input({ kind: "adoption" }));
    assert.ok(reliability.score > adoption.score);
  });

  test("effort matters but is not allowed to dominate", () => {
    // A large-effort reliability problem affecting many must still outrank a
    // small-effort adoption gap affecting few.
    const bigProblem = scoreOpportunity(input({
      kind: "reliability", affectedUsers: 400, evidenceQuality: "strong_supporting_evidence",
      independentEvidenceKinds: 3,
      estimate: { engineeringEffort: "large", strategicImportance: "medium", hasWorkaround: false },
    }));
    const easyNothing = scoreOpportunity(input({
      kind: "adoption", affectedUsers: 5, evidenceQuality: "preliminary_observation",
      independentEvidenceKinds: 0, revenueExposureMinor: null,
      estimate: { engineeringEffort: "small", strategicImportance: "low", hasWorkaround: true },
    }));
    assert.ok(bigProblem.score > easyNothing.score,
      "easy is not the same as worth doing");
  });

  test("a human estimate is labelled as such, never as a measurement", () => {
    const s = scoreOpportunity(input({
      estimate: { engineeringEffort: "small", strategicImportance: "high", hasWorkaround: false },
    }));
    for (const name of ["engineering_effort", "strategic_importance", "has_workaround"] as const) {
      const f = s.factors.find((x) => x.factor === name)!;
      assert.equal(f.provenance, "user_estimate", `${name} is a judgement, not data`);
    }
    assert.match(s.factors.find((f) => f.factor === "strategic_importance")!.explanation,
      /judgement, not a measurement/);
  });
});

describe("configurable weights", () => {
  test("defaults are returned when nothing is configured", () => {
    const h = harness("UTC");
    assert.deepEqual(getWeights(h.db, h.projectId), DEFAULT_WEIGHTS);
  });

  test("weights round-trip and change the ranking", () => {
    const h = harness("UTC");
    const ids = { orgId: h.orgId, projectId: h.projectId, userId: h.userId };
    must(setWeights(h.db, ids, { revenue_exposure: 0.9, affected_users: 0.01 }));
    assert.equal(getWeights(h.db, h.projectId).revenue_exposure, 0.9);

    const revenueHeavy = getWeights(h.db, h.projectId);
    // Reach-heavy versus money-heavy, with the money case at 15% of total MRR
    // rather than an extreme that would dominate under any weighting.
    const lotsOfUsers = input({ affectedUsers: 500, revenueExposureMinor: 1_000 });
    const lotsOfMoney = input({ affectedUsers: 5, revenueExposureMinor: 150_000 });

    assert.ok(
      scoreOpportunity(lotsOfMoney, revenueHeavy).score > scoreOpportunity(lotsOfUsers, revenueHeavy).score,
      "a revenue-weighted project must rank the revenue-heavy case first",
    );
    assert.ok(
      scoreOpportunity(lotsOfUsers, DEFAULT_WEIGHTS).score > scoreOpportunity(lotsOfMoney, DEFAULT_WEIGHTS).score,
      "the default weighting leans towards reach, so the ordering flips",
    );
  });

  test("a case exposing a large share of all revenue outranks reach even by default", () => {
    // Not a bug: 40% of a company's MRR sitting behind one problem is more
    // urgent than a cosmetic issue touching many free users, and the default
    // weights are deliberately set so that comes through.
    const manyFreeUsers = input({ affectedUsers: 500, revenueExposureMinor: 1_000 });
    const mostOfTheRevenue = input({ affectedUsers: 5, revenueExposureMinor: 400_000 });
    assert.ok(
      scoreOpportunity(mostOfTheRevenue, DEFAULT_WEIGHTS).score >
      scoreOpportunity(manyFreeUsers, DEFAULT_WEIGHTS).score,
    );
  });

  test("an out-of-range weight is rejected", () => {
    const h = harness("UTC");
    const ids = { orgId: h.orgId, projectId: h.projectId, userId: h.userId };
    assert.equal(mustFail(setWeights(h.db, ids, { affected_users: 2 })).code, "validation_failed");
    assert.equal(mustFail(setWeights(h.db, ids, { affected_users: -1 })).code, "validation_failed");
  });
});

describe("estimates", () => {
  function caseInProject() {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "A", activationEvent: "project_created", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }));
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 50; i++) {
      h.event(`u${i}`, "signup_completed", base + i * 1000);
      h.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
      if (i < 15) h.event(`u${i}`, "onboarding_completed", base + i * 1000 + 2 * HOUR);
    }
    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW });
    const caseId = String(listFrictionCases(h.db, h.projectId)[0]!.id);
    return { h, caseId, ids: { orgId: h.orgId, projectId: h.projectId, userId: h.userId } };
  }

  test("an estimate is stored and feeds the next ranking", () => {
    const { h, caseId, ids } = caseInProject();
    const before = rankOpportunities(h.db, ids, { now: NOW })[0]!;
    assert.equal(before.factors.find((f) => f.factor === "engineering_effort")!.provenance, "absent");

    must(setEstimate(h.db, ids, caseId, { engineeringEffort: "small", strategicImportance: "high" }, NOW));
    const after = rankOpportunities(h.db, ids, { now: NOW })[0]!;
    assert.equal(after.factors.find((f) => f.factor === "engineering_effort")!.provenance, "user_estimate");
    assert.ok(after.score > before.score, "a small-effort, high-importance case should rank higher");
  });

  test("an invalid estimate value is rejected", () => {
    const { h, caseId, ids } = caseInProject();
    assert.equal(mustFail(setEstimate(h.db, ids, caseId, { engineeringEffort: "enormous" }, NOW)).code,
      "validation_failed");
  });

  test("a case in another project cannot be estimated", () => {
    const { caseId } = caseInProject();
    const other = harness("UTC");
    assert.equal(mustFail(setEstimate(other.db,
      { orgId: other.orgId, projectId: other.projectId, userId: other.userId },
      caseId, { engineeringEffort: "small" }, NOW)).code, "not_found");
  });
});

describe("rankOpportunities", () => {
  function projectWithSeveralProblems() {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "A", activationEvent: "project_created", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }));
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 80; i++) {
      h.event(`u${i}`, "signup_completed", base + i * 1000);
      h.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
      if (i < 30) h.event(`u${i}`, "onboarding_completed", base + i * 1000 + 2 * HOUR);
    }
    // A separate reliability problem affecting a different, smaller group.
    for (let i = 60; i < 70; i++) {
      const identityId = h.db.get<{ id: string }>(
        "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, `u${i}`],
      )!.id;
      must(recordError(h.db, { orgId: h.orgId, projectId: h.projectId }, {
        fingerprint: "RangeError:export",
        title: "Range error while exporting",
        timestamp: base + 3 * HOUR,
      }, { identityId }));
    }
    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW });
    return { h, ids: { orgId: h.orgId, projectId: h.projectId, userId: h.userId } };
  }

  test("ranks every open case together and persists the result", () => {
    const { h, ids } = projectWithSeveralProblems();
    const ranked = rankOpportunities(h.db, ids, { now: NOW });
    assert.ok(ranked.length >= 2, `expected several cases, got ${ranked.length}`);
    // Sorted by score, descending.
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1]!.score >= ranked[i]!.score);
    }
    const stored = h.db.all<{ rank: number; score: number }>(
      "SELECT rank, score FROM opportunity_scores WHERE project_id = ? ORDER BY rank", [h.projectId],
    );
    assert.equal(stored.length, ranked.length);
    assert.equal(stored[0]!.rank, 1);
    assert.ok(Math.abs(stored[0]!.score - ranked[0]!.score) < 0.01);
  });

  test("every stored score keeps its factor breakdown", () => {
    const { h, ids } = projectWithSeveralProblems();
    rankOpportunities(h.db, ids, { now: NOW });
    const scoreId = h.db.get<{ id: string }>(
      "SELECT id FROM opportunity_scores WHERE project_id = ? ORDER BY rank LIMIT 1", [h.projectId],
    )!.id;
    const factors = h.db.all<{ factor: string; provenance: string; explanation: string }>(
      "SELECT factor, provenance, explanation FROM opportunity_score_factors WHERE score_id = ?", [scoreId],
    );
    assert.equal(factors.length, 9);
    assert.ok(factors.every((f) => f.explanation.length > 0));
  });

  test("re-ranking replaces the previous ranking rather than accumulating", () => {
    const { h, ids } = projectWithSeveralProblems();
    const first = rankOpportunities(h.db, ids, { now: NOW });
    rankOpportunities(h.db, ids, { now: NOW + HOUR });
    assert.equal(
      h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM opportunity_scores WHERE project_id = ?", [h.projectId])!.n,
      first.length,
    );
  });

  test("dismissed and resolved cases are excluded from the ranking", () => {
    const { h, ids } = projectWithSeveralProblems();
    const before = rankOpportunities(h.db, ids, { now: NOW }).length;
    const caseId = String(listFrictionCases(h.db, h.projectId)[0]!.id);
    must(transitionCase(h.db, ids, caseId, "dismissed", "Known", NOW));
    assert.equal(rankOpportunities(h.db, ids, { now: NOW }).length, before - 1);
  });

  test("a project with no cases ranks nothing rather than erroring", () => {
    const h = harness("UTC");
    assert.deepEqual(
      rankOpportunities(h.db, { orgId: h.orgId, projectId: h.projectId }, { now: NOW }), [],
    );
  });

  test("ranking is isolated per project", () => {
    const { h, ids } = projectWithSeveralProblems();
    rankOpportunities(h.db, ids, { now: NOW });
    const other = harness("UTC");
    assert.deepEqual(
      rankOpportunities(other.db, { orgId: other.orgId, projectId: other.projectId }, { now: NOW }), [],
    );
  });

  test("reading the ranking does not write one", () => {
    const { h, ids } = projectWithSeveralProblems();
    rankOpportunities(h.db, ids, { now: NOW });
    const stored = h.db.all<{ id: string; computed_at: number }>(
      "SELECT id, computed_at FROM opportunity_scores WHERE project_id = ?", [h.projectId],
    );
    assert.ok(stored.length > 0);

    // A page that renders the order on every view must not replace it.
    const readOnly = rankOpportunities(h.db, ids, { now: NOW + DAY, persist: false });
    assert.equal(readOnly.length, stored.length);
    const after = h.db.all<{ id: string; computed_at: number }>(
      "SELECT id, computed_at FROM opportunity_scores WHERE project_id = ?", [h.projectId],
    );
    assert.deepEqual(after.map((r) => r.id).sort(), stored.map((r) => r.id).sort());
    assert.deepEqual(after.map((r) => r.computed_at), stored.map((r) => r.computed_at));
  });
});

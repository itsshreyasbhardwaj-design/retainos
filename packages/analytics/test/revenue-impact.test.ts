import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { harness, must, mustFail, DAY, T0 } from "./helpers.ts";
import { newId } from "@retainos/shared";
import {
  createExperiment, startExperiment, getExperiment, recordExposure,
} from "../src/experiments.ts";
import {
  classifyEvidence, observedMovementForIdentities, estimateMonthlyRevenue,
  experimentSupportedImpact, recordImpact, listImpactRecords, impactSummary,
  CLASSIFICATION_STRENGTH, type EvidenceBasis, type Assumption,
} from "../src/revenue-impact.ts";

const measured = (name: string, value: string): Assumption =>
  ({ name, value, unit: "x", source: "measured" });

function basis(over: Partial<EvidenceBasis> = {}): EvidenceBasis {
  return {
    billingRecordsForExactEntities: false,
    randomisedExperimentId: null,
    experimentConclusive: false,
    assumptions: [],
    observationalComparison: false,
    entityCount: 10,
    ...over,
  };
}

// --- classification --------------------------------------------------------

describe("classification", () => {
  test("billing records with no model are observed", () => {
    const c = classifyEvidence(basis({ billingRecordsForExactEntities: true }));
    assert.equal(c.classification, "observed");
    assert.ok(c.reasons.some((r) => /billing records/.test(r)));
  });

  test("a conclusive randomised experiment is experiment_supported", () => {
    const c = classifyEvidence(basis({ randomisedExperimentId: "exp_1", experimentConclusive: true }));
    assert.equal(c.classification, "experiment_supported");
  });

  test("an inconclusive experiment is insufficient evidence, not an estimate", () => {
    // The temptation this guards against: turning a null result into a number.
    const c = classifyEvidence(basis({
      randomisedExperimentId: "exp_1",
      experimentConclusive: false,
      assumptions: [measured("arpu", "900000")],
    }));
    assert.equal(c.classification, "insufficient_evidence");
    assert.ok(c.reasons.some((r) => /not downgraded to an estimate/.test(r)));
  });

  test("assumptions make a figure an estimate even on top of billing data", () => {
    const c = classifyEvidence(basis({
      billingRecordsForExactEntities: true,
      assumptions: [measured("retained_share", "0.6")],
    }));
    assert.equal(c.classification, "estimated");
  });

  test("an estimate names the assumptions that are not measured", () => {
    const c = classifyEvidence(basis({
      assumptions: [
        measured("affected_users", "40"),
        { name: "conversion_delta", value: "5%", unit: "pp", source: "default" },
      ],
    }));
    assert.equal(c.classification, "estimated");
    assert.ok(c.reasons.some((r) => /conversion_delta/.test(r)));
  });

  test("an observational comparison with no model is only associated", () => {
    const c = classifyEvidence(basis({ observationalComparison: true }));
    assert.equal(c.classification, "associated");
    assert.ok(c.reasons.some((r) => /at the same time/.test(r)));
  });

  test("no entities means insufficient evidence whatever else is true", () => {
    const c = classifyEvidence(basis({
      entityCount: 0, billingRecordsForExactEntities: true, randomisedExperimentId: "exp_1",
      experimentConclusive: true,
    }));
    assert.equal(c.classification, "insufficient_evidence");
  });

  test("nothing at all is insufficient evidence", () => {
    assert.equal(classifyEvidence(basis()).classification, "insufficient_evidence");
  });

  test("only an experiment outranks observed billing data", () => {
    assert.ok(CLASSIFICATION_STRENGTH.experiment_supported > CLASSIFICATION_STRENGTH.observed);
    assert.ok(CLASSIFICATION_STRENGTH.observed > CLASSIFICATION_STRENGTH.estimated);
    assert.ok(CLASSIFICATION_STRENGTH.estimated > CLASSIFICATION_STRENGTH.associated);
    assert.ok(CLASSIFICATION_STRENGTH.associated > CLASSIFICATION_STRENGTH.insufficient_evidence);
  });
});

// --- observed movement -----------------------------------------------------

function subscribe(
  h: ReturnType<typeof harness>,
  identityId: string,
  events: Array<{ type: string; at: number; amountMinor: number; interval?: string }>,
) {
  const subId = newId("sub");
  h.db.run(
    `INSERT INTO customer_subscriptions
      (id, org_id, project_id, provider, external_id, identity_id, plan_name, status,
       amount_minor, currency, interval, started_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, 'Pro', 'active', ?, 'INR', 'month', ?, ?)`,
    [subId, h.orgId, h.projectId, newId("ext"), identityId,
     events[0]!.amountMinor, events[0]!.at, events[events.length - 1]!.at],
  );
  for (const e of events) {
    h.db.run(
      `INSERT INTO subscription_events
        (id, org_id, project_id, subscription_id, provider, external_event_id, type,
         occurred_at, received_at, amount_minor, currency, interval)
       VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, 'INR', ?)`,
      [newId("sev"), h.orgId, h.projectId, subId, newId("xev"), e.type, e.at, e.at,
       e.amountMinor, e.interval ?? "month"],
    );
  }
  return subId;
}

function identityOf(h: ReturnType<typeof harness>, external: string): string {
  return h.db.get<{ id: string }>(
    "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, external],
  )!.id;
}

describe("observed movement for a cohort", () => {
  test("a cancellation inside the window is observed churn", () => {
    const h = harness();
    h.event("u1", "page_viewed", T0 - 100 * DAY);
    const id = identityOf(h, "u1");
    subscribe(h, id, [
      { type: "subscription_started", at: T0 - 90 * DAY, amountMinor: 900000 },
      { type: "cancelled", at: T0 - 10 * DAY, amountMinor: 0 },
    ]);
    const [m] = observedMovementForIdentities(h.db, h.projectId, [id], T0 - 30 * DAY, T0);
    assert.ok(m);
    assert.equal(m.startMrrMinor, 900000);
    assert.equal(m.endMrrMinor, 0);
    assert.equal(m.churnedMinor, 900000);
    assert.equal(m.netChangeMinor, -900000);
    assert.equal(m.entityCount, 1);
  });

  test("an upgrade inside the window is observed expansion", () => {
    const h = harness();
    h.event("u1", "page_viewed", T0 - 100 * DAY);
    const id = identityOf(h, "u1");
    subscribe(h, id, [
      { type: "subscription_started", at: T0 - 90 * DAY, amountMinor: 500000 },
      { type: "upgraded", at: T0 - 10 * DAY, amountMinor: 900000 },
    ]);
    const [m] = observedMovementForIdentities(h.db, h.projectId, [id], T0 - 30 * DAY, T0);
    assert.equal(m!.expansionMinor, 400000);
    assert.equal(m!.churnedMinor, 0);
    assert.equal(m!.netChangeMinor, 400000);
  });

  test("an annual plan is normalised to a monthly figure", () => {
    const h = harness();
    h.event("u1", "page_viewed", T0 - 100 * DAY);
    const id = identityOf(h, "u1");
    subscribe(h, id, [
      { type: "subscription_started", at: T0 - 90 * DAY, amountMinor: 12_000_000, interval: "year" },
    ]);
    const [m] = observedMovementForIdentities(h.db, h.projectId, [id], T0 - 30 * DAY, T0);
    assert.equal(m!.startMrrMinor, 1_000_000);
  });

  test("identities outside the cohort are not counted", () => {
    const h = harness();
    h.event("inside", "page_viewed", T0 - 100 * DAY);
    h.event("outside", "page_viewed", T0 - 100 * DAY);
    const inside = identityOf(h, "inside");
    const outside = identityOf(h, "outside");
    subscribe(h, inside, [{ type: "subscription_started", at: T0 - 90 * DAY, amountMinor: 900000 }]);
    subscribe(h, outside, [{ type: "subscription_started", at: T0 - 90 * DAY, amountMinor: 5_000_000 }]);
    const [m] = observedMovementForIdentities(h.db, h.projectId, [inside], T0 - 30 * DAY, T0);
    assert.equal(m!.startMrrMinor, 900000);
    assert.equal(m!.entityCount, 1);
  });

  test("currencies are reported separately, never summed", () => {
    const h = harness();
    h.event("u1", "page_viewed", T0 - 100 * DAY);
    h.event("u2", "page_viewed", T0 - 100 * DAY);
    const a = identityOf(h, "u1");
    const b = identityOf(h, "u2");
    subscribe(h, a, [{ type: "subscription_started", at: T0 - 90 * DAY, amountMinor: 900000 }]);
    const subId = subscribe(h, b, [{ type: "subscription_started", at: T0 - 90 * DAY, amountMinor: 4000 }]);
    h.db.run("UPDATE subscription_events SET currency = 'USD' WHERE subscription_id = ?", [subId]);
    const movements = observedMovementForIdentities(h.db, h.projectId, [a, b], T0 - 30 * DAY, T0);
    assert.equal(movements.length, 2);
    assert.deepEqual(movements.map((m) => m.currency).sort(), ["INR", "USD"]);
  });

  test("a cohort with no subscriptions yields nothing rather than zero", () => {
    const h = harness();
    h.event("u1", "page_viewed", T0 - DAY);
    const movements = observedMovementForIdentities(h.db, h.projectId, [identityOf(h, "u1")], T0 - 30 * DAY, T0);
    assert.deepEqual(movements, []);
  });

  test("an empty cohort yields nothing", () => {
    const h = harness();
    assert.deepEqual(observedMovementForIdentities(h.db, h.projectId, [], T0 - DAY, T0), []);
  });
});

// --- estimation ------------------------------------------------------------

describe("estimation", () => {
  const input = {
    label: "Fixing the import step",
    affectedUsers: 40,
    conversionDelta: 0.1,
    conversionDeltaSource: "default" as const,
    arpuMinor: 900000,
    arpuSource: "measured" as const,
    currency: "INR",
    horizonMonths: 6,
  };

  test("the point estimate is the product of the stated inputs", () => {
    const e = estimateMonthlyRevenue(input);
    assert.equal(e.classification, "estimated");
    assert.equal(e.amountMinor, 40 * 0.1 * 900000);
  });

  test("every input is recorded as an assumption with its source", () => {
    const e = estimateMonthlyRevenue(input);
    const names = e.assumptions.map((a) => a.name).sort();
    assert.deepEqual(names, ["affected_users", "arpu", "conversion_delta", "horizon"]);
    assert.equal(e.assumptions.find((a) => a.name === "conversion_delta")!.source, "default");
    assert.equal(e.assumptions.find((a) => a.name === "affected_users")!.source, "measured");
  });

  test("a range is always given alongside the point", () => {
    const e = estimateMonthlyRevenue(input);
    assert.ok(e.rangeMinor);
    assert.ok(e.rangeMinor![0] < e.amountMinor!);
    assert.ok(e.rangeMinor![1] > e.amountMinor!);
  });

  test("the method is stated so the arithmetic can be checked", () => {
    assert.match(estimateMonthlyRevenue(input).method, /affected_users . conversion_delta . arpu/);
  });

  test("a long horizon adds a limitation rather than being silently accepted", () => {
    const e = estimateMonthlyRevenue({ ...input, horizonMonths: 36 });
    assert.ok(e.limitations.some((l) => /36-month horizon/.test(l)));
  });

  test("a zero input produces no figure at all", () => {
    const e = estimateMonthlyRevenue({ ...input, affectedUsers: 0 });
    assert.equal(e.classification, "insufficient_evidence");
    assert.equal(e.amountMinor, null);
    assert.equal(e.rangeMinor, null);
  });

  test("an estimate never claims to be a measurement", () => {
    assert.ok(estimateMonthlyRevenue(input).limitations.some((l) => /model, not a measurement/.test(l)));
  });
});

// --- experiment-supported --------------------------------------------------

function runExperiment(rates: { control: number; treatment: number }, perArm = 1200) {
  const h = harness();
  const exp = must(createExperiment(h.db, { orgId: h.orgId, projectId: h.projectId, userId: h.userId }, {
    key: "import-flow",
    name: "Simpler import",
    primaryMetricEvent: "import_completed",
    primaryMetricKind: "conversion",
    minExposuresPerVariant: 200,
    guardrailMetrics: [],
    variants: [
      { key: "control", name: "Current", isControl: true, weight: 0.5 },
      { key: "treatment", name: "Simpler", weight: 0.5 },
    ],
  }));
  must(startExperiment(h.db, h.projectId, exp.id, T0 - 20 * DAY));
  for (const variant of ["control", "treatment"] as const) {
    const converts = Math.round(perArm * rates[variant]);
    for (let i = 0; i < perArm; i++) {
      const external = `${variant}-${i}`;
      h.event(external, "page_viewed", T0 - 19 * DAY + i);
      recordExposure(h.db, { orgId: h.orgId, projectId: h.projectId }, exp.id,
        identityOf(h, external), variant, T0 - 19 * DAY + i);
      if (i < converts) h.event(external, "import_completed", T0 - 19 * DAY + i + 1000);
    }
  }
  return { h, experimentId: exp.id };
}

describe("experiment-supported impact", () => {
  test("a clear win is experiment_supported and carries its interval", () => {
    const { h, experimentId } = runExperiment({ control: 0.2, treatment: 0.32 });
    const impact = experimentSupportedImpact(h.db, h.projectId, experimentId, T0);
    assert.equal(impact.classification, "experiment_supported");
    assert.equal(impact.verdict, "improvement_supported");
    assert.ok(impact.effect);
    assert.ok(impact.effect!.interval);
  });

  test("a null result is insufficient evidence, with the verdict reported", () => {
    const { h, experimentId } = runExperiment({ control: 0.2, treatment: 0.201 });
    const impact = experimentSupportedImpact(h.db, h.projectId, experimentId, T0);
    assert.equal(impact.classification, "insufficient_evidence");
    assert.equal(impact.effect, null);
    assert.ok(impact.reasons.some((r) => /does not support a revenue claim/.test(r)));
  });

  test("an underpowered experiment is insufficient evidence", () => {
    const { h, experimentId } = runExperiment({ control: 0.2, treatment: 0.4 }, 20);
    const impact = experimentSupportedImpact(h.db, h.projectId, experimentId, T0);
    assert.equal(impact.classification, "insufficient_evidence");
  });

  test("an unknown experiment is reported rather than guessed at", () => {
    const h = harness();
    const impact = experimentSupportedImpact(h.db, h.projectId, "exp_nope", T0);
    assert.equal(impact.classification, "insufficient_evidence");
    assert.equal(impact.verdict, "not_found");
  });
});

// --- persistence and validation -------------------------------------------

describe("recording impact", () => {
  const ok = (h: ReturnType<typeof harness>) => ({ orgId: h.orgId, projectId: h.projectId, userId: h.userId });

  test("an observed record stores and reads back", () => {
    const h = harness();
    const r = must(recordImpact(h.db, ok(h), {
      label: "MRR lost among affected accounts",
      classification: "observed",
      basis: basis({ billingRecordsForExactEntities: true, entityCount: 4 }),
      amountMinor: 3_600_000,
      currency: "INR",
      method: "Sum of MRR at the start of the window for accounts that were paying then and are not now.",
      periodStart: T0 - 30 * DAY,
      periodEnd: T0,
    }, T0));
    assert.equal(r.classification, "observed");
    const [stored] = listImpactRecords(h.db, h.projectId);
    assert.equal(stored!.amountMinor, 3_600_000);
    assert.equal(stored!.classification, "observed");
  });

  test("a claim stronger than the evidence is refused", () => {
    const h = harness();
    const e = mustFail(recordImpact(h.db, ok(h), {
      label: "Revenue saved",
      classification: "observed",
      basis: basis({ observationalComparison: true }),
      amountMinor: 5_000_000,
      currency: "INR",
      method: "Compared the month before and the month after the fix.",
    }, T0));
    assert.equal(e.code, "validation_failed");
    assert.match(e.message, /supports at most "associated"/);
  });

  test("a weaker claim than the evidence supports is allowed", () => {
    // Understating is always permitted; overstating never is.
    const h = harness();
    must(recordImpact(h.db, ok(h), {
      label: "Churn among affected accounts",
      classification: "associated",
      basis: basis({ billingRecordsForExactEntities: true }),
      amountMinor: 900000,
      currency: "INR",
      method: "Observed churn, reported conservatively while the cause is still unclear.",
    }, T0));
    assert.equal(listImpactRecords(h.db, h.projectId).length, 1);
  });

  test("assumptions alone downgrade an observed claim", () => {
    const h = harness();
    const e = mustFail(recordImpact(h.db, ok(h), {
      label: "Recovered revenue",
      classification: "observed",
      basis: basis({ billingRecordsForExactEntities: true, assumptions: [measured("share", "0.5")] }),
      amountMinor: 100,
      currency: "INR",
      method: "Sum of billing rows, adjusted.",
    }, T0));
    assert.match(e.message, /supports at most "estimated"/);
  });

  test("an observed figure cannot carry assumptions even behind an experiment", () => {
    // Strong evidence elsewhere does not launder a modelled figure into a
    // measured one: the shape of the claim is checked on its own terms.
    const h = harness();
    const e = mustFail(recordImpact(h.db, ok(h), {
      label: "Recovered revenue",
      classification: "observed",
      basis: basis({
        randomisedExperimentId: "exp_1", experimentConclusive: true,
        assumptions: [measured("share", "0.5")],
      }),
      amountMinor: 100,
      currency: "INR",
      method: "Sum of billing rows, adjusted by the experiment's effect size.",
    }, T0));
    assert.match(e.message, /it is an estimate/);
  });

  test("an estimate with no assumptions is refused", () => {
    const h = harness();
    const e = mustFail(recordImpact(h.db, ok(h), {
      label: "Projected uplift",
      classification: "estimated",
      basis: basis({ billingRecordsForExactEntities: true }),
      amountMinor: 100,
      currency: "INR",
      method: "A model.",
    }, T0));
    assert.match(e.message, /assumptions it rests on/);
  });

  test("insufficient evidence cannot carry an amount", () => {
    const h = harness();
    const e = mustFail(recordImpact(h.db, ok(h), {
      label: "Unclear",
      classification: "insufficient_evidence",
      basis: basis({ entityCount: 0 }),
      amountMinor: 1_000_000,
      currency: "INR",
      method: "Nothing conclusive.",
    }, T0));
    assert.match(e.message, /cannot carry an amount/);
  });

  test("a figure with no method is refused", () => {
    const h = harness();
    const e = mustFail(recordImpact(h.db, ok(h), {
      label: "Impact",
      classification: "observed",
      basis: basis({ billingRecordsForExactEntities: true }),
      amountMinor: 100,
      currency: "INR",
      method: "   ",
    }, T0));
    assert.match(e.message, /cannot be checked/);
  });

  test("an amount with no currency is refused", () => {
    const h = harness();
    const e = mustFail(recordImpact(h.db, ok(h), {
      label: "Impact",
      classification: "observed",
      basis: basis({ billingRecordsForExactEntities: true }),
      amountMinor: 100,
      method: "Summed from billing.",
    }, T0));
    assert.match(e.message, /needs a currency/);
  });

  test("an insufficient-evidence record with no amount is still worth storing", () => {
    const h = harness();
    must(recordImpact(h.db, ok(h), {
      label: "Effect of the onboarding change",
      classification: "insufficient_evidence",
      basis: basis({ entityCount: 0 }),
      method: "Too few accounts in the window to say anything.",
    }, T0));
    const [stored] = listImpactRecords(h.db, h.projectId);
    assert.equal(stored!.amountMinor, null);
    assert.equal(stored!.classification, "insufficient_evidence");
  });
});

// --- summary ---------------------------------------------------------------

describe("summary", () => {
  function seed(h: ReturnType<typeof harness>) {
    const ids = { orgId: h.orgId, projectId: h.projectId, userId: h.userId };
    must(recordImpact(h.db, ids, {
      label: "Churned MRR, affected accounts",
      classification: "observed",
      basis: basis({ billingRecordsForExactEntities: true, entityCount: 4 }),
      amountMinor: 3_600_000, currency: "INR",
      method: "Billing rows.",
    }, T0));
    must(recordImpact(h.db, ids, {
      label: "Projected uplift from the fix",
      classification: "estimated",
      basis: basis({ assumptions: [measured("affected_users", "40")] }),
      amountMinor: 3_600_000, currency: "INR",
      method: "Model.",
    }, T0));
    must(recordImpact(h.db, ids, {
      label: "Unclear effect",
      classification: "insufficient_evidence",
      basis: basis({ entityCount: 0 }),
      method: "Nothing to say.",
    }, T0));
    return ids;
  }

  test("observed and estimated amounts are never added together", () => {
    const h = harness();
    seed(h);
    const summary = impactSummary(h.db, h.projectId);
    assert.equal(summary.buckets.length, 2);
    for (const bucket of summary.buckets) assert.equal(bucket.totalMinor, 3_600_000);
    // And there is no field that holds 7,200,000.
    assert.ok(!Object.values(summary).includes(7_200_000));
  });

  test("the strongest evidence is listed first", () => {
    const h = harness();
    seed(h);
    const summary = impactSummary(h.db, h.projectId);
    assert.equal(summary.buckets[0]!.classification, "observed");
    assert.equal(summary.buckets[1]!.classification, "estimated");
  });

  test("records with no amount are counted rather than dropped", () => {
    const h = harness();
    seed(h);
    assert.equal(impactSummary(h.db, h.projectId).recordsWithoutAmount, 1);
  });

  test("every bucket carries what its classification means", () => {
    const h = harness();
    seed(h);
    for (const bucket of impactSummary(h.db, h.projectId).buckets) {
      assert.ok(bucket.meaning.length > 40, `${bucket.classification} has no meaning text`);
    }
  });

  test("the disclaimer about summing travels with the summary", () => {
    const h = harness();
    seed(h);
    assert.match(impactSummary(h.db, h.projectId).disclaimer, /never summed/);
  });

  test("one project's records never appear in another's summary", () => {
    const a = harness();
    const b = harness();
    seed(a);
    assert.deepEqual(impactSummary(b.db, b.projectId).buckets, []);
  });
});

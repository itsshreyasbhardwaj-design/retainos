import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detectFrictionCases, persistFrictionCases, refreshFrictionGraph, deriveRelationships,
  listFrictionCases, getFrictionCase, transitionCase, canTransitionCase, linkCaseToImprovement,
  revenueExposureFor, segmentConcentration, identitiesWhoStalled, caseIdentityIds,
  RELATIONSHIP_STRENGTH, type EvidenceItem,
} from "../src/friction.ts";
import { upsertActivationDefinition } from "../src/activation.ts";
import { recordError, submitFeedback, createImprovement, applyProviderEvent } from "@retainos/database";
import { rebuildClusters } from "../src/clustering.ts";
import { harness, must, mustFail, DAY, HOUR, T0 } from "./helpers.ts";

const NOW = T0 + 60 * DAY;

function item(over: Partial<EvidenceItem> & { localId: string }): EvidenceItem {
  return {
    kind: "note",
    referenceId: null,
    source: "retainos",
    summary: "s",
    snapshot: {},
    observedAt: NOW,
    userIds: new Set<string>(),
    ...over,
  };
}

describe("deriveRelationships", () => {
  test("links two signals that share actual users, and reports the overlap", () => {
    const rels = deriveRelationships([
      item({ localId: "a", userIds: new Set(["u1", "u2", "u3", "u4"]) }),
      item({ localId: "b", userIds: new Set(["u2", "u3", "u9"]) }),
    ]);
    const shared = rels.find((r) => r.relationship === "shared_affected_users")!;
    assert.ok(shared, "overlapping user sets must produce a link");
    assert.equal(shared.sharedKey, "2");
    assert.match(shared.basis, /2 of the 3 users/);
    assert.match(shared.basis, /same people, not a correlation/);
    assert.equal(shared.strength, RELATIONSHIP_STRENGTH.shared_affected_users);
  });

  test("does NOT link two signals with no shared key at all", () => {
    const rels = deriveRelationships([
      item({ localId: "a", userIds: new Set(["u1"]), observedAt: NOW }),
      item({ localId: "b", userIds: new Set(["u2"]), observedAt: NOW - 90 * DAY }),
    ]);
    assert.deepEqual(rels, [], "no shared users, no shared workflow, far apart in time: no link");
  });

  test("links on a shared workflow", () => {
    const rels = deriveRelationships([
      item({ localId: "a", workflow: "checkout" }),
      item({ localId: "b", workflow: "checkout" }),
    ]);
    assert.ok(rels.some((r) => r.relationship === "same_workflow" && r.sharedKey === "checkout"));
  });

  test("does not link different workflows", () => {
    const rels = deriveRelationships([
      item({ localId: "a", workflow: "checkout", observedAt: NOW }),
      item({ localId: "b", workflow: "onboarding", observedAt: NOW - 90 * DAY }),
    ]);
    assert.ok(!rels.some((r) => r.relationship === "same_workflow"));
  });

  test("links on a shared error fingerprint and says it came from the sender", () => {
    const rels = deriveRelationships([
      item({ localId: "a", errorFingerprint: "TypeError:save" }),
      item({ localId: "b", errorFingerprint: "TypeError:save" }),
    ]);
    const r = rels.find((x) => x.relationship === "same_error_fingerprint")!;
    assert.ok(r);
    assert.match(r.basis, /sender's own\s+grouping key rather than anything RetainOS inferred/);
  });

  test("a release links forward in time only, and never backwards", () => {
    const release = item({ localId: "rel", kind: "release", observedAt: NOW - 3 * DAY });
    const after = item({ localId: "after", observedAt: NOW });
    const before = item({ localId: "before", observedAt: NOW - 30 * DAY });

    const forward = deriveRelationships([release, after]);
    assert.ok(forward.some((r) => r.relationship === "same_release_window"));
    assert.match(forward.find((r) => r.relationship === "same_release_window")!.basis, /not evidence that the release caused it/);

    const backward = deriveRelationships([release, before]);
    assert.ok(!backward.some((r) => r.relationship === "same_release_window"),
      "a signal from before the release cannot be in its window");
  });

  test("temporal proximity only fires when nothing stronger connects the two", () => {
    // Shared users AND close in time: only the strong link is recorded.
    const strong = deriveRelationships([
      item({ localId: "a", userIds: new Set(["u1"]), observedAt: NOW }),
      item({ localId: "b", userIds: new Set(["u1"]), observedAt: NOW - HOUR }),
    ]);
    assert.ok(strong.some((r) => r.relationship === "shared_affected_users"));
    assert.ok(!strong.some((r) => r.relationship === "temporal_proximity"),
      "temporal proximity must not clutter a graph that already has a real link");

    // Nothing else in common, but close in time: the weak link is recorded,
    // and labelled as weak.
    const weak = deriveRelationships([
      item({ localId: "a", observedAt: NOW }),
      item({ localId: "b", observedAt: NOW - HOUR }),
    ]);
    const t = weak.find((r) => r.relationship === "temporal_proximity")!;
    assert.ok(t);
    assert.match(t.basis, /weakest kind of link/);
  });

  test("relationship strengths are ordered so shared users outrank coincidence", () => {
    assert.ok(RELATIONSHIP_STRENGTH.shared_affected_users > RELATIONSHIP_STRENGTH.same_workflow);
    assert.ok(RELATIONSHIP_STRENGTH.same_workflow > RELATIONSHIP_STRENGTH.same_product_version);
    assert.ok(RELATIONSHIP_STRENGTH.same_product_version > RELATIONSHIP_STRENGTH.temporal_proximity);
  });
});

describe("identitiesWhoStalled", () => {
  test("returns users who reached the first event but not the second", () => {
    const h = harness("UTC");
    for (let i = 0; i < 10; i++) {
      h.event(`u${i}`, "onboarding_started", NOW - 5 * DAY);
      if (i < 4) h.event(`u${i}`, "onboarding_completed", NOW - 5 * DAY + HOUR);
    }
    const stalled = identitiesWhoStalled(
      h.db, h.projectId, "onboarding_started", "onboarding_completed", NOW - 30 * DAY, NOW,
    );
    assert.equal(stalled.size, 6);
  });
});

describe("revenue exposure", () => {
  test("sums normalised MRR for the affected users only", () => {
    const h = harness("UTC");
    h.event("payer", "signup_completed", NOW - 30 * DAY);
    h.event("free", "signup_completed", NOW - 30 * DAY);
    const payerId = h.db.get<{ id: string }>("SELECT id FROM identities WHERE external_id = 'payer'")!.id;

    must(applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      provider: "simulator", externalEventId: "e1", externalSubscriptionId: "s1",
      type: "subscription_started", occurredAt: NOW - 20 * DAY,
      amountMinor: 1_198_800, currency: "INR", interval: "year", externalUserId: "payer",
    }));

    const exposure = revenueExposureFor(h.db, h.projectId, new Set([payerId]));
    // An annual plan contributes one twelfth, as everywhere else in RetainOS.
    assert.equal(exposure.amountMinor, 99_900);
    assert.equal(exposure.currency, "INR");
    assert.equal(exposure.subscriptions, 1);

    const freeId = h.db.get<{ id: string }>("SELECT id FROM identities WHERE external_id = 'free'")!.id;
    assert.equal(revenueExposureFor(h.db, h.projectId, new Set([freeId])).amountMinor, 0);
  });

  test("an empty set exposes nothing rather than everything", () => {
    const h = harness("UTC");
    assert.deepEqual(revenueExposureFor(h.db, h.projectId, new Set()),
      { amountMinor: 0, currency: null, subscriptions: 0 });
  });
});

describe("segmentConcentration", () => {
  test("reports a dimension only when the problem is genuinely concentrated", () => {
    const h = harness("UTC");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      // 9 of 10 affected users are on the free plan: concentrated.
      // Device is evenly split: not concentrated.
      h.event(`u${i}`, "signup_completed", NOW - 10 * DAY, {
        plan: i < 9 ? "free" : "growth",
        device: i % 2 === 0 ? "mobile" : "desktop",
      });
      ids.push(h.db.get<{ id: string }>("SELECT id FROM identities WHERE external_id = ?", [`u${i}`])!.id);
    }
    const segments = segmentConcentration(h.db, h.projectId, new Set(ids));
    const plan = segments.find((s) => s.dimension === "plan");
    assert.ok(plan, "a 90% concentration must be reported");
    assert.equal(plan!.value, "free");
    assert.equal(plan!.users, 9);
    assert.ok(!segments.some((s) => s.dimension === "device_category"),
      "a 50/50 split is exactly what chance gives you, not a concentration");
  });

  test("the threshold sits above an even two-way split", () => {
    // 60/40 is not enough; it is barely distinguishable from chance.
    const h = harness("UTC");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      h.event(`u${i}`, "signup_completed", NOW - 10 * DAY, { plan: i < 6 ? "free" : "growth" });
      ids.push(h.db.get<{ id: string }>("SELECT id FROM identities WHERE external_id = ?", [`u${i}`])!.id);
    }
    assert.ok(!segmentConcentration(h.db, h.projectId, new Set(ids)).some((s) => s.dimension === "plan"));
  });
});

describe("detectFrictionCases", () => {
  /** A project with a funnel drop-off, errors and feedback from the SAME users. */
  function projectWithConvergingSignals() {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "First project", activationEvent: "project_created",
      signupEvent: "signup_completed", windowDays: 7, isPrimary: true,
    }));

    const base = NOW - 20 * DAY;
    const stalledUsers: string[] = [];
    for (let i = 0; i < 60; i++) {
      const u = `u${i}`;
      h.event(u, "signup_completed", base + i * 1000);
      h.event(u, "onboarding_started", base + i * 1000 + HOUR);
      if (i < 20) {
        h.event(u, "onboarding_completed", base + i * 1000 + 2 * HOUR);
        h.event(u, "project_created", base + i * 1000 + 3 * HOUR);
      } else {
        stalledUsers.push(u);
      }
    }

    // The stalled users hit an error and wrote in about it.
    for (const u of stalledUsers.slice(0, 15)) {
      const identityId = h.db.get<{ id: string }>(
        "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, u],
      )!.id;
      must(recordError(h.db, { orgId: h.orgId, projectId: h.projectId }, {
        fingerprint: "TypeError:template-picker",
        title: "Cannot read property of undefined in template picker",
        workflow: "onboarding_started → onboarding_completed",
        timestamp: base + 4 * HOUR,
        productVersion: "2.1.0",
      }, { identityId }));
      must(submitFeedback(h.db, { orgId: h.orgId, projectId: h.projectId }, {
        kind: "confusion",
        title: "Template picker is confusing and broken",
        body: "The template picker in onboarding is confusing and throws an error",
        source: "widget",
        identityId,
      }, base + 5 * HOUR));
    }
    rebuildClusters(h.db, { orgId: h.orgId, projectId: h.projectId }, {}, NOW);
    return { h, stalledUsers };
  }

  test("finds the activation drop-off and names the users behind it", () => {
    const { h } = projectWithConvergingSignals();
    const cases = detectFrictionCases(h.db, h.projectId, { timezone: "UTC", now: NOW });
    const activation = cases.find((c) => c.kind === "activation_friction")!;
    assert.ok(activation, `expected an activation case, got: ${cases.map((c) => c.kind).join(", ")}`);
    assert.equal(activation.affectedUserIds.size, 40, "60 started onboarding, 20 completed it");
    assert.match(activation.observation, /40 of 60 users/);
  });

  test("joins the error and the feedback to the drop-off, by shared users", () => {
    const { h } = projectWithConvergingSignals();
    const cases = detectFrictionCases(h.db, h.projectId, { timezone: "UTC", now: NOW });
    const activation = cases.find((c) => c.kind === "activation_friction")!;

    const kinds = activation.evidence.map((e) => e.kind);
    assert.ok(kinds.includes("funnel_step"), "the triggering signal");
    assert.ok(kinds.includes("error_group"), "errors hit by the stalled users");
    assert.ok(kinds.includes("feedback_cluster") || kinds.includes("feedback_item"),
      `feedback from the stalled users; got ${kinds.join(", ")}`);

    // And the links between them come from real overlap.
    const shared = activation.relationships.filter((r) => r.relationship === "shared_affected_users");
    assert.ok(shared.length > 0, "the signals must be joined by the users they share");
    assert.ok(shared.every((r) => Number(r.sharedKey) > 0));
  });

  test("a case with corroboration from an independent source rates higher than one without", () => {
    const { h } = projectWithConvergingSignals();
    const corroborated = detectFrictionCases(h.db, h.projectId, { timezone: "UTC", now: NOW })
      .find((c) => c.kind === "activation_friction")!;

    // Same funnel, but with no errors or feedback attached.
    const bare = harness("UTC");
    must(upsertActivationDefinition(bare.db, { orgId: bare.orgId, projectId: bare.projectId }, {
      name: "A", activationEvent: "project_created", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }));
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 60; i++) {
      bare.event(`u${i}`, "signup_completed", base + i * 1000);
      bare.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
      if (i < 20) {
        bare.event(`u${i}`, "onboarding_completed", base + i * 1000 + 2 * HOUR);
        bare.event(`u${i}`, "project_created", base + i * 1000 + 3 * HOUR);
      }
    }
    const lonely = detectFrictionCases(bare.db, bare.projectId, { timezone: "UTC", now: NOW })
      .find((c) => c.kind === "activation_friction")!;

    assert.ok(lonely.limitations.some((l) => /single kind of evidence/.test(l)),
      "an uncorroborated case must say so");
    assert.ok(!corroborated.limitations.some((l) => /single kind of evidence/.test(l)));
  });

  test("every case separates observation from hypothesis", () => {
    const { h } = projectWithConvergingSignals();
    for (const c of detectFrictionCases(h.db, h.projectId, { timezone: "UTC", now: NOW })) {
      assert.ok(!/\bmay\b|\bmight\b|\bprobably\b/i.test(c.observation),
        `observation must not speculate: "${c.observation}"`);
      assert.ok(c.hypotheses.length >= 2, `${c.kind} needs hypotheses`);
      assert.ok(c.limitations.length > 0, `${c.kind} must state its limitations`);
      assert.ok(c.recommendedInvestigations.length > 0, `${c.kind} must suggest what would settle it`);
    }
  });

  test("detects a reliability case from an error cluster", () => {
    const { h } = projectWithConvergingSignals();
    const cases = detectFrictionCases(h.db, h.projectId, { timezone: "UTC", now: NOW });
    const reliability = cases.find((c) => c.kind === "reliability")!;
    assert.ok(reliability);
    assert.match(reliability.observation, /15 distinct users/);
    assert.ok(reliability.limitations.some((l) => /not an error monitor/.test(l)));
  });

  test("detects billing friction from verified past-due state", () => {
    const h = harness("UTC");
    h.event("payer", "signup_completed", NOW - 40 * DAY);
    must(applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      provider: "simulator", externalEventId: "e1", externalSubscriptionId: "s1",
      type: "subscription_started", occurredAt: NOW - 40 * DAY,
      amountMinor: 99_900, currency: "INR", interval: "month", externalUserId: "payer",
    }));
    must(applyProviderEvent(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      provider: "simulator", externalEventId: "e2", externalSubscriptionId: "s1",
      type: "payment_failed", occurredAt: NOW - DAY,
      amountMinor: 99_900, currency: "INR", interval: "month",
    }));
    const cases = detectFrictionCases(h.db, h.projectId, { timezone: "UTC", now: NOW, minAffectedUsers: 1 });
    const billing = cases.find((c) => c.kind === "billing_friction")!;
    assert.ok(billing);
    assert.match(billing.observation, /verified billing state from provider/);
    assert.ok(billing.hypotheses.some((hy) => /expired or replaced card/.test(hy)));
  });

  test("an empty project produces no cases rather than invented ones", () => {
    const h = harness("UTC");
    assert.deepEqual(detectFrictionCases(h.db, h.projectId, { timezone: "UTC", now: NOW }), []);
  });

  test("a signal below the minimum affected users is not raised", () => {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "A", activationEvent: "project_created", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }));
    for (let i = 0; i < 3; i++) {
      h.event(`u${i}`, "signup_completed", NOW - 5 * DAY);
      h.event(`u${i}`, "onboarding_started", NOW - 5 * DAY + HOUR);
    }
    assert.deepEqual(
      detectFrictionCases(h.db, h.projectId, { timezone: "UTC", now: NOW, minAffectedUsers: 10 }), [],
    );
  });
});

describe("persistence", () => {
  function seeded() {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "A", activationEvent: "project_created", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }));
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 60; i++) {
      h.event(`u${i}`, "signup_completed", base + i * 1000);
      h.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
      if (i < 20) {
        h.event(`u${i}`, "onboarding_completed", base + i * 1000 + 2 * HOUR);
        h.event(`u${i}`, "project_created", base + i * 1000 + 3 * HOUR);
      }
    }
    return h;
  }

  test("stores cases with their evidence and relationships", () => {
    const h = seeded();
    const r = refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId },
      { timezone: "UTC", now: NOW });
    assert.ok(r.created > 0);
    const cases = listFrictionCases(h.db, h.projectId);
    assert.equal(cases.length, r.created);
    const detail = getFrictionCase(h.db, h.projectId, String(cases[0]!.id))!;
    assert.ok(detail.evidence.length > 0);
    assert.equal(String(detail.record.status), "detected");
    assert.equal(String(detail.record.detector), "rules_v1");
  });

  test("re-running updates in place rather than duplicating", () => {
    const h = seeded();
    const first = refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId },
      { timezone: "UTC", now: NOW });
    const second = refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId },
      { timezone: "UTC", now: NOW + HOUR });
    assert.equal(second.created, 0);
    assert.equal(second.updated, first.created);
    assert.equal(listFrictionCases(h.db, h.projectId).length, first.created);
  });

  test("re-running never resurrects a dismissed case or resets an investigation", () => {
    const h = seeded();
    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW });
    const caseId = String(listFrictionCases(h.db, h.projectId)[0]!.id);
    const ids = { orgId: h.orgId, projectId: h.projectId, userId: h.userId };

    must(transitionCase(h.db, ids, caseId, "investigating", "Looking into it", NOW));
    must(transitionCase(h.db, ids, caseId, "evidence_collected", undefined, NOW));

    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW + DAY });
    assert.equal(
      String(getFrictionCase(h.db, h.projectId, caseId)!.record.status), "evidence_collected",
      "a human's decision must survive re-detection",
    );
  });

  test("a case remembers which people it is about, not just how many", () => {
    const h = seeded();
    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW });
    const record = listFrictionCases(h.db, h.projectId)[0]!;
    const members = caseIdentityIds(h.db, h.projectId, String(record.id));
    // The count on the record is derived from the set, not asserted beside it.
    assert.ok(members.length > 0, "a case with affected users must store them");
    assert.equal(members.length, Number(record.affected_users));
    assert.equal(new Set(members).size, members.length, "no duplicates");
  });

  test("membership is replaced on re-detection rather than accumulated", () => {
    const h = seeded();
    const ids = { orgId: h.orgId, projectId: h.projectId };
    refreshFrictionGraph(h.db, ids, { timezone: "UTC", now: NOW });
    const caseId = String(listFrictionCases(h.db, h.projectId)[0]!.id);
    const before = caseIdentityIds(h.db, h.projectId, caseId).length;
    refreshFrictionGraph(h.db, ids, { timezone: "UTC", now: NOW + HOUR });
    assert.equal(caseIdentityIds(h.db, h.projectId, caseId).length, before);
  });

  test("another project cannot read a case's membership", () => {
    const h = seeded();
    const other = harness("UTC");
    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW });
    const caseId = String(listFrictionCases(h.db, h.projectId)[0]!.id);
    assert.deepEqual(caseIdentityIds(h.db, other.projectId, caseId), []);
  });

  test("erasing a user removes them from every case", () => {
    const h = seeded();
    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW });
    const caseId = String(listFrictionCases(h.db, h.projectId)[0]!.id);
    const members = caseIdentityIds(h.db, h.projectId, caseId);
    assert.ok(members.length > 0);
    h.db.run("DELETE FROM identities WHERE id = ?", [members[0]!]);
    const after = caseIdentityIds(h.db, h.projectId, caseId);
    assert.equal(after.length, members.length - 1);
    assert.ok(!after.includes(members[0]!));
  });

  test("evidence is replaced, not accumulated, across runs", () => {
    const h = seeded();
    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW });
    const caseId = String(listFrictionCases(h.db, h.projectId)[0]!.id);
    const before = getFrictionCase(h.db, h.projectId, caseId)!.evidence.length;
    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW + HOUR });
    assert.equal(getFrictionCase(h.db, h.projectId, caseId)!.evidence.length, before);
  });
});

describe("case workflow", () => {
  function caseInProject() {
    const h = harness("UTC");
    must(upsertActivationDefinition(h.db, { orgId: h.orgId, projectId: h.projectId }, {
      name: "A", activationEvent: "project_created", signupEvent: "signup_completed",
      windowDays: 7, isPrimary: true,
    }));
    const base = NOW - 20 * DAY;
    for (let i = 0; i < 40; i++) {
      h.event(`u${i}`, "signup_completed", base + i * 1000);
      h.event(`u${i}`, "onboarding_started", base + i * 1000 + HOUR);
      if (i < 10) h.event(`u${i}`, "onboarding_completed", base + i * 1000 + 2 * HOUR);
    }
    refreshFrictionGraph(h.db, { orgId: h.orgId, projectId: h.projectId }, { timezone: "UTC", now: NOW });
    const caseId = String(listFrictionCases(h.db, h.projectId)[0]!.id);
    return { h, caseId, ids: { orgId: h.orgId, projectId: h.projectId, userId: h.userId } };
  }

  test("a case cannot skip from detected straight to resolved", () => {
    const { h, caseId, ids } = caseInProject();
    assert.equal(mustFail(transitionCase(h.db, ids, caseId, "resolved", undefined, NOW)).code, "conflict");
    assert.equal(canTransitionCase("detected", "resolved"), false);
    assert.equal(canTransitionCase("detected", "investigating"), true);
  });

  test("the full path to resolved is permitted, and recorded", () => {
    const { h, caseId, ids } = caseInProject();
    for (const next of ["investigating", "evidence_collected", "validated", "approved",
                        "in_development", "released", "measuring", "resolved"] as const) {
      must(transitionCase(h.db, ids, caseId, next, undefined, NOW));
    }
    const detail = getFrictionCase(h.db, h.projectId, caseId)!;
    assert.equal(String(detail.record.status), "resolved");
    assert.ok(detail.history.length >= 9, "every step is recorded, including the initial detection");
  });

  test("dismissing records the reason", () => {
    const { h, caseId, ids } = caseInProject();
    must(transitionCase(h.db, ids, caseId, "dismissed", "Known and intentional", NOW));
    const detail = getFrictionCase(h.db, h.projectId, caseId)!;
    assert.equal(String(detail.record.dismissed_reason), "Known and intentional");
  });

  test("a case can be promoted into a FixFlow improvement", () => {
    const { h, caseId } = caseInProject();
    const imp = must(createImprovement(h.db, h.scope, { title: "Fix the onboarding template step" }));
    must(linkCaseToImprovement(h.db, h.projectId, caseId, imp.id, NOW));
    assert.equal(String(getFrictionCase(h.db, h.projectId, caseId)!.record.improvement_id), imp.id);
  });

  test("an improvement from another project cannot be linked", () => {
    const { h, caseId } = caseInProject();
    const other = harness("UTC");
    const imp = must(createImprovement(other.db, other.scope, { title: "Someone else's work" }));
    assert.equal(mustFail(linkCaseToImprovement(h.db, h.projectId, caseId, imp.id, NOW)).code, "not_found");
  });

  test("a case in another project is not found", () => {
    const { h } = caseInProject();
    const other = harness("UTC");
    assert.equal(getFrictionCase(other.db, other.projectId, "fcs_nope"), null);
    assert.equal(
      mustFail(transitionCase(other.db,
        { orgId: other.orgId, projectId: other.projectId, userId: other.userId },
        "fcs_nope", "investigating", undefined, NOW)).code,
      "not_found",
    );
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { harness, must, mustFail, DAY, HOUR, T0 } from "./helpers.ts";
import {
  upsertPlaybook, getPlaybook, listPlaybooks, approvePlaybook, setPlaybookStatus,
  setMessagingConsent, hasMessagingConsent, evaluateEnrolment, enrolIdentities,
  dueMessages, markDelivered, measurePlaybook, suppressionSummary,
  manipulativePhrasesIn, PLAYBOOK_KIND_RULES, CANCELLATION_RULE,
  MIN_HOLDOUT_PERCENT, type PlaybookInput, type Playbook,
} from "../src/playbooks.ts";

function identityOf(h: ReturnType<typeof harness>, external: string): string {
  return h.db.get<{ id: string }>(
    "SELECT id FROM identities WHERE project_id = ? AND external_id = ?", [h.projectId, external],
  )!.id;
}

const BASE: PlaybookInput = {
  name: "Onboarding recovery",
  kind: "onboarding_recovery",
  triggerKind: "funnel_stalled",
  triggerConfig: { fromEvent: "signup_completed", toEvent: "project_published" },
  delayHours: 24,
  channel: "in_app",
  messageTitle: "Stuck on the import step?",
  messageBody: "You started a project and stopped at the import step. Here is how that step works.",
  helpUrl: "https://example.com/help/import",
  primaryMetricEvent: "project_published",
  holdoutPercent: 0.2,
};

function makeActive(h: ReturnType<typeof harness>, over: Partial<PlaybookInput> = {}): Playbook {
  const ids = { orgId: h.orgId, projectId: h.projectId, userId: h.userId };
  const { id } = must(upsertPlaybook(h.db, ids, { ...BASE, ...over }, T0));
  must(approvePlaybook(h.db, { projectId: h.projectId, userId: h.userId }, id, T0));
  must(setPlaybookStatus(h.db, h.projectId, id, "active", T0));
  return getPlaybook(h.db, h.projectId, id)!;
}

// --- creation rules --------------------------------------------------------

describe("creation", () => {
  const ids = (h: ReturnType<typeof harness>) =>
    ({ orgId: h.orgId, projectId: h.projectId, userId: h.userId });

  test("a playbook is created as a draft, never active", () => {
    const h = harness();
    const { id } = must(upsertPlaybook(h.db, ids(h), BASE, T0));
    assert.equal(getPlaybook(h.db, h.projectId, id)!.status, "draft");
  });

  test("a holdout below the floor is refused", () => {
    const h = harness();
    const e = mustFail(upsertPlaybook(h.db, ids(h), { ...BASE, holdoutPercent: 0.01 }, T0));
    assert.match(e.message, /cannot measure whether the playbook does anything/);
  });

  test("a holdout of zero is refused outright", () => {
    const h = harness();
    const e = mustFail(upsertPlaybook(h.db, ids(h), { ...BASE, holdoutPercent: 0 }, T0));
    assert.match(e.message, new RegExp(`${MIN_HOLDOUT_PERCENT * 100}%`));
  });

  test("an instant outbound message is refused", () => {
    const h = harness();
    const e = mustFail(upsertPlaybook(h.db, ids(h), { ...BASE, delayHours: 0 }, T0));
    assert.match(e.message, /reads as surveillance/);
  });

  test("pressure tactics in the copy are refused by name", () => {
    const h = harness();
    const e = mustFail(upsertPlaybook(h.db, ids(h), {
      ...BASE, messageBody: "Last chance to finish setting up before it's too late!",
    }, T0));
    assert.match(e.message, /"last chance"/);
    assert.match(e.message, /before it's too late/);
  });

  test("the manipulative-phrase check is a readable list, not a hidden model", () => {
    assert.deepEqual(manipulativePhrasesIn("Your streak is about to expire in an hour"),
      ["expires in", "your streak"].filter((p) => "your streak is about to expire in an hour".includes(p)));
    assert.deepEqual(manipulativePhrasesIn("We fixed the bug you reported."), []);
  });

  test("a cancellation playbook cannot trigger before the cancellation completes", () => {
    const h = harness();
    const e = mustFail(upsertPlaybook(h.db, ids(h), {
      ...BASE, name: "Why did you go?", kind: "cancellation_feedback",
      triggerKind: "event_occurred", triggerConfig: { event: "cancel_clicked" },
    }, T0));
    assert.match(e.message, /never earlier/);
    assert.match(CANCELLATION_RULE, /will not help delay, complicate or discourage/);
  });

  test("a cancellation playbook on a completed cancellation is allowed", () => {
    const h = harness();
    must(upsertPlaybook(h.db, ids(h), {
      ...BASE, name: "Why did you go?", kind: "cancellation_feedback",
      triggerKind: "subscription_state", triggerConfig: { state: "cancelled" },
      messageTitle: "Can you tell us what happened?",
      messageBody: "Your subscription has ended. If you have a minute, we would like to know why.",
    }, T0));
    assert.equal(listPlaybooks(h.db, h.projectId).length, 1);
  });

  test("a funnel from an event to itself is refused", () => {
    const h = harness();
    const e = mustFail(upsertPlaybook(h.db, ids(h), {
      ...BASE, triggerConfig: { fromEvent: "page_viewed", toEvent: "page_viewed" },
    }, T0));
    assert.match(e.message, /has no audience/);
  });

  test("a stalled-funnel trigger missing a step is refused", () => {
    const h = harness();
    const e = mustFail(upsertPlaybook(h.db, ids(h), {
      ...BASE, triggerConfig: { fromEvent: "signup_completed" },
    }, T0));
    assert.match(e.message, /needs both the event/);
  });

  test("a campaign-sized message cap is refused", () => {
    const h = harness();
    const e = mustFail(upsertPlaybook(h.db, ids(h), { ...BASE, maxPerUserTotal: 12 }, T0));
    assert.match(e.message, /it is a campaign/);
  });

  test("email always requires consent, whatever the caller asks for", () => {
    const h = harness();
    const { id } = must(upsertPlaybook(h.db, ids(h), { ...BASE, channel: "email" }, T0));
    assert.equal(getPlaybook(h.db, h.projectId, id)!.requiresConsent, true);
  });

  test("every playbook kind documents what it must not be used for", () => {
    for (const [kind, rules] of Object.entries(PLAYBOOK_KIND_RULES)) {
      assert.ok(rules.purpose.length > 20, `${kind} has no purpose`);
      assert.ok(rules.forbidden.length > 10, `${kind} has no forbidden list`);
    }
  });

  test("editing an approved playbook returns it to draft", () => {
    const h = harness();
    const playbook = makeActive(h);
    must(upsertPlaybook(h.db, ids(h), { ...BASE, id: playbook.id, messageBody: "A different message entirely." }, T0));
    const after = getPlaybook(h.db, h.projectId, playbook.id)!;
    assert.equal(after.status, "draft");
    assert.equal(after.approvedBy, null);
  });
});

// --- approval --------------------------------------------------------------

describe("approval", () => {
  test("an unapproved playbook cannot be activated", () => {
    const h = harness();
    const { id } = must(upsertPlaybook(h.db, { orgId: h.orgId, projectId: h.projectId, userId: h.userId }, BASE, T0));
    const e = mustFail(setPlaybookStatus(h.db, h.projectId, id, "active", T0));
    assert.match(e.message, /approved by a person/);
  });

  test("approval records who approved it", () => {
    const h = harness();
    const playbook = makeActive(h);
    assert.equal(playbook.approvedBy, h.userId);
    assert.equal(playbook.approvedAt, T0);
  });

  test("a sending playbook with no message cannot be approved", () => {
    const h = harness();
    const { id } = must(upsertPlaybook(h.db, { orgId: h.orgId, projectId: h.projectId, userId: h.userId },
      { ...BASE, messageTitle: "", messageBody: "" }, T0));
    const e = mustFail(approvePlaybook(h.db, { projectId: h.projectId, userId: h.userId }, id, T0));
    assert.match(e.message, /must have a message to approve/);
  });

  test("a draft playbook enrols nobody", () => {
    const h = harness();
    const { id } = must(upsertPlaybook(h.db, { orgId: h.orgId, projectId: h.projectId, userId: h.userId }, BASE, T0));
    h.event("u1", "signup_completed", T0 - DAY);
    const e = mustFail(enrolIdentities(h.db, h, getPlaybook(h.db, h.projectId, id)!, [identityOf(h, "u1")], T0));
    assert.match(e.message, /only enrols while active/);
  });
});

// --- consent ---------------------------------------------------------------

describe("consent", () => {
  test("an absent consent record is never read as consent", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0 - DAY);
    assert.equal(hasMessagingConsent(h.db, h.projectId, identityOf(h, "u1"), "email"), false);
  });

  test("consent needs a basis", () => {
    const h = harness();
    h.event("u1", "signup_completed", T0 - DAY);
    const e = mustFail(setMessagingConsent(h.db, h, identityOf(h, "u1"), "email", true, "  ", T0));
    assert.match(e.message, /not evidence of consent/);
  });

  test("an email playbook suppresses anyone without consent, and says why", () => {
    const h = harness();
    const playbook = makeActive(h, { channel: "email" });
    h.event("u1", "signup_completed", T0 - DAY);
    const result = must(enrolIdentities(h.db, h, playbook, [identityOf(h, "u1")], T0));
    assert.equal(result.enrolled, 0);
    assert.equal(result.suppressed[0]!.reason, "no_consent");
    assert.match(result.suppressed[0]!.detail, /absent record is not consent/);
  });

  test("withdrawn consent between enrolment and delivery stops the message", () => {
    const h = harness();
    const playbook = makeActive(h, { channel: "email" });
    h.event("u1", "signup_completed", T0 - DAY);
    const id = identityOf(h, "u1");
    must(setMessagingConsent(h.db, h, id, "email", true, "signup checkbox", T0));
    const enrolled = must(enrolIdentities(h.db, h, playbook, [id], T0));
    assert.equal(enrolled.enrolled + enrolled.holdout, 1);

    must(setMessagingConsent(h.db, h, id, "email", false, "unsubscribe link", T0 + HOUR));
    const due = dueMessages(h.db, h.projectId, playbook, T0 + 48 * HOUR, 12);
    assert.equal(due.messages.length, 0);
    assert.ok(due.suppressed.some((s) => s.reason === "no_consent") || enrolled.holdout === 1);
  });

  test("in-app messages do not require a separate consent record", () => {
    const h = harness();
    const playbook = makeActive(h);
    h.event("u1", "signup_completed", T0 - DAY);
    const result = must(enrolIdentities(h.db, h, playbook, [identityOf(h, "u1")], T0));
    assert.equal(result.enrolled + result.holdout, 1);
  });
});

// --- enrolment -------------------------------------------------------------

describe("enrolment", () => {
  function cohort(h: ReturnType<typeof harness>, n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      h.event(`u${i}`, "signup_completed", T0 - 2 * DAY);
      ids.push(identityOf(h, `u${i}`));
    }
    return ids;
  }

  test("a share of the cohort is held out", () => {
    const h = harness();
    const playbook = makeActive(h, { holdoutPercent: 0.2 });
    const result = must(enrolIdentities(h.db, h, playbook, cohort(h, 400), T0));
    assert.ok(result.holdout > 40, `expected roughly 80 held out, got ${result.holdout}`);
    assert.ok(result.holdout < 130, `expected roughly 80 held out, got ${result.holdout}`);
    assert.equal(result.enrolled + result.holdout, 400);
  });

  test("holdout assignment is deterministic, so it cannot be re-rolled", () => {
    const h = harness();
    const playbook = makeActive(h);
    const ids = cohort(h, 50);
    const first = ids.map((id) => evaluateEnrolment(h.db, h.projectId, playbook, id, T0).arm);
    const second = ids.map((id) => evaluateEnrolment(h.db, h.projectId, playbook, id, T0 + DAY).arm);
    assert.deepEqual(first, second);
  });

  test("the holdout is told it is a holdout, not hidden", () => {
    const h = harness();
    const playbook = makeActive(h);
    const ids = cohort(h, 60);
    const held = ids
      .map((id) => evaluateEnrolment(h.db, h.projectId, playbook, id, T0))
      .find((d) => d.arm === "holdout")!;
    assert.match(held.detail, /deliberately receives nothing/);
  });

  test("nobody is enrolled twice", () => {
    const h = harness();
    const playbook = makeActive(h);
    const ids = cohort(h, 5);
    must(enrolIdentities(h.db, h, playbook, ids, T0));
    const again = must(enrolIdentities(h.db, h, playbook, ids, T0 + DAY));
    assert.equal(again.enrolled, 0);
    assert.ok(again.suppressed.every((s) => s.reason === "already_enrolled"));
  });

  test("someone who already did the thing is not nudged to do it", () => {
    const h = harness();
    const playbook = makeActive(h, { stopOnEvent: "project_published" });
    h.event("done", "signup_completed", T0 - 3 * DAY);
    h.event("done", "project_published", T0 - 2 * DAY);
    const result = must(enrolIdentities(h.db, h, playbook, [identityOf(h, "done")], T0));
    assert.equal(result.suppressed[0]!.reason, "stop_event_seen");
    assert.match(result.suppressed[0]!.detail, /nothing to help with/);
  });

  test("the per-person cap counts messages from every playbook", () => {
    const h = harness();
    const first = makeActive(h, { name: "First" });
    const second = makeActive(h, { name: "Second" });
    h.event("u", "signup_completed", T0 - 3 * DAY);
    const id = identityOf(h, "u");

    // Force the first playbook into treatment and mark it delivered.
    h.db.run(
      `INSERT INTO playbook_enrollments
        (id, org_id, project_id, playbook_id, identity_id, arm, enrolled_at, due_at, delivered_at)
       VALUES ('pbe_forced', ?, ?, ?, ?, 'treatment', ?, ?, ?)`,
      [h.orgId, h.projectId, first.id, id, T0 - 2 * DAY, T0 - DAY, T0 - DAY],
    );
    const result = must(enrolIdentities(h.db, h, second, [id], T0));
    assert.equal(result.suppressed[0]!.reason, "cap_reached");
  });

  test("every suppression is stored for audit", () => {
    const h = harness();
    const playbook = makeActive(h);
    must(enrolIdentities(h.db, h, playbook, cohort(h, 100), T0));
    const summary = suppressionSummary(h.db, h.projectId, playbook.id);
    assert.ok(summary.some((s) => s.reason === "holdout" && s.count > 0));
  });
});

// --- delivery --------------------------------------------------------------

describe("delivery", () => {
  function enrolOne(h: ReturnType<typeof harness>, playbook: Playbook, external = "u1") {
    h.event(external, "signup_completed", T0 - 2 * DAY);
    const id = identityOf(h, external);
    // Place the person in treatment explicitly, so the test is about delivery.
    h.db.run(
      `INSERT INTO playbook_enrollments
        (id, org_id, project_id, playbook_id, identity_id, arm, enrolled_at, due_at)
       VALUES (?, ?, ?, ?, ?, 'treatment', ?, ?)`,
      ["pbe_" + external, h.orgId, h.projectId, playbook.id, id, T0, T0 + 24 * HOUR],
    );
    return id;
  }

  test("nothing is due before its delay has passed", () => {
    const h = harness();
    const playbook = makeActive(h);
    enrolOne(h, playbook);
    assert.equal(dueMessages(h.db, h.projectId, playbook, T0 + HOUR, 12).messages.length, 0);
  });

  test("a due message carries the approved copy and a way to get help", () => {
    const h = harness();
    const playbook = makeActive(h);
    enrolOne(h, playbook);
    const { messages } = dueMessages(h.db, h.projectId, playbook, T0 + 25 * HOUR, 12);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.body, BASE.messageBody);
    assert.equal(messages[0]!.helpUrl, BASE.helpUrl);
  });

  test("quiet hours delay a message rather than cancelling it", () => {
    const h = harness();
    const playbook = makeActive(h, { quietHoursStart: 21, quietHoursEnd: 8 });
    enrolOne(h, playbook);
    const night = dueMessages(h.db, h.projectId, playbook, T0 + 25 * HOUR, 23);
    assert.equal(night.messages.length, 0);
    assert.equal(night.suppressed[0]!.reason, "quiet_hours");
    const morning = dueMessages(h.db, h.projectId, playbook, T0 + 36 * HOUR, 10);
    assert.equal(morning.messages.length, 1);
  });

  test("the holdout is never delivered to", () => {
    const h = harness();
    const playbook = makeActive(h);
    h.event("held", "signup_completed", T0 - 2 * DAY);
    h.db.run(
      `INSERT INTO playbook_enrollments
        (id, org_id, project_id, playbook_id, identity_id, arm, enrolled_at, due_at, suppressed_reason)
       VALUES ('pbe_held', ?, ?, ?, ?, 'holdout', ?, ?, 'holdout')`,
      [h.orgId, h.projectId, playbook.id, identityOf(h, "held"), T0, T0 + 24 * HOUR],
    );
    assert.equal(dueMessages(h.db, h.projectId, playbook, T0 + 48 * HOUR, 12).messages.length, 0);
  });

  test("a playbook with channel 'none' sends nothing at all", () => {
    const h = harness();
    const playbook = makeActive(h, { channel: "none", messageTitle: "", messageBody: "" });
    enrolOne(h, playbook);
    assert.equal(dueMessages(h.db, h.projectId, playbook, T0 + 48 * HOUR, 12).messages.length, 0);
  });

  test("a message is delivered once and only once", () => {
    const h = harness();
    const playbook = makeActive(h);
    enrolOne(h, playbook);
    const { messages } = dueMessages(h.db, h.projectId, playbook, T0 + 25 * HOUR, 12);
    assert.equal(markDelivered(h.db, h.projectId, messages[0]!.enrolmentId, T0 + 25 * HOUR), true);
    assert.equal(markDelivered(h.db, h.projectId, messages[0]!.enrolmentId, T0 + 26 * HOUR), false);
    assert.equal(dueMessages(h.db, h.projectId, playbook, T0 + 30 * HOUR, 12).messages.length, 0);
  });

  test("someone who acts before the message is due is left alone", () => {
    const h = harness();
    const playbook = makeActive(h, { stopOnEvent: "project_published" });
    const id = enrolOne(h, playbook);
    h.event("u1", "project_published", T0 + 2 * HOUR);
    const due = dueMessages(h.db, h.projectId, playbook, T0 + 25 * HOUR, 12);
    assert.equal(due.messages.length, 0);
    assert.equal(due.suppressed[0]!.reason, "stop_event_seen");
    assert.ok(id);
  });
});

// --- measurement -----------------------------------------------------------

describe("measurement", () => {
  /**
   * Build a settled playbook population with controlled conversion in each
   * arm, so the measurement itself can be tested.
   */
  function population(
    h: ReturnType<typeof harness>,
    playbook: Playbook,
    counts: { treatment: number; holdout: number },
    rates: { treatment: number; holdout: number },
  ) {
    const enrolledAt = T0 - 60 * DAY;
    for (const arm of ["treatment", "holdout"] as const) {
      const n = counts[arm];
      const converts = Math.round(n * rates[arm]);
      for (let i = 0; i < n; i++) {
        const external = `${arm}-${i}`;
        h.event(external, "signup_completed", enrolledAt - DAY);
        const identityId = identityOf(h, external);
        h.db.run(
          `INSERT INTO playbook_enrollments
            (id, org_id, project_id, playbook_id, identity_id, arm, enrolled_at, due_at, delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`pbe_${arm}_${i}`, h.orgId, h.projectId, playbook.id, identityId, arm,
           enrolledAt, enrolledAt + 24 * HOUR, arm === "treatment" ? enrolledAt : null],
        );
        if (i < converts) h.event(external, "project_published", enrolledAt + 2 * DAY);
      }
    }
  }

  test("a real effect is attributed to the playbook because the holdout was randomised", () => {
    const h = harness();
    const playbook = makeActive(h);
    population(h, playbook, { treatment: 400, holdout: 400 }, { treatment: 0.35, holdout: 0.2 });
    const outcome = measurePlaybook(h.db, h.projectId, playbook, { now: T0 });
    assert.equal(outcome.measurable, true);
    assert.ok(outcome.test!.pValue < 0.05);
    assert.match(outcome.interpretation, /attributable to the playbook/);
  });

  test("no effect is reported as no effect, not as success", () => {
    const h = harness();
    const playbook = makeActive(h);
    population(h, playbook, { treatment: 400, holdout: 400 }, { treatment: 0.2, holdout: 0.2 });
    const outcome = measurePlaybook(h.db, h.projectId, playbook, { now: T0 });
    assert.match(outcome.interpretation, /does not change behaviour/);
  });

  test("the treated group's own conversion rate is never reported as the effect", () => {
    const h = harness();
    const playbook = makeActive(h);
    population(h, playbook, { treatment: 400, holdout: 400 }, { treatment: 0.6, holdout: 0.6 });
    const outcome = measurePlaybook(h.db, h.projectId, playbook, { now: T0 });
    // 60% of treated users converted, and the honest answer is still "no effect".
    assert.ok(outcome.treatment.rate! > 0.5);
    assert.match(outcome.interpretation, /No difference was detected/);
  });

  test("too small a sample is reported as unmeasurable, not as a result", () => {
    const h = harness();
    const playbook = makeActive(h);
    population(h, playbook, { treatment: 10, holdout: 4 }, { treatment: 0.8, holdout: 0.1 });
    const outcome = measurePlaybook(h.db, h.projectId, playbook, { now: T0 });
    assert.equal(outcome.measurable, false);
    assert.equal(outcome.test, null);
    assert.match(outcome.interpretation, /statement about the sample/);
  });

  test("a playbook with no primary metric cannot be measured and says so", () => {
    const h = harness();
    const playbook = makeActive(h, { primaryMetricEvent: null });
    const outcome = measurePlaybook(h.db, h.projectId, playbook, { now: T0 });
    assert.equal(outcome.measurable, false);
    assert.match(outcome.interpretation, /nothing to measure it against/);
  });

  test("members whose outcome window has not closed are excluded", () => {
    const h = harness();
    const playbook = makeActive(h);
    population(h, playbook, { treatment: 400, holdout: 400 }, { treatment: 0.35, holdout: 0.2 });
    // Measuring immediately after enrolment: nothing has settled.
    const outcome = measurePlaybook(h.db, h.projectId, playbook, { now: T0 - 59 * DAY });
    assert.equal(outcome.measurable, false);
  });

  test("the limitations of the comparison travel with the result", () => {
    const h = harness();
    const playbook = makeActive(h);
    population(h, playbook, { treatment: 400, holdout: 400 }, { treatment: 0.35, holdout: 0.2 });
    const outcome = measurePlaybook(h.db, h.projectId, playbook, { now: T0 });
    assert.ok(outcome.limitations.some((l) => /outcome window is fixed/.test(l)));
  });

  test("one project's playbooks are invisible to another", () => {
    const a = harness();
    const b = harness();
    makeActive(a);
    assert.deepEqual(listPlaybooks(b.db, b.projectId), []);
  });
});

# Retention playbooks

This is the part of a retention product most likely to do harm, so it is the
part with the most rules.

The usual version of this feature sends whatever the growth team can think of
to whoever looks like they might leave, counts the ones who stayed, and calls
the difference retention. That is not a measurement: the people who were going
to stay anyway are in the numerator.

## Four commitments, enforced in code

### 1. A person approves it

A playbook is created as a `draft` and enrols nobody. `approvePlaybook` records
who approved it and `setPlaybookStatus` refuses to activate an unapproved one —
"this is not a setting". **Editing an approved playbook returns it to draft**,
because an approval covers the copy and audience that were approved, not
whatever they become later.

### 2. A holdout receives nothing

Between 5% and 50%, required. A smaller holdout cannot measure whether the
playbook does anything, and this product will not report an effect it has not
measured, so it is refused with that reason.

Assignment is deterministic on `(playbook, person)`, so it cannot drift between
runs and cannot be re-rolled until the answer improves. The holdout is told it
is a holdout in the UI, not hidden.

### 3. Email consent is checked twice

At enrolment and again at delivery. Someone who opted out in between has opted
out, and a system that only checks at enrolment will send to them anyway.

**An absent record is never read as consent.** Consent requires a `basis` —
where it came from — because a consent record with no provenance is not
evidence of consent.

### 4. Caps are hard, and every refusal is recorded

One message per person per playbook by default, five maximum ("more than that
is not a playbook, it is a campaign, and it belongs in a tool the recipient can
unsubscribe from"). The cap counts deliveries from **every** playbook: a person
who received three messages from three playbooks received three messages.

Quiet hours delay rather than cancel. Every suppression stores its reason —
`no_consent`, `already_enrolled`, `cap_reached`, `stop_event_seen`, `holdout`,
`quiet_hours` — and the UI shows the tally. A retention system that cannot tell
you why someone got nothing is a system nobody can audit.

## What it cannot do

- **It cannot act before a cancellation completes.** A `cancellation_feedback`
  playbook must trigger on the completed subscription state; the engine refuses
  anything else, and there is no mechanism anywhere to delay, complicate or
  discourage someone leaving, or to offer a discount in that flow.
- **It cannot send inside an hour of its trigger.** An instant message after
  something a user just did reads as surveillance.
- **It cannot use pressure copy.** "Last chance", "your streak", "before it's
  too late", "expires in", "you'll lose" and the rest are refused by name.
  Deliberately a blocklist the user can read and argue with rather than a
  sentiment classifier that silently rejects things.
- **It cannot enrol a funnel from an event to itself.** That has no audience,
  and enrolling nobody would look like the playbook working.

Each playbook kind also documents what it must not be used for, in
`PLAYBOOK_KIND_RULES`, and the UI shows it next to the playbook:
inactivity follow-up forbids "guilt, streak-breaking, loss framing"; feedback
follow-up forbids "asking for a review in the same message"; payment failure
assistance forbids "threats, countdowns, or restricting access before the grace
period ends".

## Measurement

Against the holdout, which is what makes it a measurement at all.

The clock starts when the message was due for both arms, so they are compared
over the same elapsed time. Below 30 settled users per arm, it reports that the
sample is too small — "a statement about the sample, not about the playbook" —
rather than reporting a result.

A playbook where 60% of treated users converted still reports **no difference
detected** when the holdout also converted at 60%. There is a test for exactly
that, because it is the number a vendor would otherwise quote.

## Delivery

`dueMessages` returns what is due and `markDelivered` is the only thing that
records a send; nothing else sets `delivered_at`. The holdout is never
delivered to, and a `channel: "none"` playbook sends nothing at all — it only
records that the trigger fired.

## Tests

45 tests in `packages/analytics/test/playbooks.test.ts`.

# Next steps

Ordered by what would most change the product's standing, not by what is
easiest. Each item says what exists today, so nothing here reads as a promise
already kept.

## 1. Talk to ten teams before writing more code

Nothing in `BUSINESS_VALIDATION.md` has been tested. The most valuable next
action involves no engineering at all, and three of the six core assumptions
can be killed or confirmed by conversations.

The assumption most worth testing first: **does anyone want an arguable
ranking, or do they want a confident number?** The whole product leans on the
answer being the former.

## 2. A real pilot, starting with the doctor

One team, their real data, and the Instrumentation Doctor as the first screen
they see. If their instrumentation is broken — and it usually is — every other
number in the product is untrustworthy for them, and finding that out on day
one is the honest order of events.

What this would exercise that the demo cannot: data volume, event names nobody
designed, identity linking that was never set up, and whether the detectors
find anything a human had not already noticed.

## 3. Cancellation and churn intelligence

The data is already captured (`subscription_events`, the
`cancellation_feedback` playbook kind, `churnBreakdown`). What is missing is the
surface that reads it: why people leave, grouped, with the product signals that
preceded each cancellation.

This is the highest-value unbuilt feature, because it is the question the
product's buyers actually wake up with, and most of the plumbing exists.

## 4. Behavioural AI-product retention metrics

Not model-graded quality — the no-paid-API constraint rules that out, and it
would be the weakest part anyway. The behavioural version is better and is
free: did the user retry, regenerate, abandon, come back. See
`AI_SAAS_INTELLIGENCE.md` for what exists today.

## 5. Playbook delivery

The engine schedules, gates, caps and measures; `markDelivered` records a send.
**Nothing actually sends.** A delivery adapter is needed — in-app first, since
it needs no third-party service and no consent record beyond product use.

Until that exists, playbooks are a scheduling and measurement system that a
human can act on manually, which is honest but limited.

## 6. Live provider probes

`verifyConnection` takes an injected probe and the connection stays
`disconnected` until one succeeds. Today no real probe is implemented, so every
provider except CSV reports exactly that. The connection, provenance,
deduplication and import paths are all built and tested; what is missing is one
HTTP call per provider.

## 7. Browser-level end-to-end tests

Current coverage: 748 unit and integration tests, a 4-test journey suite, and a
route smoke check. What is missing is an automated browser test that drives a
form, submits it and asserts the resulting page — the layer that found three
real bugs in this pass by hand.

## 8. Worker scheduling for the new engines

The detectors, the doctor and the alert checks run on demand from the UI and
once during seeding. They should run on a schedule in the worker, which already
has an idempotent job queue to hang them on.

## 9. The deferred surfaces

Listed honestly in `AI_SAAS_INTELLIGENCE.md`: Activation Blueprints, Smart
Onboarding Optimizer, Product Value Scorecard, Customer Voice Intelligence,
Agency Command Center, Customer Success Workflows, Time To First Value as its
own page, Release Intelligence, Retention Operations Timeline, FixFlow Pro
(`FIXFLOW_PRO.md`), and RetainOS Engineer.

**Real Product Benchmarking is deliberately not on this list.** It would
require aggregate data across customers that RetainOS does not have, and
publishing benchmark figures without it would mean inventing them.

## 10. Things that should not be built

Recorded so a later pass does not treat them as oversights:

- A single "revenue impact" total
- A churn probability per customer
- A health score out of 100
- Cancellation-flow retention offers
- Pricing on event volume
- Any feature that makes leaving harder

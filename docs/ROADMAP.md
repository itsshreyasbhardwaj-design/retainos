# Roadmap

Honest about sequence, and about what will not be built.

## Next

**Verify the external integrations.** GitHub dispatch and the Razorpay and
Stripe webhook paths are written and typechecked but have never met the real
systems. Until they have, they stay *Implemented but unverified* in
`FEATURE_STATUS.md`. This is the highest-value next step because it converts a
claim into a fact.

**Browser end-to-end tests.** The journey is covered in-process; it is not
covered through a real browser. Playwright, the 32-step flow, desktop and mobile
viewports.

**Accessibility audit.** The markup is semantic and focus is visible, but
nothing has been tested with a screen reader. RetainOS will not call itself
accessible until it has been.

**The onboarding flow builder.** The data model, tracking and reporting work;
creating a flow through the UI does not.

**A shared rate limiter.** Required before running more than one ingestion
process. The class is already isolated for the swap.

## After that

- PostgreSQL as the primary target, with partitioning
- Live Razorpay checkout, so a plan change takes a real payment
- Embeddable React onboarding components
- Two-way GitHub status sync
- Saved segments and cohort comparison in the UI
- Scheduled report delivery, once there is a delivery provider and collected
  consent
- A mobile SDK, if there is demand the HTTP API does not already serve

## Deliberately not planned

Each of these is a decision, not an omission:

**Session replay.** It records what people type and see. RetainOS will not
collect it. Use a dedicated tool if you need it, with your own consent story.

**Churn prediction scores.** A number between 0 and 1 attached to a customer
invites action on a model nobody validated. Build one against your own outcomes
if you want one.

**Automated retention interventions.** No discount offers on a cancellation
page, no exit-survey friction, no win-back emails on an inactivity trigger.
Retention should improve because the product became more useful.

**Behavioural profiling or advertising features.** For any audience, children
included.

**Letting a language model compute a metric.** An adapter may rephrase a
finding. It will never be the calculator. That boundary is the product.

**Claiming parity with specialised tools.** RetainOS is not the deepest
analytics tool, the deepest feedback tool or an error monitor. `/features` says
where each is better, and that page is maintained.

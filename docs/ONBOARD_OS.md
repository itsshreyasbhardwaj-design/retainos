# OnboardOS

## Model

A **flow** is an ordered list of **steps**. A step completes when its configured
event arrives for that user, so progress reflects what people actually did
rather than what they clicked past.

Every flow is **dismissible**. Non-dismissible onboarding is a dark pattern and
RetainOS does not offer it — the column exists, and the UI flags a flow that
sets it to false.

## Reported

Starts, completions, completion rate, per-step completion, time to completion,
and **dismissals**. A high dismissal rate is a signal worth reading, and the UI
colours it as a problem rather than hiding it.

## The honest caveat

> Do not assume an onboarding overlay improves activation. Run it as an
> experiment: the honest default is that it makes no difference until shown
> otherwise.

A completion rate is **not** evidence the flow helped. Compare activation
between users who saw it and users who did not, ideally as a controlled
experiment in ImpactLab.

## Status

**Partially implemented.**

- Data model, progress tracking and the reporting screen: built and working.
- **Creating and editing flows through the UI: not built.** Flows can be created
  through the database or a seed script.
- **Embeddable React checklist components: not built.** The UI would be rendered
  by your own application.

`FEATURE_STATUS.md` records this as partial rather than claiming it is finished.

## What it will not do

No forced walkthroughs, no undismissable modals, no interfaces that obscure the
product until a checklist is finished, and no deceptive progress indicators.

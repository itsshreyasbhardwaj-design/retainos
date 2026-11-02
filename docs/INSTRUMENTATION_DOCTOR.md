# Instrumentation doctor

## Why this exists

Bad instrumentation does not fail. It answers.

A missing activation event produces a confident activation rate of zero. A
duplicated event name halves a funnel. A running experiment with no exposures
collects nothing while looking busy. None of these show up as errors, because
they all look exactly like findings — and a team acts on them.

## Available on every plan, free included

Unreliable data makes every other part of the product worse, including for
people who never pay. Putting this behind a paywall would mean selling metrics
we know might be wrong to the customers least able to tell.

## The thirteen checks

| Check | Severity | Catches |
| --- | --- | --- |
| `no_events` | blocking | Nothing has ever arrived |
| `activation_undefined` | blocking | Events arriving with no activation event defined |
| `activation_event_never_seen` | blocking | Activation configured to an event that has never arrived |
| `signup_event_never_seen` | blocking | Same, for the funnel's denominator |
| `high_rejection_rate` | blocking / warning | Events being refused at ingestion |
| `event_name_variants` | warning | `project_published` and `projectPublished` splitting a funnel |
| `low_identity_linking` | warning | Mostly anonymous identities, so nothing can be joined |
| `identify_without_anonymous_history` | advisory | Pre-signup behaviour being lost |
| `events_without_schema` | advisory | Events nothing validates |
| `schema_drift` | warning | A schema version bump inside the reporting window |
| `volume_collapse` | blocking | A sharp fall that is usually a broken deploy, not churn |
| `clock_skew` | warning | Events rejected for an out-of-range timestamp |
| `experiment_without_exposure` | blocking | A running experiment collecting nothing |
| `unlinked_subscriptions` | warning | Revenue that cannot be joined to product behaviour |
| `multiple_sdk_versions` | advisory | A rollout in progress |

## Every finding carries five things

- **What is wrong** — the specific detail
- **Supporting evidence** — the figures, as JSON
- **Why it affects your analytics** — what it does to your numbers
- **Suggested fix** — what to change
- **How to verify** — how to know it worked

The severity says what it costs: `blocking` means some metric is currently
wrong rather than merely incomplete; `warning` means less reliable than it
looks; `advisory` is worth knowing and affects no number.

The most important wording in the whole engine is in
`activation_event_never_seen`:

> Your activation rate is currently 0%, and that figure is an instrumentation
> gap rather than a product problem. Acting on it would mean fixing something
> that is not broken.

## What it refuses to do

- **It does not nag an empty project.** A project with no events is told it has
  no events, not that its activation event is undefined.
- **It does not judge small projects on ratios.** Identity linking needs 20
  identities; a trend needs 100 events in the prior window; rejections need 10
  before the rate means anything.
- **It does not invent problems to look useful.** A healthy project is told all
  13 checks passed, and advisory notes alone do not make a project unhealthy —
  the summary says so explicitly rather than implying warnings exist.

## Findings resolve themselves

`persistFindings` stores one row per check and marks any check that stopped
firing as resolved. The open list stays a to-do rather than becoming an
archive.

## Alerting depends on this

`dataQualityNote` runs the doctor, and `fireAlert` **withholds every alert
except the ingestion one** while a blocking finding is open: an alert built on
broken tracking is worse than silence. The ingestion alert is the exception
because it is about the broken data.

## Tests

30 tests in `packages/analytics/test/instrumentation.test.ts`.

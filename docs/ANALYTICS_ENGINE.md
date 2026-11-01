# Analytics engine

Every engine returns both the numbers **and** the definitions that produced
them. The UI renders the definition next to the chart, so a percentage is never
shown without its denominator.

## Funnels

### Semantics, stated and enforced

- **Unique users.** A user is counted at most once per step, however many times
  they fired the event.
- **Ordered.** An event that fires before the previous step does not count for
  the later one. A user who performed the core action and *then* signed up has
  not converted.
- **Earliest qualifying occurrence** after the previous completed step. Earlier
  and repeated occurrences are ignored.
- **The conversion window is measured from the user's first step**, not from the
  previous one. "Convert within 7 days" means seven days from entering the
  funnel. Three four-day hops do not fit inside a seven-day window, and the test
  suite asserts that.
- **Deterministic ordering.** Events are sorted by `(occurred_at, id)`, so two
  events in the same millisecond always resolve the same way, on every run.

### Returned

Per step: users, step conversion, overall conversion, users lost, a **Wilson
interval** for the step conversion, and the median time from the previous step.
Plus the largest drop-off by absolute users lost, and a sample warning below 30
entrants.

Wilson rather than the normal interval because it stays inside [0,1] and behaves
sensibly at small n — exactly the conditions an early-stage funnel lives in. One
conversion out of one is shown as 100% with an interval from roughly 21% to
100%, so it cannot be read as certainty.

### Zero denominators

Never `NaN`, never `Infinity`. An empty funnel returns zeros, the largest
drop-off is `null`, and the sample warning explains there is nothing to
interpret.

## Active users

An active user is an identity with at least one accepted event in the bucket,
counted once. **New** means their first-ever event in the project falls in that
bucket; **returning** means it does not. Buckets are calendar periods in the
project's reporting timezone.

Every point carries `complete: false` when the bucket has not fully elapsed. The
chart draws a marker at that boundary, because a dashboard that ignores this
invents a drop at the right-hand edge of every chart it renders.

## Segmentation

Six dimensions, and the list is closed: `plan`, `country`, `device_category`,
`product_version`, `acquisition_source`, `release_id`.

Closed for two reasons. They are promoted to real columns, so filtering is an
index lookup. And it keeps RetainOS away from demographic segmentation — there
is no age, gender, income or precise-location dimension, and no API that can add
one.

## User journeys

Aggregate event sequences only. Consecutive repeats of the same event are
collapsed, because "viewed, viewed, viewed" is a polling artefact rather than a
journey. Every response carries the caveat that a sequence shows what happened
in what order, not why, and is not evidence that one step caused the next.

There is no per-user session replay, and no code that could produce one.

## Feature adoption

- **Discovered by** — distinct users who used it at least once in the period.
- **First-time users** — users whose first-ever use falls in the period, so the
  figure is not an artefact of the window.
- **Repeat users** — users who used it on **two distinct calendar days**. Two
  events in one session is not repeat usage, and counting it as such is the
  vanity metric this avoids.
- **Feature retention** — of users who first used it in the window, how many
  were active in the product at all on a later day.

Adoption is measured against all active users, which understates adoption within
a feature's target segment. The UI says so.

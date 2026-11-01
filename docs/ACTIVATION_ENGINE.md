# Activation engine

## RetainOS will not guess what activation means

Activation is the first moment a user gets real value, and that is different in
every product. RetainOS refuses to pick a default, because a wrong default
produces a confident number that is worse than no number.

You configure: an **activation event**, an optional property filter, a **window
in days**, and the **signup event** that starts the clock.

| Product | A reasonable activation event |
|---|---|
| Developer tool | First successful integration |
| Project management | First project created with an actionable task |
| Content tool | First finished asset exported |
| Finance app | First useful report completed |

**Signup completion is never activation.** Creating an account is a cost the
user paid, not value they received.

## How the rate is computed

For users whose first signup event falls in the selected period:

```
activated = fired the activation event, matching any property filter,
            at or after their own signup, within windowDays of it
rate      = activated / registrations
```

The activation event must come **at or after** that user's signup. A user who
fired it before signing up has not activated, and the test suite asserts it.

The **earliest** qualifying occurrence is used, so a user who creates a project
on day 1 and again on day 5 has a time-to-value of one day.

## Open windows — the honest denominator

Someone who signed up yesterday has not *failed* a 7-day activation window.
They have not finished it.

The result reports `eligibleForWindow`: how many of the signups have had the
full window elapse. When that is fewer than the total, a warning says so and
notes that the rate will rise as those windows close.

## Every applicable caveat, not just the first

`activationFunnel` returns `warnings: string[]`, not a single message. A result
can be both small-sample **and** have open windows, and suppressing either would
overstate how much the number can be trusted. This was a real bug caught by a
test, and the fix was to change the shape of the return value.

## Time to value

Median and the 25th, 75th and 90th percentiles, by nearest rank, across
**activated users only**. Users who never activated have no duration and are not
counted as a large one — including them as "infinite" would be meaningless and
excluding them silently would be dishonest, so the count of contributing users
is reported alongside.

## Segment breakdown

Activation by plan, country, device, product version or acquisition source.
Segments under 30 signups are marked small in the UI.

A large difference between acquisition sources usually says more about who is
arriving than about the product. The UI says that too.

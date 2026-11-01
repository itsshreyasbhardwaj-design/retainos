# Retention engine

Three things most retention charts get wrong, and what RetainOS does instead.

## 1. The denominator

**The cohort, fixed at assignment. It never shrinks.**

Dividing by "users we still have records for" produces retention curves that
trend *upward* over time, which is nonsense. The denominator is every member of
the cohort, forever. Day 14 with nobody returning is `0/10`, reported as 0% —
not omitted, not `0/0`.

## 2. Period boundaries

**Period N means N calendar days after the user's own cohort day, resolved in
the project's reporting timezone.**

Not `N × 86,400,000` milliseconds. Across a DST transition those differ by an
hour, which silently moves events between buckets. A user who signs up at 13:00
on 7 March and returns at 13:00 on 8 March has returned one calendar day later,
even though only 23 hours elapsed. There is a test for exactly that.

For a weekly cohort, day-N is still measured from **each member's own** cohort
day, not from the week's start. Two users joining the same week on different
days are both day-1 retained if each returns a day after their own signup.

## 3. Incomplete periods

**A cohort from two days ago has no day-7 number yet.**

Those cells are marked `complete: false`, rendered as "—" rather than 0%, and
**excluded from averages**. Reporting them as zero invents a cliff that is
purely an artefact of when the report was run — the single most common way a
retention chart lies.

Completeness is judged against the cohort's **latest** member: a weekly cohort's
period-1 cell is not complete until every member has had their full seven days.

## Configuration

**Cohort basis** — first-ever event, a signup event, an activation event, plan
or release.

**Return event** — any accepted event by default, or one specific event. "Came
back" and "came back and did the thing worth doing" are different questions, and
the definition block states which one is on screen.

**Granularity** — day, week (ISO-8601, Monday start) or month.

**Periods** — defaults of `[0, 1, 3, 7, 14, 30]` for daily,
`[0, 1, 2, 3, 4, 8, 12]` for weekly.

## Small samples

Cohorts under 20 users are flagged. Every cell carries a Wilson interval, so a
cohort of one showing "100%" also shows an interval starting below 21%.

## What it will not tell you

- **Why** anyone left. Retention is a measurement, not an explanation.
- Whether a difference between cohorts is an effect of anything. Cohorts differ
  in many ways at once.
- Anything useful about a monthly-use product from a day-7 number. Pick a window
  that matches how your product is actually used.

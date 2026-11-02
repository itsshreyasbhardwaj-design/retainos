# Opportunity engine

## What it refuses to be

It does not produce a 99/100 AI priority score. A number from a formula nobody
has seen cannot be argued with, which is why it is popular and why it is
useless: a team cannot act on "87" and cannot tell whether 87 means "lots of
users" or "we guessed".

Every score here shows its nine factors, what each one measured, in what unit,
which named transform normalised it, its weight, and what it contributed. You
can disagree with it *specifically* rather than in general, which is the only
kind of disagreement that leads anywhere.

## The factors

| Factor | Default weight | What it measures |
| --- | --- | --- |
| `affected_users` | 0.22 | Distinct users, log-scaled against a quarter of active users |
| `evidence_quality` | 0.18 | The case's confidence level |
| `revenue_exposure` | 0.16 | Exposure as a share of total MRR |
| `corroboration` | 0.12 | Independent kinds of evidence, saturating at three |
| `severity` | 0.10 | The problem kind: reliability outranks adoption |
| `recency` | 0.08 | Linear decay to zero over 30 days |
| `engineering_effort` | 0.08 | A human estimate |
| `strategic_importance` | 0.04 | A human estimate |
| `has_workaround` | 0.02 | A human estimate |

Weights are per project and editable. Changing them changes the conclusion
without changing a single measurement, which is the point: the measurements are
facts and the weights are your business.

## Why log scaling

100 affected users is not ten times as urgent as 10. Linear scaling makes one
large case dominate a list permanently and buries everything else, so reach is
scaled logarithmically against a quarter of the project's active users.

## The rule that matters most

**A missing input is never imputed.** An unanswered factor is recorded with
`provenance: "absent"`, contributes nothing, and **has its weight removed from
the denominator**.

The alternative — treating "not estimated" as zero — punishes a case for a
question nobody has answered yet, and quietly rewards whoever fills in
guesses. With the weight removed, a case scored on five real factors and a case
scored on nine are both scored on what is actually known about them.

`provenance` distinguishes three states in the schema and in the UI:
`measured` (from data), `user_estimate` (a person typed it), `absent`.

## Human estimates

Effort, strategic importance and whether a workaround exists are things only
the team knows. They live in `opportunity_estimates`, kept in a separate table
from measured values so the two can never be confused, and every one of them is
optional.

## The disclaimer travels with the score

```
This score orders a list. It is not a probability, not a confidence level,
and not a prediction of business impact.
```

`SCORE_DISCLAIMER` is exported and rendered on every surface that shows a
score, including inside the founder brief.

Each score also carries `howToImprove`: the named factors that would make this
particular ranking more trustworthy.

## Tests

30 tests in `packages/analytics/test/opportunity.test.ts`: contributions sum to
the score, bounds hold, absent factors are never imputed, diminishing returns
behave, each factor moves the score in the right direction, effort cannot
dominate reach, weights are configurable, and the ranking persists and isolates
per project. One test holds the stored ranking's ids and timestamps across a
read, because reading an order must not rewrite it.

# RetainAI

## It is a rule engine, and it says so

RetainAI's analysis is **deterministic**. It runs with no API key, no network
access and no per-query cost. Every record it writes carries
`generator: "rules_v1"`, and every answer carries
`generator: "deterministic_templates"`.

RetainOS will not imply a model wrote text it did not. That claim is asserted in
the test suite.

## The architecture, and why the boundary matters

```
1. Intent parsing        pattern matching over the question
2. Authorization         the caller supplies an already-verified scope
3. Data retrieval        the deterministic engines, nothing else
4. Metric calculation    the engines. A model is never the calculator
5. Answer composition    templates over computed values
6. Action                suggested, never performed
```

An optional language-model adapter would only ever receive **step 5**, to
rephrase. It never sees step 4's job.

That boundary is the whole point: it is what stops an "AI analyst" from
confidently reporting a number nobody computed. No adapter ships today, and
everything works without one.

## Findings

Every finding separates four things:

| Field | Nature |
|---|---|
| **Observation** | A measurement, with figures. Asserted by test to contain no hedging language |
| **Hypotheses** | Guesses. Asserted by test to *all* read as guesses |
| **Suggested investigation** | What would settle it |
| **Limitations** | What this measurement cannot tell you |

Plus the metric definition, the period, the comparison period, affected users,
and frozen evidence snapshots.

### Rules implemented

Activation drop-off · activation trend · day-7 retention trend · feedback theme
volume · instrumentation health · revenue at risk · low feature adoption.

Each has a materiality floor. A 2-point move in activation is not reported,
because a finding that fires on noise trains people to ignore findings.

## Confidence

Four qualitative labels, never an invented percentage:

| Label | Requires |
|---|---|
| **Strong supporting evidence** | 200+ users and a 25-point effect, or a 10-point effect corroborated by a second source |
| **Moderate supporting evidence** | 200+ users with a 10-point effect, or 50+ with a large effect or corroboration |
| **Preliminary observation** | Above the floor but below those thresholds |
| **Insufficient data** | Under 10 users. Reported so you know the signal exists, not as a finding |

An incomplete period caps confidence at preliminary regardless of effect size.
A 90-point effect on 30 users is **preliminary**, not strong — the rules are
deliberately conservative, and every label shows the basis that produced it,
including the thresholds themselves.

These are **sample-size rules, not statistical confidence intervals**, and the
basis string says so.

## Asking questions

Ten intents: activation rate, onboarding drop-off, retention, active users,
feedback summary, feature adoption, revenue and churn, MRR, release impact, and
which findings to investigate first.

Every answer carries each figure it quoted **with the definition that produced
it**, plus limitations and suggested actions.

**It refuses what it cannot compute.** An unrecognised question returns:

> RetainOS could not match that question to a metric it knows how to compute.
> […] It will not answer a question by guessing at numbers it has not computed.

And where data is missing, it says so rather than estimating:

> No subscription data is connected to this project, so revenue questions
> cannot be answered. RetainOS will not estimate revenue from product usage.

## Security

- No model is in the data path, so there is **no prompt to inject into**.
  Feedback text is never passed to a model as an instruction.
- Tenancy is enforced before retrieval, by the same scope checks as everything
  else.
- Actions are **suggested, never performed**. Asking about a drop-off offers to
  create an improvement task; it does not create one. Tested.
- Questions are metered per plan, because answering one runs real queries.

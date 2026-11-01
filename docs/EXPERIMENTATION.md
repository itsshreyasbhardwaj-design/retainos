# Experimentation

The only method in RetainOS that supports a causal claim.

## Assignment

A **pure function** of `(experimentKey, identityId)` through a SHA-256 hash
folded to a fraction in [0,1), compared against cumulative variant weights.

Reproducible across calls, processes and restarts. The database row is a *cache*
of that decision, not the decision itself, so a lost row cannot flip a user's
variant. Independent per experiment: a user in the treatment arm of one
experiment has an unrelated 50/50 chance in the next, verified over 200 users.

Weight distribution is verified over 10,000 users: a 90/10 split lands between
8.5% and 11.5%.

## Exposure, not assignment

**Analysis counts exposures.** Call the exposure endpoint where the variant is
actually *shown*, not where it is assigned.

A user assigned to the treatment who never reached the changed screen tells you
nothing about the change. Including them dilutes any real effect towards zero
and makes a working change look like it did nothing.

## Validity checks

Run **before** the statistics. A blocking failure forces the verdict to
`invalid_experiment` regardless of how good the p-value looks — an experiment
with a sample ratio mismatch has not produced a small effect, it has produced no
usable information.

| Check | Severity | What it catches |
|---|---|---|
| **Missing exposure data** | blocking | No exposures recorded — nothing to analyse |
| **Sample ratio mismatch** | blocking | Chi-square at α=0.001 against configured weights. A 53/47 split over 20,000 users is a bug in assignment or logging, not a finding |
| **Contamination** | blocking | An exposure recorded under a variant the user was not assigned. Their outcome cannot be attributed to either arm |
| **Minimum sample** | blocking | Below the pre-registered exposure count. Reading now is premature stopping |
| **Normal approximation** | blocking | Too few conversions for the z-test's assumptions to hold |
| **Metric schema stable** | blocking | The metric's event schema changed mid-experiment, so it may not mean the same thing in both arms |

The SRM threshold is deliberately strict at α=0.001: a mismatch warning should
mean something is genuinely wrong, not fire on one experiment in twenty.

## Statistics

Implemented from scratch and tested against published reference values.

**Two-proportion z-test.** The **pooled** standard error for the p-value
(correct under the null of equal proportions) and the **unpooled** standard
error for the interval (correct when estimating the actual difference). Mixing
those up produces an interval that disagrees with its own p-value — a common
error, and one the test suite guards against by asserting a non-significant
result's interval contains zero and a significant one's does not.

**Welch's t-test** for continuous metrics, not Student's: equal variances
between a control and a treatment arm is an assumption with no justification.

**Holm-Bonferroni** across guardrail metrics. Eight independent tests at α=0.05
produce a false positive about a third of the time, so "one of our eight
guardrails moved" is not reported as a finding. With three guardrails the
tightest threshold is α/3, asserted in a test.

**Sample size** at 80% power, reported from the observed baseline so you know
what you would need to detect a 10% relative change.

## Verdicts

| Verdict | Meaning |
|---|---|
| `improvement_supported` | Treatment higher, p ≤ α, every blocking check passed |
| `worse_outcome` | Treatment lower, p ≤ α |
| `no_clear_difference` | p > α. **Not** proof the variants are equal |
| `inconclusive` | The metric could not be computed for both arms |
| `invalid_experiment` | A blocking check failed. No conclusion is available |

Every verdict carries plain-language reasoning naming the evidence that drove
it, in readable units — percentage points for conversion metrics, with tiny
p-values in scientific notation rather than rounded to `0.0000`.

## What the p-value is not

Stated on screen, every time:

- A p-value above the threshold means **no difference was detected**. It does
  not mean the variants are equal — the interval still contains effects that
  would matter commercially.
- A p-value below the threshold is **not the probability that the treatment is
  better**. It is how surprising this data would be if there were no difference.
- Peeking before the pre-registered sample inflates false positives, which is
  why reading early is **refused outright** rather than corrected for. RetainOS
  implements fixed-horizon tests; sequential testing is not implemented.

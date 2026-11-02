# Revenue Impact Studio

## Five classifications

Every analytics product will tell you a change made you money. Almost none can
tell you how they know. A figure cannot exist here without a classification —
the column is `NOT NULL` with a `CHECK` constraint.

| Classification | What stands behind it |
| --- | --- |
| `experiment_supported` | A randomised experiment measured this metric and reached a conclusion. **The only class that supports a causal claim** |
| `observed` | The money movement is in billing data for exactly these accounts and this period. No model. Does not by itself prove cause |
| `estimated` | A model from measured inputs, with every assumption listed and its source named. A scenario, not a measurement |
| `associated` | An observational comparison with no randomisation. Direction only |
| `insufficient_evidence` | Not enough data to put a figure on it. Stated rather than filled in |

## The classification is derived, not chosen

`classifyEvidence` takes a basis — facts about what the data supports — and
returns the strongest class those facts justify. `recordImpact` then refuses
any claim stronger than that, and refuses several shapes that are contradictory
on their face:

- an `observed` figure that carries assumptions ("if something had to be
  assumed, it is an estimate")
- an `estimated` figure with no assumptions ("otherwise nobody can disagree
  with it")
- an `insufficient_evidence` record that nonetheless carries an amount
- any figure with no `method`, because a figure that cannot be checked is not a
  figure
- an amount with no currency

Understating is always permitted. Overstating never is.

## The rule that protects the whole feature

**An inconclusive experiment falls to `insufficient_evidence`, not to
`estimated`.**

Laundering a null result into a number is the single most tempting dishonesty
available in this part of a product, so it is a rule with a test rather than a
convention.

## Totals are bucketed, and there is no grand total

`impactSummary` returns one bucket per classification per currency, strongest
evidence first, each carrying the meaning of its class. There is no field that
sums them, and there will not be one.

The only way to produce a single "revenue impact" figure is to add a measured
amount to a modelled one, and the result would be a number nobody could
defend. A test asserts that an observed ₹36,000 and an estimated ₹36,000 never
become ₹72,000.

## Observed movement for a cohort

`observedMovementForIdentities` decomposes MRR movement restricted to a set of
people: churned, contraction, expansion, new, reconciling with the net change.
Annual plans are normalised to monthly; currencies are reported separately and
never summed.

"MRR fell 3%" is a company metric. "The 41 accounts affected by this case lost
₹X between them" is something a team can act on, and it needs the case's
membership — which is why `friction_case_users` exists.

When the churned figure is zero, the record says so explicitly: a measurement
of zero, not an absence of a measurement.

## Estimates always carry a range

`estimateMonthlyRevenue` returns a point and a band built by halving and
doubling the least certain input. A single number invites a precision nobody
has. Every input becomes a listed assumption with `source` set to `measured`,
`user_supplied` or `default`, and a horizon over twelve months adds a stated
limitation of its own.

Any zero input produces no figure at all, classified
`insufficient_evidence` — a model with a zero in it is vacuous rather than
small.

## What an experiment can and cannot buy you

`experimentSupportedImpact` reads an experiment's own verdict and only
`improvement_supported` or `worse_outcome` qualifies. It deliberately does not
compute a revenue figure from an experiment on a non-revenue metric: an
experiment showing an activation lift does not say what that lift is worth, and
combining the two is a model, which makes it an estimate.

## Tests

43 tests in `packages/analytics/test/revenue-impact.test.ts`.

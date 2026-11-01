# Churn metrics

RetainOS keeps three things apart that are routinely conflated.

## 1. Inactivity — observed, configurable, not a prediction

A user who has fired no event for longer than the project's configured
threshold.

The threshold is per-project because it is meaningless otherwise: a fortnight of
silence is alarming for a daily note-taking tool and completely normal for a
quarterly reporting product. The default is 14 days and it is meant to be
changed.

Every surface that shows inactivity carries:

> This is observed inactivity against a threshold you configured. It is not a
> prediction of cancellation, and it says nothing about intent.

**RetainOS does not label anyone "churned" for not opening an app.**

## 2. Subscription churn — verified, from the provider

A subscription that stopped paying, with its cause taken from the provider's own
event type:

| Cause | Source |
|---|---|
| `voluntary` | A `cancelled` event |
| `payment_failure` | A `payment_failed` event with no recovery |
| `expiration` | An `expired` event |
| `trial_expired` | A trial that ended without converting |
| `downgrade` | A downgrade to no paid plan |
| **unknown** | **Anything RetainOS could not attribute** |

Unattributed cancellations are reported as **unknown**, never bucketed into a
guess. RetainOS does not invent cancellation reasons, and the breakdown says so
in its own output.

## 3. Revenue churn — an amount, not a count

MRR lost from subscriptions that were paying at the start of a period and paying
nothing at the end. Distinct from *contraction*, which is a reduction by a
subscription that is still paying. See `REVENUE_INTELLIGENCE.md`.

## Revenue at risk

Three observed amounts:

- MRR on subscriptions whose user has been inactive past the threshold
- MRR on subscriptions in a failed-payment state
- MRR on subscriptions already cancelled in the window

Each is an **observed amount**: MRR currently attached to subscriptions in a
given state. None is a forecast, and the label attached to every one of them
says:

> Observed amounts and heuristic risk exposure. Inactivity is a signal to
> investigate, not evidence that a customer will cancel, and no amount here is
> promised recoverable.

## What RetainOS deliberately does not build

- **A churn prediction score.** A number between 0 and 1 attached to a customer
  invites action on a model nobody validated. If you want one, build it against
  your own outcomes and evaluate it honestly.
- **Automated retention interventions.** No discount offers on a cancellation
  page, no "are you sure" friction, no win-back emails fired on an inactivity
  trigger. Retention should improve because the product became more useful.
- **Any claim about recovered revenue.** RetainOS will not tell you it saved
  you money.

# Customer health

## There is no score

A health score in this category is almost always a number out of 100 from a
formula nobody outside the vendor has seen. A success manager cannot act on
"67" and cannot tell whether 67 means "logged in less" or "about to leave".

So there is no score. There are eight named signals and four states a person
can disagree with.

## The states

| State | Meaning |
| --- | --- |
| `strong_engagement` | Every signal with enough data points the same way, and none is concerning |
| `mixed_signals` | Some positive, some not. The normal state for most accounts, and **not a warning** |
| `attention_suggested` | One or more signals are worth a look. **Not a prediction that they will leave** |
| `insufficient_information` | Too few signals have data. Stated plainly rather than reported as a middling score |

## The signals

Each reports what was observed, which way it counted, why, and — required by
the type — **what would change it**. An explanation nobody can act on is
decoration.

| Signal | Default weight | Concerning when |
| --- | --- | --- |
| `recent_activity` | 1.0 | No activity at all in the window |
| `activity_trend` | 0.8 | Activity halved against the prior period |
| `breadth_of_use` | 0.6 | None of the core features were used |
| `activation_reached` | 0.9 | The activation event never happened |
| `seat_engagement` | 0.7 | A quarter or fewer of known seats are active |
| `error_exposure` | 0.8 | Five or more errors hit this customer |
| `unresolved_feedback` | 0.4 | Two open bug reports, or three open items |
| `billing_status` | 1.0 | Past due, cancelled or expired |

Core events default to the project's declared tracked features, so breadth is
assessable without a second round of configuration.

## What the signals refuse to say

This is the design, not a limitation:

- **An absence of errors proves nothing** on a project that has never sent one.
  Reported as `unknown`, not as good news.
- **Silence from a customer is not a positive signal.** Most people never
  report anything, so zero open feedback carries no information.
- **A trend needs ten events in the earlier period.** Below that a ratio is
  noise wearing a percentage sign.
- **Seat engagement is never claimed for an individual**, and means nothing for
  a single-seat account.
- **Billing says nothing when the subscription is not linked**, and the signal
  says how to link it.

Below three signals with real data, **no state is claimed at all**. Looking
fine is the most damaging failure mode a health score has.

## Aggregation

Weigh the concerning signals against the supporting ones and compare. That is
all it does.

A deliberately boring rule a person can re-derive on paper beats a better rule
they cannot check, because the entire value of this feature is that someone
will act on it in a conversation with a real customer, and they need to be able
to explain why they are calling.

## Accounts are not people

`subject_kind` is `identity` or `account` and the two are never conflated. An
account's health covers every seat on it; `account_key` comes from the SDK and
**RetainOS never infers an account from an email domain**.

The roster orders by what is worth a conversation, then by revenue — not
because large customers matter more as people, but because a success team has
finite hours and needs an order.

## History

`recordHealthObservation` stores the state and every signal's contribution at a
point in time, so a change becomes visible rather than remembered. Recording
the same observation twice is a no-op.

## The disclaimer

```
A health state is a summary of observed product signals. It is not a churn
probability, not a prediction, and not a reason to treat a customer
differently without talking to them.
```

## Tests

37 tests in `packages/analytics/test/health.test.ts`, including one per refusal
above and one proving weights change the conclusion while leaving every
observation identical.

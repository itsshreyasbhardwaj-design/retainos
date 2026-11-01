# Revenue intelligence

Every figure comes from a verified provider event. **RetainOS never estimates
revenue from product usage.**

## MRR

Sum of normalised monthly amounts for subscriptions in `active` or `past_due`
status.

| Interval | Normalisation |
|---|---|
| Monthly | amount |
| Quarterly | amount ÷ 3 |
| Annual | **amount ÷ 12** |

The annual divisor is the one that matters: counting a ₹11,988 annual plan as
₹11,988 of MRR inflates the figure twelvefold, and there is a test asserting it
does not happen here. Normalisation lives in one function so no two screens can
disagree.

**Trials contribute nothing.** A trial has not paid, and counting it is the
fastest way to make MRR a number nobody trusts.

**`past_due` still counts.** The subscription exists and the revenue is at risk
rather than gone. It is reported separately under revenue at risk.

## MRR movement

The decomposition compares each subscription's normalised MRR at the start and
end of the period:

| Component | Definition |
|---|---|
| **New** | Began paying this period, never paid before |
| **Reactivation** | Paid before, stopped, began again this period |
| **Expansion** | Increase from a subscription already paying at the start |
| **Contraction** | Decrease from a subscription still paying at the end |
| **Churn** | Was paying at the start, paying nothing at the end |

It is computed by snapshot comparison rather than by classifying event types,
because a subscription can be upgraded *and then* cancelled inside one month —
event classification double-counts that case and snapshot comparison does not.

### The reconciliation identity

```
start + new + reactivation + expansion − contraction − churn = end
```

This is asserted in the test suite against a deliberately messy month
containing a renewal, an upgrade, a downgrade, a cancellation and a new
subscription. If a change breaks the decomposition, that test fails.

## Retention ratios

```
NRR = (start + expansion − contraction − churn) / start
GRR = (start − contraction − churn) / start
```

NRR excludes new and reactivated business, so it measures what happened to the
revenue you already had. GRR excludes expansion, so **it can never exceed 100%**
— asserted in a test.

Both are `null`, never `Infinity`, when starting MRR is zero, and the result
says why.

## Currency

Currencies are **reported separately and never converted**. There is no implicit
exchange rate anywhere. When a project has subscriptions in more than one
currency, the result carries:

> This project also has subscriptions in USD. Currencies are reported separately
> and never converted without an explicit exchange rate.

## Provider events

Webhooks are verified before anything is applied:

- **Razorpay** — HMAC-SHA256 over the raw body, compared in constant time.
- **Stripe** — HMAC-SHA256 over `timestamp.body`, with a five-minute timestamp
  tolerance so a captured request cannot be replayed later.
- **Simulator** — development only, and **refused outright in production**, so
  an unsigned webhook endpoint cannot exist on a live deployment.

Application is **idempotent on the provider's own event id**. Every provider
delivers at least once, often more; a repeat is a no-op and still returns 200 so
the provider stops retrying.

**The raw payload is never stored.** Only the mapped fields, so a provider
cannot push customer PII into RetainOS through a field RetainOS did not ask for.

A payment is recorded as successful only because a signed provider event said
so. Visiting a checkout success page is not evidence of payment, and there is no
code path that treats it as one.

> **Status:** signature verification follows each provider's documented scheme
> and the mapping typechecks, but has **not been exercised against live provider
> traffic**. Recorded as *Implemented but unverified* in `FEATURE_STATUS.md`.

# Subscriptions

## Plans

| | Free | Starter | Growth | Agency |
|---|---|---|---|---|
| Monthly | ₹0 | ₹999 | ₹2,499 | ₹4,999 |
| Annual | — | ₹9,990 | ₹24,990 | ₹49,990 |
| Projects | 1 | 3 | 10 | 40 |
| Events/month | 10,000 | 100,000 | 500,000 | 2,000,000 |
| Seats | 1 | 3 | 15 | 40 |
| Raw history | 30d | 90d | 180d | 365d |

> These prices are a commercial hypothesis, not validated willingness to pay.
> They are configuration in `packages/shared/src/plans.ts` and are expected to
> change.

A test asserts each plan is a **feature superset** of the one below it, so a
pricing change cannot accidentally remove a capability from a higher tier.

## Enforcement

Server-side, **in the code path that does the work** — not only in a pre-check.

`createProject` calls `checkCountLimit` itself, so an owner with every
permission still cannot exceed their plan. That gap was found by a test, and the
fix was to move enforcement into the write path.

### Partial acceptance at the limit

When a batch of 100 events crosses the monthly allowance at event 60, RetainOS
**accepts 60 and reports 40 rejected**, with the reason and the remaining quota.
It does not silently drop the batch and does not bill past the plan.

### A lapsed subscription

Falls back to free-plan limits and **keeps read and export access to its own
data**. `dataExport` is true on every plan, including Free, and a test asserts
it. Withholding a customer's own data on cancellation would be a dark pattern.

## Billing

**Production:** Razorpay, India-first. A subscription is marked paid only when a
signed provider event says so. Visiting a checkout success page is not evidence
of payment and no code path treats it as one.

**Development:** a billing simulator. It changes the plan locally, records the
change as `is_simulated`, labels it **simulated** everywhere it appears, and
**never reports a payment as confirmed**. The simulator webhook endpoint is
refused outright in production.

**Live payment collection is not implemented.** Razorpay checkout is not wired.
`FEATURE_STATUS.md` records this.

## Cancellation

An ordinary setting. No retention flow, no exit survey you must complete, no
countdown, no discount interstitial. Downgrading to Free keeps your data.

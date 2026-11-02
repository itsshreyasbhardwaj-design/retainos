# Billing, entitlements and the pricing axis

## The axis is tracked users, not events

Pricing on event volume punishes exactly the behaviour the product needs. A
team that instruments carefully, adds the events an analysis requires, or
backfills their history would get a larger bill for doing the work properly —
so they instrument less, and the product becomes useless to them.

Tracked users scale with the customer's own revenue, which is the only axis
where paying more happens because the product is working.

`PRICING_AXIS` states this as data, so the pricing page cannot drift from the
enforcement.

## The event ceiling is abuse protection

Every plan has one, set far above what thorough instrumentation needs. It
exists so a runaway loop cannot run up a bill.

The claim is made checkable rather than merely asserted: `eventHeadroomRatio`
is tested to be **at least 100 events per tracked user on every plan**, so
"events are not the price lever" is a property of the data rather than a line
of marketing.

| Plan | Tracked users / month | Event ceiling | Headroom |
| --- | --- | --- | --- |
| Free | 1,000 | 1,000,000 | 1,000× |
| Starter | 10,000 | 10,000,000 | 1,000× |
| Growth | 50,000 | 50,000,000 | 1,000× |
| Agency | 250,000 | 250,000,000 | 1,000× |

## How tracked users are counted

`trackedUsersThisMonth` is a `COUNT(DISTINCT identity_id)` over the calendar
month, **counted rather than incremented**: the same person appearing on five
days is one tracked user, and a counter cannot know that.

When the allowance is used up, **people already being tracked keep working**.
Only new identities are refused. Cutting off the users a customer already has
would break their product's analytics mid-month to make a billing point.

The rejection reason distinguishes the two failures that otherwise look
identical to a developer staring at the event inspector:

- `tracked_user_limit_reached` — your plan is full
- `no_identity` — your SDK call is missing an id

## What is never charged for

Listed in `PRICING_AXIS.neverCharged` and enforced by the plan data:

- **Exporting your own data.** `dataExport` is `true` on every plan, including
  when a subscription lapses. Holding product data hostage is a dark pattern.
- **Deleting a user's data, or responding to a privacy request.**
- **Seeing why your instrumentation is broken.** The Instrumentation Doctor is
  on the free plan.
- **Adding another event name or another property.**

A test asserts `dataExport` on every plan, so this cannot be quietly removed.

## Feature gating

`PlanFeatures` is a closed set of booleans; `entitlementFor` resolves the
organisation's plan and every gate is checked **server-side in the write
path**, not only in a pre-check. A UI that forgets to hide a button cannot
produce an unentitled write.

| Feature | Free | Starter | Growth | Agency |
| --- | --- | --- | --- | --- |
| FrictionGraph | ✓ | ✓ | ✓ | ✓ |
| Opportunity engine | | ✓ | ✓ | ✓ |
| Customer health | | ✓ | ✓ | ✓ |
| Command centre | | ✓ | ✓ | ✓ |
| Alerting | | ✓ | ✓ | ✓ |
| Provider integrations | | ✓ | ✓ | ✓ |
| Retention playbooks | | | ✓ | ✓ |
| Revenue Impact Studio | | | ✓ | ✓ |
| Data export | ✓ | ✓ | ✓ | ✓ |

FrictionGraph is on the free tier for the same reason as the doctor: a free
user who can see that their signals are about the same people is a user who
understands what the product is for.

## Metered usage

`consumeUsage` accepts partially: a batch of 100 events crossing the limit at
event 60 accepts 60 and reports 40 rejected, rather than dropping the batch or
billing beyond the plan. The quota is returned to the SDK so it can back off.

## Payments

RetainOS **never receives card details**. The billing connection stores a
provider name and non-secret configuration; card data goes directly to the
provider. There are no automatic payment retries, and nothing in the system can
charge, refund or retry.

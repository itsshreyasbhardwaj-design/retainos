# Competitive analysis

## What this document is, and what it is not

**No vendor evaluation was performed.** Nobody signed up for a competitor's
product, read their current documentation, or tested their behaviour while
building RetainOS. This document therefore makes **no claims about what any
named product does or does not do**, because any such claim would be invented,
and inventing them would be exactly the dishonesty this product is built to
avoid.

What follows is the set of **category patterns** RetainOS was designed against:
recurring failure modes in analytics and retention tooling as a class, drawn
from how these products are generally structured rather than from testing any
one of them. Each is stated as a pattern, not as an accusation against a
vendor.

If you need a real competitive analysis — for positioning, pricing or a
funding conversation — it has to be done by someone using the products, and the
section at the end says what that would take.

## The patterns RetainOS is designed against

### Pattern 1: correct signals, unconnected

A tool computes a funnel, a retention cohort, an error rate and a feedback
inbox, each correctly, and leaves the user to notice they are about the same
people. Nothing is wrong with any single number; the product's value leaks out
of the gap between them.

**RetainOS's answer:** FrictionGraph joins signals by shared keys — the same
identities, the same error fingerprint, the same account — and refuses to link
two things that merely happened at a similar time.

### Pattern 2: an opaque priority score

A single number, often out of 100, produced by a weighting nobody outside the
vendor has seen. It cannot be argued with, which is why it ships and why it
does not get used.

**RetainOS's answer:** nine named factors, each showing its raw measurement,
its unit, the named transform that normalised it, its weight and its
contribution. Weights are editable per project. A missing input contributes
nothing and has its weight removed from the denominator rather than counting as
a zero.

### Pattern 3: an unexplainable health score

"67 out of 100" tells a success manager nothing they can act on and nothing
they can repeat to a customer.

**RetainOS's answer:** no score. Eight named signals, each stating what was
observed and what would change it, and four states a person can disagree with —
including `insufficient_information`, because looking fine is the most damaging
failure mode a health score has.

### Pattern 4: revenue attribution with no evidence class

"This change made you ₹X" with no statement of how that was derived, so an
observed cancellation and a modelled projection are added together and reported
as one number.

**RetainOS's answer:** five classifications, derived from the evidence rather
than chosen; figures of different classes are never summed, and there is no
grand total anywhere in the product.

### Pattern 5: retention measured against itself

Messages are sent to users who look likely to leave, the ones who stayed are
counted, and the difference is reported as retention saved. The people who were
going to stay anyway are in the numerator.

**RetainOS's answer:** a holdout between 5% and 50% is required, assignment is
deterministic, and a playbook where 60% of treated users converted still
reports "no difference detected" when the holdout also converted at 60%.

### Pattern 6: silent data-quality failure

Broken instrumentation produces confident wrong numbers rather than errors. A
missing activation event yields an activation rate of 0%, which reads as a
product problem.

**RetainOS's answer:** thirteen checks, each finding carrying what is wrong,
why it affects the numbers, how to fix it and how to verify; available on the
free plan; and alerts are withheld entirely while a blocking finding is open.

### Pattern 7: pricing on event volume

Billing by events charges more for careful instrumentation, so teams
instrument less and the tool becomes less useful to them — a pricing model that
degrades its own product.

**RetainOS's answer:** tracked users, with an event ceiling at least 100× the
tracked-user allowance on every plan, asserted in a test.

### Pattern 8: migration as a precondition

A tool that requires moving off an existing analytics stack to be evaluated
rarely gets evaluated.

**RetainOS's answer:** read from PostHog, Amplitude, Sentry, GitHub, billing
providers and CSV, with provenance on every row and one authoritative source
per thing so nothing is double counted.

## What a real competitive analysis would require

- Paid or trial accounts on each product being compared
- A fixed evaluation script run identically on each: instrument the same
  events, raise the same problem, follow it to a decision
- Screenshots and dated notes, so a claim can be checked later
- Their current pricing pages, captured with dates, since pricing changes
- An explicit list of what was **not** evaluated

Until that exists, RetainOS's public material should describe what RetainOS
does and why, and make no comparative claims at all. See
`PRODUCT_DIFFERENTIATION.md`, which is written to that constraint.

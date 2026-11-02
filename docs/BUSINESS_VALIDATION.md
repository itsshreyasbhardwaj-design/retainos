# Business validation

## Nothing has been validated

**No customer has used RetainOS. No revenue exists. No pricing has been
tested. No interview has been conducted.** Every figure in the product's own
pricing and positioning is a hypothesis.

This document records what is assumed, what would disconfirm it, and what it
would cost to find out — because the alternative, a page of projected ARR and
invented testimonials, would be the exact dishonesty the product refuses to
commit on its customers' behalf.

## What does not exist

- No customers, paying or trialling
- No revenue
- No letters of intent
- No pricing research
- No user interviews or usability sessions
- No benchmark data from other companies
- No live production deployment
- No testimonials, logos or case studies, and none will be fabricated

## The assumptions the product is built on

Each is stated with what would disconfirm it, so a single honest conversation
can kill one.

### A1. Teams have unconnected signals and feel it

**Assumed:** product teams with analytics, feedback and error tooling cannot
reliably tell when those tools are describing the same problem.

**Disconfirmed by:** teams saying they already do this easily, or that they do
not care because prioritisation is decided by the loudest customer anyway.

**Cheapest test:** ten conversations. Ask how they chose the last thing they
fixed, and whether they looked at more than one tool to decide.

### A2. An arguable ranking is worth more than a confident one

**Assumed:** showing the factors behind a priority order makes it usable in a
real disagreement, and teams want that.

**Disconfirmed by:** users ignoring the factor breakdown entirely and asking
for a single number. This is the assumption most likely to be wrong — opaque
scores are popular for a reason.

**Cheapest test:** show the opportunities page to five product people and watch
whether they read the factors or scroll past them.

### A3. Honest measurement is a buying reason, not a tax

**Assumed:** "we will not tell you a number we cannot defend" wins trust and
therefore money.

**Disconfirmed by:** buyers choosing a tool that gives them a figure for the
board deck. Plausible, and would not be a small revision — it would mean the
product's central argument does not sell.

**Cheapest test:** put the positioning in front of ten buyers before building
anything else.

### A4. Pricing on tracked users is acceptable

**Assumed:** ₹999 / ₹2,499 / ₹4,999 per month, on tracked users, is in range
for Indian SaaS teams.

**Disconfirmed by:** anything. There is no evidence for these numbers at all.

**Cheapest test:** ask. Price is the single easiest thing on this list to
research and the one with the least excuse for being a guess.

### A5. Reading from existing tools removes the main objection

**Assumed:** teams will try RetainOS alongside PostHog or Amplitude but will
not migrate to evaluate it.

**Disconfirmed by:** teams saying they would happily switch, or that running
two tools is itself the objection.

**Cheapest test:** the same ten conversations as A1.

### A6. Refusing manipulative retention does not cost deals

**Assumed:** the absence of cancellation-flow offers and pressure messaging is
neutral or positive in a buying decision.

**Disconfirmed by:** a buyer asking for exactly that feature and leaving when
told it does not exist. If this happens, the answer is to lose the deal — this
one is a values constraint rather than a hypothesis, and it is listed here so
the cost of holding it is visible rather than hidden.

## What *has* been verified

All of this is a statement about the software, not the business:

- 748 automated tests pass
- The typechecker is clean across every package
- The production build succeeds
- 44 routes and 3 detail routes return 200 against a seeded project
- Statistical functions were validated against published reference values
- Every figure in the demo is computed from seeded events, with the demo
  organisation banner-labelled throughout so no screenshot of it can be
  mistaken for a real customer

## What would come next, in order

1. Ten conversations about A1 and A5. No code.
2. Positioning in front of ten buyers (A3). No code.
3. Price research (A4). No code.
4. A real pilot with one team's actual data, with the Instrumentation Doctor as
   the first thing they see — because if their data is broken, nothing else in
   the product can be evaluated honestly.

Until step 4 produces a figure, this document should keep saying nothing has
been validated.

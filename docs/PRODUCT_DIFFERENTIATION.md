# What makes RetainOS different

Written to a constraint: **every claim below is about RetainOS and is
checkable in this repository.** There are no comparative claims, because no
competitor evaluation has been done (see `COMPETITIVE_ANALYSIS.md`).

## The one-sentence version

RetainOS connects unconnected product signals into cases about specific
people, orders them by a ranking you can argue with factor by factor, and
refuses to tell you what your work was worth unless it can say how it knows.

## The nine things it will not do

These are the product. Each is enforced in code with a test, not documented as
an intention.

1. **It will not report an effect it has not measured.** A playbook with a
   holdout under 5% is refused. An inconclusive experiment is
   `insufficient_evidence`, never an estimate.

2. **It will not sum figures of different evidence classes.** There is no
   grand total of revenue impact anywhere, because producing one means adding a
   measured amount to a modelled one.

3. **It will not impute a missing input.** An unanswered scoring factor
   contributes nothing and has its weight removed from the denominator, so a
   case is not punished for a question nobody has answered.

4. **It will not invent a connection.** Two signals link only through a shared
   key. Temporal proximity is the weakest link there is and is suppressed
   whenever a stronger one exists.

5. **It will not claim a live integration it has not verified.** A registered
   connection reads "set up but never verified. Nothing is being read from it
   yet" until a probe actually succeeds.

6. **It will not read an absence as a signal.** No errors proves nothing on a
   project that has never sent one. Silence from a customer is not satisfaction.
   Both are reported as unknown.

7. **It will not alert on data it knows is broken.** Every alert except the
   ingestion one is withheld while a blocking instrumentation finding is open.

8. **It will not help you keep someone who wants to leave.** A cancellation
   playbook can only run after the cancellation has completed. Pressure copy is
   refused by name. There is no retention-offer mechanism to build on.

9. **It will not charge you for being thorough.** Pricing is on tracked users;
   export, privacy requests, the Instrumentation Doctor and adding events are
   never charged for.

## The four things it does that are structurally unusual

### Signals become cases about people

A friction case stores *which* identities it covers, not just how many
(`friction_case_users`). That is what lets the same case produce a revenue
figure, a playbook audience and an account health signal — all about the same
people, rather than three independent approximations.

### Scores are arguable

`opportunity_score_factors` stores, per factor: the raw value, its unit, the
normalised value, the weight, the contribution, the provenance
(`measured` / `user_estimate` / `absent`) and a plain-language explanation. The
UI renders all of it. A disagreement becomes "the reach weight is too high for
us", which is a conversation that ends in a changed setting.

### Evidence class is a column, not a caption

`revenue_impact_records.classification` is `NOT NULL` with a `CHECK`. A figure
cannot be stored without one, the class is derived from the basis rather than
chosen, and `recordImpact` refuses any claim stronger than the evidence
supports — including a few that are contradictory on their face.

### Honesty survives the UI

Caveats are rendered prominently rather than tucked into tooltips, empty states
say *why* they are empty, and a quiet week is reported as a finding rather than
as a gap. `SCORE_DISCLAIMER`, `REVENUE_IMPACT_DISCLAIMER`, `HEALTH_DISCLAIMER`
and `CANCELLATION_RULE` are exported constants, so the wording cannot drift
between the engine and the page.

## Who this is for, honestly

- **A founder** who wants to know what to fix on Monday and why, and who will
  not be helped by a dashboard that shows six unrelated true things.
- **A product team** that needs to defend a prioritisation decision to someone
  who disagrees with it.
- **A success team** that needs to say something specific to a customer rather
  than quoting a number out of 100.

## Who this is not for

- Anyone who needs a figure to put in a board deck and does not care how it was
  derived. RetainOS will keep adding the caveat.
- Anyone who wants to improve retention by making leaving harder. There is
  nothing here for that, by design.
- A team with no instrumentation and no appetite to add any. The Instrumentation
  Doctor will tell them the truth, which is that the numbers cannot be trusted
  yet.

# RetainOS — product excellence pass: delivery report

A single question shaped this pass: **would a SaaS team pay for this every
month?** The audit that opened it (`RETAINOS_PRODUCT_AUDIT.md`) answered no,
and said why: RetainOS v0.1 was an excellent measurement tool and a weak
product. Its signals were unconnected islands, there was no way to choose what
to fix, revenue was disconnected from product work, nothing closed the loop
with users, data quality was invisible, and the pricing billed for the wrong
thing.

This report says what was built, what was not, and what remains unverified.
Nothing below is projected, fabricated or rounded up.

---

## 1. Verified state

| | |
|---|---|
| Tests passing | **748** (744 unit and integration, 4 end-to-end) |
| Tests added this pass | **322** |
| Typecheck | Clean across every package |
| Production build | Succeeds |
| Routes returning 200 | **44**, plus 3 detail routes resolved from real ids |
| Database tables | **84**, across 8 migrations |
| Source lines | ~45,300 TypeScript |
| Documentation files | 40 |
| Runtime dependencies in the core | Zero (`node:sqlite`, no native builds) |
| Paid services required | None |

Verified means: the tests run and pass on this machine, the build completes,
and every page listed was loaded in a browser against the seeded project
during this pass.

---

## 2. What was built

### 2.1 FrictionGraph — the product's centre of gravity

Signals that touch the same people become one case. Links come from shared
keys — the same identities, the same error fingerprint, the same account,
the same workflow — with fixed, visible strengths. Two signals that merely
happened in the same week are not linked, and temporal proximity, the weakest
rule there is, is suppressed whenever a stronger link exists.

Five detectors, each producing candidates *with the identity set behind them*,
which is what makes corroboration possible. Observation, hypotheses and
limitations are stored separately so one is never read as another. Re-detection
updates evidence and leaves a human's status decision alone.

`docs/FRICTION_GRAPH.md` · 35 tests

### 2.2 Opportunity engine — a ranking you can argue with

Nine factors, each reporting its raw measurement, its unit, the named transform
that normalised it, its weight and its contribution. Weights are editable per
project; changing them changes the conclusion without changing a measurement.

The rule that matters: **a missing input is never imputed.** An unanswered
factor contributes nothing and has its weight removed from the denominator, so
a case is not punished for a question nobody has answered.

`docs/OPPORTUNITY_ENGINE.md` · 30 tests

### 2.3 Instrumentation Doctor — the data under the metrics

Thirteen checks on the failures that look like findings. Each carries what is
wrong, the evidence, what it does to your numbers, how to fix it and how to
verify the fix. Findings resolve themselves when the check stops firing.

Free on every plan: unreliable data makes the whole product worse, including
for people who never pay.

`docs/INSTRUMENTATION_DOCTOR.md` · 30 tests

### 2.4 Revenue Impact Studio — five evidence classes

Observed, experiment-supported, estimated, associated, insufficient evidence.
The classification is **derived from the basis, not chosen**, and `recordImpact`
refuses any claim stronger than the evidence supports.

Figures of different classes are never summed. There is no grand total anywhere
in the product, because the only way to produce one is to add a measured amount
to a modelled one.

An inconclusive experiment falls to insufficient evidence, never to an
estimate.

`docs/REVENUE_IMPACT.md` · 43 tests

### 2.5 Customer health — no score

Eight named signals, each stating what was observed, which way it counted, and
what would change it. Four states a person can disagree with. Below three
signals with real data, no state is claimed at all.

An absence of errors proves nothing on a project that has never sent one, and
silence from a customer is not satisfaction. Both are reported as unknown.

`docs/CUSTOMER_HEALTH.md` · 37 tests

### 2.6 Retention playbooks — holdout-controlled and consent-gated

A named person approves; editing returns it to draft. A holdout of 5–50%
receives nothing. Email consent is checked at enrolment and again at delivery,
and an absent record is never consent. Caps are hard and count across every
playbook. Every suppression records its reason.

Cancellation playbooks can only run after the cancellation has completed, and
there is no mechanism anywhere to delay or discourage someone leaving. Pressure
copy is refused by name.

Measurement is against the holdout: a playbook where 60% of treated users
converted still reports no difference when the holdout also converted at 60%.

`docs/RETENTION_PLAYBOOKS.md` · 45 tests

### 2.7 Alert quality engine

A floor on affected users that cannot be configured below five, a minimum
cooldown, deduplication, and a refusal to fire at all while a blocking
instrumentation finding is open. Every alert carries five evidence fields,
required by the schema.

Quality is measured by whether anyone acted. A rule that fires ten times and is
never acknowledged is told it is producing noise, and the recommendation is to
raise the threshold or turn it off — explicitly not to make it more sensitive.

`alerts.ts` · 38 tests

### 2.8 Founder copilot and command centre

What changed, what it means, what is not known, what to do first. Data quality
is the first section, because reading a 12% activation fall before learning the
activation event stopped arriving is how people act on nothing.

Runs entirely on local rules — no model, no key, no network. Partly cost,
mostly honesty: a generated paragraph reads as confident whether or not the
data supports it.

`copilot.ts` · 18 tests

### 2.9 Provider integrations with provenance

Read from PostHog, Amplitude, Sentry, GitHub, billing providers and CSV without
asking anyone to migrate. Every event row carries its source and sync run. One
source is authoritative per thing, and a record from any other is refused at
import and counted.

A connection is "connected" only after a probe succeeds; credentials are
refused if they appear in the config, with the environment variable named in
the error. Imports can be reverted, removing only their own rows.

`docs/INTEGRATIONS.md` · 41 tests

### 2.10 Pricing that does not punish instrumentation

Moved from event volume to tracked users. The event ceiling is at least 100×
the tracked-user allowance on every plan — asserted in a test, so the claim
stays checkable — and functions as abuse protection.

Tracked users are counted, not incremented. When the allowance runs out, people
already tracked keep working and only new ones wait, with a rejection reason
that distinguishes "your plan is full" from "fix your SDK call". Export,
privacy requests, the Instrumentation Doctor and adding events are never
charged for.

`docs/BILLING_AND_ENTITLEMENTS.md`

### 2.11 The product surface

Nine new pages, each showing the engine's reasoning rather than only its
answer: command centre, FrictionGraph list and detail, opportunities, customer
health roster and account detail, playbooks, revenue impact, Instrumentation
Doctor, data sources, alerts.

---

## 3. Defects found and fixed during verification

Six real bugs, each fixed at the cause rather than worked around. These are
listed because they are the evidence that the verification was real.

1. **A privacy denylist false positive.** `scrubProperties` stripped whitespace
   before matching, so a legitimate error title compacted to 45 letters and
   matched the opaque-blob pattern. Genuine error titles and feedback were
   being refused. Fixed in both `shared` and the SDK, then tightened again with
   an entropy requirement when the first fix flagged a long run of one
   character.

2. **A friction case stored how many users it covered, not which ones.**
   Revenue impact had no cohort to read, and the action I had written queried a
   column that did not exist. Migration 008 persists the membership;
   recomputing it later would have answered about different data.

3. **`generateBrief` was writing.** It called the ranking function, which
   persists, with an empty org id — so the command centre would have rewritten
   the stored ranking on every page view. The seed crashed on the foreign key
   rather than doing it silently. Ranking now takes `persist`, and a test holds
   the stored rows' ids and timestamps across a read.

4. **The data export had fallen a whole feature-set behind the schema.** It now
   covers 52 tables, with a test that fails if a project-scoped table is added
   without reaching the export. "Your data is yours" has to keep being true as
   the product grows.

5. **A playbook could be configured from an event to itself**, enrolling nobody
   while looking like it worked. Refused with a reason.

6. **The smoke test covered 32 routes, none of them new, and no detail pages.**
   It now checks 44 routes plus one real detail page per kind, resolving ids
   from the database.

Two honesty improvements came out of the same work: the activation detector now
states both user counts when the funnel window and the identity set disagree
rather than quietly picking one, and health's core events fall back to the
project's declared tracked features instead of leaving half the product
unconfigured.

---

## 4. What was not built

Stated plainly, with a document each where it matters.

| Not implemented | Where it is documented |
|---|---|
| FixFlow Pro | `docs/FIXFLOW_PRO.md` |
| AI SaaS retention intelligence | `docs/AI_SAAS_INTELLIGENCE.md` |
| Activation Blueprints | `docs/AI_SAAS_INTELLIGENCE.md` |
| Smart Onboarding Optimizer | same |
| Cancellation / churn intelligence surface | same (the data is captured) |
| Product Value Scorecard | same |
| Customer Voice Intelligence | same |
| Agency Command Center | same |
| Customer Success Workflows | same |
| Time To First Value as its own page | same (activation measures it) |
| Release Intelligence | same |
| Retention Operations Timeline | same |
| RetainOS Engineer | same |
| Browser-level automated end-to-end tests | `docs/NEXT_STEPS.md` |

**Partially implemented, with the gap named:**

- **Playbook delivery.** The engine schedules, gates, caps and measures.
  Nothing actually sends; no delivery adapter exists.
- **Provider probes.** Every path around them is built and tested. No live HTTP
  probe exists, so every provider except CSV correctly reports "never
  verified".

**Blocked:**

- **Real Product Benchmarking.** Requires aggregate data across customers that
  does not exist. Publishing benchmark figures without it would mean inventing
  them, so it is blocked rather than deferred.

---

## 5. What is not verified

- **No customer has used this.** No revenue, no pilot, no interviews, no
  pricing research. Every price is a hypothesis.
  (`docs/BUSINESS_VALIDATION.md`)
- **No competitor was evaluated.** `docs/COMPETITIVE_ANALYSIS.md` describes
  category patterns and states explicitly that it makes no claims about any
  named product.
- **No production deployment.** Verified on one machine, in development mode
  and a production build, against seeded data.
- **No live integration has ever returned a byte.** The product says so on its
  own Data Sources page.
- **Load and scale are untested beyond benchmarks** on roughly 9,000 seeded
  events.

---

## 6. The demo

`pnpm db:seed` builds a reproducible project: 1,247 signups, ~8,850 events
across 121 days, 56 active subscriptions, a release that lifts onboarding
completion from 45% to 70%, an experiment that reaches a verdict, and — new in
this pass — six B2B accounts with `account_key` sent properly, the detectors
run, the doctor run, alert rules installed and a brief generated.

Every figure is computed from the seeded events. Nothing is a fixture. The
demo organisation is banner-labelled throughout the UI, so no screenshot of it
can be mistaken for a real customer:

> Demonstration data. Every figure on this screen comes from a fictional seeded
> project. The numbers reconcile with each other but describe no real company.

Login: `demo@retainos.example` / `Demo-RetainOS-2026`

---

## 7. The honest verdict

The audit asked whether this was worth paying for monthly. It is now a product
rather than a measurement tool: signals connect into cases about specific
people, the ranking is arguable factor by factor, revenue impact cannot be
stated without its evidence class, retention work is measured against a holdout
or not reported, and the data underneath is checked and shown.

What stands between that and a business is not more features. It is ten
conversations, one pilot on real data, and a price someone has actually agreed
to pay. `docs/NEXT_STEPS.md` puts those first, ahead of every remaining
feature, and the first three require no engineering at all.

The product's central bet is that "we will not tell you a number we cannot
defend" is a reason to buy rather than a tax. That bet is untested. It is the
first thing worth finding out.

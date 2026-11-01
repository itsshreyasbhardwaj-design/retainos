# RetainOS product audit

Audit of the repository as it stood before this enhancement, against the
question: **is this worth paying for every month?**

Verified at audit time: `pnpm typecheck` clean, **426 tests passing**,
production build succeeds (46 routes), all 35 routes return 200 against seeded
data.

---

## What exists, and how far it is verified

| Subsystem | Status | Note |
|---|---|---|
| Schema, migrations, tenancy | Completed and verified | 59 tables, 4 migrations; 14 cross-tenant isolation tests |
| Authentication, roles | Completed and verified | scrypt, sessions, 6 roles × 28 permissions |
| SDK | Completed and verified | Zero dependencies, 41 tests |
| Ingestion | Completed and verified | Full rejection matrix, two-level idempotency, 42 tests |
| Funnels, actives, journeys, features | Completed and verified | 25 funnel tests; reference dataset reproduces exactly |
| Activation | Completed and verified | Customer-defined; open-window honesty |
| Retention | Completed and verified | Fixed denominators, DST-correct, 21 tests |
| Revenue (MRR/NRR/GRR) | Completed and verified | Decomposition reconciles by assertion, 28 tests |
| Experiments | Completed and verified | Six validity checks, Holm correction, 27 tests |
| ImpactLab before/after | Completed and verified | Six confounder categories, 15 tests |
| FeedbackOS | Completed and verified | Widget, portal, clustering, voting |
| FixFlow | Completed and verified | Evidence→issue, approval gate, enforced workflow |
| RetainAI | Completed and verified | Seven deterministic rules, grounded answers |
| GitHub dispatch | Implemented but unverified | Never called the real API |
| Provider webhooks | Implemented but unverified | Never seen live traffic |
| OnboardOS | Partially implemented | Reporting works; no builder UI |
| Live payment collection | Not implemented | Simulator only |

**The engine layer is strong.** The metric semantics are deliberate,
documented, and tested against reference values.

---

## The commercial gap

The audit's real finding is not a list of broken features. It is that
**v0.1 is an excellent measurement tool and a weak product**.

### 1. It tells you *where*, never *what to do*

A founder opens the dashboard, sees "largest drop-off: onboarding_started →
onboarding_completed, 350 users lost", and is no better off than with any free
analytics tool. The signals that would explain it — the eleven feedback reports
using the same words, the error spike that started the same week, the release
that shipped two days earlier — all exist in the database, **as unconnected
islands**.

Nothing joins them. That join is the product.

### 2. It cannot answer "which of these first?"

Insights carry a `severity` integer that orders a list. It is not derived from
anything a founder cares about: how many users, how much revenue, how strong the
evidence, how much work. There is no way to compare a reliability bug against an
activation friction against a billing failure.

### 3. Revenue is measured but never connected to product work

`mrrMovement` and `revenueAtRisk` are correct and isolated. Nothing links a
friction point to the revenue exposed by it, and nothing distinguishes an
*observed* financial fact from an *estimated* one or an *experiment-supported*
one. Without that distinction, any revenue claim is either useless or dishonest.

### 4. Nothing closes the loop with users

A problem can be found, fixed, released and measured — and the people who
reported it are never told. There is no mechanism to act on a finding at all.

### 5. Data quality is invisible until it is wrong

Rejections are counted in the inspector, but nobody checks whether the
*activation event is even instrumented*, whether a schema drifted, whether
identity links are missing, or whether exposure events exist for a running
experiment. Every metric silently depends on these.

### 6. Pricing bills for the wrong thing

Plans are gated mostly on event volume. Established platforms give away far more
volume than RetainOS can. **Billing for ingestion is competing on the one axis
where RetainOS is structurally weakest.**

---

## What this enhancement therefore builds

Not more charts. The missing connective tissue:

| Gap | Built |
|---|---|
| Signals are unconnected islands | **FrictionGraph** — an evidence relationship engine |
| No way to choose what to fix | **Opportunity Engine** — explainable, weighted, auditable scoring |
| Revenue disconnected from product work | **Revenue Impact Studio** — five evidence classifications |
| No way to act on a finding | **Retention Playbooks** — consent-gated, holdout-controlled |
| Data quality invisible | **Instrumentation Doctor** — twelve checks, free tier |
| Account-level blindness | **Account Health** — transparent, rule-based, no fake prediction |
| Analysis without a next step | **Founder Copilot** — answer, facts, sources, uncertainty, next step |
| Noise | **Alert Quality Engine** — materiality floors and deduplication |
| Forced migration | **Provider integrations** — provenance and deduplication, no forced switch |
| Wrong pricing axis | **Plans repriced on workflow value, not volume** |

---

## Constraints honoured

- Additive migrations only. No existing table altered destructively.
- No existing engine's semantics changed. New engines read from them.
- Everything still runs with no paid service, no Docker, no API key.
- No capability is claimed as working until a test asserts it.

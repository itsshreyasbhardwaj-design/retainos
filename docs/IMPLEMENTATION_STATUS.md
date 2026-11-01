# Implementation status

What this build produced, and what it did not.

## Delivered

**21,000+ lines** across 5 packages, 1 application, 1 worker, 1 demo app and 27
documents.

| Layer | State |
|---|---|
| Schema and migrations | 59 tables, 4 migrations, idempotent |
| Tenancy | Scope-based, 14 isolation tests |
| Authentication | scrypt, sessions, lockout, CSRF, 6 roles × 28 permissions |
| SDK | Zero dependencies, 25 KiB, 41 tests |
| Ingestion | Full rejection matrix, idempotency, identity resolution, 42 tests |
| Analytics | Funnels, actives, journeys, features, segments |
| Activation | Customer-defined, time to value, open-window honesty |
| Retention | Cohorts, fixed denominators, DST-correct, incomplete periods excluded |
| Revenue | MRR, NRR, GRR, reconciling decomposition, multi-currency |
| FeedbackOS | Widget, portal, inbox, clustering, voting, roadmap |
| FixFlow | Evidence to issue, approval gate, enforced workflow |
| ImpactLab | Before/after with six confounder categories |
| Experiments | Stable assignment, exposure analysis, six validity checks, Holm correction |
| RetainAI | Seven deterministic rules, confidence labelling, grounded answers |
| Statistics | Normal, t, chi-square, incomplete beta and gamma, from scratch |
| SaaS | Plans, entitlements, metering, simulator, export, erasure |
| Application | 46 routes, marketing site, full module coverage |
| Worker | Idempotent jobs, conditional-update claiming, retry with backoff |

## Verified

- `pnpm typecheck` — clean across every package and the app
- `pnpm test` — 422 passing
- `pnpm test:e2e` — 4 passing, the full founder journey
- `pnpm build` — 46 routes, production build succeeds
- `pnpm bench` — measured, in `PERFORMANCE.md`
- The application was **run and driven in a browser** against seeded data:
  login, dashboard, funnels and experiments all render real computed figures
- The demo app sent **19 real events over HTTP** to a running instance, with the
  invalid name refused client-side and sensitive properties stripped at both
  layers

## Not verified

Stated here as plainly as in `FEATURE_STATUS.md`:

- **GitHub dispatch has never called the real API.** No token was available.
- **Webhook signature verification has never seen live provider traffic.**
- **No browser end-to-end test suite.** The journey is covered in-process.
- **No accessibility audit.** No screen reader, no automated checker.
- **No mobile viewport verification.**
- **No sustained or distributed load test.**
- **No penetration test.**

## Not implemented

Session replay · heatmaps · error monitoring · mobile SDKs · multi-touch
attribution · live payment collection · LLM adapter · onboarding flow builder UI
· embeddable onboarding components · two-way GitHub sync · release notification
email · sequential experiment testing · RevenueCat adapter · feedback
attachments.

Each is recorded in `FEATURE_STATUS.md` with its reason. Several are
deliberate refusals rather than gaps — see `ROADMAP.md`.

## Bugs found and fixed during the build

The test suite earned its place:

1. `incompleteBeta` returned `h − 1` instead of `h`, making **every t-test and
   chi-square p-value wrong**. Caught against an analytic reference value.
2. `createProject` did not enforce the plan's project cap.
3. `await flush()` resolved immediately during an in-flight flush.
4. `enqueueJob` could not report whether it created or deduplicated.
5. Activation suppressed one of two applicable warnings.
6. A contamination check that could never fire.
7. A `batch_id` foreign key violated by insert ordering.
8. `mrrSeries` read a field that did not exist on its parameter type.
9. Retention took 30 seconds on 20,000 identities. Now 0.4 s.
10. Activation issued 150 queries where one would do. Now 7.8× faster.
11. `node:sqlite`'s null-prototype rows crashed the improvement detail page at
    runtime — React cannot serialise them to a client component. Normalised at
    the source, with a measured escape hatch for the hot paths.

## Honest assessment

The engine layer is the strongest part: the metric semantics are deliberate,
documented and tested against reference values, and the system is consistently
more willing to say "not yet knowable" than to show a confident wrong number.

The weakest parts are the two external integrations, which are written but
unproven, and the absence of browser-level and accessibility testing. Those are
the first things to fix, and they are named rather than glossed.

# Testing

```bash
pnpm typecheck    # every package and the app
pnpm test         # 422 unit tests
pnpm test:e2e     # 4 end-to-end journey tests
pnpm build        # production build
pnpm bench        # performance on your machine
pnpm verify       # all of the above
```

**426 tests passing.** No skipped tests, no `.only`, no snapshots.

## Distribution

| Suite | Tests | Covers |
|---|---|---|
| `shared/time` | 17 | Timezone bucketing, DST transitions, ISO weeks, leap years |
| `shared/privacy` | 8 | The sensitive-data denylist, by key and by value |
| `shared/validate` | 13 | Schema validation, naming, type coercion refusal |
| `database/accounts` | 29 | Auth, lockout, sessions, keys, permissions |
| `database/tenancy` | 14 | **Cross-tenant isolation** |
| `database/ingest` | 42 | The complete rejection matrix, idempotency, identity |
| `database/entitlements` | 21 | Plans, quotas, partial acceptance |
| `analytics/stats` | 44 | Distributions against published reference values |
| `analytics/funnels` | 25 | Ordering, windows, segments, edge cases |
| `analytics/retention` | 21 | Denominators, incomplete periods, DST |
| `analytics/activation` | 19 | Definitions, time to value, open windows |
| `analytics/revenue` | 28 | MRR normalisation, movement reconciliation, idempotency |
| `analytics/experiments` | 27 | Assignment, validity checks, statistics |
| `analytics/impact` | 15 | Before/after, confounder detection |
| `analytics/insights` | 26 | Rules, confidence, clustering |
| `analytics/worker` | 13 | Idempotent aggregation, job claiming, retries |
| `analytics/ask` | 16 | Intent parsing, grounded answers, refusals |
| `sdk` | 41 | Consent, identity, privacy, delivery, retries |
| `tests/journey` | 4 | **The full founder journey** |

## What the tests actually assert

Not just "the function returns something". The suite encodes the product's
commitments:

- **The brief's reference funnel.** 1,000 → 700 → 350 → 200 reproduces exactly.
- **DST correctness.** A user signing up at 13:00 on 7 March and returning at
  13:00 on 8 March is day-1 retained, across a 23-hour day.
- **Incomplete periods are not zero.** A cohort without a complete day-7 window
  reports `null`, and is excluded from the average rather than counted as 0%.
- **The revenue decomposition reconciles.** Asserted against a month containing
  a renewal, upgrade, downgrade, cancellation and new subscription.
- **Statistics match published values.** Φ(1.96)=0.975002, probit(0.975)=1.959964,
  t(2.0, df=10) p=0.073388, χ²(3.8415, df=1) p=0.05, accurate into the far tails.
- **Observations never hedge; hypotheses always do.** Asserted by regex over
  every generated finding.
- **Cross-tenant access fails.** 14 separate attempts.
- **No credential reaches the store.** Both by key name and by value shape.

## Bugs these tests caught during the build

Worth recording, because they are the argument for the suite:

1. **`incompleteBeta` returned `h − 1` instead of `h`**, making every t-test and
   chi-square p-value wrong. Caught by comparing I₀.₅(1,1) against its analytic
   value of 0.5.
2. **`createProject` did not enforce the plan's project cap.** An owner could
   exceed their plan. Fixed by moving enforcement into the write path.
3. **`await flush()` resolved immediately** when a flush was already in flight,
   so callers could not wait for delivery.
4. **`enqueueJob` could not tell callers whether it created or deduplicated**, so
   the scheduler reported phantom work every run.
5. **Activation suppressed one of two applicable warnings.** Fixed by returning
   all of them.
6. **A contamination check that could never fire**, because the schema already
   made it impossible. Replaced with the inconsistency that can occur.
7. **`node:sqlite` returns null-prototype rows**, which React Server Components
   refuse to serialise to a client component — a runtime 500 on the improvement
   detail page, invisible to the typechecker. `Db.all` now normalises, with a
   measured `allFast` escape hatch for the engine hot paths.

## What is not tested

Stated plainly:

- **Browser end-to-end.** The 32-step flow is covered in-process by
  `tests/journey.test.ts`, not through a real browser. Playwright is not
  installed.
- **The GitHub API.** The dispatch path is typechecked and its surrounding
  workflow is tested with a simulated result; the real call has not been made.
- **Live provider webhooks.** Signature verification follows each documented
  scheme but has not seen real provider traffic.
- **Accessibility.** No screen-reader or automated audit was run.
- **Mobile viewports.** Built mobile-first, not verified in a browser at phone
  width.
- **Sustained or distributed load.** `pnpm bench` measures one machine.

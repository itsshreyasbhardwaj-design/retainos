## What this changes

## Why

## Verification

- [ ] `pnpm verify` passes (typecheck, unit tests, end-to-end tests, build)
- [ ] A bug fix includes a test that fails without the fix
- [ ] New metric semantics are asserted by a test, not just exercised

## Honesty checks

Tick what applies, or say why it does not:

- [ ] Any new metric returns the **definition** that produced it
- [ ] Incomplete periods are marked incomplete, not shown as real values
- [ ] No observational result implies causation
- [ ] Observations and hypotheses stay separate
- [ ] No division by an unchecked denominator (`null`, never `NaN`)
- [ ] No new path that could collect sensitive data
- [ ] Any new external action is behind an explicit approval gate
- [ ] `docs/FEATURE_STATUS.md` updated if a capability's status changed

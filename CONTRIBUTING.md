# Contributing

## Setup

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Node 22.5+ is required: RetainOS uses `node:sqlite` and runs TypeScript directly
with `--experimental-strip-types`.

## Before opening a pull request

```bash
pnpm verify    # typecheck, unit tests, end-to-end tests, build
```

## The rules that matter here

RetainOS makes specific promises about honesty in measurement. A change that
breaks one of these will be rejected even if every test passes, so it is worth
stating them.

**A metric must be able to explain itself.** Every engine returns its
definitions alongside its numbers, and the UI renders them. If you add a metric,
add its definition to the return value — the `Metric` component makes
`definition` a required prop precisely so this cannot be skipped.

**Never show an incomplete period as a real value.** Mark it incomplete and
exclude it from averages. A cohort without a finished window reports `null`, not
zero.

**Never imply causation from observation.** Before-and-after results carry
`causalClaim: "none"` and enumerate their confounders. Only an experiment
supports a causal claim.

**Keep observations and hypotheses apart.** A finding's observation must contain
no hedging language and its hypotheses must all read as guesses. There is a test
asserting exactly that.

**Never divide by an unchecked denominator.** Return `null`, never `NaN` or
`Infinity`, and say why it is null.

**Never add a way to collect sensitive data.** The denylist in
`packages/shared/src/privacy.ts` is enforced on both sides. Session replay,
keystroke capture and fingerprinting are not features to add behind a flag.

**Never add an external action without an approval gate.** Anything that leaves
the system — an issue, a message, a payment — requires an explicit, audited
approval.

## Code conventions

- **No new runtime dependencies** in `shared`, `database`, `analytics` or `sdk`
  without a strong argument. The SDK has zero and should keep them.
- **No TypeScript parameter properties.** `--experimental-strip-types` cannot
  transform them.
- **Client components import `@retainos/shared/<module>`**, never the barrel,
  which would pull `node:crypto` into the browser bundle.
- **Comments explain *why*.** The code already says what it does.
- **Parameterise every query.** Where a table or column name must be
  interpolated, take it from a closed literal list.

## Tests

A bug fix comes with a test that fails without it. New metric semantics come
with a test asserting the semantics, not just the plumbing — ideally against a
hand-computed dataset or a published reference value, as the statistics tests
do.

## Documentation

If a change alters what a capability does or how far it has been verified,
update `docs/FEATURE_STATUS.md` in the same pull request. That file is the
project's claim about its own honesty, and it is only worth something if it
stays true.

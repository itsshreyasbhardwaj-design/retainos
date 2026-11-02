# FixFlow Pro — not implemented

**Status: Not implemented.**

The directive specified a FixFlow Pro upgrade. It was not built in this pass,
and this document exists to say so clearly rather than to describe something
that does not exist.

## What does exist

FixFlow itself, from the first build, and documented in `FIXFLOW.md`:

- Improvement tasks with a state machine and an audit trail
- Evidence attachment, with cross-project references refused
- GitHub issue drafting that **requires explicit human approval before
  dispatch** (`createIssueDraft` → `approveIssueDraft` → dispatch)
- Outcome recording, linked to ImpactLab measurement

This pass added one FixFlow-adjacent capability: a friction case can be linked
to an improvement (`linkCaseToImprovement`), so the evidence that justified the
work stays attached to the work.

## What FixFlow Pro was specified to add, and is not here

- Richer reproduction capture
- Automated patch suggestion
- Deeper repository context

## The constraints any future implementation must keep

From the directive, and these are not negotiable in a later pass:

- No fabricated source-code access
- No invented stack traces
- No invented reproduction results
- No unauthorised repository changes
- Nothing approves its own patches
- No automatic pull-request merges
- No production deployment without separate authorisation

The existing GitHub integration already holds the line that matters: it is
read-only for repository state, and an issue is dispatched only after a named
person approves the draft. Any Pro feature must be built on that, not around
it.

## Why it was not built

The eleven phases of this pass were scoped to the engines that make the product
worth paying for monthly — connecting signals, ordering work, measuring effects
honestly, and not lying about revenue. FixFlow Pro is an improvement to a
feature that already works, rather than a gap in the product's core argument,
so it was deferred.

See `NEXT_STEPS.md` for where it sits relative to everything else outstanding.

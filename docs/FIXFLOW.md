# FixFlow

Turning a measured problem into a developer-ready task, and keeping the evidence
attached to it.

## The record

| Field | Why it is separate |
|---|---|
| **What was observed** | A measurement. Facts and figures |
| **Hypothesised cause** | A guess. Rendered as unconfirmed everywhere it appears |
| **How to investigate** | What would settle whether the guess is right |
| **Proposed work** | What to build |
| **Acceptance criteria** | How to know it is done |
| **Measurement plan** | How to know it worked — decided *before* merging |
| **Priority rationale** | Why this before something else |

Keeping observation and hypothesis apart is the whole point. A task that reads
"the template step is confusing" has already decided something nobody verified.

## Evidence

Each piece carries a **frozen snapshot** of the numbers at the moment it was
attached, so the task still means what it meant after the underlying data moves
on. Evidence from another project is refused — tested.

A task with no evidence is an opinion, and the UI says so.

## Status workflow

```
detected → investigating → validated → planned → approved
         → in_development → in_review → released → measuring
         → resolved | not_effective → closed
```

Transitions are **enforced**. A task cannot jump from `detected` to `released`,
because that would leave an audit trail claiming work was approved and shipped
without either step happening. `not_effective` is a first-class outcome: work
that shipped and did not help is a result worth recording.

Moving to `approved` requires the `improvement:approve` permission and is
written to the audit log.

## The drafted issue

```markdown
## Problem
## Evidence                 ← frozen snapshots, rendered as values
## Hypothesised cause
> The section above is a hypothesis, not a diagnosis. It has not been confirmed.
## Investigation
## Reproduction steps
  _RetainOS does not have reproduction steps for this issue. They were not
   recorded, and RetainOS will not invent them from telemetry._
## Proposed work
## Acceptance criteria
## How the impact will be measured
```

**Sections with no recorded content say so**, rather than being filled with
plausible text. A fabricated reproduction step wastes a developer's afternoon,
and an issue that confidently states a cause nobody verified is worse than one
that admits the gap.

Labels are derived from the evidence: `customer-reported` when feedback is
attached, `activation` for funnel evidence, `retention`, `revenue`, and a
priority label.

## The approval gate

```
draft ──(explicit approval by a permitted user)──▶ approved ──▶ dispatched
```

Nothing reaches GitHub from the `draft` state. The approval is recorded
**before** the network call, so a failed dispatch still leaves an auditable
record of exactly what a human approved. A task that already has a dispatched
issue in a repository cannot get a second one.

## The timeline

```
problem → investigation → approval → GitHub issue → release → measurement → outcome
```

Rendered on the task's page, with measurements badged **observational** or
**experiment**. When a task is released but unmeasured, the page says so:
shipping is not the same as improving.

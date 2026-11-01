# ImpactLab

Two methods, and ImpactLab is explicit about which one you are looking at.

## Before and after — observational

Compares a metric in the window before a release with the window after.

Every result carries `causalClaim: "none"` as a field, not just as prose, and:

> This is an observational before-and-after comparison. It shows that a metric
> changed around a release; it does not show that the release caused the change.
> Only a controlled experiment supports a causal claim.

### The confounder list is the point

A before/after number alone invites a causal reading. So every result enumerates
six categories, stating for each whether it was detected:

| Confounder | How it is detected |
|---|---|
| **Concurrent releases** | Other releases recorded inside the comparison window, named |
| **Acquisition mix** | Any single source's share moved by 15 points or more |
| **Tracking changes** | An event schema version changed inside the window |
| **Population change** | The measured population grew or shrank by more than 50% |
| **Seasonality** | The window is under 14 days, so day-of-week effects are not averaged out twice |
| **External factors** | **Always reported as undetectable.** RetainOS cannot see marketing campaigns, press, outages, pricing changes or competitor activity |

That last row never says "clear". Absence of detection is not evidence of
absence, and the result says so.

### Also reported

- Wilson intervals on both windows
- A descriptive difference test, labelled as scale only, not a causal test
- Whether the "after" window is still partial, with how many days have elapsed
- A small-population warning below 30 in either window

## Experiments — causal

See `EXPERIMENTATION.md`. This is the only method here that supports a claim
about *why* a metric moved.

## The impact timeline

Each improvement carries its full chain:

```
problem → investigation → approval → GitHub issue → release → measurement → outcome
```

Rendered on the improvement's own page, with measurements badged
**observational** or **experiment** so the strength of the evidence is visible
at a glance rather than buried in a tooltip.

When an improvement is marked released but has no measurement, the page says:

> This shipped but has not been measured. Shipping is not the same as
> improving — measure it in ImpactLab.

## Release timeline

Users firing a core event in the week either side of each release. Shown with:

> Two numbers either side of a date is the weakest form of evidence there is. It
> is shown because it is sometimes the only thing available, not because it
> supports a conclusion.

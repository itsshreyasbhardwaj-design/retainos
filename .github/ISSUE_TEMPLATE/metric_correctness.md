---
name: Metric correctness
about: A number looks wrong, or disagrees with its own definition
labels: correctness, needs-triage
---

**Which metric**

**What it showed**

**What you believe it should show, and why**

**The definition shown next to it**
Every metric in RetainOS renders the rule that produced it. Paste it here — if
the number disagrees with its own stated definition, that is a bug in the
engine; if the definition itself is wrong for your product, that may be a
documentation or configuration issue.

**Relevant configuration**
- Reporting timezone:
- Conversion window / activation window:
- Return event, if retention:
- Segment filter, if any:

**Sample size**
Small samples move a lot. If the figure is based on fewer than ~30 users,
RetainOS should already be warning you — say whether it did.

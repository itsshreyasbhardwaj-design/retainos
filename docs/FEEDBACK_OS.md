# FeedbackOS

## Sources

The embeddable widget, a public portal, manual entry, CSV import and in-app
surveys. Every source lands in the same inbox with its origin recorded.

## The widget

```html
<script src="https://your-instance.example/widget?key=rpk_YOUR_KEY" async></script>
```

Dependency-free, served as a single script, and deliberately limited. It
collects: the category, a summary, a description, an optional contact address,
and the **page path** the host application is on.

It does **not** read the DOM, capture form fields, take automatic screenshots or
observe keystrokes. There is no code in it that could. The panel says so to the
person filling it in:

> Only what you type here is sent, along with the page path. This widget does
> not read the page, your inputs or your keystrokes.

**Contact details are discarded unless the consent box is ticked**, enforced
server-side rather than in the widget.

## The inbox

Statuses: new · under review · planned · in progress · released · closed ·
duplicate. With search, filters, tags, internal notes and duplicate merging.

Internal notes are filtered out of the public portal **in SQL**, not in the UI,
so a rendering mistake cannot leak one.

## Clustering

Reports are grouped by **term overlap** — Jaccard similarity over tokenised
titles and bodies, single-link agglomerative with a similarity floor.

Deliberately simple and entirely local: no embedding model, no API call, no
dependency, no per-query cost. It is enough to surface "eleven people are
describing the same problem".

Every cluster is editable, because **shared vocabulary is not shared meaning**,
and a grouping is a suggestion. A cluster a human has curated is preserved
across automatic rebuilds — tested.

## Duplicate detection

Candidates ranked by similarity, with the score shown so a human can judge.
Merging moves votes across, deduplicated by voter, and refuses to create a
duplicate chain or a loop.

## Feature requests and voting

Votes are deduplicated per voter by a **salted hash** of a stable voter token,
so the portal can prevent double voting without storing who voted.

Stated on every surface that shows a vote count:

> Votes signal interest. They are not verified demand. A vote count reflects the
> people who found the portal and chose to vote; it is not a sample of your
> users. Shipping the most-voted request is not the same as shipping the most
> valuable one.

## The roadmap

Derived from feedback status, so it cannot drift out of step with the inbox. It
reflects **status, not commitment** — nothing on it is a delivery date, and
items marked Released describe work that shipped, not work verified to have
helped.

## What feedback is not

Carried on every screen:

- Report volume reflects **who chose to write in**, not how many users are
  affected.
- Sentiment in a report is **not evidence** of dissatisfaction across your base,
  or of a coming cancellation.
- Absence of feedback is **not evidence of satisfaction**. Most users never
  write in.

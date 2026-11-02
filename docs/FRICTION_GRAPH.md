# FrictionGraph

## The problem it exists to solve

Before this engine, RetainOS could tell you six true things at once and leave
you to notice they were about the same people:

- 117 users dropped between registration and onboarding
- a feedback theme about the import step, with 9 reports
- an error group affecting 23 users
- a release on the 14th
- two past-due subscriptions
- day-7 retention down 4 points

Every one of those was computed correctly. None of them told you whether they
were one problem or six, and a human staring at six dashboards is not going to
work it out reliably. That gap is where the product's value was leaking out.

## What a case is

A **friction case** is a set of signals that touch the same people, plus the
observation, the hypotheses, and the limitations — stored apart from each other
on purpose, so one is never read as another.

```
friction_cases            the case: observation, kind, status, counts
friction_evidence         the signals, with their numbers frozen at attachment
friction_relationships    why two signals are linked, with the shared value
friction_case_users       which people the case is about
friction_status_history   every status change, with who and why
```

`observation` is measurement only. `hypotheses` are explanations consistent
with the evidence, and the UI labels them as such. `limitations` is never empty
for a detected case — there is always something a funnel drop-off cannot tell
you.

## How signals get linked

Links come from **shared keys**, never from coincidence. Each relationship kind
carries a fixed strength, visible in the UI next to the link:

| Relationship | Strength | The shared key |
| --- | --- | --- |
| `shared_affected_users` | 0.90 | The same identities appear in both signals |
| `same_error_fingerprint` | 0.85 | The sender's own fingerprint |
| `same_workflow` | 0.70 | The workflow both signals name |
| `same_feedback_theme` | 0.60 | The cluster id |
| `same_account` | 0.55 | The `account_key` the SDK supplied |
| `same_product_version` | 0.45 | The version on both records |
| `same_release_window` | 0.40 | A release between the two observations |
| `temporal_proximity` | 0.20 | Only that they happened near each other |

Two rules make this honest rather than decorative:

1. **No shared key, no link.** Two signals that merely happened in the same
   week are not related, and the graph says nothing rather than guessing.
2. **Temporal proximity is suppressed whenever a stronger link exists.** It is
   the weakest evidence there is, and showing it alongside a real link invites
   the reader to treat them as comparable.

A release links forward only. A release on the 14th can be related to a problem
observed on the 20th; it cannot be related to one observed on the 1st.

## The detectors

Five, each producing candidates *with the set of identities behind them* —
which is what makes corroboration possible at all:

| Detector | Looks for |
| --- | --- |
| `detectActivationFriction` | The largest absolute loss in the activation funnel |
| `detectReliability` | Error fingerprints affecting enough distinct users |
| `detectFeedbackVolume` | Feedback clusters above a volume floor |
| `detectBillingFriction` | Subscriptions stuck in a failed-payment state |
| `detectRetentionFriction` | A cohort retention drop against the prior period |

After a detector produces a candidate, `gatherCorroboratingEvidence` pulls in
every other signal touching **the same users** — feedback they filed, errors
they hit, releases in the window, subscriptions they hold. Confidence rises
with independent corroboration, using the same four-level scale as the rest of
the product (`strong_supporting_evidence` down to `insufficient_data`).

## What re-detection does not do

`persistFrictionCases` updates the observation, the evidence and the
relationships, and leaves `status` and `improvement_id` alone. A dismissed case
stays dismissed; an investigation in progress is not reset to `detected`. A
human's decision survives the machine re-running, and there is a test that
fails if that stops being true.

Membership is replaced rather than accumulated, so the case always describes
the people its current evidence covers.

## Revenue exposure, and what it is not

`revenueExposureFor` sums the monthly recurring revenue of the accounts the
affected users belong to. Annual plans are divided by 12; currencies are never
mixed.

It is labelled **exposure**, and the UI repeats the caveat wherever the figure
appears: these accounts pay this much and were affected by this case. Neither
fact implies they will leave, and the product does not multiply it by a churn
probability to produce a scarier number.

## Segment concentration

`segmentConcentration` reports a dimension only when more than 60% of affected
users share one value. A 50/50 split is not a concentration, and reporting it
as one would send a team chasing a pattern that is only the shape of their user
base.

## Workflow

```
detected → investigating → evidence_collected → validated → approved
         → in_development → released → measuring → resolved
```

with `dismissed` and `inconclusive` reachable from most states, and
`dismissed → detected` as the only way back. `canTransitionCase` is the single
source of truth, and the UI offers only the transitions it permits — the others
are not hidden buttons, they are genuinely not possible.

## Tests

35 tests in `packages/analytics/test/friction.test.ts`, covering: each
relationship rule, no-shared-key-no-link, release directionality, temporal
suppression, strength ordering, exposure arithmetic, concentration thresholds,
converging-signal detection, observation-versus-hypothesis separation,
membership persistence and replacement, cross-project isolation, erasure
cascading, and every workflow transition.

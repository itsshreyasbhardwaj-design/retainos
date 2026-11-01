# Feature status

The honest answer to "does this actually work". Every capability carries one of
five statuses, and the evidence behind it.

- **Completed and verified** — implemented, and covered by tests that would fail
  if it broke.
- **Implemented but unverified** — the code exists and typechecks, but has not
  been exercised against the real external system it talks to.
- **Partially implemented** — some of it works; the gap is named.
- **Not implemented** — absent.
- **Blocked** — cannot be completed in this environment, with the reason.

Last updated at the end of the build that produced this repository.
Test counts: **426 passing** (422 unit, 4 end-to-end), typecheck clean,
production build succeeds.

---

## Foundation

| Capability | Status | Evidence |
|---|---|---|
| Monorepo, workspaces, typecheck | Completed and verified | `pnpm typecheck` clean across every package |
| Database schema and migrations | Completed and verified | 4 migrations, 59 tables, applied idempotently; `packages/database/test` |
| Authentication (scrypt, sessions) | Completed and verified | 27 tests in `accounts.test.ts`, including lockout and timing-equalised failures |
| Organizations, projects, roles | Completed and verified | Role/permission matrix tested; 6 roles, 28 permissions |
| **Multi-tenant isolation** | Completed and verified | 14 dedicated tests in `tenancy.test.ts`, every one a cross-tenant access attempt that must fail |
| Audit log | Completed and verified | Written on every permission change, key issuance, dispatch and erasure |

## Developer SDK

| Capability | Status | Evidence |
|---|---|---|
| `@retainos/sdk` event SDK | Completed and verified | 41 tests; zero dependencies; 25 KiB of source |
| Consent gating | Completed and verified | Nothing queues before consent; withdrawal discards the queue |
| Identity and reset | Completed and verified | Anonymous → identified promotion; reset rotates the anonymous id |
| Batching, retry, backoff | Completed and verified | Retries 5xx and 429, discards 4xx, preserves the idempotency key across retries |
| Queue limits | Completed and verified | Oldest dropped at capacity, reported in diagnostics |
| Client-side privacy denylist | Completed and verified | Sensitive keys and credential-shaped values never leave the device |
| React integration | Implemented but unverified | `packages/sdk/src/react.ts` typechecks and is used by the demo app's docs, but has no component test |
| Mobile SDKs | Not implemented | The HTTP API is documented and usable from any platform |

## Event ingestion

| Capability | Status | Evidence |
|---|---|---|
| Ingestion endpoint | Completed and verified | 42 tests covering the whole rejection matrix |
| Schema registry and validation | Completed and verified | Types, required properties, closed schemas, deprecation, versioning |
| Server-side privacy enforcement | Completed and verified | Denylist applied again on arrival; stripped properties reported, event still accepted |
| Idempotency (batch and per event) | Completed and verified | Replayed batch returns the original outcome without double-counting |
| Rate limiting | Completed and verified | In-process fixed window; **single node only** — see `EVENT_INGESTION.md` |
| Origin allowlist | Completed and verified | Enforced server-side, not only via CORS |
| Identity resolution | Completed and verified | Explicit identify only; a claimed anonymous id is never stolen; identified users never merged |
| Quota enforcement | Completed and verified | Partial batch acceptance at the limit, with the count reported back |

## Analytics

| Capability | Status | Evidence |
|---|---|---|
| Funnels | Completed and verified | 25 tests; reproduces the brief's 1000→700→350→200 reference exactly |
| Conversion window semantics | Completed and verified | Measured from the first step; boundary case tested |
| Segmentation | Completed and verified | Six closed dimensions; no demographic or sensitive segmentation possible |
| Active users, DAU/WAU/MAU | Completed and verified | Incomplete trailing buckets flagged |
| User journeys | Completed and verified | Aggregate paths only; consecutive repeats collapsed |
| Feature adoption | Completed and verified | Repeat use requires two distinct calendar days |
| **Timezone and DST correctness** | Completed and verified | 17 tests including spring-forward, fall-back and ISO week edges |

## Activation and retention

| Capability | Status | Evidence |
|---|---|---|
| Activation definitions | Completed and verified | 19 tests; signup is never treated as activation |
| Time to value | Completed and verified | Median and percentiles over activated users only |
| Open-window honesty | Completed and verified | Users still inside their window are reported, not hidden |
| Retention cohorts | Completed and verified | 21 tests; fixed denominator; incomplete cells excluded from averages |
| Inactivity detection | Completed and verified | Configurable threshold, labelled as observation not prediction |

## FeedbackOS

| Capability | Status | Evidence |
|---|---|---|
| Feedback submission and inbox | Completed and verified | Validation, status workflow, search, filters |
| Embeddable widget | Completed and verified | Served from `/widget`; collects only typed input and the page path |
| Public portal submission and voting | Completed and verified | Salted voter hash prevents duplicate votes without storing who voted |
| Clustering by shared terms | Completed and verified | 26 tests; human-curated clusters survive automatic rebuilds |
| Duplicate detection and merging | Completed and verified | Merge chains and loops refused |
| Roadmap | Completed and verified | Derived from status, so it cannot drift from the inbox |
| Attachments / screenshots | Not implemented | The table exists; no upload path is built |
| Support-ticket import | Not implemented | CSV import of feedback is available; no integration connectors |

## FixFlow

| Capability | Status | Evidence |
|---|---|---|
| Improvement tasks with evidence | Completed and verified | Frozen snapshots; cross-project evidence refused |
| Status workflow | Completed and verified | Illegal transitions rejected; full history recorded |
| Approval gate | Completed and verified | Only `improvement:approve` can approve; recorded in the audit log |
| GitHub issue drafting | Completed and verified | Never invents reproduction steps; states where they are missing |
| **GitHub dispatch** | Implemented but unverified | The call, error handling and audit trail are written and typechecked, but **have not been run against the real GitHub API**. No token was configured in this environment. |
| Duplicate issue prevention | Completed and verified | A task with a dispatched issue cannot get a second one in the same repository |

## ImpactLab and experiments

| Capability | Status | Evidence |
|---|---|---|
| Before-and-after measurement | Completed and verified | 15 tests; `causalClaim: "none"` always |
| Confounder detection | Completed and verified | Concurrent releases, acquisition mix, tracking changes, population shift, seasonality; external factors reported as undetectable |
| Experiment assignment | Completed and verified | Pure, stable, reproducible; weight distribution verified over 10,000 users |
| Exposure-based analysis | Completed and verified | Assignment is never used as the denominator |
| Sample ratio mismatch | Completed and verified | Chi-square at α=0.001; forces an invalid verdict |
| Contamination detection | Completed and verified | Exposure-versus-assignment mismatch is blocking |
| Premature stopping guard | Completed and verified | Pre-registered minimum; a dramatic early result is refused |
| Multiple comparisons | Completed and verified | Holm-Bonferroni across guardrails |
| **Statistics** | Completed and verified | 44 tests against published reference values for the normal, t, chi-square and beta distributions |
| Sequential testing / always-valid inference | Not implemented | Fixed-horizon tests only, which is why premature stopping is refused rather than corrected for |

## Revenue intelligence

| Capability | Status | Evidence |
|---|---|---|
| MRR, ARR, NRR, GRR | Completed and verified | 28 tests; the decomposition reconciles by assertion |
| Interval normalisation | Completed and verified | Annual ÷ 12, quarterly ÷ 3, applied in one place |
| Multi-currency | Completed and verified | Never summed or converted without an explicit rate |
| Churn by verified cause | Completed and verified | From provider event types only; unattributed reported as unknown |
| Revenue at risk | Completed and verified | Labelled observational throughout |
| Idempotent webhook application | Completed and verified | Repeat delivery is a no-op on the provider's event id |
| **Razorpay / Stripe webhooks** | Implemented but unverified | Signature verification follows each provider's documented scheme and the payload mapping typechecks, but **has not been exercised against live provider traffic** |
| RevenueCat | Not implemented | The provider enum accepts it; no adapter is written |

## RetainAI

| Capability | Status | Evidence |
|---|---|---|
| Deterministic insight rules | Completed and verified | 26 tests; observation and hypothesis asserted to stay separate |
| Confidence labelling | Completed and verified | Explicit sample-size rules; a huge effect on 30 users is only preliminary |
| Grounded question answering | Completed and verified | Refuses unrecognised questions rather than guessing |
| Evidence linking | Completed and verified | Every finding carries frozen snapshots |
| LLM adapter | Not implemented | The configuration flag and the boundary exist; no provider adapter is written. RetainAI is fully functional without one. |

## SaaS operations

| Capability | Status | Evidence |
|---|---|---|
| Plans and entitlements | Completed and verified | 21 tests; enforced in the write path, not just a pre-check |
| Usage metering | Completed and verified | Partial acceptance at the limit; monthly reset |
| Billing simulator | Completed and verified | Labelled as simulated everywhere; refused in production |
| **Live payment collection** | Not implemented | Razorpay checkout is not wired. The simulator changes plans locally and never claims a payment occurred. |
| Data export | Completed and verified | JSON and CSV; available on every plan including after lapse |
| Data erasure | Completed and verified | Deletes, anonymises and detaches correctly; queues aggregate recomputation |
| Retention policy enforcement | Completed and verified | Worker job deletes past the window, preserves aggregates |

## OnboardOS and ReleaseHub

| Capability | Status | Evidence |
|---|---|---|
| Release tracking | Completed and verified | Linked improvements, changelog, public/private entries |
| Changelog | Completed and verified | Includes a known-limitations category |
| Onboarding data model and reporting | Completed and verified | Flows, steps, progress, completion and dismissal rates |
| **Onboarding flow builder UI** | Partially implemented | The reporting screen works; creating and editing flows through the UI is not built. Flows can be created through the database or a seed script. |
| Embeddable onboarding components | Not implemented | No React checklist component ships |
| Release notification email | Not implemented | Deliberately: it needs a delivery provider and collected consent, neither of which RetainOS assumes |

## Application and interface

| Capability | Status | Evidence |
|---|---|---|
| 46 routes building | Completed and verified | `pnpm build` succeeds; route table in the build output |
| Marketing site | Completed and verified | Home, features with an honest capability matrix, pricing, docs, integrations, demo, privacy, terms |
| Responsive layout | Implemented but unverified | Built mobile-first with a collapsing nav; **not tested at mobile viewport in a browser** |
| Accessibility | Partially implemented | Semantic HTML, labelled controls, `aria-current`, visible focus rings, reduced-motion support. **No screen-reader or automated audit was run**, so it is not claimed as accessible. |
| Dashboard and all module screens | Completed and verified | Verified rendering real seeded data in a browser |

## Testing

| Capability | Status | Evidence |
|---|---|---|
| Unit tests | Completed and verified | 420 across shared, database, analytics and SDK |
| End-to-end journey test | Completed and verified | 4 tests covering the full founder journey in process |
| **Browser end-to-end tests** | Not implemented | The 32-step browser flow from the brief is covered in-process by `tests/journey.test.ts`, not through a real browser. Playwright is not installed. |
| Load testing | Partially implemented | `pnpm bench` measures ingestion throughput and query latency on one machine. No distributed or sustained load test was run. |
| Security tests | Completed and verified | Cross-tenant access, key misuse, permission escalation, secret exposure, data export authorisation and erasure all tested |
| Prompt injection | Not applicable in the usual sense | No language model is in the data path, so there is no prompt to inject into. Feedback text is never passed to a model as an instruction. |

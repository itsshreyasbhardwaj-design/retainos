# RetainOS

**Find the friction. Fix the experience. Prove the impact.**

RetainOS is a product intelligence and customer retention platform that connects
product analytics, customer feedback and development work into one workflow:
a measured problem becomes a developer-ready task, ships, and then gets verified.

It runs locally with no paid service, no Docker, no database server and no API key.

```bash
pnpm install
pnpm db:migrate
pnpm db:seed      # a fictional project with a year of reconciling data
pnpm dev          # http://localhost:3000, credentials printed by the seed
```

---

## What makes it different

Most analytics tools stop at the chart. RetainOS carries the measurement
forward:

| Stage | What happens | Where |
|---|---|---|
| **Trust** | Thirteen checks on the data under the metrics, because bad instrumentation does not fail — it answers. | Instrumentation Doctor |
| **Measure** | Events arrive. Funnels, activation and retention are computed from them. | Analytics, Activation, Retention |
| **Connect** | Signals that touch the same people become one case, linked by shared keys rather than coincidence. | FrictionGraph |
| **Choose** | Nine factors, each showing its measurement, its weight and its contribution. Argue with it specifically. | Opportunities |
| **Fix** | Approve an improvement; RetainOS drafts a GitHub issue with the evidence frozen into it. | FixFlow |
| **Prove** | Compare the metric with confounders named, settle it with an experiment, or say plainly that you cannot tell. | ImpactLab, Revenue impact |
| **Close the loop** | Tell the people who reported it — once, with a holdout, and never to stop someone leaving. | Playbooks |

### The nine things it will not do

Each is enforced in code with a test. They are the product, not a disclaimer.

1. Report an effect it has not measured against a holdout
2. Sum revenue figures of different evidence classes — there is no grand total
3. Impute a missing input; an unanswered factor loses its weight instead
4. Invent a connection between two signals with no shared key
5. Claim a live integration it has not verified with a real probe
6. Read an absence as a signal — no errors on a project that sends none proves nothing
7. Alert on data it knows is broken
8. Help you keep someone who wants to leave
9. Charge you for instrumenting thoroughly

Full reasoning: [`docs/PRODUCT_DIFFERENTIATION.md`](docs/PRODUCT_DIFFERENTIATION.md).

The improvement you approve carries the measurement that found it all the way
through to the result. That is one workflow, not four modules sharing a nav bar.

---

## What it refuses to do

These are enforced in code, with tests, not stated as values.

- **A funnel drop-off is reported as a location, never a cause.** Every surface
  that shows one says so.
- **An incomplete period is marked incomplete, never shown as a decline.** A
  cohort from two days ago has no day-7 number, and RetainOS says "not yet
  knowable" rather than drawing a cliff.
- **A before-and-after never claims causation.** It returns
  `causalClaim: "none"` and enumerates six categories of confounder, saying
  which it detected and which it cannot see at all.
- **An experiment with a sample ratio mismatch is invalid, not "a small
  effect".** Blocking validity failures override the p-value entirely.
- **No GitHub issue is created without an explicit approval.** There is no code
  path that pushes commits or opens pull requests.
- **The SDK will not collect** passwords, tokens, session ids, card numbers,
  CVVs, bank details, Aadhaar, PAN, passport numbers, private keys, one-time
  codes, health fields, dates of birth or precise coordinates. The server drops
  them again on arrival.
- **There is no session replay, keystroke capture or fingerprinting.** Not
  disabled — absent. No setting turns them on.
- **RetainAI computes nothing with a language model.** The analysis is a
  deterministic rule engine, it runs with no API key, and every record states
  what generated it.

---

## Repository layout

```
retainos/
├── apps/
│   ├── web/                 Next.js application, marketing site and HTTP API
│   └── demo-app/            A separate program that sends real events over HTTP
├── packages/
│   ├── shared/              Contracts, timezone-correct bucketing, privacy rules, plans
│   ├── database/            Schema, migrations, tenancy, ingestion, entitlements
│   ├── analytics/           Every metric engine and the statistics behind them
│   ├── sdk/                 @retainos/sdk — zero-dependency event SDK
│   └── ui/                  Reserved for extracted UI primitives
├── workers/analytics/       Background aggregation worker
├── scripts/                 Migrations, demo seed, benchmarks
├── tests/                   End-to-end journey tests
└── docs/                    27 reference documents
```

---

## Verification

```bash
pnpm typecheck    # every package and the app
pnpm test         # 422 unit tests across shared, database, analytics and the SDK
pnpm test:e2e     # the full founder journey, end to end
pnpm build        # production build
pnpm bench        # performance, measured on your machine
pnpm verify       # all of the above
```

`docs/FEATURE_STATUS.md` records every capability as **Completed and verified**,
**Implemented but unverified**, **Partially implemented**, **Not implemented**
or **Blocked**. It is the honest answer to "does this actually work".

---

## Documentation

| Document | Covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module boundaries and why they sit where they do |
| [DATABASE.md](docs/DATABASE.md) | Schema, tenancy, and the SQLite → PostgreSQL path |
| [SDK.md](docs/SDK.md) | Installing, tracking, consent, identity |
| [EVENT_INGESTION.md](docs/EVENT_INGESTION.md) | The pipeline and every rejection reason |
| [ANALYTICS_ENGINE.md](docs/ANALYTICS_ENGINE.md) | Funnel and active-user semantics |
| [ACTIVATION_ENGINE.md](docs/ACTIVATION_ENGINE.md) | Defining activation, time to value |
| [RETENTION_ENGINE.md](docs/RETENTION_ENGINE.md) | Cohorts, denominators, incomplete periods |
| [CHURN_METRICS.md](docs/CHURN_METRICS.md) | Inactivity versus churn, and why they differ |
| [REVENUE_INTELLIGENCE.md](docs/REVENUE_INTELLIGENCE.md) | MRR, NRR, GRR, and the reconciliation identity |
| [FEEDBACK_OS.md](docs/FEEDBACK_OS.md) | Widget, portal, inbox, clustering |
| [FIXFLOW.md](docs/FIXFLOW.md) | Evidence to issue, and the approval gate |
| [GITHUB_INTEGRATION.md](docs/GITHUB_INTEGRATION.md) | Scope, safety, failure modes |
| [IMPACT_LAB.md](docs/IMPACT_LAB.md) | Before/after, confounders, release timelines |
| [EXPERIMENTATION.md](docs/EXPERIMENTATION.md) | Assignment, exposure, validity checks, statistics |
| [RETAIN_AI.md](docs/RETAIN_AI.md) | The rule engine, and where a model is and is not used |
| [ONBOARD_OS.md](docs/ONBOARD_OS.md) | Onboarding flows and their limits |
| [SECURITY.md](docs/SECURITY.md) | Tenancy, authentication, keys, the threat model |
| [PRIVACY.md](docs/PRIVACY.md) | What is collected, refused, and erasable |
| [SUBSCRIPTIONS.md](docs/SUBSCRIPTIONS.md) | Plans, entitlements, the billing simulator |
| [API_REFERENCE.md](docs/API_REFERENCE.md) | Every HTTP endpoint |
| [TESTING.md](docs/TESTING.md) | What is tested and what is not |
| [PERFORMANCE.md](docs/PERFORMANCE.md) | Measured benchmarks and the hardware behind them |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Running it in production, and the costs |
| [FEATURE_STATUS.md](docs/FEATURE_STATUS.md) | **Honest status of every capability** |
| [ROADMAP.md](docs/ROADMAP.md) | What is next, and what will not be built |
| [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | What the first build delivered |

### Product intelligence

| Document | Covers |
|---|---|
| [FRICTION_GRAPH.md](docs/FRICTION_GRAPH.md) | How signals are joined, and what is never joined |
| [OPPORTUNITY_ENGINE.md](docs/OPPORTUNITY_ENGINE.md) | The nine factors, and why a missing one is not a zero |
| [INSTRUMENTATION_DOCTOR.md](docs/INSTRUMENTATION_DOCTOR.md) | Thirteen checks on the data under the metrics |
| [REVENUE_IMPACT.md](docs/REVENUE_IMPACT.md) | Five evidence classes, and why there is no grand total |
| [CUSTOMER_HEALTH.md](docs/CUSTOMER_HEALTH.md) | Eight signals, four states, and no score |
| [RETENTION_PLAYBOOKS.md](docs/RETENTION_PLAYBOOKS.md) | Holdouts, consent, caps, and what it will not send |
| [INTEGRATIONS.md](docs/INTEGRATIONS.md) | Provenance, deduplication, and reading without migrating |
| [BILLING_AND_ENTITLEMENTS.md](docs/BILLING_AND_ENTITLEMENTS.md) | Why pricing is on tracked users, not events |
| [PRODUCT_DIFFERENTIATION.md](docs/PRODUCT_DIFFERENTIATION.md) | What is different, with no comparative claims |
| [COMPETITIVE_ANALYSIS.md](docs/COMPETITIVE_ANALYSIS.md) | Category patterns, and why no vendor is named |
| [FIXFLOW_PRO.md](docs/FIXFLOW_PRO.md) | **Not implemented**, and what that would require |
| [AI_SAAS_INTELLIGENCE.md](docs/AI_SAAS_INTELLIGENCE.md) | **Not implemented**, with everything else deferred |
| [BUSINESS_VALIDATION.md](docs/BUSINESS_VALIDATION.md) | **Nothing has been validated**, and what would test it |
| [NEXT_STEPS.md](docs/NEXT_STEPS.md) | What to do next, starting with no code at all |
| [../RETAINOS_PRODUCT_AUDIT.md](RETAINOS_PRODUCT_AUDIT.md) | The audit that opened this pass |
| [../RETAINOS_DELIVERY_REPORT.md](RETAINOS_DELIVERY_REPORT.md) | What was built, what was not, what is unverified |

---

## Licence

Apache 2.0. See [LICENSE](LICENSE).

RetainOS is an independent project. It is not affiliated with, endorsed by, or
derived from any analytics vendor referenced in its documentation.

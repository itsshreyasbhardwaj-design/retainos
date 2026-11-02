# AI SaaS retention intelligence — not implemented

**Status: Not implemented.**

The directive specified retention intelligence specific to AI products. It was
not built, and this document says so rather than describing an absent feature.

## What was specified

Metrics particular to AI-native products: usage patterns around model calls,
token or credit consumption against plan value, the relationship between output
quality and retention, and whether users return after a poor result.

## What exists today that is relevant

Nothing AI-specific. What exists is generic and would carry some of the weight:

- Arbitrary event properties with a closed schema, so an AI product can send
  `model`, `latency_ms`, `tokens` or `rating` as validated properties today
- Feature adoption tracking, which can treat an AI capability as a feature
- The activation engine, which can use an AI-specific event as activation
- Error events with a sender-supplied fingerprint, which can group a class of
  bad output if the application chooses to report it

A team building an AI product can get real value from RetainOS now by
instrumenting those events themselves. What is missing is anything that
*understands* those events as AI-specific and reports on them accordingly.

## The constraint that shaped the decision

> Local development must function without mandatory paid AI services.

and, from the repository's own operating rules, no paid API usage at all.

This is not a blocker for the metrics themselves — counting model calls and
credit consumption needs no AI — but it does rule out the version of this
feature that evaluates output quality with a model, which is the part that
would have been most interesting. Any implementation would need to be either
purely behavioural (did the user retry, regenerate, abandon, return) or rely on
the customer's own ratings.

The behavioural version is the one worth building, and it is the one listed in
`NEXT_STEPS.md`.

## Also not implemented from the same directive

Named for completeness, with the same honesty:

- **Activation Blueprints** — pre-built activation definitions per product type
- **Smart Onboarding Optimizer** — automated onboarding-flow suggestions
- **Cancellation / churn intelligence** — a dedicated analysis surface
  (cancellation *data* is captured, and the cancellation-feedback playbook kind
  exists; the analysis page does not)
- **Product Value Scorecard**
- **Customer Voice Intelligence** — beyond the existing feedback clustering
- **Agency Command Center** — multi-client rollup
- **Customer Success Workflows** — task management for success teams
- **Time To First Value** — as a dedicated surface; the activation engine does
  measure time-to-value today
- **Release Intelligence** — beyond the existing release tracking and ImpactLab
- **Retention Operations Timeline**
- **Real Product Benchmarking** — would require aggregate data across
  customers, which RetainOS does not have and should not fabricate
- **RetainOS Engineer** — the autonomous engineering agent

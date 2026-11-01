# Performance

Every figure here was **measured**, not projected. Reproduce them with
`pnpm bench`.

## Hardware and conditions

- Apple Silicon (arm64), macOS
- Node v24.16.0
- SQLite in memory, single process
- 210,000 events, 20,000 identities, 90 days of history

## Results

| Operation | Time | Detail |
|---|---|---|
| Ingestion (validated) | 772 ms | 10,000 events in batches of 100, full validation and privacy scrubbing |
| Funnel, 4 steps, 90 days | 391 ms | 210,000 events scanned |
| Funnel with a segment filter | 145 ms | Same funnel, one plan |
| Retention cohorts, 5 periods | 398 ms | 20,000 identities cohorted |
| Activation funnel | 579 ms | Signups over 90 days |
| Active users, 90 daily buckets | 450 ms | DAU, WAU, MAU and the full series |
| Daily aggregate recomputation | 9 ms | One day |
| Insight generation | 267 ms | Every rule over the whole project |
| MRR snapshot | 0.1 ms | Replayed from the subscription event log |

**Ingestion throughput: ~12,900 events/second**, single process, with full
validation, schema checking and privacy scrubbing.

**SDK: 25 KiB of source across all modules, zero dependencies.**

## Two optimisations, and what they were worth

Both were found by running the benchmark, not by guessing.

### Day-key memoisation — retention 30.5 s → 0.40 s (**75×**)

`Intl.DateTimeFormat.format` was the single most expensive call in the analytics
layer, invoked once per event. The local calendar date cannot change within an
hour — every IANA transition lands on an hour boundary — so caching by hour
bucket collapses millions of format calls to at most 24 per day of data, with
identical results.

Insight generation improved 7.2 s → 0.27 s (26×) from the same change.

### One query instead of 150 — activation 4.5 s → 0.58 s (**7.8×**)

The activation engine chunked identities into `IN (…)` lists of 400, issuing
roughly 50 queries per event name, each re-scanning the index. Replaced with one
time-bounded query per event name, filtered in memory against the signup map.

## Where this stops working

Honest limits, not projections dressed as capacity:

- **SQLite, single writer.** Fine to the low hundreds of thousands of events per
  day on one node. Beyond that, move to PostgreSQL — see `DATABASE.md`.
- **Engines read raw events.** A funnel over a year of tens of millions of
  events will not return in under a second. The fix is monthly range partitions
  on `occurred_at` plus pre-aggregated funnel results, in that order.
- **The rate limiter is per process.** Several ingestion processes multiply the
  effective limit. Replace it before scaling out.
- **No sustained or distributed load test has been run.** These are
  single-machine, cold-start measurements.

## Reproducing

```bash
pnpm bench
BENCH_EVENTS=1000000 BENCH_USERS=100000 pnpm bench   # a heavier run
```

The benchmark builds its own dataset with a seeded PRNG, so runs are comparable.

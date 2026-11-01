# Event ingestion

## The endpoint

```
POST /api/v1/ingest
x-retainos-key: rpk_…                     (required)
x-retainos-idempotency-key: batch-001     (optional, recommended)
content-type: application/json
```

```json
{
  "events": [
    {
      "name": "signup_completed",
      "userId": "USER_123",
      "anonymousId": "a1b2c3…",
      "timestamp": 1773489600000,
      "eventId": "client-generated-uuid",
      "consent": true,
      "properties": { "acquisition_source": "docs" }
    }
  ],
  "sdk": { "name": "@retainos/sdk", "version": "0.1.0" }
}
```

Returns **202** with a per-event outcome:

```json
{
  "accepted": 1, "rejected": 0, "duplicates": 0, "replayed": false,
  "outcomes": [{ "index": 0, "status": "accepted", "eventId": "evt_…" }],
  "quota": { "used": 1, "limit": 10000, "remaining": 9999 }
}
```

**Every event is judged independently.** One malformed event in a batch of fifty
does not discard the other forty-nine, and the response says exactly which index
failed and why. That is what makes the event inspector useful rather than
decorative.

## The pipeline

```
authenticate ▸ origin ▸ rate limit ▸ body size ▸ batch idempotency ▸ quota reservation
   └─ per event ─▶ name ▸ size ▸ consent ▸ clock skew ▸ privacy scrub ▸ schema
                   ▸ identity ▸ quota ▸ client-id dedupe ▸ store ▸ mark day dirty
```

## Rejection reasons

Every one is recorded in `event_rejections` with its detail, and surfaced in the
inspector.

| Reason | When | Why not just accept it |
|---|---|---|
| `missing_event_name` | Absent or non-string | An unnamed event cannot be queried |
| `invalid_event_name` | Not lower_snake_case, or over 80 characters | Casing differences silently create duplicate events |
| `event_too_large` | Over 16 KiB | One oversized payload should not degrade a shared endpoint |
| `consent_not_granted` | Project requires consent and the flag is not exactly `true` | Absence of a signal is not consent |
| `timestamp_out_of_range` | More than 1 hour ahead or 30 days behind | Silently moving an event corrupts every time-bucketed metric |
| `schema_validation_failed` | Property type, required field, closed-schema violation, or unregistered event in strict mode | Analytics must never depend on a value RetainOS guessed at |
| `no_identity` | Neither `anonymousId` nor `userId` | An event belonging to nobody cannot be counted |
| `event_quota_exceeded` | Monthly plan allowance reached | Partial acceptance: what fits is stored, the rest reported |
| `duplicate_event` | `eventId` already seen for this project | Exactly-once under retry |
| `sensitive_properties_removed` | A property matched the privacy denylist | **Not a rejection.** The event is accepted; the property is dropped and the removal recorded |

## Clock skew

Client clocks are wrong. RetainOS tolerates one hour ahead and thirty days
behind, and **rejects anything outside that rather than clamping it**. Clamping
looks helpful and corrupts every daily bucket it touches; rejecting is visible
in the inspector and can be fixed.

## Idempotency, at two levels

**Batch:** `x-retainos-idempotency-key`. A replay returns the original counts
with `replayed: true` and stores nothing. The SDK derives the key from the
batch's own event ids, so a retry of the same batch is recognised.

**Event:** a client-supplied `eventId`. A repeat is reported as `duplicate`
rather than stored. Events *without* a client id are never deduplicated against
each other — two genuine occurrences of the same action must both count.

## Rate limiting — and its honest limit

A fixed-window limiter, **in process memory**, defaulting to 600 events per
minute per project.

> **This is correct for a single node and wrong for several.** Each process
> keeps its own window, so N processes allow N× the configured rate. Before
> running more than one ingestion process, replace `RateLimiter` with a shared
> counter — Redis `INCR` with an expiry, or an atomic row in PostgreSQL.
> The class is isolated in `packages/database/src/ratelimit.ts` for exactly
> this reason.

## Why CORS is not the security boundary

A public write key ships in browser bundles. Anyone can read it and post from
curl, where CORS does not exist. So:

- The **origin allowlist is enforced server-side**, before any event is
  processed, and a missing `Origin` header is refused once an allowlist is set.
- The key grants **append-only access to exactly one project**. There is no code
  path from an `IngestScope` to a read scope.
- Payload caps, rate limits, schema validation and the privacy denylist all run
  regardless of where the request came from.

CORS headers are still sent, because browsers need them. They are a convenience,
not a control.

## Identity resolution

Three rules, each with a test:

1. **An anonymous id is claimed only by an explicit `identify()`**, and the
   transition is recorded in `identity_links`.
2. **A claimed anonymous id is never re-pointed.** If `anon-1` already belongs
   to `user-a`, a later `identify("user-b")` from that device creates a separate
   identity with no anonymous id, rather than merging two real people who share
   a laptop.
3. **Two identified users are never merged.** There is no fingerprinting path,
   no probabilistic matching, and no setting that enables one.

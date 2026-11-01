# API reference

Base URL is your RetainOS instance. All bodies are JSON.

## Authentication

| Credential | Header | Grants |
|---|---|---|
| Public write key `rpk_…` | `x-retainos-key` | Append events and feedback to one project. **Not a secret** |
| Secret admin key `rsk_…` | `authorization: Bearer …` | Read one project. Shown once |
| Session cookie | — | The signed-in user's own permissions |

## `POST /api/v1/ingest`

Public write key. Ingest a batch of events. See `EVENT_INGESTION.md`.

**202** with per-event outcomes. **400** validation, **401** unknown key,
**403** origin refused, **413** payload too large, **429** rate limited.

```json
{ "events": [{ "name": "signup_completed", "userId": "USER_123", "consent": true }] }
```

Optional headers: `x-retainos-idempotency-key`.

## `POST /api/v1/feedback`

Public write key. Submit feedback, or vote on an existing request.

```json
{
  "kind": "bug",
  "title": "CSV export fails",
  "body": "It errors every time on large projects",
  "contactEmail": "person@example.com",
  "consentToContact": true,
  "pageIdentifier": "/exports",
  "userId": "USER_123"
}
```

Contact details are discarded unless `consentToContact` is `true`.

To vote: `{ "voteFor": "fbk_…", "voterToken": "stable-per-voter-token" }`.

**201** created, **409** already voted.

## `POST /api/v1/experiments/assign`

Public write key. Returns the variant for this identity in every **running**
experiment.

```json
{ "anonymousId": "a1b2…", "userId": "USER_123" }
→ { "assignments": { "optional-template-step": "treatment" }, "identityId": "idn_…" }
```

## `POST /api/v1/experiments/expose`

Public write key. Record that the user **actually saw** the variant. Call this
where it is rendered, not where it is assigned — analysis counts exposures.

```json
{ "experiment": "optional-template-step", "variant": "treatment", "userId": "USER_123" }
```

**202** recorded, **409** the experiment is not running.

## `POST /api/v1/webhooks/{provider}?project={projectId}`

`razorpay` · `stripe` · `simulator` (development only).

Signature verified before the payload is treated as meaningful. Idempotent on
the provider's event id; a replay returns 200 so the provider stops retrying.

**403** signature mismatch or missing secret.

## `GET /api/v1/export?project={id}&format=json|csv&table={name}`

Session cookie with the `analytics:export` permission. Available on every plan,
including after a subscription lapses.

Returns a downloadable file. CSV requires `&table=`; the error lists the
available tables.

## `GET /api/v1/health`

No authentication. Reports database reachability, applied migration count, and
which optional integrations are configured — **never their credentials**.

```json
{
  "status": "ok", "database": "ok", "migrationsApplied": 4,
  "integrations": { "github": false, "razorpay": false, "stripe": false, "llm": false }
}
```

**503** when the database is unreachable.

## `GET /widget?key={publicKey}`

Serves the embeddable feedback widget as JavaScript. An unknown key returns a
script that logs a warning and mounts nothing.

## Errors

```json
{ "error": { "code": "validation_failed", "message": "…", "detail": { } } }
```

| Code | Status |
|---|---|
| `validation_failed` | 400 |
| `unauthenticated` | 401 |
| `entitlement_exceeded` | 402 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `payload_too_large` | 413 |
| `insufficient_data` | 422 |
| `rate_limited` | 429 |
| `not_configured` | 501 |
| `integration_error` | 502 |
| `integration_unavailable` | 503 |

## Limits

16 KiB per event · 100 events per batch · 1 MiB per body · 64 properties per
event · 1,024 characters per string value · 600 events per minute per project
(configurable) · clock skew +1 hour / −30 days.

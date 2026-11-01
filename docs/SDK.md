# @retainos/sdk

Zero dependencies. 25 KiB of source. Works in any browser and in Node.

```bash
pnpm add @retainos/sdk
```

```ts
import { RetainOS } from "@retainos/sdk";

export const retain = RetainOS.init({
  projectKey: process.env.NEXT_PUBLIC_RETAINOS_KEY!,
  endpoint: "https://your-retainos-instance.example",
  autoCapture: false,
});

retain.grantConsent();                  // nothing leaves the device before this
retain.track("signup_completed");
retain.identify("USER_123");
retain.track("core_action_completed", { feature: "first_project" });
retain.reset();                         // on logout
```

## Options

| Option | Default | Notes |
|---|---|---|
| `projectKey` | — | Public write key. Not a secret; it ships in your bundle |
| `endpoint` | — | Your RetainOS instance |
| `autoCapture` | `false` | Page views only. Off by default on purpose |
| `requireConsent` | `true` | Nothing is sent until `grantConsent()` |
| `batchSize` | 20 | Server hard limit is 100 |
| `flushIntervalMs` | 5000 | Partial batches flush on this timer |
| `maxQueueSize` | 500 | Oldest dropped at capacity |
| `maxRetries` | 3 | Exponential backoff with jitter |
| `allowedProperties` | — | When set, anything else is dropped |
| `globalProperties` | — | Merged into every event; per-event values win |
| `debug` | `false` | Logs warnings about dropped properties and refused names |
| `transport` / `storage` / `now` | — | Injectable, for tests |

## Methods

`track(name, properties?)` · `identify(userId, traits?)` · `reset()` ·
`page(path?, properties?)` · `grantConsent()` · `revokeConsent()` ·
`hasConsent()` · `optOut()` · `optIn()` · `isOptedOut()` ·
`flush()` · `diagnostics()` · `shutdown()`

## Behaviour worth knowing

**It never throws into your application.** Every public method swallows its own
errors and records them in `diagnostics()`. A broken analytics call must not
break a customer's product.

**`await flush()` really means flushed.** If a flush is already in flight it
returns that promise rather than resolving immediately, including events added
mid-flush. (This was a bug, caught by a test, and fixed by changing the
contract.)

**Event names must be lower_snake_case.** Anything else is refused client-side
and recorded in `diagnostics().lastError`.

**`identify()` rejects email addresses.** Pass a stable pseudonymous id.

**Retries reuse the idempotency key**, so the server recognises a replay rather
than double-counting. A 5xx or 429 is retried with exponential backoff and
jitter; a 4xx is not, because that payload will never be accepted and retrying
it forever is a busy loop against your own server.

**The queue drops oldest-first** at capacity. Losing the start of a long offline
session is better than losing what the user is doing right now.

**localStorage access is wrapped in try/catch everywhere.** Safari private mode,
blocked site data and partitioned iframes all make it *throw* rather than return
null; an unguarded read would crash the host page. The SDK degrades to memory.

## What it will not collect

See `PRIVACY.md`. In short: credentials, financial identifiers, government ids,
health fields, precise location, and anything non-scalar. There is no session
recording, keystroke capture or fingerprinting, and no option that enables one.

`page()` sends the **path only** — never the query string, which routinely
carries tokens and search terms.

## Server-side and other platforms

The same SDK works in Node. Or post directly:

```bash
curl -X POST https://your-instance.example/api/v1/ingest \
  -H "content-type: application/json" \
  -H "x-retainos-key: rpk_YOUR_KEY" \
  -H "x-retainos-idempotency-key: batch-001" \
  -d '{"events":[{"name":"signup_completed","userId":"USER_123","consent":true}]}'
```

See `API_REFERENCE.md`. There is no mobile SDK; the HTTP API is documented and
usable from any platform.

## Event naming

Lower_snake_case, outcome over interaction: `project_created`, not
`clicked_create`. Outcomes survive a redesign; button names do not. The registry
surfaces naming advice when you register an event.

## Verification

41 tests covering initialisation, consent, opt-out, identity, privacy,
delivery, retries, queue limits and diagnostics: `pnpm test:sdk`.

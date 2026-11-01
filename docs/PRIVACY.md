# Privacy

RetainOS collects information about how people use *other* applications. That
makes data minimisation the central design problem.

This document describes what the software does. It is not legal advice, and a
deployment is responsible for its own obligations.

## Collected

Per event: name, client timestamp, server receipt time, an identifier, and the
properties the integrator's code passes.

Alongside: a coarse **device category** (mobile, tablet, desktop) derived from
the user agent, and a two-letter **country code** if the deployment's edge
supplies one.

**The raw user agent string is never stored.** Only the derived category.

## Refused

Dropped by the SDK before leaving the device, and dropped again by the server on
arrival — by **key name and by value shape**, so a JWT under `note` is caught as
readily as one under `token`:

passwords · tokens · JWTs · API keys · bearer credentials · session ids ·
cookies · card numbers · CVVs · IBANs · bank and routing numbers · SSN ·
Aadhaar · PAN · passport numbers · tax ids · private keys · mnemonics and seed
phrases · PINs · OTPs · MFA codes · security questions · health, diagnosis and
prescription fields · dates of birth · latitude, longitude and precise
coordinates · anything resembling keystroke capture

Also dropped: **every non-scalar value**. Passing a whole user object cannot
smuggle an email address into analytics by accident.

## Never implemented

Not "disabled by default" — **absent**, with no setting that enables them:

- Session recording or replay
- Keystroke capture
- Form field capture
- Clipboard access
- Device fingerprinting
- Cross-site tracking
- Behavioural profiling or advertising features, for any audience

## Identity

A visitor gets a random anonymous id stored on their own device. `identify()`
links it to the integrator's own pseudonymous user id, and the link is recorded
explicitly in `identity_links`.

- Identities are merged **only** on an explicit `identify()` call.
- An anonymous id already claimed by one user is **never reassigned**. That
  would merge two real people sharing a device.
- Two identified users are **never** merged. There is no fingerprinting path.
- `identify()` **rejects values that look like email addresses**, keeping direct
  identifiers out of the event store.
- `reset()` on logout issues a fresh anonymous id, so the next person on a
  shared device is not attributed to the previous one.

## Consent

On by default. With it on, an event without an explicit consent flag is
**rejected** — the absence of a signal is not agreement, and a falsy or missing
flag is tested to be treated as no consent.

The SDK queues nothing before consent is granted, and **discards its queue** if
consent is withdrawn. End users can opt out entirely, which clears local
identifiers and survives a reload.

## Retention and erasure

Each project sets how long raw events are kept. Aggregated counts outlive them.

Erasing one end user:

| Data | Action |
|---|---|
| Events | Deleted |
| Identity and identity links | Deleted |
| Experiment assignments and exposures | Deleted |
| Onboarding progress | Deleted |
| Feedback | **Anonymised**, not destroyed — the product signal survives, the person does not |
| Subscriptions | **Detached**, financial records kept |
| Affected daily aggregates | **Queued for recomputation** |

That last row matters: without it, aggregates would quietly disagree with the
raw store forever. The journey test asserts both the deletion and the queued
recomputation.

Every erasure is recorded in `data_deletion_requests` with a count of what was
removed, and in the audit log.

## Children and sensitive services

India's **Digital Personal Data Protection Act** places specific obligations on
processing children's data, including verifiable parental consent and a
prohibition on behavioural monitoring and targeted advertising directed at
children.

RetainOS has no behavioural profiling and no advertising features for any
audience. **It does not implement a parental consent mechanism.** If an
instrumented application serves children, disable behavioural tracking for those
users and take your own legal advice. RetainOS states this plainly rather than
implying it handles the obligation for you.

Do not instrument flows handling health or financial detail so that those values
become event properties. The denylist is a safety net, not a substitute for not
sending the data.

## Where the data lives

Self-hosted: on infrastructure you control. Local development: a SQLite file on
your own machine, contacting no external service.

Optional integrations — GitHub, a billing provider, a language-model adapter —
are off unless configured, and each states what it sends before being enabled.

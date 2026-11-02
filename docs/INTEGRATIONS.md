# Integrations, provenance and deduplication

## The premise

Most teams who would get value from RetainOS already have PostHog or Amplitude,
already have Sentry, and are not going to rip any of it out to try something
new. Demanding migration is how a good product never gets used.

So RetainOS reads from what is already there — and that creates the problem
this layer exists to solve.

## The problem: the same action, twice

Once two systems can report the same signup, a number built by adding them is
wrong in a way nobody notices. Three rules.

### 1. Every record carries its source

Migration 007 adds `source` and `sync_run_id` to `analytics_events` (additive
and reversible; existing rows keep the default `sdk`). `eventProvenance` answers
"where did this number come from?" with counts and date ranges per source, and
the Data Sources page shows it as the first thing on the page.

### 2. One source is authoritative per thing

`source_mappings` records which system is authoritative per domain, optionally
per event. A record from any other source for the same thing is **refused at
import**, counted, and the reason stored. Deduplication at the door beats
reconciliation later.

With no decision recorded, everything is accepted. Refusing data on the basis
of a decision nobody made would be worse than a possible duplicate, so the
default is permissive and the UI says so.

An entity-level decision beats a domain-level one, so a project can say "the
SDK is authoritative for events, except `subscription_renewed`, which comes
from Stripe".

### 3. Connected means verified

A connection starts `disconnected` and says so: *"set up but never verified.
Nothing is being read from it yet."* Only `verifyConnection` can set
`connected`, and it takes an **injected probe** — the caller owns the network
call, so nothing in this module can claim a live integration it has not
checked. A failed probe stores the error and the status line repeats it.

## Credentials are never stored

`connectProvider` refuses any config key that looks like a credential, naming
the environment variable to use instead:

> Credentials are never stored in the database. Remove "apiKey" and set the
> credential in the environment instead (`RETAINOS_POSTHOG_API_KEY`).

A key that merely *names* a variable (`apiKeyEnvVar`) is fine.

## What each provider cannot do

Stated in `PROVIDER_CAPABILITIES` and rendered next to every connection:

| Provider | Reads | Cannot |
| --- | --- | --- |
| PostHog | events, person properties | write back; read session recordings |
| Amplitude | events, user properties | write back |
| Sentry | error groups, counts, affected user ids | **read stack traces** — they routinely contain file paths, query strings and user data |
| GitHub | releases, tags, PR titles | push commits, open pull requests, change a repository in any way |
| Stripe / Razorpay / RevenueCat | subscriptions, payment outcomes | take payments, issue refunds, retry a charge, read card details |
| CSV | events, subscriptions, feedback | run on a schedule |

## Import is not ingestion

Imports deliberately do not route through live ingestion, which correctly
rejects timestamps over thirty days old — right for a skewed client clock,
wrong for a historical backfill.

The import path keeps the same event-name validation and the same privacy
scrubbing, and adds rules of its own:

- **A future timestamp is refused rather than clamped.** Silently moving an
  event corrupts every time-bucketed metric it touches.
- **An unmatched user is a rejection.** RetainOS will not attach an imported
  event to a plausible-looking person.
- **A record with no provider id is refused**, because without it there is no
  way to tell a retry from a second event.
- **Dedupe is by `source:externalId`**, so re-importing the same file imports
  nothing and reports the duplicates.

Rejections are stored per row in `import_rejections` with spreadsheet row
numbers, because a person is sitting there trying to fix a file and "import
failed" tells them nothing.

## Imports can be undone

`revertSyncRun` deletes exactly the events that run brought in and leaves every
other source untouched. A backfill that turns out to be wrong has to be
removable.

## CSV is first class

`parseCsv` handles quoted fields, escaped quotes and CRLF with no dependency,
and `csvToEvents` accepts both epoch milliseconds and ISO dates, reporting
unparseable rows by spreadsheet row number. Extra columns become event
properties.

CSV import works on every plan, including free: importing your own data should
never cost money, and it means the whole integration story works offline with
no account anywhere.

## Tests

41 tests in `packages/analytics/test/integrations.test.ts`, plus a verified
end-to-end run against the seeded demo database: historical dates accepted, bad
event name rejected by name, unmatched user rejected, re-import deduplicated,
provenance tracked, revert removing only the imported rows.

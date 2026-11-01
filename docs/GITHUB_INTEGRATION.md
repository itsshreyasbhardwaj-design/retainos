# GitHub integration

Optional. RetainOS is fully functional without it.

## Setup

Create a **fine-grained personal access token** with **Issues: write** on the
target repository only, and set it on the server:

```bash
RETAINOS_GITHUB_TOKEN=github_pat_…
```

The token is read at dispatch time and never reaches the browser. Never put it
in a `NEXT_PUBLIC_` variable.

## What it can do

Exactly one thing: **create an issue**.

There is no code path in this repository that pushes commits, opens or merges a
pull request, modifies repository contents, changes settings or deletes
anything. The integration module is a single function that POSTs to
`/repos/{owner}/{repo}/issues`.

## The approval gate

```
RetainOS drafts    →   a human reads it   →   a human approves   →   RetainOS sends
```

An issue is created only after an explicit approval by a user with the
`improvement:approve` permission. The approval is recorded in the audit log
before the request is made.

## Failure handling

| Failure | Behaviour |
|---|---|
| No token configured | Refused locally. Nothing is sent, and the message says what to set |
| Malformed repository | Refused before any network call |
| 401 / 403 | Recorded with GitHub's own message plus "check the token has Issues: write on this repository" |
| 404 | "The repository was not found, or the token cannot see it" |
| Timeout | 15-second abort, so a hung request cannot hold a server action open |
| Any failure | `dispatch_state` becomes `failed`, the error is stored and shown, and the draft can be retried |

The token never appears in an error message, a log line or the stored error.

## Status synchronisation

Issue number, URL and state are stored when the issue is created. **Ongoing
two-way synchronisation is not implemented** — there is no webhook receiver
updating a task when its issue closes. `FEATURE_STATUS.md` records this.

## Verification status

The dispatch call, its error handling and its audit trail are written and
typechecked, and the surrounding workflow is covered by the journey test with a
simulated result.

**It has not been run against the real GitHub API**, because no token was
configured in the environment where this was built. `FEATURE_STATUS.md` records
it as *Implemented but unverified*, and this document will not claim otherwise.

To verify it yourself: set the token, draft an issue from an improvement,
approve it, and check the repository.

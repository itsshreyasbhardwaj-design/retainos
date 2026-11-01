# Security policy

## Reporting a vulnerability

Open a **private security advisory** on this repository. Please do not open a
public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. You will get an acknowledgement, and an honest answer about timing rather
than a promised SLA this project cannot guarantee.

## Scope

In scope: cross-tenant data access, authentication or session flaws, privilege
escalation, injection, credential leakage into the event store, bypassing the
GitHub or billing approval gates, and anything that lets one customer affect
another.

Out of scope: findings that require an already-compromised server, denial of
service through sheer volume against a single-node deployment, and the known
gaps listed in `docs/SECURITY.md` — those are documented, not undiscovered.

## Known gaps

`docs/SECURITY.md` has the current list, including the per-process rate limiter,
the absence of 2FA, and the integrations that have not been exercised against
live external systems. These are stated deliberately so nobody has to find them
the hard way.

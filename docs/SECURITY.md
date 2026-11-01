# Security

## Threat model

RetainOS holds behavioural data about *other companies' users*. The failures
that matter most, in order:

1. **Cross-tenant data exposure.** One customer seeing another's product data.
2. **Credential leakage into the event store.** An integrator accidentally
   sending a password or token as an event property.
3. **Privilege escalation.** A viewer performing an owner's action.
4. **Unauthorised external action.** A GitHub issue created without approval.
5. **Ingestion abuse.** A public write key used to flood or poison a project.

## 1. Tenancy

Every repository function requires a scope, and a scope can only be produced by
`resolveOrgScope` or `resolveProjectScope`, which verify membership against the
database. A project id from a URL, a cookie or a form field cannot widen access
on its own.

A non-member gets **`not_found`, never `forbidden`** — `forbidden` would confirm
the id exists.

**14 tests in `tenancy.test.ts` are cross-tenant access attempts that must
fail**, covering scope resolution, listing, reads, exports, evidence linking,
erasure and write keys. A further test walks every table and fails if a new one
is added without a tenancy column.

## 2. Credentials in the event store

Defence at two layers, because the SDK runs on a machine you do not control.

**Client:** the SDK drops sensitive keys and credential-shaped values before
anything leaves the device, and drops non-scalar values entirely so passing a
whole user object cannot smuggle an email address into analytics.

**Server:** the same denylist runs again on arrival. A matching property is
removed, the removal is recorded, and the event is still accepted — dropping the
whole event would lose the signal to punish a mistake.

Covered: passwords, tokens, JWTs, API keys, session ids, cookies, card numbers,
CVVs, IBANs, bank and routing numbers, SSN, Aadhaar, PAN, passport numbers,
private keys, mnemonics, PINs, OTPs, MFA codes, health and diagnosis fields,
dates of birth and precise coordinates — by key name *and* by value shape, so a
JWT under `note` is caught too.

## 3. Authentication and authorisation

**Passwords:** scrypt (N=16384, r=8, p=1) with a 16-byte random salt. Stored
only as a hash. A failed login spends comparable time to a successful one, so
timing cannot reveal whether an account exists, and both return the same error
message. Eight failures lock the account for fifteen minutes.

**Sessions:** an HMAC-SHA256-signed token containing random entropy, in an
`httpOnly`, `sameSite=lax`, `secure`-in-production cookie. The server stores
only a SHA-256 hash, so a database read cannot produce a usable session token.
Revocation takes effect immediately, because every request checks the database
rather than trusting the signature alone.

**Roles:** 6 roles, 28 permissions, as explicit sets rather than a hierarchy, so
a new role cannot silently inherit something dangerous. Every check is
server-side. The full matrix is rendered in the team settings page.

**Keys:** two kinds, deliberately different types in the code.

| | Public write (`rpk_`) | Secret admin (`rsk_`) |
|---|---|---|
| Secret? | **No** — ships in browser bundles | **Yes** |
| Storage | Plaintext (it is public) | SHA-256 hash only |
| Grants | Append events to one project | Read one project |
| Shown | Always | Once, at creation |

There is no function anywhere that converts an `IngestScope` into a
`ProjectScope`.

## 4. External actions

**No GitHub issue is created without an explicit approval** recorded against a
user with the `improvement:approve` permission, and written to the audit log.
The approval is recorded *before* the network call, so a failed dispatch still
leaves an auditable record of what a human approved.

The GitHub token is read from the server environment at dispatch time and never
reaches the browser. The only write the integration can perform is creating an
issue — there is no code path that pushes commits, opens pull requests or
modifies repository contents.

## 5. Ingestion abuse

Payload caps (16 KiB per event, 100 events per batch, 1 MiB per body), a
per-project rate limit, a server-side origin allowlist, schema validation, clock
skew bounds, and plan quotas with partial acceptance.

CORS is **not** the boundary — a public key works from curl, where CORS does not
exist. See `EVENT_INGESTION.md`.

## Other controls

- **CSRF:** mutating forms carry a token derived by HMAC from the session token,
  so it cannot be replayed from another session.
- **Headers:** `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
  `Permissions-Policy` denying geolocation, microphone and camera.
- **SQL:** every query is parameterised. The three places a table or column name
  is interpolated take it from a closed literal list, never from input.
- **CSV injection:** exported cells beginning `=`, `+`, `-`, `@` or a control
  character are prefixed with an apostrophe.
- **Audit log:** append-only, covering permission changes, key issuance and
  revocation, GitHub dispatch, plan changes and every erasure.
- **Webhooks:** signatures verified before the payload is treated as meaningful;
  Stripe timestamps rejected outside five minutes; the simulator refused in
  production.

## Known gaps

Stated rather than discovered later:

- **The rate limiter is per process.** Running several ingestion processes
  multiplies the effective limit. Replace it with a shared counter first.
- **No 2FA.** Password plus session only.
- **No brute-force protection on the ingestion endpoint beyond the rate limit.**
- **No automated dependency scanning** configured in this repository.
- **The GitHub and billing integrations have not been exercised against live
  external systems.** See `FEATURE_STATUS.md`.
- **No penetration test has been performed.** The tenancy tests are thorough
  and are not a substitute for one.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.

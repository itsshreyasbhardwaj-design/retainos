# Deployment

## Local

```bash
pnpm install
pnpm db:migrate
pnpm db:seed          # optional: a fictional project with reconciling data
pnpm dev              # http://localhost:3000
pnpm worker           # background aggregation, in a second terminal
```

No Docker, no database server, no API key, no account. A SQLite file on disk and
Node's built-in driver.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `RETAINOS_SESSION_SECRET` | **yes** | 32+ random characters. The app **refuses to start** without it rather than signing sessions with a guessable key |
| `RETAINOS_DB_PATH` | no | Defaults to `./data/retainos.db` |
| `RETAINOS_PUBLIC_URL` | production | Used in SDK snippets and the widget |
| `RETAINOS_GITHUB_TOKEN` | no | Fine-grained, **Issues: write on the target repository only** |
| `RETAINOS_RAZORPAY_WEBHOOK_SECRET` | no | Signature verification |
| `RETAINOS_STRIPE_WEBHOOK_SECRET` | no | Signature verification |
| `RETAINOS_INGEST_RATE_PER_MIN` | no | Default 600 |
| `RETAINOS_LLM_PROVIDER` | no | `none` by default. Everything works without it |

Generate a secret: `openssl rand -base64 48`.

## Production

### 1. PostgreSQL

SQLite is right for development and wrong for a multi-process deployment. See
`DATABASE.md` for the four dialect differences and the partitioning plan.

Before going live at volume:
- Range-partition `analytics_events` by month on `occurred_at`
- Enable row-level security as defence in depth behind the scope checks
- Replace the in-process rate limiter with a shared counter

### 2. Processes

```
web      ─ Next.js, stateless, scale horizontally
worker   ─ at least one, runs `pnpm worker`
```

The worker is safe to run more than once: claiming a job is a conditional
`UPDATE`, so two workers racing cannot both win. Or run `pnpm worker --once`
from cron.

### 3. Checklist

- [ ] `RETAINOS_SESSION_SECRET` set to 32+ random characters, unique per environment
- [ ] HTTPS terminated; session cookies are `secure` in production
- [ ] `RETAINOS_PUBLIC_URL` set to the real origin
- [ ] Database backups configured and a **restore actually tested**
- [ ] Worker running
- [ ] Per-project origin allowlists configured
- [ ] Raw event retention set per project to match your policy
- [ ] Webhook secrets set if billing is connected
- [ ] `/api/v1/health` wired to your uptime monitor

### 4. Backup and restore

SQLite: the database file, plus `-wal` and `-shm`, taken with the app stopped or
via `VACUUM INTO`.

PostgreSQL: `pg_dump`, or your provider's snapshots.

**Restore is not a backup until you have restored it.** Raw events are the
source of truth; every aggregate can be rebuilt by replaying the recomputation
jobs, so a partial aggregate loss is recoverable without the raw events being
lost.

## Expected costs

Rough, for a small deployment. RetainOS does not require any of these to work —
it runs on one machine for nothing.

| Component | Typical |
|---|---|
| Web (2 small instances) | $20–40/month |
| Worker (1 small instance) | $10–20/month |
| PostgreSQL (managed, small) | $20–50/month |
| Object storage (attachments) | <$5/month |
| **Total** | **$50–115/month** |

The dominant variable is event volume, which drives database size and query
cost. At a million events per month the figures above hold; at a hundred
million, partitioning and a column store become the conversation, and
`PERFORMANCE.md` says where that line sits.

There is **no per-seat vendor cost and no AI API cost**, because RetainAI is a
rule engine.

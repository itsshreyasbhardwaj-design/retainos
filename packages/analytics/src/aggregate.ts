import { type Db, jsonParse, enqueueJob } from "@retainos/database";
import { dayKey, dayKeyToMillis, addDays, monthKey } from "@retainos/shared";
import { mrrMovement, currenciesInUse } from "./revenue.ts";
import { generateInsights, persistInsights } from "./insights.ts";
import { rebuildClusters } from "./clustering.ts";
import { applyRetention } from "@retainos/database";

/**
 * Background aggregation.
 *
 * Every job here is idempotent: running it twice produces the same rows. That
 * is what makes a crash-and-retry safe, and it is why aggregates can always be
 * rebuilt from the raw event store rather than being the source of truth.
 */

export interface JobResult {
  jobId: string;
  kind: string;
  ok: boolean;
  detail: string;
}

/** Recompute the daily aggregates for one day. Idempotent by primary key. */
export function recomputeDay(db: Db, projectId: string, day: string, timezone: string): void {
  const from = dayKeyToMillis(day, timezone);
  const to = dayKeyToMillis(addDays(day, 1, timezone), timezone) - 1;
  const now = Date.now();

  const rows = db.all<{ identity_id: string; name: string }>(
    "SELECT identity_id, name FROM analytics_events WHERE project_id = ? AND occurred_at >= ? AND occurred_at <= ?",
    [projectId, from, to],
  );

  const actives = new Set<string>();
  const perEvent = new Map<string, { count: number; users: Set<string> }>();
  for (const r of rows) {
    actives.add(r.identity_id);
    let e = perEvent.get(r.name);
    if (!e) {
      e = { count: 0, users: new Set() };
      perEvent.set(r.name, e);
    }
    e.count++;
    e.users.add(r.identity_id);
  }

  // "New" means the identity's first-ever event in this project is on this day.
  let newUsers = 0;
  if (actives.size > 0) {
    const ids = [...actives];
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const firsts = db.all<{ identity_id: string; first_at: number }>(
        `SELECT identity_id, MIN(occurred_at) AS first_at FROM analytics_events
          WHERE project_id = ? AND identity_id IN (${chunk.map(() => "?").join(",")})
          GROUP BY identity_id`,
        [projectId, ...chunk],
      );
      for (const f of firsts) if (dayKey(f.first_at, timezone) === day) newUsers++;
    }
  }

  db.run(
    `INSERT INTO daily_active_aggregates
      (project_id, day_key, active_users, new_users, returning_users, event_count, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, day_key) DO UPDATE SET
       active_users = excluded.active_users, new_users = excluded.new_users,
       returning_users = excluded.returning_users, event_count = excluded.event_count,
       computed_at = excluded.computed_at`,
    [projectId, day, actives.size, newUsers, actives.size - newUsers, rows.length, now],
  );

  // Replace this day's per-event rows wholesale, so an event that disappeared
  // (for example after an erasure) does not linger in the aggregate.
  db.run("DELETE FROM event_daily_aggregates WHERE project_id = ? AND day_key = ?", [projectId, day]);
  for (const [name, e] of perEvent) {
    db.run(
      `INSERT INTO event_daily_aggregates (project_id, day_key, event_name, event_count, unique_users, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [projectId, day, name, e.count, e.users.size, now],
    );
  }
}

/** Recompute a month's revenue snapshot per currency. Idempotent. */
export function recomputeRevenueMonth(db: Db, projectId: string, month: string, timezone: string): void {
  const start = dayKeyToMillis(`${month}-01`, timezone);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const end = dayKeyToMillis(nextMonth, timezone) - 1;
  const now = Date.now();

  for (const currency of currenciesInUse(db, projectId)) {
    const mv = mrrMovement(db, projectId, { periodStart: start, periodEnd: end, currency, periodKey: month });
    db.run(
      `INSERT INTO revenue_snapshots
        (project_id, month_key, currency, mrr_minor, new_minor, expansion_minor, contraction_minor,
         churn_minor, reactivation_minor, active_subscriptions, churned_customers, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, month_key, currency) DO UPDATE SET
         mrr_minor = excluded.mrr_minor, new_minor = excluded.new_minor,
         expansion_minor = excluded.expansion_minor, contraction_minor = excluded.contraction_minor,
         churn_minor = excluded.churn_minor, reactivation_minor = excluded.reactivation_minor,
         active_subscriptions = excluded.active_subscriptions,
         churned_customers = excluded.churned_customers, computed_at = excluded.computed_at`,
      [
        projectId, month, currency, Math.round(mv.endMrrMinor), Math.round(mv.newMinor),
        Math.round(mv.expansionMinor), Math.round(mv.contractionMinor), Math.round(mv.churnMinor),
        Math.round(mv.reactivationMinor), mv.startCustomers, mv.churnedCustomers, now,
      ],
    );
  }
}

/**
 * Claim and run one pending job.
 *
 * The claim is a conditional UPDATE, so two workers racing for the same job
 * cannot both win: whichever UPDATE reports a change owns it.
 */
export function runNextJob(db: Db, now = Date.now()): JobResult | null {
  const candidate = db.get<{ id: string; kind: string; project_id: string | null; org_id: string | null; payload: string; attempts: number }>(
    `SELECT id, kind, project_id, org_id, payload, attempts FROM aggregation_jobs
      WHERE status = 'pending' AND run_after <= ? ORDER BY created_at ASC LIMIT 1`,
    [now],
  );
  if (!candidate) return null;

  const claimed = db.run(
    "UPDATE aggregation_jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
    [now, candidate.id],
  );
  if (claimed.changes === 0) return null; // another worker took it

  const payload = jsonParse<Record<string, unknown>>(candidate.payload, {});
  const projectId = candidate.project_id;

  try {
    const timezone = projectId
      ? db.get<{ reporting_timezone: string }>("SELECT reporting_timezone FROM projects WHERE id = ?", [projectId])?.reporting_timezone ?? "UTC"
      : "UTC";

    let detail = "";
    switch (candidate.kind) {
      case "recompute_day": {
        if (!projectId) throw new Error("recompute_day needs a project id");
        const day = String(payload.dayKey ?? dayKey(now, timezone));
        recomputeDay(db, projectId, day, timezone);
        detail = `Recomputed daily aggregates for ${day}.`;
        break;
      }
      case "recompute_revenue_month": {
        if (!projectId) throw new Error("recompute_revenue_month needs a project id");
        const month = String(payload.monthKey ?? monthKey(now, timezone));
        recomputeRevenueMonth(db, projectId, month, timezone);
        detail = `Recomputed revenue snapshot for ${month}.`;
        break;
      }
      case "rebuild_feedback_clusters": {
        if (!projectId || !candidate.org_id) throw new Error("rebuild_feedback_clusters needs org and project");
        const r = rebuildClusters(db, { orgId: candidate.org_id, projectId });
        detail = `Rebuilt ${r.clusters} clusters covering ${r.itemsGrouped} items.`;
        break;
      }
      case "generate_insights": {
        if (!projectId || !candidate.org_id) throw new Error("generate_insights needs org and project");
        const generated = generateInsights(db, projectId, { timezone, now });
        const r = persistInsights(db, { orgId: candidate.org_id, projectId }, generated, now);
        detail = `Generated ${generated.length} findings; ${r.created} new, ${r.skipped} already known.`;
        break;
      }
      case "apply_retention_policy": {
        if (!projectId) throw new Error("apply_retention_policy needs a project id");
        const r = applyRetention(db, projectId, now);
        detail = `Deleted ${r.eventsDeleted} expired events and ${r.rejectionsDeleted} rejection records.`;
        break;
      }
      default:
        throw new Error(`Unknown job kind '${candidate.kind}'`);
    }

    db.run("UPDATE aggregation_jobs SET status = 'done', finished_at = ?, last_error = NULL WHERE id = ?",
      [Date.now(), candidate.id]);
    return { jobId: candidate.id, kind: candidate.kind, ok: true, detail };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Retry with backoff up to three attempts, then fail loudly rather than
    // retrying forever.
    const attempts = candidate.attempts + 1;
    if (attempts < 3) {
      db.run(
        "UPDATE aggregation_jobs SET status = 'pending', last_error = ?, run_after = ? WHERE id = ?",
        [message.slice(0, 500), now + attempts * 30_000, candidate.id],
      );
    } else {
      db.run("UPDATE aggregation_jobs SET status = 'failed', finished_at = ?, last_error = ? WHERE id = ?",
        [Date.now(), message.slice(0, 500), candidate.id]);
    }
    return { jobId: candidate.id, kind: candidate.kind, ok: false, detail: message };
  }
}

/** Drain the queue. Returns what it did, for the worker's log. */
export function drainJobs(db: Db, opts: { max?: number; now?: number } = {}): JobResult[] {
  const max = opts.max ?? 500;
  const results: JobResult[] = [];
  for (let i = 0; i < max; i++) {
    const r = runNextJob(db, opts.now ?? Date.now());
    if (!r) break;
    results.push(r);
  }
  return results;
}

/** Enqueue the periodic work. Idempotent via dedupe keys. */
export function schedulePeriodicJobs(db: Db, now = Date.now()): number {
  const projects = db.all<{ id: string; org_id: string; reporting_timezone: string }>(
    "SELECT id, org_id, reporting_timezone FROM projects WHERE archived_at IS NULL",
  );
  let queued = 0;
  for (const p of projects) {
    const today = dayKey(now, p.reporting_timezone);
    const month = monthKey(now, p.reporting_timezone);
    const jobs: Array<{ kind: string; payload?: Record<string, unknown> }> = [
      { kind: "recompute_day", payload: { dayKey: today } },
      { kind: "recompute_revenue_month", payload: { monthKey: month } },
      { kind: "rebuild_feedback_clusters" },
      { kind: "generate_insights" },
      { kind: "apply_retention_policy" },
    ];
    for (const j of jobs) {
      const { created } = enqueueJob(db, {
        orgId: p.org_id,
        projectId: p.id,
        kind: j.kind,
        payload: j.payload,
        dedupeKey: `${j.kind}:${p.id}:${j.payload ? Object.values(j.payload).join(":") : today}`,
      }, now);
      if (created) queued++;
    }
  }
  return queued;
}

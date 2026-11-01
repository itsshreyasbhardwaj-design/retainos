/**
 * The analytics worker.
 *
 * Runs with no Redis, no managed queue and no external scheduler: the queue is
 * a table, claiming a job is a conditional UPDATE, and the loop is a plain
 * interval. That keeps the whole system runnable on one machine with nothing
 * installed, which is the point.
 *
 *   pnpm worker              # run continuously
 *   pnpm worker --once       # drain the queue and exit (for cron or CI)
 */
import { openDb } from "@retainos/database";
import { drainJobs, schedulePeriodicJobs } from "@retainos/analytics";

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.RETAINOS_WORKER_INTERVAL_MS ?? 15_000);
const scheduleEveryMs = Number(process.env.RETAINOS_WORKER_SCHEDULE_MS ?? 3_600_000);

const db = openDb(process.env.RETAINOS_DB_PATH ?? "./data/retainos.db");

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function tick(schedule: boolean): number {
  if (schedule) {
    const queued = schedulePeriodicJobs(db);
    if (queued > 0) console.log(`[${stamp()}] queued ${queued} periodic job(s)`);
  }
  const results = drainJobs(db, { max: 200 });
  for (const r of results) {
    const prefix = r.ok ? "ok  " : "FAIL";
    console.log(`[${stamp()}] ${prefix} ${r.kind}: ${r.detail}`);
  }
  return results.length;
}

if (once) {
  const processed = tick(true);
  console.log(`[${stamp()}] drained ${processed} job(s); exiting.`);
  db.close();
  process.exit(0);
}

console.log(`[${stamp()}] worker started. Polling every ${intervalMs}ms, scheduling every ${scheduleEveryMs}ms.`);
tick(true);

const pollTimer = setInterval(() => tick(false), intervalMs);
const scheduleTimer = setInterval(() => tick(true), scheduleEveryMs);

const shutdown = (signal: string) => {
  console.log(`[${stamp()}] ${signal} received; finishing the current pass and exiting.`);
  clearInterval(pollTimer);
  clearInterval(scheduleTimer);
  // Drain whatever is already claimed so a restart does not leave work stuck.
  tick(false);
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

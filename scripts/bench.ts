/**
 * Performance benchmarks.
 *
 * Every number this prints is measured on the machine it runs on, now. Nothing
 * here is a projection, and PERFORMANCE.md records the hardware the published
 * figures came from so they can be judged.
 */
import { Db, migrate } from "../packages/database/src/db.ts";
import {
  createUser, createOrganization, createProject, resolveOrgScope, resolveProjectScope,
  authenticateWriteKey, ingestBatch, ingestLimiter,
} from "../packages/database/src/index.ts";
import {
  computeFunnel, computeRetention, activationFunnel, activeUsers, mrrSnapshot,
  recomputeDay, generateInsights,
} from "../packages/analytics/src/index.ts";
import { newId, dayKey, addDays } from "../packages/shared/src/index.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(7);

interface Result { name: string; ms: number; detail: string }
const results: Result[] = [];

function time<T>(name: string, detail: string, fn: () => T): T {
  const started = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  results.push({ name, ms, detail });
  return value;
}

const EVENTS = Number(process.env.BENCH_EVENTS ?? 200_000);
const USERS = Number(process.env.BENCH_USERS ?? 20_000);

console.log(`RetainOS benchmarks — ${EVENTS.toLocaleString()} events, ${USERS.toLocaleString()} users`);
console.log(`Node ${process.version} on ${process.platform}/${process.arch}\n`);

const db = new Db(":memory:");
migrate(db);

const user = createUser(db, { email: "bench@example.com", name: "Bench", password: "Correct-Horse-Battery-9" });
if (!user.ok) throw new Error(user.error.message);
const org = createOrganization(db, { name: "Bench Co", ownerId: user.value.id });
if (!org.ok) throw new Error(org.error.message);
db.run("UPDATE org_subscriptions SET plan_id = 'agency' WHERE org_id = ?", [org.value.orgId]);
const orgScope = resolveOrgScope(db, user.value.id, org.value.orgId);
if (!orgScope.ok) throw new Error(orgScope.error.message);
const project = createProject(db, orgScope.value, { name: "Bench App", timezone: "UTC" });
if (!project.ok) throw new Error(project.error.message);
const projectId = project.value.projectId;
const orgId = org.value.orgId;
const scope = resolveProjectScope(db, user.value.id, projectId);
if (!scope.ok) throw new Error(scope.error.message);

// --- 1. ingestion through the real public endpoint path --------------------

ingestLimiter.reset();
const ingestScope = authenticateWriteKey(db, project.value.publicKey);
if (!ingestScope.ok) throw new Error(ingestScope.error.message);

const BATCHES = 100;
const BATCH_SIZE = 100;
time("Ingestion (validated)", `${BATCHES * BATCH_SIZE} events in batches of ${BATCH_SIZE}, full validation`, () => {
  for (let b = 0; b < BATCHES; b++) {
    // Reset the limiter per batch: this measures the pipeline, not the limiter.
    ingestLimiter.reset();
    const events = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      name: "core_action_completed",
      userId: `ingest-user-${b * BATCH_SIZE + i}`,
      consent: true,
      timestamp: NOW - Math.floor(random() * 20 * DAY),
      properties: { feature: "bench", plan: "growth" },
    }));
    const r = ingestBatch(db, ingestScope.value, { events }, NOW);
    if (!r.ok) throw new Error(`ingestion failed: ${r.error.message}`);
  }
});

// --- bulk history, inserted directly so query benchmarks have real volume ---

console.log("Building the query dataset…");
const insert = db.raw.prepare(
  `INSERT INTO analytics_events
    (id, org_id, project_id, identity_id, name, occurred_at, received_at, plan, acquisition_source, properties)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
);
const insertIdentity = db.raw.prepare(
  `INSERT INTO identities (id, org_id, project_id, external_id, first_seen_at, last_seen_at, plan)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

const identityIds: string[] = [];
db.exec("BEGIN");
for (let i = 0; i < USERS; i++) {
  const id = `idn_b_${String(i).padStart(7, "0")}`;
  identityIds.push(id);
  insertIdentity.run(id, orgId, projectId, `bench-${i}`, NOW - 90 * DAY, NOW, i % 5 === 0 ? "growth" : "free");
}
const NAMES = ["signup_completed", "onboarding_started", "onboarding_completed", "project_created", "core_action_completed", "page_viewed"];
let written = 0;
let seq = 0;
while (written < EVENTS) {
  const identityId = identityIds[Math.floor(random() * identityIds.length)]!;
  const base = NOW - Math.floor(random() * 90 * DAY);
  // Write a plausible ordered chain so the funnel has something real to walk.
  for (let s = 0; s < NAMES.length && written < EVENTS; s++) {
    if (s > 0 && random() > 0.72) break;
    insert.run(
      `evt_b_${String(seq++).padStart(9, "0")}`, orgId, projectId, identityId,
      NAMES[s]!, base + s * HOUR, base + s * HOUR,
      random() > 0.8 ? "growth" : "free", "docs",
    );
    written++;
  }
}
db.exec("COMMIT");

const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM analytics_events")!.n;
console.log(`  ${total.toLocaleString()} events stored\n`);

// --- 2. query benchmarks ----------------------------------------------------

time("Funnel (4 steps, 90 days)", `${total.toLocaleString()} events scanned`, () => {
  const r = computeFunnel(db, projectId, {
    steps: [
      { event: "signup_completed" }, { event: "onboarding_started" },
      { event: "onboarding_completed" }, { event: "project_created" },
    ],
    from: NOW - 90 * DAY, to: NOW, conversionWindowHours: 168,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
});

time("Funnel with a segment filter", "same funnel, filtered to one plan", () => {
  const r = computeFunnel(db, projectId, {
    steps: [{ event: "signup_completed" }, { event: "project_created" }],
    from: NOW - 90 * DAY, to: NOW, segment: { plan: "growth" },
  });
  if (!r.ok) throw new Error(r.error.message);
});

time("Retention cohorts (daily, 6 periods)", `${USERS.toLocaleString()} identities cohorted`, () => {
  computeRetention(db, projectId, {
    from: NOW - 90 * DAY, to: NOW, timezone: "UTC", periods: [0, 1, 7, 14, 30], now: NOW,
  });
});

time("Activation funnel", "signups in the last 90 days", () => {
  activationFunnel(db, projectId, {
    definition: {
      id: "x", name: "a", activationEvent: "project_created", propertyFilter: {},
      windowDays: 7, signupEvent: "signup_completed", isPrimary: true,
    },
    from: NOW - 90 * DAY, to: NOW, now: NOW,
  });
});

time("Active users (90 daily buckets)", "DAU, WAU, MAU and the full series", () => {
  activeUsers(db, projectId, { from: NOW - 90 * DAY, to: NOW, granularity: "day", timezone: "UTC", now: NOW });
});

time("Daily aggregate recomputation", "one day", () => {
  recomputeDay(db, projectId, dayKey(NOW - DAY, "UTC"), "UTC");
});

time("Insight generation", "every rule over the whole project", () => {
  generateInsights(db, projectId, { timezone: "UTC", now: NOW });
});

time("MRR snapshot", "replayed from the subscription event log", () => {
  mrrSnapshot(db, projectId, NOW);
});

// --- 3. SDK size ------------------------------------------------------------

const { readFileSync, readdirSync } = await import("node:fs");
const sdkDir = new URL("../packages/sdk/src/", import.meta.url);
let sdkBytes = 0;
for (const file of readdirSync(sdkDir)) {
  if (file.endsWith(".ts")) sdkBytes += readFileSync(new URL(file, sdkDir)).byteLength;
}

// --- report -----------------------------------------------------------------

console.log("Results\n");
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`  ${r.name.padEnd(width)}  ${r.ms.toFixed(1).padStart(9)} ms   ${r.detail}`);
}

const ingestion = results.find((r) => r.name.startsWith("Ingestion"))!;
console.log(`\n  Ingestion throughput: ${Math.round((BATCHES * BATCH_SIZE) / (ingestion.ms / 1000)).toLocaleString()} events/second`);
console.log(`  (single process, SQLite in memory, full validation and privacy scrubbing)`);
console.log(`\n  SDK source size: ${(sdkBytes / 1024).toFixed(1)} KiB across all modules, zero dependencies.`);
console.log(`  Measured on Node ${process.version}, ${process.platform}/${process.arch}.`);
console.log("\n  These are measurements from this machine, not projections. PERFORMANCE.md");
console.log("  records the hardware behind the published figures.");

db.close();

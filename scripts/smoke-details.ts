/**
 * Print one real detail route per kind, for the smoke check.
 *
 * Detail pages are where runtime failures actually happen — they render the
 * deepest structures and the most database rows — so smoke-testing only the
 * list pages would miss the class of bug this script exists to catch.
 */
import { openDb } from "../packages/database/src/index.ts";

const db = openDb(process.env.RETAINOS_DB_PATH ?? "./data/retainos.db");
const project = db.get<{ id: string }>("SELECT id FROM projects ORDER BY created_at LIMIT 1");
if (!project) process.exit(0);

const routes: string[] = [];

const improvement = db.get<{ id: string }>(
  "SELECT id FROM improvement_tasks WHERE project_id = ? LIMIT 1", [project.id],
);
if (improvement) routes.push(`/improvements/${improvement.id}`);

const frictionCase = db.get<{ id: string }>(
  "SELECT id FROM friction_cases WHERE project_id = ? LIMIT 1", [project.id],
);
if (frictionCase) routes.push(`/friction/${frictionCase.id}`);

const account = db.get<{ account_key: string }>(
  "SELECT account_key FROM accounts WHERE project_id = ? LIMIT 1", [project.id],
);
if (account) routes.push(`/health/${encodeURIComponent(account.account_key)}`);

console.log(routes.join("\n"));
db.close();

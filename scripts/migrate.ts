/**
 * Apply pending migrations.
 *
 * Idempotent: already-applied migrations are skipped, so this is safe to run on
 * every deploy and in every environment.
 */
import { Db, migrate } from "../packages/database/src/db.ts";

const path = process.env.RETAINOS_DB_PATH ?? "./data/retainos.db";
const db = new Db(path);
const applied = migrate(db);

if (applied.length === 0) {
  console.log(`No pending migrations. Database at ${path} is up to date.`);
} else {
  console.log(`Applied ${applied.length} migration(s) to ${path}:`);
  for (const name of applied) console.log(`  ${name}`);
}

const tables = db.all<{ n: number }>(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
)[0]!.n;
console.log(`${tables} tables present.`);
db.close();

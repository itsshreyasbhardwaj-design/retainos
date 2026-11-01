import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "migrations");

export type Row = Record<string, unknown>;

/**
 * Thin wrapper over node:sqlite.
 *
 * Why SQLite for local development: RetainOS must be buildable and testable
 * with no paid service and no running daemon. node:sqlite ships with Node, so
 * `pnpm test` works on a clean machine with zero native builds.
 *
 * The SQL this wrapper executes is deliberately portable. See docs/DATABASE.md
 * for the PostgreSQL production path and the differences that matter.
 */
export class Db {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA busy_timeout = 5000");
  }

  /**
   * node:sqlite returns rows with a null prototype.
   *
   * That breaks two things in practice: `assert.deepEqual` against an object
   * literal, and — more importantly — React Server Components, which refuse to
   * serialise a null-prototype object across the boundary to a client
   * component. Normalising here fixes it once rather than at every call site
   * that might one day pass a row to the UI.
   */
  all<T = Row>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.raw.prepare(sql);
    const rows = stmt.all(...(params as never[])) as Row[];
    return rows.map((row) => ({ ...row })) as T[];
  }

  /**
   * `all` without the prototype normalisation.
   *
   * Measured escape hatch for the engine hot loops, where rows are consumed
   * inside this process and never cross a server/client boundary. Normalising
   * costs about 55% on a 210,000-event funnel scan (391 ms → 608 ms), which is
   * worth paying everywhere except the few scans that dominate a request.
   *
   * Never return the result of this from a server component to a client one:
   * React cannot serialise a null-prototype object, and it will fail at
   * runtime rather than at compile time.
   */
  allFast<T = Row>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.raw.prepare(sql);
    return stmt.all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
    const stmt = this.raw.prepare(sql);
    const row = stmt.get(...(params as never[])) as Row | undefined;
    return row === undefined ? undefined : ({ ...row } as T);
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.raw.prepare(sql);
    const r = stmt.run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Run `fn` in a transaction. Rolls back on any throw. */
  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* the transaction was already rolled back */
      }
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

/** Apply every pending migration, in filename order, exactly once. */
export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(db.all<{ name: string }>("SELECT name FROM schema_migrations").map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [file, Date.now()]);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    }
    ran.push(file);
  }
  return ran;
}

/** Open a migrated database. Used by the app, the worker, and every test. */
export function openDb(path = process.env.RETAINOS_DB_PATH ?? ":memory:"): Db {
  const db = new Db(path);
  migrate(db);
  return db;
}

export function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

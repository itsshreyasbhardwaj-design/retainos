import { openDb, type Db } from "@retainos/database";

/**
 * One database handle per server process.
 *
 * Next.js reloads modules in development, so the handle is cached on
 * globalThis to avoid opening a new SQLite connection on every hot reload and
 * exhausting file descriptors.
 */
const globalForDb = globalThis as unknown as { __retainosDb?: Db };

export function db(): Db {
  if (!globalForDb.__retainosDb) {
    globalForDb.__retainosDb = openDb(process.env.RETAINOS_DB_PATH ?? "./data/retainos.db");
  }
  return globalForDb.__retainosDb;
}

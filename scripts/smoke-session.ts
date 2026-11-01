/**
 * Mint a session for an existing user, printed to stdout.
 *
 * Used by the route smoke test so authenticated pages can be exercised exactly
 * as a browser would reach them. Development only: it writes a real session
 * row, which is why it takes the email explicitly rather than guessing.
 */
import { signSession, hashSecret, newId } from "../packages/shared/src/index.ts";
import { Db } from "../packages/database/src/db.ts";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node --experimental-strip-types scripts/smoke-session.ts <email>");
  process.exit(1);
}
const secret = process.env.RETAINOS_SESSION_SECRET;
if (!secret) {
  console.error("RETAINOS_SESSION_SECRET must be set to the same value the server uses.");
  process.exit(1);
}

const db = new Db(process.env.RETAINOS_DB_PATH ?? "./data/retainos.db");
const user = db.get<{ id: string }>("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]);
if (!user) {
  console.error(`No user with email ${email}.`);
  process.exit(1);
}

const now = Date.now();
const expiresAt = now + 3_600_000;
const token = signSession({ userId: `${user.id}:smoke`, issuedAt: now, expiresAt }, secret);
db.run(
  "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  [newId("ses"), user.id, hashSecret(token), now, expiresAt],
);
console.log(token);
db.close();

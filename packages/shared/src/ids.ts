import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Sortable, collision-resistant id: millisecond prefix + 12 random chars. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const bytes = randomBytes(12);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${time}${rand}`;
}

/**
 * A public write key identifies a project to the ingestion endpoint. It is NOT
 * a secret: it ships in browser bundles. It is therefore prefixed so it is
 * obvious in a code review, and it grants write-only, project-scoped access.
 */
export function newPublicKey(): string {
  return `rpk_${randomBytes(18).toString("base64url")}`;
}

/**
 * A private API key is a real secret, shown once and stored only as a hash.
 */
export function newSecretKey(): { secret: string; hash: string; preview: string } {
  const secret = `rsk_${randomBytes(24).toString("base64url")}`;
  return { secret, hash: hashSecret(secret), preview: `${secret.slice(0, 11)}…${secret.slice(-4)}` };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Stable hash used for experiment bucketing. Deterministic across processes and
 * restarts, which is what makes variant assignment reproducible.
 */
export function stableHashFraction(input: string): number {
  const digest = createHash("sha256").update(input, "utf8").digest();
  // Take 6 bytes -> 48 bits of entropy, ample for bucketing without float issues.
  const n =
    digest[0]! * 2 ** 40 +
    digest[1]! * 2 ** 32 +
    digest[2]! * 2 ** 24 +
    digest[3]! * 2 ** 16 +
    digest[4]! * 2 ** 8 +
    digest[5]!;
  return n / 2 ** 48;
}

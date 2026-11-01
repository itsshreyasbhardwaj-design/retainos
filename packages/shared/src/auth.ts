import { randomBytes, scryptSync, createHmac, timingSafeEqual } from "node:crypto";
import { safeEqual } from "./ids.ts";

const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/** scrypt password hashing. Node built-in; no external dependency, no service. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(keyB64, "base64url");
  const actual = scryptSync(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (password.length < 12) problems.push("Use at least 12 characters.");
  if (password.length > 256) problems.push("Use at most 256 characters.");
  if (!/[a-z]/.test(password)) problems.push("Include a lowercase letter.");
  if (!/[A-Z0-9]/.test(password)) problems.push("Include an uppercase letter or a digit.");
  if (/^(?:password|qwerty|letmein|admin|welcome)/i.test(password)) problems.push("Avoid common passwords.");
  return { ok: problems.length === 0, problems };
}

/** Signed, tamper-evident session token. HMAC-SHA256 over the payload. */
export function signSession(payload: { userId: string; issuedAt: number; expiresAt: number }, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySession(
  token: string,
  secret: string,
  now = Date.now(),
): { userId: string; issuedAt: number; expiresAt: number } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload?.userId !== "string" || typeof payload?.expiresAt !== "number") return null;
    if (payload.expiresAt <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

/** CSRF token bound to the session token, so it cannot be replayed elsewhere. */
export function csrfToken(sessionToken: string, secret: string): string {
  return createHmac("sha256", `${secret}:csrf`).update(sessionToken).digest("base64url");
}

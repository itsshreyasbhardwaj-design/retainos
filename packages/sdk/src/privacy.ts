/**
 * Client-side privacy guard.
 *
 * This duplicates the server's denylist on purpose. The server is the
 * enforcement point, but stopping a secret at the client means it never
 * crosses the network at all, which is the difference between "we deleted it"
 * and "it was never sent".
 */
const DENY_KEY = [
  /pass(word|wd|phrase)/i, /^pwd$/i, /secret/i, /token/i, /^jwt$/i, /bearer/i,
  /api[-_]?key/i, /\bauth(oriz(ation|ed))?\b/i, /session[-_]?id/i, /cookie/i,
  /credit[-_]?card/i, /\bcard[-_]?(number|num|no|cvv|cvc)\b/i, /^cvv$/i, /^cvc$/i,
  /\bpan\b/i, /\biban\b/i, /\bssn\b/i, /aadhaar/i, /passport/i, /tax[-_]?id/i,
  /bank[-_]?account/i, /routing[-_]?number/i, /security[-_]?(code|answer|question)/i,
  /private[-_]?key/i, /mnemonic/i, /seed[-_]?phrase/i, /\bpin\b/i, /otp/i, /\bmfa\b/i,
  /health|diagnos|prescription|medical/i,
  /latitude|longitude|^lat$|^lng$|^lon$|precise[-_]?location|coords?/i,
  /keystroke|keylog/i, /\bdob\b|date[-_]?of[-_]?birth/i,
];

/**
 * Matched against the value as sent. Only the card pattern needs separators
 * removed first; stripping whitespace before the others made any long sentence
 * look like an opaque blob.
 */
const DENY_VALUE = [
  /^eyJ[A-Za-z0-9_-]{8,}\./,
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{12,}\b/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const CARD_NUMBER = /^(?:\d[ -]?){13,19}$/;

/**
 * An opaque, high-entropy blob. Shape alone would also match a long run of one
 * letter, so real character diversity is required too.
 */
const OPAQUE_BLOB_SHAPE = /^[A-Za-z0-9+/]{40,}={0,2}$/;

function looksLikeOpaqueSecret(value: string): boolean {
  return OPAQUE_BLOB_SHAPE.test(value) && new Set(value).size >= 16;
}

export function isSensitiveKey(key: string): boolean {
  return DENY_KEY.some((re) => re.test(key));
}

export function isSensitiveValue(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 13) return false;
  return CARD_NUMBER.test(value) || looksLikeOpaqueSecret(value) || DENY_VALUE.some((re) => re.test(value));
}

export const MAX_STRING_LENGTH = 1024;
export const MAX_PROPERTY_COUNT = 64;

export interface SanitiseResult {
  properties: Record<string, string | number | boolean>;
  dropped: string[];
}

/**
 * Sanitise event properties.
 *
 * Drops: sensitive keys and values, non-scalar values, non-finite numbers,
 * anything outside the project's allowlist when one is configured, and
 * properties beyond the count limit. Truncates over-long strings rather than
 * dropping them, because a truncated label is still useful.
 */
export function sanitiseProperties(
  input: Record<string, unknown>,
  allowed?: string[],
): SanitiseResult {
  const properties: Record<string, string | number | boolean> = {};
  const dropped: string[] = [];
  const allowList = allowed && allowed.length > 0 ? new Set(allowed) : null;
  let count = 0;

  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (count >= MAX_PROPERTY_COUNT) {
      dropped.push(key);
      continue;
    }
    if (isSensitiveKey(key) || isSensitiveValue(value)) {
      dropped.push(key);
      continue;
    }
    if (allowList && !allowList.has(key)) {
      dropped.push(key);
      continue;
    }
    if (typeof value === "string") {
      properties[key] = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
      count++;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        dropped.push(key);
        continue;
      }
      properties[key] = value;
      count++;
    } else if (typeof value === "boolean") {
      properties[key] = value;
      count++;
    } else {
      // Objects, arrays, functions and symbols are never sent. Flattening them
      // would be a quiet way to smuggle a whole user record into analytics.
      dropped.push(key);
    }
  }
  return { properties, dropped };
}

/**
 * Server-side privacy enforcement.
 *
 * The SDK refuses to collect sensitive fields, but a public write key is not a
 * secret and anyone can post to the ingestion endpoint. So the *server* is the
 * enforcement point: these rules run on every event before it is persisted.
 */

/** Property keys that RetainOS refuses to store, whatever the project config says. */
const DENY_KEY_PATTERNS: RegExp[] = [
  /pass(word|wd|phrase)/i,
  /^pwd$/i,
  /secret/i,
  /token/i,
  /^jwt$/i,
  /bearer/i,
  /api[-_]?key/i,
  /\bauth(oriz(ation|ed))?\b/i,
  /session[-_]?id/i,
  /cookie/i,
  /credit[-_]?card/i,
  /\bcard[-_]?(number|num|no|cvv|cvc)\b/i,
  /^cvv$/i,
  /^cvc$/i,
  /\bpan\b/i,
  /\biban\b/i,
  /\bssn\b/i,
  /aadhaar/i,
  /\bpan[-_]?card\b/i,
  /passport/i,
  /tax[-_]?id/i,
  /bank[-_]?account/i,
  /routing[-_]?number/i,
  /\bcvn\b/i,
  /security[-_]?(code|answer|question)/i,
  /private[-_]?key/i,
  /mnemonic/i,
  /seed[-_]?phrase/i,
  /\bpin\b/i,
  /otp/i,
  /\bmfa\b/i,
  /health|diagnos|prescription|medical/i,
  /latitude|longitude|^lat$|^lng$|^lon$|precise[-_]?location|coords?/i,
  /keystroke|keylog/i,
  /\bdob\b|date[-_]?of[-_]?birth/i,
];

/**
 * Values that look like credentials regardless of the key they arrived under.
 *
 * Matched against the value **as sent**. An earlier version stripped whitespace
 * first, which made the opaque-blob pattern match any long sentence once its
 * spaces were removed — so a perfectly ordinary error message or feedback title
 * was refused as a secret. Only the card-number pattern needs separators
 * removed, and it gets that treatment on its own below.
 */
const DENY_VALUE_PATTERNS: RegExp[] = [
  /^eyJ[A-Za-z0-9_-]{8,}\./, // JWT
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{12,}\b/, // provider secret keys
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Card-like numbers, which legitimately arrive with spaces or dashes. */
const CARD_NUMBER_PATTERN = /^(?:\d[ -]?){13,19}$/;

/**
 * An opaque, high-entropy blob: the shape of an encoded secret.
 *
 * Shape alone is not enough. "xxxxxxxx…" and a long run of ordinary letters
 * both fit the character class, so this also requires real character
 * diversity. An encoded token of this length essentially always has 16 or more
 * distinct characters; repeated or natural text does not.
 */
const OPAQUE_BLOB_SHAPE = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const OPAQUE_BLOB_MIN_DISTINCT = 16;

function looksLikeOpaqueSecret(value: string): boolean {
  if (!OPAQUE_BLOB_SHAPE.test(value)) return false;
  return new Set(value).size >= OPAQUE_BLOB_MIN_DISTINCT;
}

export interface SensitiveFinding {
  key: string;
  reason: "denied_key" | "denied_value";
}

export function findSensitiveKeys(props: Record<string, unknown>): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (DENY_KEY_PATTERNS.some((re) => re.test(key))) {
      findings.push({ key, reason: "denied_key" });
      continue;
    }
    if (typeof value === "string" && value.length >= 13) {
      if (
        CARD_NUMBER_PATTERN.test(value) ||
        looksLikeOpaqueSecret(value) ||
        DENY_VALUE_PATTERNS.some((re) => re.test(value))
      ) {
        findings.push({ key, reason: "denied_value" });
      }
    }
  }
  return findings;
}

/** Remove sensitive properties. Returns the clean object and what was dropped. */
export function scrubProperties(
  props: Record<string, unknown>,
): { clean: Record<string, unknown>; dropped: SensitiveFinding[] } {
  const dropped = findSensitiveKeys(props);
  if (dropped.length === 0) return { clean: props, dropped };
  const deniedKeys = new Set(dropped.map((d) => d.key));
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (!deniedKeys.has(k)) clean[k] = v;
  return { clean, dropped };
}

/**
 * Coarsen a user agent to a device category. RetainOS stores the category, never
 * the raw UA string, so the event store cannot be used for fingerprinting.
 */
export function deviceCategory(userAgent: string | null | undefined): "mobile" | "tablet" | "desktop" | "unknown" {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk(?!.*mobile)/.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android.*mobile|windows phone/.test(ua)) return "mobile";
  if (/mozilla|chrome|safari|firefox|edge|opera/.test(ua)) return "desktop";
  return "unknown";
}

/**
 * Time handling for RetainOS.
 *
 * Rules, applied everywhere without exception:
 *  - All timestamps are stored as integer milliseconds since the Unix epoch, UTC.
 *  - All *reporting* buckets are computed in the project's reporting timezone,
 *    because "daily active users" means "a day where the customer lives", not
 *    "a day in UTC". The timezone is an IANA name on the project.
 *  - Bucket keys are strings so they sort lexicographically and join safely:
 *      day   -> "2026-03-14"
 *      week  -> "2026-W11" (ISO-8601 week, Monday start)
 *      month -> "2026-03"
 */

export type Millis = number;
export type DayKey = string;
export type Granularity = "day" | "week" | "month";

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timezone: string): Intl.DateTimeFormat {
  let f = dayFormatters.get(timezone);
  if (!f) {
    // en-CA renders as YYYY-MM-DD, which is exactly the key format we want.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timezone, f);
  }
  return f;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Memoised day-key cache.
 *
 * Intl.DateTimeFormat.format is the single most expensive call in the analytics
 * layer, and the engines call it once per event. The local calendar date cannot
 * change within an hour (every IANA transition lands on an hour boundary), so
 * caching by hour bucket collapses millions of format calls down to at most 24
 * per day of data, with identical results.
 */
const dayKeyCache = new Map<string, DayKey>();
const DAY_KEY_CACHE_LIMIT = 200_000;

/** Calendar day in the given timezone, as "YYYY-MM-DD". */
export function dayKey(ts: Millis, timezone = "UTC"): DayKey {
  const bucket = Math.floor(ts / 3_600_000);
  const cacheKey = `${timezone}|${bucket}`;
  const cached = dayKeyCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const value = dayFormatter(timezone).format(new Date(ts));
  // A plain cap rather than a true LRU: the access pattern here is a scan over
  // a contiguous time range, so eviction order barely matters.
  if (dayKeyCache.size >= DAY_KEY_CACHE_LIMIT) dayKeyCache.clear();
  dayKeyCache.set(cacheKey, value);
  return value;
}

/** Clear the memoisation caches. Exposed for benchmarks and long-lived workers. */
export function clearTimeCaches(): void {
  dayKeyCache.clear();
  dayKeyMillisCache.clear();
}

/** Midnight (start of day) in `timezone`, returned as a UTC epoch millis value. */
export function startOfDay(ts: Millis, timezone = "UTC"): Millis {
  return dayKeyToMillis(dayKey(ts, timezone), timezone);
}

/**
 * Resolve "YYYY-MM-DD" in `timezone` back to epoch millis at local midnight.
 * Uses two-pass offset correction, which is correct across DST boundaries:
 * the first pass may land in the wrong offset, the second fixes it.
 */
const dayKeyMillisCache = new Map<string, Millis>();

export function dayKeyToMillis(key: DayKey, timezone = "UTC"): Millis {
  const cacheKey = `${timezone}|${key}`;
  const cached = dayKeyMillisCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const value = resolveDayKeyToMillis(key, timezone);
  if (dayKeyMillisCache.size >= 50_000) dayKeyMillisCache.clear();
  dayKeyMillisCache.set(cacheKey, value);
  return value;
}

function resolveDayKeyToMillis(key: DayKey, timezone: string): Millis {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  let guess = naive - tzOffsetMs(naive, timezone);
  if (dayKey(guess, timezone) !== key) {
    guess = naive - tzOffsetMs(guess, timezone);
  }
  // Snap forward if the local midnight does not exist (spring-forward gaps).
  if (dayKey(guess, timezone) !== key) {
    for (let add = 1; add <= 4; add++) {
      const alt = guess + add * 3_600_000;
      if (dayKey(alt, timezone) === key) return alt;
    }
  }
  return guess;
}

/** Offset of `timezone` from UTC in milliseconds at instant `ts`. */
export function tzOffsetMs(ts: Millis, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(ts))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUTC = Date.UTC(
    parts.year!,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    (parts.hour ?? 0) % 24,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return asUTC - ts;
}

export const DAY_MS = 86_400_000;

/** Whole days between two day keys (b - a). DST-safe because it re-resolves midnights. */
export function daysBetween(a: DayKey, b: DayKey, timezone = "UTC"): number {
  const ma = dayKeyToMillis(a, timezone);
  const mb = dayKeyToMillis(b, timezone);
  return Math.round((mb - ma) / DAY_MS);
}

export function addDays(key: DayKey, n: number, timezone = "UTC"): DayKey {
  // Add in the middle of the day so a DST shift never changes the calendar date.
  return dayKey(dayKeyToMillis(key, timezone) + n * DAY_MS + DAY_MS / 2, timezone);
}

/** Inclusive list of day keys from `from` to `to`. */
export function dayRange(from: DayKey, to: DayKey, timezone = "UTC"): DayKey[] {
  const out: DayKey[] = [];
  const n = daysBetween(from, to, timezone);
  for (let i = 0; i <= n; i++) out.push(addDays(from, i, timezone));
  return out;
}

/** ISO-8601 week key, Monday start, e.g. "2026-W11". */
export function weekKey(ts: Millis, timezone = "UTC"): string {
  const local = dayKey(ts, timezone);
  const [y, m, d] = local.split("-").map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dow = utc.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  utc.setUTCDate(utc.getUTCDate() + 4 - dow); // nearest Thursday fixes the year
  const isoYear = utc.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((utc.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Calendar month key, e.g. "2026-03". */
export function monthKey(ts: Millis, timezone = "UTC"): string {
  return dayKey(ts, timezone).slice(0, 7);
}

export function bucketKey(ts: Millis, granularity: Granularity, timezone = "UTC"): string {
  if (granularity === "day") return dayKey(ts, timezone);
  if (granularity === "week") return weekKey(ts, timezone);
  return monthKey(ts, timezone);
}

/** Bucket width in days. Used to decide whether a bucket has fully elapsed. */
export const bucketDays: Record<Granularity, number> = { day: 1, week: 7, month: 28 };

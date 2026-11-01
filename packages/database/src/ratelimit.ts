/**
 * Fixed-window rate limiter, in process memory.
 *
 * RetainOS must run with no Redis and no managed queue, so the default limiter
 * is in-memory. That is correct for a single node and honest about its limits:
 * see docs/EVENT_INGESTION.md for the shared-counter implementation to use
 * when running more than one ingestion process.
 */
export interface RateDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(key: string, cost = 1, now = Date.now()): RateDecision {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    if (w.count + cost > this.limit) {
      return { allowed: false, remaining: Math.max(0, this.limit - w.count), resetAt: w.resetAt };
    }
    w.count += cost;
    return { allowed: true, remaining: this.limit - w.count, resetAt: w.resetAt };
  }

  /** Drop expired windows. Called periodically so memory cannot grow unbounded. */
  sweep(now = Date.now()): void {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }

  reset(): void {
    this.windows.clear();
  }
}

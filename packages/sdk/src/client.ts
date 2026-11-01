import type {
  EventProperties, QueuedEvent, RetainOSOptions, SdkDiagnostics, StorageAdapter, Transport,
} from "./types.ts";
import { sanitiseProperties } from "./privacy.ts";
import { defaultStorage } from "./storage.ts";
import { fetchTransport } from "./transport.ts";

export const SDK_NAME = "@retainos/sdk";
export const SDK_VERSION = "0.1.0";

const KEY_ANON = "retainos.anonymous_id";
const KEY_USER = "retainos.user_id";
const KEY_CONSENT = "retainos.consent";
const KEY_OPTOUT = "retainos.opted_out";

const EVENT_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  // Last resort. Only reached on very old runtimes; still unique enough for a
  // per-device id, and never used for anything security-sensitive.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * The RetainOS client.
 *
 * Design commitments:
 *  - Never throws into the host application. A broken analytics call must not
 *    break a customer's product; every public method swallows its own errors
 *    and records them in `diagnostics()`.
 *  - Sends nothing before consent when `requireConsent` is on (the default).
 *  - Collects no session recordings, no keystrokes, no fingerprints, and no
 *    form field contents. There is no code path that does any of those.
 */
export class RetainOSClient {
  private readonly options: Required<Pick<RetainOSOptions, "projectKey" | "endpoint">> & RetainOSOptions;
  private readonly storage: StorageAdapter;
  private readonly transport: Transport;
  private readonly now: () => number;

  private queue: QueuedEvent[] = [];
  private anonymousId: string | null = null;
  private userId: string | null = null;
  private consentGranted = false;
  private optedOut = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stats = { sent: 0, dropped: 0, failed: 0 };
  private lastError: string | null = null;
  private unloadHandler: (() => void) | null = null;

  constructor(options: RetainOSOptions) {
    if (!options.projectKey) throw new Error("RetainOS.init requires a projectKey.");
    if (!options.endpoint) throw new Error("RetainOS.init requires an endpoint.");
    this.options = {
      autoCapture: false,
      requireConsent: true,
      batchSize: 20,
      flushIntervalMs: 5_000,
      maxQueueSize: 500,
      maxRetries: 3,
      debug: false,
      ...options,
    };
    this.storage = options.storage ?? defaultStorage();
    this.transport = options.transport ?? fetchTransport();
    this.now = options.now ?? (() => Date.now());

    this.optedOut = this.storage.get(KEY_OPTOUT) === "1";
    this.consentGranted = this.options.requireConsent === false || this.storage.get(KEY_CONSENT) === "1";
    this.userId = this.storage.get(KEY_USER);
    if (!this.optedOut) this.anonymousId = this.loadOrCreateAnonymousId();

    this.installUnloadFlush();
    if (this.options.autoCapture) this.installAutoCapture();
  }

  // -- identity ------------------------------------------------------------

  private loadOrCreateAnonymousId(): string {
    const existing = this.storage.get(KEY_ANON);
    if (existing) return existing;
    const fresh = randomId();
    this.storage.set(KEY_ANON, fresh);
    return fresh;
  }

  /**
   * Associate subsequent events with a known user id.
   *
   * Pass a stable, pseudonymous id from your own system. Do not pass an email
   * address or a name: RetainOS does not need them, and this method rejects
   * values that look like email addresses to stop that happening by accident.
   */
  identify(userId: string, traits?: EventProperties): void {
    this.guard(() => {
      if (this.optedOut) return;
      const id = String(userId ?? "").trim();
      if (!id) {
        this.warn("identify() needs a non-empty user id.");
        return;
      }
      if (id.includes("@") && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)) {
        this.warn("identify() was called with an email address. Pass a pseudonymous id instead; the call was ignored.");
        return;
      }
      if (id.length > 200) {
        this.warn("identify() user id is too long (max 200 characters); the call was ignored.");
        return;
      }
      this.userId = id;
      this.storage.set(KEY_USER, id);
      if (traits) {
        // Traits are recorded as a normal event so they flow through exactly the
        // same validation and privacy rules as everything else.
        this.track("user_identified", traits);
      }
    });
  }

  /**
   * Clear the identity. Call this on logout.
   *
   * Issues a fresh anonymous id so the next person on this device is not
   * attributed to the previous one.
   */
  reset(): void {
    this.guard(() => {
      this.flush();
      this.userId = null;
      this.storage.remove(KEY_USER);
      const fresh = randomId();
      this.storage.set(KEY_ANON, fresh);
      this.anonymousId = fresh;
    });
  }

  // -- consent and opt-out --------------------------------------------------

  grantConsent(): void {
    this.guard(() => {
      this.consentGranted = true;
      this.storage.set(KEY_CONSENT, "1");
      if (!this.anonymousId && !this.optedOut) this.anonymousId = this.loadOrCreateAnonymousId();
      void this.flush();
    });
  }

  /** Withdraw consent. Queued events that were never sent are discarded. */
  revokeConsent(): void {
    this.guard(() => {
      this.consentGranted = false;
      this.storage.set(KEY_CONSENT, "0");
      this.stats.dropped += this.queue.length;
      this.queue = [];
    });
  }

  hasConsent(): boolean {
    return this.consentGranted;
  }

  /** Stop all collection and forget local identifiers. Survives reloads. */
  optOut(): void {
    this.guard(() => {
      this.optedOut = true;
      this.storage.set(KEY_OPTOUT, "1");
      this.stats.dropped += this.queue.length;
      this.queue = [];
      this.anonymousId = null;
      this.userId = null;
      this.storage.remove(KEY_ANON);
      this.storage.remove(KEY_USER);
      this.clearTimer();
    });
  }

  optIn(): void {
    this.guard(() => {
      this.optedOut = false;
      this.storage.remove(KEY_OPTOUT);
      this.anonymousId = this.loadOrCreateAnonymousId();
    });
  }

  isOptedOut(): boolean {
    return this.optedOut;
  }

  // -- capture -------------------------------------------------------------

  track(name: string, properties?: EventProperties): void {
    this.guard(() => {
      if (this.optedOut) return;
      const eventName = String(name ?? "").trim();
      if (!EVENT_NAME_RE.test(eventName)) {
        this.warn(`Event name '${eventName}' is not lower_snake_case and was not queued.`);
        return;
      }
      if (!this.consentGranted) {
        // Not an error: the integrator has told us to wait for consent.
        this.debug(`Event '${eventName}' withheld: consent has not been granted.`);
        return;
      }
      if (!this.anonymousId && !this.userId) {
        this.warn(`Event '${eventName}' has no identity and was not queued.`);
        return;
      }

      const merged = { ...(this.options.globalProperties ?? {}), ...(properties ?? {}) };
      const { properties: clean, dropped } = sanitiseProperties(
        merged as Record<string, unknown>,
        this.options.allowedProperties,
      );
      if (dropped.length > 0) {
        this.warn(`Dropped ${dropped.length} propert${dropped.length === 1 ? "y" : "ies"} on '${eventName}': ${dropped.join(", ")}`);
      }

      const event: QueuedEvent = {
        name: eventName,
        timestamp: this.now(),
        eventId: randomId(),
        anonymousId: this.anonymousId,
        userId: this.userId,
        properties: clean,
        consent: true,
      };
      this.enqueue(event);
    });
  }

  /**
   * Record a page view. The path is sent; query strings and fragments are not,
   * because they routinely carry tokens, search terms and personal data.
   */
  page(path?: string, properties?: EventProperties): void {
    const resolved = path ?? this.currentPath();
    if (resolved === null) return;
    this.track("page_viewed", { ...properties, path: resolved });
  }

  private currentPath(): string | null {
    const loc = (globalThis as { location?: Location }).location;
    if (!loc) return null;
    return loc.pathname || "/";
  }

  private enqueue(event: QueuedEvent): void {
    if (this.queue.length >= (this.options.maxQueueSize ?? 500)) {
      // Drop the oldest. Losing the start of a long offline session is better
      // than losing what the user is doing right now.
      this.queue.shift();
      this.stats.dropped++;
      this.warn("Event queue is full; the oldest queued event was dropped.");
    }
    this.queue.push(event);
    if (this.queue.length >= (this.options.batchSize ?? 20)) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.flushIntervalMs ?? 5_000);
    // Do not hold a Node process open just to send analytics.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // -- delivery ------------------------------------------------------------

  /**
   * Send everything queued. Safe to call at any time; never throws.
   *
   * When a flush is already running, this returns that same promise rather
   * than resolving immediately, so `await flush()` always means "delivery has
   * been attempted for everything queued", including events added mid-flush.
   */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0 || this.optedOut || !this.consentGranted) return Promise.resolve();
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
      if (this.queue.length > 0) this.scheduleFlush();
    });
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    this.clearTimer();
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, Math.min(this.options.batchSize ?? 20, 100));
        // The idempotency key is derived from the batch's own event ids, so a
        // retry of the same batch is recognised by the server as a replay.
        const idempotencyKey = `${batch[0]!.eventId}-${batch.length}`;
        const payload = {
          events: batch,
          sdk: { name: SDK_NAME, version: SDK_VERSION },
          idempotencyKey,
        };
        const delivered = await this.send(payload);
        if (!delivered) {
          this.debug(`Flush failed; ${this.queue.length} events remain queued for a later attempt.`);
          break;
        }
        this.queue.splice(0, batch.length);
        this.stats.sent += batch.length;
      }
    } catch (e) {
      // Delivery problems are recorded, never thrown at the host application.
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  private async send(payload: { events: QueuedEvent[]; sdk: { name: string; version: string }; idempotencyKey: string }): Promise<boolean> {
    const url = `${this.options.endpoint.replace(/\/+$/, "")}/api/v1/ingest`;
    const maxRetries = this.options.maxRetries ?? 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await this.transport(url, payload, this.options.projectKey);

      if (res.status >= 200 && res.status < 300) return true;

      // 4xx other than 408/429 means this payload will never be accepted.
      // Retrying it forever would be a busy loop against our own server.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        this.stats.dropped += payload.events.length;
        this.lastError = `Server rejected the batch with status ${res.status}; the events were discarded.`;
        this.warn(this.lastError);
        return true; // consumed: remove from the queue
      }

      this.stats.failed++;
      this.lastError = `Delivery attempt ${attempt + 1} failed with status ${res.status}.`;
      if (attempt === maxRetries) return false;

      // Exponential backoff with jitter, so a recovering server is not hit by
      // every client at the same instant.
      const base = Math.min(30_000, 500 * 2 ** attempt);
      const wait = base / 2 + Math.random() * (base / 2);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        (t as { unref?: () => void }).unref?.();
      });
    }
    return false;
  }

  private installUnloadFlush(): void {
    const target = globalThis as unknown as {
      addEventListener?: (t: string, h: () => void) => void;
      document?: { visibilityState?: string };
    };
    if (typeof target.addEventListener !== "function") return;
    this.unloadHandler = () => {
      if (target.document?.visibilityState === "visible") return;
      void this.flush();
    };
    target.addEventListener("pagehide", this.unloadHandler);
    target.addEventListener("visibilitychange", this.unloadHandler);
  }

  private installAutoCapture(): void {
    const target = globalThis as unknown as { addEventListener?: (t: string, h: () => void) => void };
    if (typeof target.addEventListener !== "function") return;
    // Page views only. Auto-capture never records clicks, inputs, keystrokes
    // or DOM contents; there is no code here that could.
    this.page();
    target.addEventListener("popstate", () => this.page());
  }

  // -- introspection -------------------------------------------------------

  diagnostics(): SdkDiagnostics {
    return {
      queued: this.queue.length,
      sent: this.stats.sent,
      dropped: this.stats.dropped,
      failed: this.stats.failed,
      lastError: this.lastError,
      consentGranted: this.consentGranted,
      optedOut: this.optedOut,
      anonymousId: this.anonymousId,
      userId: this.userId,
    };
  }

  /** Release timers and listeners. Call this in a component unmount or in tests. */
  shutdown(): void {
    this.clearTimer();
    const target = globalThis as unknown as { removeEventListener?: (t: string, h: () => void) => void };
    if (this.unloadHandler && typeof target.removeEventListener === "function") {
      target.removeEventListener("pagehide", this.unloadHandler);
      target.removeEventListener("visibilitychange", this.unloadHandler);
    }
  }

  get version(): string {
    return SDK_VERSION;
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      // An analytics failure must never surface as an application error.
      this.lastError = e instanceof Error ? e.message : String(e);
      this.debug(`Suppressed internal error: ${this.lastError}`);
    }
  }

  private warn(message: string): void {
    this.lastError = message;
    if (this.options.debug) console.warn(`[retainos] ${message}`);
  }

  private debug(message: string): void {
    if (this.options.debug) console.debug(`[retainos] ${message}`);
  }
}

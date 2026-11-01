export type PropertyValue = string | number | boolean;
export type EventProperties = Record<string, PropertyValue | null | undefined>;

export interface QueuedEvent {
  name: string;
  timestamp: number;
  eventId: string;
  anonymousId: string | null;
  userId: string | null;
  properties: Record<string, PropertyValue>;
  consent: boolean;
  releaseId?: string;
}

export interface TransportPayload {
  events: QueuedEvent[];
  sdk: { name: string; version: string };
  idempotencyKey: string;
}

export interface TransportResponse {
  /** HTTP-like status. 0 means the request never reached the server. */
  status: number;
  body?: unknown;
}

export type Transport = (url: string, payload: TransportPayload, publicKey: string) => Promise<TransportResponse>;

export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface RetainOSOptions {
  /** Public project key. Not a secret: it is expected to ship in the bundle. */
  projectKey: string;
  /** Base URL of the RetainOS instance, e.g. https://retain.example.com */
  endpoint: string;
  /**
   * Capture page views automatically. Off by default: automatic capture is a
   * decision for the integrator to make deliberately, not a default we impose.
   */
  autoCapture?: boolean;
  /**
   * Whether the SDK may send events before `grantConsent()` is called.
   * Defaults to false, i.e. nothing leaves the device without consent.
   */
  requireConsent?: boolean;
  /** Events per request. The server's hard limit is 100. */
  batchSize?: number;
  /** Milliseconds to wait before flushing a partial batch. */
  flushIntervalMs?: number;
  /** Maximum events held in memory while offline. Oldest are dropped first. */
  maxQueueSize?: number;
  /** Number of retry attempts for a failed flush. */
  maxRetries?: number;
  /** Property names the project has approved. When set, others are dropped. */
  allowedProperties?: string[];
  /** Properties attached to every event, e.g. product_version. */
  globalProperties?: EventProperties;
  debug?: boolean;
  transport?: Transport;
  storage?: StorageAdapter;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface SdkDiagnostics {
  queued: number;
  sent: number;
  dropped: number;
  failed: number;
  lastError: string | null;
  consentGranted: boolean;
  optedOut: boolean;
  anonymousId: string | null;
  userId: string | null;
}

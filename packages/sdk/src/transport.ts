import type { Transport, TransportPayload, TransportResponse } from "./types.ts";

/**
 * Default transport: fetch with keepalive.
 *
 * keepalive lets an in-flight request survive a page unload, which is what
 * makes the last event before a navigation arrive. If fetch is unavailable the
 * transport reports status 0 and the caller retries later, rather than throwing
 * into the host application's call stack.
 */
export function fetchTransport(): Transport {
  return async (url: string, payload: TransportPayload, publicKey: string): Promise<TransportResponse> => {
    if (typeof fetch !== "function") return { status: 0 };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-retainos-key": publicKey,
          "x-retainos-idempotency-key": payload.idempotencyKey,
        },
        body: JSON.stringify(payload),
        keepalive: payload.events.length <= 20,
        credentials: "omit",
        mode: "cors",
      });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      return { status: res.status, body };
    } catch {
      return { status: 0 };
    }
  };
}

/** Collects payloads instead of sending them. Used by the test suite. */
export function recordingTransport(responder?: (p: TransportPayload) => TransportResponse) {
  const sent: TransportPayload[] = [];
  const transport: Transport = async (_url, payload) => {
    sent.push(payload);
    return responder ? responder(payload) : { status: 202 };
  };
  return { transport, sent };
}

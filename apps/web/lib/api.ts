import { NextResponse } from "next/server";
import { statusForError, type DomainError } from "@retainos/shared";

/** CORS for the ingestion and widget endpoints, which are called from browsers. */
export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  // CORS is a browser convenience here, not the security boundary: the server
  // enforces the origin allowlist itself. See docs/EVENT_INGESTION.md.
  const allowOrigin =
    allowed.length === 0 || allowed.includes("*")
      ? (origin ?? "*")
      : origin && allowed.includes(origin)
        ? origin
        : (allowed[0] ?? "*");
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-retainos-key, x-retainos-idempotency-key",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

export function errorResponse(error: DomainError, extraHeaders: Record<string, string> = {}): NextResponse {
  return NextResponse.json(
    { error: { code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) } },
    { status: statusForError(error.code), headers: extraHeaders },
  );
}

export function okResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: extraHeaders });
}

/** Read a JSON body with a hard size cap, so a huge payload cannot be buffered. */
export async function readJson(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    return { ok: false, message: `Request body exceeds ${maxBytes} bytes.` };
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, message: `Request body exceeds ${maxBytes} bytes.` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: "Request body is not valid JSON." };
  }
}

import type { NextRequest } from "next/server";
import { domainError } from "@retainos/shared";
import { authenticateWriteKey, ingestBatch, MAX_BODY_BYTES, type IngestRequest } from "@retainos/database";
import { db } from "@/lib/db";
import { corsHeaders, errorResponse, okResponse, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Event ingestion.
 *
 * Authenticated by a public write key, which is not a secret: it ships in
 * browser bundles and grants append-only access to exactly one project. The
 * protections that matter are the per-project rate limit, the payload caps,
 * schema validation, the server-side origin allowlist and the privacy
 * denylist — all of which run below, not in the client.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const key = request.headers.get("x-retainos-key");

  if (!key) {
    return errorResponse(
      domainError("unauthenticated", "Send your public project key in the x-retainos-key header."),
      corsHeaders(origin, []),
    );
  }

  const handle = db();
  const scope = authenticateWriteKey(handle, key);
  if (!scope.ok) return errorResponse(scope.error, corsHeaders(origin, []));

  const cors = corsHeaders(origin, scope.value.allowedOrigins);

  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return errorResponse(domainError("payload_too_large", body.message), cors);

  const payload = body.value as Partial<IngestRequest> & Record<string, unknown>;
  const result = ingestBatch(handle, scope.value, {
    events: Array.isArray(payload.events) ? payload.events : [],
    sdk: typeof payload.sdk === "object" && payload.sdk !== null ? (payload.sdk as IngestRequest["sdk"]) : undefined,
    idempotencyKey:
      request.headers.get("x-retainos-idempotency-key") ??
      (typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined),
    origin,
    userAgent: request.headers.get("user-agent"),
    // A country from an edge header, if the deployment provides one. Coarse by
    // design: RetainOS never stores a precise location.
    country:
      request.headers.get("x-vercel-ip-country") ??
      request.headers.get("cf-ipcountry") ??
      request.headers.get("x-retainos-country"),
  });

  if (!result.ok) return errorResponse(result.error, cors);

  // 202: accepted for processing. The body reports per-event outcomes so a
  // developer can see exactly which event failed and why.
  return okResponse(
    {
      accepted: result.value.accepted,
      rejected: result.value.rejected,
      duplicates: result.value.duplicates,
      replayed: result.value.replayed,
      batchId: result.value.batchId,
      outcomes: result.value.outcomes,
      quota: result.value.quota,
    },
    202,
    cors,
  );
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  const key = request.headers.get("x-retainos-key");
  // The preflight cannot see the body, so resolve the allowlist from the key
  // when one is present and fall back to permissive otherwise.
  let allowed: string[] = [];
  if (key) {
    const scope = authenticateWriteKey(db(), key);
    if (scope.ok) allowed = scope.value.allowedOrigins;
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
}

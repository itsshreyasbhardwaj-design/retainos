import type { NextRequest } from "next/server";
import { domainError } from "@retainos/shared";
import { authenticateWriteKey, resolveIdentity } from "@retainos/database";
import { getExperiment, assignVariant, listExperiments } from "@retainos/analytics";
import { db } from "@/lib/db";
import { corsHeaders, errorResponse, okResponse, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Variant assignment.
 *
 * Returns the variant for an identity in every running experiment. Assignment
 * is a pure function of (experiment key, identity id), so the answer is stable
 * across calls, processes and restarts; the stored row is a cache of it.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const key = request.headers.get("x-retainos-key");
  if (!key) {
    return errorResponse(domainError("unauthenticated", "Send your public project key in x-retainos-key."), corsHeaders(origin, []));
  }
  const handle = db();
  const scope = authenticateWriteKey(handle, key);
  if (!scope.ok) return errorResponse(scope.error, corsHeaders(origin, []));
  const cors = corsHeaders(origin, scope.value.allowedOrigins);

  const body = await readJson(request, 8192);
  if (!body.ok) return errorResponse(domainError("validation_failed", body.message), cors);
  const payload = body.value as Record<string, unknown>;

  const identityId = resolveIdentity(handle, scope.value, {
    anonymousId: typeof payload.anonymousId === "string" ? payload.anonymousId : null,
    externalId: typeof payload.userId === "string" ? payload.userId : null,
  });
  if (!identityId) {
    return errorResponse(domainError("validation_failed", "Send an anonymousId or a userId."), cors);
  }

  const running = (listExperiments(handle, scope.value.projectId) as Array<Record<string, unknown>>)
    .filter((e) => e.status === "running");

  const assignments: Record<string, string> = {};
  for (const row of running) {
    const config = getExperiment(handle, scope.value.projectId, String(row.id));
    if (!config) continue;
    assignments[config.key] = assignVariant(
      handle, { orgId: scope.value.orgId, projectId: scope.value.projectId },
      { id: config.id, key: config.key, variants: config.variants }, identityId,
    );
  }

  return okResponse({ assignments, identityId }, 200, cors);
}

export async function OPTIONS(request: NextRequest) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin"), []) });
}

import type { NextRequest } from "next/server";
import { domainError } from "@retainos/shared";
import { authenticateWriteKey, resolveIdentity } from "@retainos/database";
import { getExperiment, recordExposure } from "@retainos/analytics";
import { db } from "@/lib/db";
import { corsHeaders, errorResponse, okResponse, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exposure recording.
 *
 * Call this where the variant is actually shown, not where it is assigned.
 * Analysis counts exposures, because a user who never reached the changed
 * screen tells you nothing about the change and including them dilutes any
 * real effect towards zero.
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

  const experimentKey = typeof payload.experiment === "string" ? payload.experiment : "";
  const variantKey = typeof payload.variant === "string" ? payload.variant : "";
  if (!experimentKey || !variantKey) {
    return errorResponse(domainError("validation_failed", "Send an experiment key and a variant key."), cors);
  }

  const row = handle.get<{ id: string; status: string }>(
    "SELECT id, status FROM experiments WHERE project_id = ? AND key = ?", [scope.value.projectId, experimentKey],
  );
  if (!row) return errorResponse(domainError("not_found", "Experiment not found."), cors);
  if (row.status !== "running") {
    return errorResponse(domainError("conflict", "That experiment is not running, so exposures are not recorded."), cors);
  }

  const config = getExperiment(handle, scope.value.projectId, row.id);
  if (!config?.variants.some((v) => v.key === variantKey)) {
    return errorResponse(domainError("validation_failed", `'${variantKey}' is not a variant of this experiment.`), cors);
  }

  const identityId = resolveIdentity(handle, scope.value, {
    anonymousId: typeof payload.anonymousId === "string" ? payload.anonymousId : null,
    externalId: typeof payload.userId === "string" ? payload.userId : null,
  });
  if (!identityId) return errorResponse(domainError("validation_failed", "Send an anonymousId or a userId."), cors);

  recordExposure(handle, { orgId: scope.value.orgId, projectId: scope.value.projectId }, row.id, identityId, variantKey);
  return okResponse({ recorded: true }, 202, cors);
}

export async function OPTIONS(request: NextRequest) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin"), []) });
}

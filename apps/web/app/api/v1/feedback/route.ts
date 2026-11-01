import type { NextRequest } from "next/server";
import { domainError } from "@retainos/shared";
import { authenticateWriteKey, submitFeedback, resolveIdentity, voteFeedback } from "@retainos/database";
import { db } from "@/lib/db";
import { corsHeaders, errorResponse, okResponse, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;

/**
 * Public feedback submission, for the embeddable widget and the portal.
 *
 * Authenticated by the same public write key as ingestion. Contact details are
 * stored only when the reporter explicitly consents, and page context is
 * limited to an identifier the host application supplies — never page contents.
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

  const body = await readJson(request, MAX_BODY);
  if (!body.ok) return errorResponse(domainError("payload_too_large", body.message), cors);
  const payload = body.value as Record<string, unknown>;

  // A vote on an existing request, rather than a new submission.
  if (typeof payload.voteFor === "string") {
    const voterToken = typeof payload.voterToken === "string" ? payload.voterToken : "";
    if (!voterToken) {
      return errorResponse(domainError("validation_failed", "A voterToken is required to vote."), cors);
    }
    const salt = process.env.RETAINOS_SESSION_SECRET ?? "retainos";
    const r = voteFeedback(handle, { orgId: scope.value.orgId, projectId: scope.value.projectId },
      payload.voteFor, voterToken, salt);
    return r.ok ? okResponse(r.value, 200, cors) : errorResponse(r.error, cors);
  }

  const identityId =
    typeof payload.userId === "string" || typeof payload.anonymousId === "string"
      ? resolveIdentity(handle, scope.value, {
          anonymousId: typeof payload.anonymousId === "string" ? payload.anonymousId : null,
          externalId: typeof payload.userId === "string" ? payload.userId : null,
        })
      : null;

  const result = submitFeedback(handle, { orgId: scope.value.orgId, projectId: scope.value.projectId }, {
    kind: (typeof payload.kind === "string" ? payload.kind : "general") as never,
    title: typeof payload.title === "string" ? payload.title : "",
    body: typeof payload.body === "string" ? payload.body : "",
    source: typeof payload.source === "string" && payload.source === "portal" ? "portal" : "widget",
    contactEmail: typeof payload.contactEmail === "string" ? payload.contactEmail : null,
    consentToContact: payload.consentToContact === true,
    pageIdentifier: typeof payload.pageIdentifier === "string" ? payload.pageIdentifier : null,
    productVersion: typeof payload.productVersion === "string" ? payload.productVersion : null,
    identityId,
    severityReported: typeof payload.severity === "string" ? payload.severity : null,
  });

  if (!result.ok) return errorResponse(result.error, cors);
  return okResponse({ id: result.value.id, received: true }, 201, cors);
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  const key = request.headers.get("x-retainos-key");
  let allowed: string[] = [];
  if (key) {
    const scope = authenticateWriteKey(db(), key);
    if (scope.ok) allowed = scope.value.allowedOrigins;
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
}

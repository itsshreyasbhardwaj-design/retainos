import type { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { domainError } from "@retainos/shared";
import { applyProviderEvent, type ProviderEvent } from "@retainos/database";
import { db } from "@/lib/db";
import { errorResponse, okResponse } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 256 * 1024;

/**
 * Billing provider webhooks.
 *
 * The signature is verified before the payload is parsed as meaningful, and an
 * unverified request is rejected outright. Repeat delivery is expected from
 * every provider, so application is idempotent on the provider's own event id.
 *
 * Verified against each provider's documented signing scheme, but not yet
 * exercised against live provider traffic — see docs/FEATURE_STATUS.md.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!["razorpay", "stripe", "simulator"].includes(provider)) {
    return errorResponse(domainError("not_found", "Unknown billing provider."));
  }

  const projectId = request.nextUrl.searchParams.get("project");
  if (!projectId) {
    return errorResponse(domainError("validation_failed", "Add ?project=<project id> to the webhook URL."));
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY) {
    return errorResponse(domainError("payload_too_large", "Webhook body is too large."));
  }

  const verified = verifySignature(provider, raw, request);
  if (!verified.ok) return errorResponse(domainError("forbidden", verified.message));

  const handle = db();
  const project = handle.get<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM projects WHERE id = ? AND archived_at IS NULL", [projectId],
  );
  if (!project) return errorResponse(domainError("not_found", "Project not found."));

  let mapped: ProviderEvent | { error: string };
  try {
    mapped = mapPayload(provider, JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return errorResponse(domainError("validation_failed", "Webhook body is not valid JSON."));
  }
  if ("error" in mapped) return errorResponse(domainError("validation_failed", mapped.error));

  const result = applyProviderEvent(handle, { orgId: project.org_id, projectId: project.id }, mapped);
  if (!result.ok) return errorResponse(result.error);

  // 200 on a replay as well as a first delivery, so the provider stops retrying.
  return okResponse({ received: true, applied: result.value.applied });
}

function verifySignature(
  provider: string,
  raw: string,
  request: NextRequest,
): { ok: true } | { ok: false; message: string } {
  if (provider === "simulator") {
    // The simulator is development-only and is refused outright in production,
    // so an unsigned endpoint can never exist on a live deployment.
    if (process.env.NODE_ENV === "production") {
      return { ok: false, message: "The billing simulator is disabled in production." };
    }
    return { ok: true };
  }

  if (provider === "razorpay") {
    const secret = process.env.RETAINOS_RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return { ok: false, message: "No Razorpay webhook secret is configured on the server." };
    const header = request.headers.get("x-razorpay-signature");
    if (!header) return { ok: false, message: "Missing x-razorpay-signature header." };
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    return constantTimeEqual(header, expected)
      ? { ok: true }
      : { ok: false, message: "Signature does not match." };
  }

  // Stripe: t=<timestamp>,v1=<signature> over "<timestamp>.<body>".
  const secret = process.env.RETAINOS_STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false, message: "No Stripe webhook secret is configured on the server." };
  const header = request.headers.get("stripe-signature");
  if (!header) return { ok: false, message: "Missing stripe-signature header." };
  const parts = new Map(
    header.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k?.trim() ?? "", v?.trim() ?? ""] as const;
    }),
  );
  const timestamp = parts.get("t");
  const signature = parts.get("v1");
  if (!timestamp || !signature) return { ok: false, message: "Malformed stripe-signature header." };
  // Reject a stale signature so a captured request cannot be replayed later.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    return { ok: false, message: "Signature timestamp is outside the five-minute tolerance." };
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return constantTimeEqual(signature, expected)
    ? { ok: true }
    : { ok: false, message: "Signature does not match." };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Map a provider payload to RetainOS's own event shape.
 *
 * Only these fields are kept. The raw payload is never stored, so a provider
 * cannot push customer PII into RetainOS through a field we did not ask for.
 */
function mapPayload(provider: string, payload: Record<string, unknown>): ProviderEvent | { error: string } {
  if (provider === "simulator") {
    const p = payload as Partial<ProviderEvent>;
    if (!p.externalEventId || !p.externalSubscriptionId || !p.type) {
      return { error: "Simulator events need externalEventId, externalSubscriptionId and type." };
    }
    return {
      provider: "simulator",
      externalEventId: String(p.externalEventId),
      externalSubscriptionId: String(p.externalSubscriptionId),
      type: p.type,
      occurredAt: typeof p.occurredAt === "number" ? p.occurredAt : Date.now(),
      amountMinor: typeof p.amountMinor === "number" ? p.amountMinor : 0,
      currency: typeof p.currency === "string" ? p.currency : "INR",
      interval: p.interval ?? "month",
      planName: p.planName ?? "unknown",
      externalUserId: p.externalUserId ?? null,
    };
  }

  if (provider === "razorpay") {
    const event = String(payload.event ?? "");
    const entity = ((payload.payload as Record<string, unknown>)?.subscription as Record<string, unknown>)?.entity as
      Record<string, unknown> | undefined;
    const paymentEntity = ((payload.payload as Record<string, unknown>)?.payment as Record<string, unknown>)?.entity as
      Record<string, unknown> | undefined;
    const subscriptionId = String(entity?.id ?? paymentEntity?.subscription_id ?? "");
    if (!subscriptionId) return { error: "Could not find a subscription id in the payload." };

    const TYPES: Record<string, ProviderEvent["type"]> = {
      "subscription.activated": "subscription_started",
      "subscription.charged": "renewed",
      "subscription.updated": "upgraded",
      "subscription.pending": "payment_failed",
      "subscription.halted": "payment_failed",
      "subscription.paused": "paused",
      "subscription.resumed": "resumed",
      "subscription.cancelled": "cancelled",
      "subscription.completed": "expired",
      "payment.failed": "payment_failed",
      "payment.captured": "payment_recovered",
      "refund.processed": "refunded",
    };
    const type = TYPES[event];
    if (!type) return { error: `Unhandled Razorpay event '${event}'.` };

    return {
      provider: "razorpay",
      externalEventId: String(payload.id ?? `${event}:${subscriptionId}:${payload.created_at ?? ""}`),
      externalSubscriptionId: subscriptionId,
      type,
      occurredAt: Number(payload.created_at ?? 0) * 1000 || Date.now(),
      amountMinor: Number(paymentEntity?.amount ?? entity?.quantity ?? 0) || 0,
      currency: String(paymentEntity?.currency ?? "INR").toUpperCase(),
      interval: "month",
      planName: String(entity?.plan_id ?? "unknown"),
      externalUserId: typeof entity?.notes === "object" && entity.notes !== null
        ? ((entity.notes as Record<string, unknown>).retainos_user_id as string | undefined) ?? null
        : null,
      payloadDigestSource: event,
    };
  }

  // Stripe
  const event = String(payload.type ?? "");
  const object = ((payload.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
  const subscriptionId = String(object.id ?? object.subscription ?? "");
  if (!subscriptionId) return { error: "Could not find a subscription id in the payload." };

  const TYPES: Record<string, ProviderEvent["type"]> = {
    "customer.subscription.created": "subscription_started",
    "customer.subscription.updated": "upgraded",
    "customer.subscription.deleted": "cancelled",
    "customer.subscription.trial_will_end": "trial_started",
    "customer.subscription.paused": "paused",
    "customer.subscription.resumed": "resumed",
    "invoice.paid": "renewed",
    "invoice.payment_failed": "payment_failed",
    "charge.refunded": "refunded",
  };
  const type = TYPES[event];
  if (!type) return { error: `Unhandled Stripe event '${event}'.` };

  const item = ((object.items as Record<string, unknown>)?.data as Array<Record<string, unknown>> | undefined)?.[0];
  const price = item?.price as Record<string, unknown> | undefined;
  const recurring = price?.recurring as Record<string, unknown> | undefined;
  const stripeInterval = String(recurring?.interval ?? "month");

  return {
    provider: "stripe",
    externalEventId: String(payload.id ?? `${event}:${subscriptionId}`),
    externalSubscriptionId: subscriptionId,
    type,
    occurredAt: Number(payload.created ?? 0) * 1000 || Date.now(),
    amountMinor: Number(price?.unit_amount ?? object.amount_paid ?? 0) || 0,
    currency: String(price?.currency ?? object.currency ?? "usd").toUpperCase(),
    interval: stripeInterval === "year" ? "year" : stripeInterval === "quarter" ? "quarter" : "month",
    planName: String(price?.nickname ?? price?.id ?? "unknown"),
    externalUserId: typeof object.metadata === "object" && object.metadata !== null
      ? ((object.metadata as Record<string, unknown>).retainos_user_id as string | undefined) ?? null
      : null,
    payloadDigestSource: event,
  };
}

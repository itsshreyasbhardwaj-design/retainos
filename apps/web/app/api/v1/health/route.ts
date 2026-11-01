import { okResponse } from "@/lib/api";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness and readiness. Reports the database as reachable or not, truthfully. */
export async function GET() {
  let database: "ok" | "unavailable" = "unavailable";
  let migrations = 0;
  try {
    const handle = db();
    migrations = handle.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migrations")?.n ?? 0;
    database = "ok";
  } catch {
    database = "unavailable";
  }
  return okResponse({
    status: database === "ok" ? "ok" : "degraded",
    database,
    migrationsApplied: migrations,
    // Optional integrations report configured-or-not, never their credentials.
    integrations: {
      github: Boolean(process.env.RETAINOS_GITHUB_TOKEN),
      razorpay: Boolean(process.env.RETAINOS_RAZORPAY_WEBHOOK_SECRET),
      stripe: Boolean(process.env.RETAINOS_STRIPE_WEBHOOK_SECRET),
      llm: (process.env.RETAINOS_LLM_PROVIDER ?? "none") !== "none",
    },
  }, database === "ok" ? 200 : 503);
}

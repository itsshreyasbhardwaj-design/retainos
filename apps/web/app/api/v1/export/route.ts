import type { NextRequest } from "next/server";
import { domainError } from "@retainos/shared";
import { resolveProjectScope, exportProject, toCsv } from "@retainos/database";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Project data export.
 *
 * Requires a signed-in user with the export permission on that project, which
 * `resolveProjectScope` verifies against the database — a project id in the
 * query string cannot widen access on its own. Available on every plan,
 * including after a subscription lapses.
 */
export async function GET(request: NextRequest) {
  const user = await requireUser();
  const projectId = request.nextUrl.searchParams.get("project");
  if (!projectId) return errorResponse(domainError("validation_failed", "Add ?project=<project id>."));

  const scope = resolveProjectScope(db(), user.id, projectId);
  if (!scope.ok) return errorResponse(scope.error);

  const format = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const table = request.nextUrl.searchParams.get("table");

  const bundle = exportProject(db(), scope.value, { includeRawEvents: true });
  if (!bundle.ok) return errorResponse(bundle.error);

  const date = new Date().toISOString().slice(0, 10);
  const slug = String((bundle.value.project as Record<string, unknown>).slug ?? "project");

  if (format === "csv") {
    const rows = table ? bundle.value.tables[table] : undefined;
    if (!rows) {
      return errorResponse(
        domainError("validation_failed", `Add &table=<name>. Available: ${Object.keys(bundle.value.tables).sort().join(", ")}.`),
      );
    }
    return new Response(toCsv(rows), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="retainos-${slug}-${table}-${date}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  return new Response(JSON.stringify(bundle.value, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="retainos-${slug}-${date}.json"`,
      "cache-control": "no-store",
    },
  });
}

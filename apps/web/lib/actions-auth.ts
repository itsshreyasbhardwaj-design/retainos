"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createUser, authenticate, createOrganization, createProject, seedSuggestedSchemas, resolveOrgScope, resolveProjectScope, checkCountLimit } from "@retainos/database";
import { db } from "./db.ts";
import { startSession, endSession, assertCsrf, requireUser, appContext, switchOrg, switchProject } from "./session.ts";

function field(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
}

export async function signupAction(_prev: unknown, fd: FormData): Promise<{ error?: string }> {
  const email = field(fd, "email");
  const name = field(fd, "name");
  const password = field(fd, "password");
  const orgName = field(fd, "orgName");

  const handle = db();
  const user = createUser(handle, { email, name, password });
  if (!user.ok) return { error: user.error.message };

  const org = createOrganization(handle, { name: orgName || `${name}'s workspace`, ownerId: user.value.id });
  if (!org.ok) return { error: org.error.message };

  await startSession(user.value.id);
  await switchOrg(org.value.orgId);
  redirect("/projects/new");
}

export async function loginAction(_prev: unknown, fd: FormData): Promise<{ error?: string }> {
  const result = authenticate(db(), field(fd, "email"), field(fd, "password"));
  if (!result.ok) return { error: result.error.message };
  await startSession(result.value.id);
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/");
}

export async function createProjectAction(_prev: unknown, fd: FormData): Promise<{ error?: string }> {
  const ctx = await appContext();
  const handle = db();

  const withinPlan = checkCountLimit(handle, ctx.scope, "projects");
  if (!withinPlan.ok) return { error: withinPlan.error.message };

  const created = createProject(handle, ctx.scope, {
    name: field(fd, "name"),
    timezone: field(fd, "timezone") || "UTC",
    currency: field(fd, "currency") || "INR",
  });
  if (!created.ok) return { error: created.error.message };

  // Seed the suggested event registry so the inspector has something to
  // validate against from the first event.
  const scope = resolveProjectScope(handle, ctx.user.id, created.value.projectId);
  if (scope.ok) seedSuggestedSchemas(handle, scope.value);

  await switchProject(ctx.org.id, created.value.projectId);
  redirect("/settings/sdk");
}

export async function switchOrgAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const orgId = field(fd, "orgId");
  // Verify membership before honouring the switch: a forged cookie value must
  // not be able to point the session at someone else's organization.
  const scope = resolveOrgScope(db(), user.id, orgId);
  if (!scope.ok) return;
  await switchOrg(orgId);
  revalidatePath("/", "layout");
}

export async function switchProjectAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const projectId = field(fd, "projectId");
  const scope = resolveProjectScope(db(), user.id, projectId);
  if (!scope.ok) return;
  await switchProject(scope.value.orgId, projectId);
  revalidatePath("/", "layout");
}

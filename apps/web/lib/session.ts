import { cookies, headers } from "next/headers";
import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import {
  signSession, verifySession, csrfToken as makeCsrf, safeEqual, deviceCategory,
  type Role, can, type Permission,
} from "@retainos/shared";
import {
  sessionUser, createSession, revokeSession, resolveOrgScope, resolveProjectScope,
  listOrganizationsForUser, listProjects, type OrgScope, type ProjectScope,
} from "@retainos/database";
import { db } from "./db.ts";

const COOKIE = "retainos_session";
const ORG_COOKIE = "retainos_org";
const SESSION_DAYS = 14;

function secret(): string {
  const value = process.env.RETAINOS_SESSION_SECRET;
  if (!value || value.length < 16) {
    // Failing loudly beats silently signing sessions with a guessable key.
    throw new Error(
      "RETAINOS_SESSION_SECRET is missing or too short. Set it to at least 32 random characters (see .env.example).",
    );
  }
  return value;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** The signed-in user, or null. Never throws for an absent session. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  const payload = verifySession(raw, secret());
  if (!payload) return null;
  // The signature proves the cookie is ours; the database decides whether the
  // session is still live, so a revoked session stops working immediately.
  return sessionUser(db(), raw) ?? null;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function startSession(userId: string): Promise<void> {
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 86_400_000;
  // The cookie value is random, not derived from the user id, and the server
  // stores only its hash.
  const token = signSession(
    { userId: `${userId}:${randomBytes(12).toString("base64url")}`, issuedAt: now, expiresAt },
    secret(),
  );
  const ua = (await headers()).get("user-agent");
  createSession(db(), userId, token, { expiresAt, deviceCategory: deviceCategory(ua) }, now);
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw) revokeSession(db(), raw);
  jar.delete(COOKIE);
  jar.delete(ORG_COOKIE);
}

/** CSRF token bound to this session. Every mutating form carries it. */
export async function csrf(): Promise<string> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value ?? "anonymous";
  return makeCsrf(raw, secret());
}

export async function assertCsrf(submitted: string | null | undefined): Promise<void> {
  const expected = await csrf();
  if (!submitted || !safeEqual(submitted, expected)) {
    throw new Error("This form has expired. Reload the page and try again.");
  }
}

export interface AppContext {
  user: SessionUser;
  org: { id: string; name: string; slug: string; role: Role; isDemo: boolean };
  orgs: Array<{ id: string; name: string; slug: string; role: Role; isDemo: boolean }>;
  scope: OrgScope;
  projects: Array<{ id: string; name: string; slug: string; timezone: string; isDemo: boolean }>;
  project: { id: string; name: string; slug: string; timezone: string; isDemo: boolean } | null;
  projectScope: ProjectScope | null;
}

/**
 * Resolve the full request context: user, organization, project.
 *
 * Every scope here comes from `resolveOrgScope` / `resolveProjectScope`, which
 * verify membership in the database. A project id in a cookie or URL can never
 * widen access on its own.
 */
export async function appContext(projectIdOverride?: string): Promise<AppContext> {
  const user = await requireUser();
  const handle = db();
  const orgs = listOrganizationsForUser(handle, user.id).map((o) => ({
    id: o.id, name: o.name, slug: o.slug, role: o.role as Role, isDemo: o.is_demo === 1,
  }));
  if (orgs.length === 0) redirect("/onboarding");

  const jar = await cookies();
  const preferred = jar.get(ORG_COOKIE)?.value;
  const org = orgs.find((o) => o.id === preferred) ?? orgs[0]!;

  const scopeResult = resolveOrgScope(handle, user.id, org.id);
  if (!scopeResult.ok) redirect("/onboarding");
  const scope = scopeResult.value;

  const projects = listProjects(handle, scope).map((p) => ({
    id: p.id, name: p.name, slug: p.slug, timezone: p.reporting_timezone, isDemo: p.is_demo === 1,
  }));

  const wanted = projectIdOverride ?? jar.get(`retainos_project_${org.id}`)?.value;
  const project = projects.find((p) => p.id === wanted) ?? projects[0] ?? null;

  let projectScope: ProjectScope | null = null;
  if (project) {
    const r = resolveProjectScope(handle, user.id, project.id);
    projectScope = r.ok ? r.value : null;
  }

  return { user, org, orgs, scope, projects, project, projectScope };
}

/** Require a project, redirecting to project creation when none exists. */
export async function requireProject(projectIdOverride?: string) {
  const ctx = await appContext(projectIdOverride);
  if (!ctx.project || !ctx.projectScope) redirect("/projects/new");
  return { ...ctx, project: ctx.project, projectScope: ctx.projectScope };
}

export function requirePermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new Error(`Your role (${role}) cannot perform this action.`);
  }
}

export async function switchOrg(orgId: string): Promise<void> {
  const jar = await cookies();
  jar.set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 86_400 });
}

export async function switchProject(orgId: string, projectId: string): Promise<void> {
  const jar = await cookies();
  jar.set(`retainos_project_${orgId}`, projectId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 86_400 });
}

/**
 * Role model. Every check runs server-side; the client never decides access.
 * Roles are ordered by capability and expressed as explicit permission sets so
 * a new role cannot silently inherit something dangerous.
 */
export const ROLES = ["owner", "admin", "product_manager", "developer", "analyst", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "org:manage",
  "org:delete",
  "member:invite",
  "member:manage",
  "billing:manage",
  "project:create",
  "project:manage",
  "project:delete",
  "key:read",
  "key:rotate",
  "schema:manage",
  "analytics:read",
  "analytics:export",
  "feedback:read",
  "feedback:manage",
  "improvement:read",
  "improvement:manage",
  "improvement:approve",
  "integration:manage",
  "integration:dispatch",
  "experiment:read",
  "experiment:manage",
  "release:manage",
  "onboarding:manage",
  "ai:query",
  "privacy:manage",
  "privacy:erase",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ANALYST: Permission[] = ["analytics:read", "analytics:export", "feedback:read", "improvement:read", "experiment:read", "ai:query"];
const VIEWER: Permission[] = ["analytics:read", "feedback:read", "improvement:read", "experiment:read"];

const DEVELOPER: Permission[] = [
  ...ANALYST,
  "key:read",
  "schema:manage",
  "improvement:manage",
  "release:manage",
  "integration:dispatch",
];

const PRODUCT_MANAGER: Permission[] = [
  ...ANALYST,
  "project:manage",
  "schema:manage",
  "feedback:manage",
  "improvement:manage",
  "improvement:approve",
  "experiment:manage",
  "release:manage",
  "onboarding:manage",
  "integration:dispatch",
];

const ADMIN: Permission[] = [
  ...PRODUCT_MANAGER,
  "org:manage",
  "member:invite",
  "member:manage",
  "project:create",
  "project:delete",
  "key:read",
  "key:rotate",
  "integration:manage",
  "privacy:manage",
  "privacy:erase",
  "audit:read",
];

const OWNER: Permission[] = [...ADMIN, "org:delete", "billing:manage"];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  product_manager: new Set(PRODUCT_MANAGER),
  developer: new Set(DEVELOPER),
  analyst: new Set(ANALYST),
  viewer: new Set(VIEWER),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  product_manager: "Product manager",
  developer: "Developer",
  analyst: "Analyst",
  viewer: "Viewer",
};

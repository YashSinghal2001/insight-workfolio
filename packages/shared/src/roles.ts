export const ROLES = ["ADMIN", "EMPLOYEE"] as const;
export type Role = (typeof ROLES)[number];

/**
 * The finalized role identities. Super Admin (CEO) and Admin (IT) are both the ADMIN permission role:
 * same permissions everywhere, different identity. Only a Super Admin grants or removes the Super
 * Admin identity (docs/roles.md).
 */
export const PLATFORM_ROLES = ["SUPER_ADMIN", "ADMIN", "EMPLOYEE"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = { SUPER_ADMIN: "Super Admin", ADMIN: "Admin", EMPLOYEE: "Employee" };
/** The permission role behind an identity. */
export const roleOf = (p: PlatformRole): Role => (p === "EMPLOYEE" ? "EMPLOYEE" : "ADMIN");
/** The identity of a stored user (an ADMIN without a stored title is an Admin). */
export const platformRoleOf = (role: Role, adminTitle: string | null | undefined): PlatformRole =>
  role === "EMPLOYEE" ? "EMPLOYEE" : adminTitle === "SUPER_ADMIN" ? "SUPER_ADMIN" : "ADMIN";

/**
 * Coarse permission map used by the role-based authorization design (see docs/security.md).
 * Enforcement happens server-side only; clients may use this to hide UI, never to grant access.
 * "-own" permissions are additionally scoped to the caller's own records by the API.
 */
export const PERMISSIONS = {
  "employees:read": ["ADMIN"],
  "leave:request": ["ADMIN", "EMPLOYEE"],
  "leave:review": ["ADMIN"],
  /** Read every employee's leave requests, summary and balances (team heads: their teams, W41). Read only. */
  "leave:read-all": ["ADMIN"],
  /** Leave types and every employee's balances (W36). */
  "leave:manage": ["ADMIN"],
  /** Holiday calendar and import (W38/W39). */
  "holidays:manage": ["ADMIN"],
  /** Teams and their members and heads (W40/W41). */
  "teams:manage": ["ADMIN"],
  "projects:manage": ["ADMIN"],
  "tasks:track": ["ADMIN", "EMPLOYEE"],
  "reports:manage": ["ADMIN"],
  /** Alert rules and the alerts list (F06). */
  "alerts:manage": ["ADMIN"],
  "websites:manage": ["ADMIN"],
  "websites:own": ["ADMIN", "EMPLOYEE"],
  "employees:manage": ["ADMIN"],
  "roles:manage": ["ADMIN"],
  "audit:read": ["ADMIN"],
  /** Own sign-in sessions (list, revoke). Any signed-in account. */
  "sessions:own": ["ADMIN", "EMPLOYEE"],
  "devices:read": ["ADMIN"],
  "devices:manage": ["ADMIN"],
  /** Desktop app releases (docs/desktop/AUTO-UPDATE-ARCHITECTURE.md): view, draft, move to Testing, disable. */
  "updates:manage": ["ADMIN"],
  /** Publish a release to employees, change a published release's rollout, policy or minimum version. Super Admin only. */
  "updates:publish": ["ADMIN"],
  /** The desktop app reports its own update state. */
  "updates:report": ["ADMIN", "EMPLOYEE"],
  "attendance:read-all": ["ADMIN"],
  "attendance:review": ["ADMIN"],
  "corrections:request": ["ADMIN", "EMPLOYEE"],
  "activity:record": ["ADMIN", "EMPLOYEE"],
  "activity:read-own": ["ADMIN", "EMPLOYEE"],
  "activity:read-all": ["ADMIN"],
  "profile:read-own": ["ADMIN", "EMPLOYEE"],
  "screenshots:read": ["ADMIN"],
  /**
   * Destructive deletion of monitoring data: delete one screenshot or a timelapse, run a retention purge
   * (screenshots, activity, website usage), or change a retention period / its approval (which makes the
   * scheduled purge delete). Super Admin only (SUPER_ADMIN_ONLY).
   */
  "screenshots:delete": ["ADMIN"],
  /** Connect or disconnect the organisation's storage account. Super Admin only (SUPER_ADMIN_ONLY). */
  "storage:manage": ["ADMIN"],
  "settings:manage": ["ADMIN"],
  "timesheet:read-own": ["ADMIN", "EMPLOYEE"],
  "timesheet:clock": ["ADMIN", "EMPLOYEE"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/**
 * W41: what the head of an active team additionally holds, only for the members of the teams they head
 * and only on routes marked team-scoped (@TeamScoped in the API). Reads outside their teams are 404.
 */
export const TEAM_HEAD_PERMISSIONS = ["employees:read", "screenshots:read", "attendance:read-all", "activity:read-all", "leave:read-all"] as const satisfies readonly Permission[];
export type TeamHeadPermission = (typeof TEAM_HEAD_PERMISSIONS)[number];
export const isTeamHeadPermission = (p: Permission): p is TeamHeadPermission => (TEAM_HEAD_PERMISSIONS as readonly Permission[]).includes(p);

/** Role-level check only. For "may this user do X" use `can`, which also applies SUPER_ADMIN_ONLY. */
export function hasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/**
 * Permissions an Admin (IT) does not get: only the Super Admin identity holds them. Everything else is
 * shared by both admin identities (docs/roles.md).
 */
export const SUPER_ADMIN_ONLY = ["screenshots:delete", "storage:manage", "roles:manage", "updates:publish"] as const satisfies readonly Permission[];

/**
 * Whether this user may do `permission`: the role check plus the Super Admin-only list. The API guard
 * enforces exactly this; clients may use it to hide UI, never to grant access. Team-head scoped reads
 * (W41) are decided separately by the API.
 */
export function can(user: { role: Role; platformRole: PlatformRole }, permission: Permission): boolean {
  return hasPermission(user.role, permission) && (user.platformRole === "SUPER_ADMIN" || !(SUPER_ADMIN_ONLY as readonly Permission[]).includes(permission));
}

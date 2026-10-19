export const ROLES = ["ADMIN", "EMPLOYEE"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Coarse permission map used by the role-based authorization design (see docs/security.md).
 * Enforcement happens server-side only; clients may use this to hide UI, never to grant access.
 * "-own" permissions are additionally scoped to the caller's own records by the API.
 */
export const PERMISSIONS = {
  "employees:read": ["ADMIN"],
  "employees:manage": ["ADMIN"],
  "devices:read": ["ADMIN"],
  "devices:manage": ["ADMIN"],
  "attendance:read-all": ["ADMIN"],
  "attendance:review": ["ADMIN"],
  "corrections:request": ["ADMIN", "EMPLOYEE"],
  "activity:record": ["ADMIN", "EMPLOYEE"],
  "activity:read-own": ["ADMIN", "EMPLOYEE"],
  "activity:read-all": ["ADMIN"],
  "profile:read-own": ["ADMIN", "EMPLOYEE"],
  "screenshots:read": ["ADMIN"],
  "settings:manage": ["ADMIN"],
  "timesheet:read-own": ["ADMIN", "EMPLOYEE"],
  "timesheet:clock": ["ADMIN", "EMPLOYEE"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

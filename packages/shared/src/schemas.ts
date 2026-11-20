import { z } from "zod";
import { isVersion } from "./desktop-updates.js";
import { PLATFORM_ROLES, ROLES, type PlatformRole } from "./roles.js";

export const roleSchema = z.enum(ROLES);

export const ACCOUNT_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const EMPLOYMENT_STATUSES = ["ACTIVE", "ON_LEAVE", "TERMINATED"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** NIST SP 800-63B style: length over composition rules. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`)
  .refine((p) => p.trim().length >= PASSWORD_MIN, "Password must not be mostly whitespace");

/**
 * The one time-zone rule (employee profiles, report schedules, gallery and audit views): an IANA
 * zone the runtime's Intl accepts, in Area/Location form or "UTC". Legacy abbreviations and bare
 * aliases ("EST", "GMT", "PST8PDT") are rejected.
 */
export const timeZoneSchema = z.string().trim().max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz.includes("/") || tz === "UTC";
  } catch {
    return false;
  }
}, "Must be an IANA time zone, e.g. Asia/Kolkata");

export const employeeCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, "2–32 letters, digits or dashes");

export const fullNameSchema = z.string().trim().min(1).max(120);

// ---- Auth -----------------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  // Policy is not re-checked at login: it would leak which rule failed and block legacy passwords.
  password: z.string().min(1).max(PASSWORD_MAX),
  client: z.enum(["web", "desktop"]).default("web"),
  /**
   * Desktop only: the app's installation id. A registered installation becomes the account's active device
   * in the same step, or the sign-in is refused with 409 ACTIVE_ON_ANOTHER_DEVICE (one active device).
   */
  installationId: z.uuid().optional(),
  /** Explicit, password-confirmed switch: ends the session on the other device and signs in here. */
  takeover: z.boolean().optional(),
});
export type LoginInput = z.input<typeof loginSchema>;

/** Desktop sends its refresh token in the body; the web client uses the HttpOnly cookie. */
export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(512).optional() }).default({});

export const setupPasswordSchema = z.object({
  token: z.string().min(1).max(512),
  password: passwordSchema,
});

// ---- Employees ------------------------------------------------------------

export const createEmployeeSchema = z.strictObject({
  email: emailSchema,
  fullName: fullNameSchema,
  employeeCode: employeeCodeSchema,
  timezone: timeZoneSchema.default(DEFAULT_TIMEZONE),
});
export type CreateEmployeeInput = z.input<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z
  .object({
    email: emailSchema,
    fullName: fullNameSchema,
    employeeCode: employeeCodeSchema,
    timezone: timeZoneSchema,
    employmentStatus: z.enum(EMPLOYMENT_STATUSES),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");
export type UpdateEmployeeInput = z.input<typeof updateEmployeeSchema>;

export const updateAccountStatusSchema = z.strictObject({ status: z.enum(ACCOUNT_STATUSES) });

export const listEmployeesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** Active members of this team (404 when the caller may not read it). */
  teamId: z.uuid().optional(),
  /** Identity: Super Admin, Admin or Employee. */
  role: z.enum(PLATFORM_ROLES).optional(),
  /** Has a non-revoked device on this platform. */
  platform: z.enum(["macos", "windows"]).optional(),
  /** A non-revoked device last reported this installed desktop version. */
  appVersion: z.string().trim().refine(isVersion, "Use MAJOR.MINOR.PATCH, for example 0.3.0").optional(),
});
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;

/** Change a user's identity (Super Admin, Admin, Employee); the reason is kept in the role history. */
export const changeRoleSchema = z.strictObject({ platformRole: z.enum(PLATFORM_ROLES), reason: z.string().trim().min(3).max(500) });

export interface RoleUser {
  id: string;
  email: string;
  platformRole: PlatformRole;
  status: AccountStatus;
  employee: { id: string; fullName: string; employeeCode: string } | null;
}

export interface RoleChange {
  target: { id: string; email: string };
  by: { id: string; email: string };
  from: PlatformRole;
  to: PlatformRole;
  reason: string;
  at: string;
}

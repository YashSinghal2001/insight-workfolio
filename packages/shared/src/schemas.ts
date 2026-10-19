import { z } from "zod";
import { ROLES } from "./roles.js";

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

export const timezoneSchema = z.string().trim().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz.includes("/") || tz === "UTC";
  } catch {
    return false;
  }
}, "Must be an IANA timezone, e.g. Asia/Kolkata");

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
});
export type LoginInput = z.input<typeof loginSchema>;

/** Desktop sends its refresh token in the body; the web client uses the HttpOnly cookie. */
export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(512).optional() }).default({});

export const setupPasswordSchema = z.object({
  token: z.string().min(1).max(512),
  password: passwordSchema,
});

// ---- Employees ------------------------------------------------------------

export const createEmployeeSchema = z.object({
  email: emailSchema,
  fullName: fullNameSchema,
  employeeCode: employeeCodeSchema,
  timezone: timezoneSchema.default(DEFAULT_TIMEZONE),
});
export type CreateEmployeeInput = z.input<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z
  .object({
    email: emailSchema,
    fullName: fullNameSchema,
    employeeCode: employeeCodeSchema,
    timezone: timezoneSchema,
    employmentStatus: z.enum(EMPLOYMENT_STATUSES),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");
export type UpdateEmployeeInput = z.input<typeof updateEmployeeSchema>;

export const updateAccountStatusSchema = z.object({ status: z.enum(ACCOUNT_STATUSES) });

export const listEmployeesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;

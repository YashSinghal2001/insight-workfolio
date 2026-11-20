import { z } from "zod";
import { ACTIVITY_RANGE_MAX_DAYS, type ApplicationCategory } from "./activity.js";
import type { EmployeeRef } from "./api.js";

/**
 * App-usage analytics for a group (W3-APPS): GET /activity/apps and /activity/apps/history. Application names
 * and identifiers only (never window titles); each range in each employee's own time zone; labels applied at
 * read time with each employee's team labels.
 */
const DAY_MS = 86_400_000;
const range = z.object({ from: z.iso.date(), to: z.iso.date(), teamId: z.uuid().optional() });
const inRange = (r: { from: string; to: string }) => Date.parse(r.to) - Date.parse(r.from) <= (ACTIVITY_RANGE_MAX_DAYS - 1) * DAY_MS;

export const activityAppsQuerySchema = range
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine(inRange, `Range is limited to ${ACTIVITY_RANGE_MAX_DAYS} days`);
export type ActivityAppsQuery = z.infer<typeof activityAppsQuerySchema>;

/** `app`: the application key from ActivityAppsResponse (identifier, or `name:` + the name). */
export const activityAppHistoryQuerySchema = range
  .extend({ app: z.string().trim().min(1).max(300) })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine(inRange, `Range is limited to ${ACTIVITY_RANGE_MAX_DAYS} days`);
export type ActivityAppHistoryQuery = z.infer<typeof activityAppHistoryQuerySchema>;

export type CategoryTotals = Record<ApplicationCategory, number>;

export interface ActivityAppUsage {
  key: string;
  applicationIdentifier: string | null;
  applicationName: string;
  activeMs: number;
  /** The label covering most of this app's time (team labels may differ between employees). */
  category: ApplicationCategory;
  employees: number;
}

export interface ActivityAppsEmployeeRow {
  employee: EmployeeRef;
  activeMs: number;
  idleMs: number;
  /** Active time per label. */
  categories: CategoryTotals;
  topApplication: string | null;
}

export interface ActivityAppsResponse {
  from: string;
  to: string;
  teamId: string | null;
  categoriesConfigured: boolean;
  /** Active time per label over everyone. */
  categories: CategoryTotals;
  /** Largest first. */
  applications: ActivityAppUsage[];
  /** Every employee in scope (active), by name. */
  employees: ActivityAppsEmployeeRow[];
}

export interface ActivityAppHistoryResponse {
  from: string;
  to: string;
  teamId: string | null;
  key: string;
  applicationName: string | null;
  /** Every local date in the range, summed over employees. */
  days: { date: string; activeMs: number }[];
  /** Employees who used the app, most usage first; only the days with usage. */
  employees: { employee: EmployeeRef; activeMs: number; days: { date: string; activeMs: number }[] }[];
}

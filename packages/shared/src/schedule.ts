import { z } from "zod";
import type { EmployeeRef, Paginated } from "./api.js";
import type { LeavePortion } from "./leave.js";
import { SETTINGS_LIMITS } from "./activity.js";
import { zonedToUtc } from "./timesheet.js";

// ---- Work schedule policy (W17/W18) -------------------------------------------------------
// Organisation-wide, with optional per-employee start/workday overrides (employeeTrackingOverrideSchema).
// Append-only history; no row = disabled, and a disabled policy never labels anyone late or absent.
// Holidays (W38) are never ABSENT.

export interface WorkScheduleSettings {
  enabled: boolean;
  /** Local wall-clock start in each employee's own profile time zone, "HH:MM". */
  expectedStart: string;
  /** Minutes after expectedStart before a clock-in counts as late (and absence becomes due). */
  graceMinutes: number;
  /** ISO weekday digits, ascending, each once: 1 = Monday … 7 = Sunday (e.g. "12345"). */
  workdays: string;
}

/** Shown before the first change. Proposed values pending business approval; disabled. */
export const DEFAULT_WORK_SCHEDULE: WorkScheduleSettings = { enabled: false, expectedStart: "09:00", graceMinutes: 15, workdays: "12345" };

export interface WorkSchedulePolicy extends WorkScheduleSettings {
  /** null = never set (defaults shown, disabled). */
  seq: number | null;
  changedBy: { id: string; email: string } | null;
  reason: string | null;
  effectiveAt: string | null;
}

export interface WorkScheduleResponse {
  current: WorkSchedulePolicy;
  history: WorkSchedulePolicy[];
}

const expectedStartSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const workdaysSchema = z
  .string()
  .regex(/^[1-7]{1,7}$/, "Use ISO weekday digits 1 (Monday) to 7 (Sunday)")
  .refine((v) => new Set(v).size === v.length, "Each weekday at most once")
  .transform((v) => [...v].sort().join(""));

export const workScheduleSchema = z.strictObject({
  enabled: z.boolean(),
  expectedStart: expectedStartSchema,
  graceMinutes: z.number().int().min(0).max(240),
  workdays: workdaysSchema,
  reason: z.string().trim().min(3).max(500),
});
export type WorkScheduleInput = z.infer<typeof workScheduleSchema>;

// ---- Daily attendance status -----------------------------------------------------------------

export const DAILY_ATTENDANCE_STATUSES = ["NO_POLICY", "NOT_SCHEDULED", "HOLIDAY", "ON_LEAVE", "PRESENT", "LATE", "ABSENT", "NOT_YET_DUE"] as const;
export type DailyAttendanceStatus = (typeof DAILY_ATTENDANCE_STATUSES)[number];

export const dailyAttendanceQuerySchema = z.object({
  date: z.iso.date(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type DailyAttendanceQuery = z.infer<typeof dailyAttendanceQuerySchema>;

export interface DailyAttendanceRow {
  employee: EmployeeRef;
  /** The requested date, read as a local date in the employee's own time zone. */
  date: string;
  /** Whether the policy in force that day makes it a workday; null when no enabled policy applied. */
  scheduled: boolean | null;
  /** expectedStart + grace on that local date, as a UTC instant; null when not scheduled. */
  dueAt: string | null;
  /** Earliest clock-in that started on that local date (UTC), and the same instant in the employee's zone ("YYYY-MM-DDTHH:mm"). */
  firstClockInAt: string | null;
  firstClockInLocal: string | null;
  /** Minutes after expectedStart (not after the grace period), only when LATE. */
  lateMinutes: number | null;
  /** An approved leave request covering the date (any portion). */
  leave: { id: string; portion: LeavePortion; startTime: string | null; endTime: string | null } | null;
  /** The organisation holiday on that local date. */
  holiday: { name: string } | null;
  status: DailyAttendanceStatus;
}

export interface DailyAttendanceResponse extends Paginated<DailyAttendanceRow> {
  date: string;
  /** Counts over every matching employee (all pages). */
  summary: Record<DailyAttendanceStatus, number>;
  meta: {
    /** Whether any holiday exists; a holiday is HOLIDAY, never ABSENT. */
    holidaysConfigured: boolean;
    /** Per-employee start / workday overrides apply (the override in force at the start of the local day). */
    perPersonOverrides: true;
    /** The policy version in force at the start of each employee's local day applies to that day. */
    policyRule: string;
  };
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
export const isoWeekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

/**
 * Status of one employee on one local date. Precedence: holiday → HOLIDAY; no enabled policy →
 * NO_POLICY (unless on leave); not a workday → NOT_SCHEDULED; approved leave → ON_LEAVE; a clock-in that day → PRESENT or
 * LATE; otherwise ABSENT once expectedStart + grace has passed, else NOT_YET_DUE.
 */
export function dailyAttendanceStatus(input: {
  date: string;
  timeZone: string;
  policy: WorkScheduleSettings | null;
  firstClockInAt: string | null;
  onLeave: boolean;
  holiday?: boolean;
  now: number;
}): Pick<DailyAttendanceRow, "status" | "scheduled" | "dueAt" | "lateMinutes"> {
  if (input.holiday) return { status: "HOLIDAY", scheduled: false, dueAt: null, lateMinutes: null };
  const p = input.policy?.enabled ? input.policy : null;
  if (!p) return { status: input.onLeave ? "ON_LEAVE" : "NO_POLICY", scheduled: null, dueAt: null, lateMinutes: null };
  if (!p.workdays.includes(String(isoWeekday(input.date)))) return { status: "NOT_SCHEDULED", scheduled: false, dueAt: null, lateMinutes: null };
  const start = Date.parse(zonedToUtc(`${input.date}T${p.expectedStart}`, input.timeZone));
  const due = start + p.graceMinutes * 60_000;
  const base = { scheduled: true, dueAt: new Date(due).toISOString() };
  if (input.onLeave) return { ...base, status: "ON_LEAVE", lateMinutes: null };
  if (input.firstClockInAt) {
    const at = Date.parse(input.firstClockInAt);
    return at > due ? { ...base, status: "LATE", lateMinutes: Math.floor((at - start) / 60_000) } : { ...base, status: "PRESENT", lateMinutes: null };
  }
  return { ...base, status: input.now > due ? "ABSENT" : "NOT_YET_DUE", lateMinutes: null };
}

// ---- Per-employee overrides (W17 start/workdays, W21 idle threshold) --------------------------
// Append-only history per employee; each version is the full override set. null = inherit the
// organisation value. Grace minutes and the on/off switch always come from the organisation schedule.

export interface EmployeeTrackingOverride {
  expectedStart: string | null;
  workdays: string | null;
  idleThresholdSeconds: number | null;
  /** F08: may this employee view their own screenshots? null = the organisation switch. */
  screenshotSelfView: boolean | null;
}

export const employeeTrackingOverrideSchema = z.strictObject({
  expectedStart: expectedStartSchema.nullable(),
  workdays: workdaysSchema.nullable(),
  idleThresholdSeconds: z.number().int().min(SETTINGS_LIMITS.idleThresholdSeconds.min).max(SETTINGS_LIMITS.idleThresholdSeconds.max).nullable(),
  /** Omitted (older clients): the current value carries over. */
  screenshotSelfView: z.boolean().nullable().optional(),
  reason: z.string().trim().min(3).max(500),
});
export type EmployeeTrackingOverrideInput = z.infer<typeof employeeTrackingOverrideSchema>;

export interface EmployeeTrackingOverridesResponse {
  employeeId: string;
  /** The override in force now (all null = none). */
  override: EmployeeTrackingOverride;
  organisation: { schedule: WorkScheduleSettings; idleThresholdSeconds: number; sampleSeconds: number; screenshotSelfView: boolean };
  /** What applies to this employee: new days' schedule, the idle threshold the desktop receives, own-screenshot access. */
  effective: { schedule: WorkScheduleSettings; idleThresholdSeconds: number; screenshotSelfView: boolean };
  /** Newest first. */
  history: (EmployeeTrackingOverride & { reason: string; changedBy: { id: string; email: string }; effectiveAt: string })[];
}

/** The organisation schedule with an employee's start/workday override applied (null fields inherit). */
export const withScheduleOverride = <T extends WorkScheduleSettings>(policy: T, o: Pick<EmployeeTrackingOverride, "expectedStart" | "workdays"> | null | undefined): T => ({
  ...policy,
  expectedStart: o?.expectedStart ?? policy.expectedStart,
  workdays: o?.workdays ?? policy.workdays,
});

/** Idle threshold for an employee: their override, never below two sampling intervals (as the organisation setting). */
export const effectiveIdleThreshold = (org: { idleThresholdSeconds: number; sampleSeconds: number }, override: number | null | undefined) =>
  override == null ? org.idleThresholdSeconds : Math.max(override, 2 * org.sampleSeconds);

// ---- Expected work window (W24) ---------------------------------------------------------------

/** One scheduled local day: when work is expected to start, and when a clock-in becomes late. */
export interface ExpectedWorkDay {
  date: string;
  /** expectedStart on that local date (UTC instant). */
  startAt: string;
  /** startAt + grace (UTC instant). */
  dueAt: string;
}

/**
 * GET /attendance/expected?from&to[&employeeId]: the effective schedule (per-person override, else the
 * organisation) for each local date in the range. Only scheduled days are listed: no enabled schedule,
 * non-workdays and holidays have no window. The schedule defines a start only, never an end.
 */
export interface ExpectedScheduleResponse {
  employeeId: string;
  timezone: string;
  days: ExpectedWorkDay[];
}

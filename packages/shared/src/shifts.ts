import { z } from "zod";
export { DEFAULT_SHIFT_GRACE_MINUTES, SHIFT_GRACE_MAX_MINUTES, shiftInputSchema, type ShiftInput } from "./schemas.js";
import type { EmployeeRef, Paginated } from "./api.js";
import { isoWeekday } from "./schedule.js";
import { addDays, localDate, toZonedLocal, zonedToUtc } from "./timesheet.js";

/**
 * Employee shifts and automatic clock-out (docs/EMPLOYEE-SHIFT-MANAGEMENT.md). A shift is a daily
 * start/end wall-clock time in its own IANA zone; end < start is an overnight shift. An employee without
 * a shift keeps the old behaviour (nothing is ever clocked out automatically).
 */
export interface ShiftSettings {
  startTime: string;
  endTime: string;
  timezone: string;
  graceMinutes: number;
  autoClockOut: boolean;
  /** ISO weekday digits the shift starts on (1 = Monday … 7 = Sunday), e.g. "12345". */
  workdays: string;
  /** When the settings last changed (UTC). Automatic clock-out never lands before it. */
  updatedAt: string;
}

export interface EmployeeShift extends ShiftSettings {
  employeeId: string;
  overnight: boolean;
  updatedBy: { id: string; email: string } | null;
}

export const isOvernight = (s: Pick<ShiftSettings, "startTime" | "endTime">) => s.endTime < s.startTime;

/**
 * Wall-clock time to UTC. A time skipped by a DST jump resolves forward (02:30 on a spring-forward night is
 * 03:30 new time); a repeated time resolves to its first occurrence. (zonedToUtc resolves gaps backward.)
 */
export function wallToUtc(local: string, timeZone: string): number {
  const t = Date.parse(zonedToUtc(local, timeZone));
  const reads = Date.parse(`${toZonedLocal(t, timeZone)}:00Z`);
  const wanted = Date.parse(`${local}:00Z`);
  return reads < wanted ? t + (wanted - reads) : t;
}

export interface ShiftOccurrence {
  /** Local date (shift zone) the occurrence starts on. */
  date: string;
  /** Whether that date is one of the shift's working days. */
  workday: boolean;
  startAt: string;
  /** Scheduled shift end. */
  endAt: string;
  /** Scheduled end + grace: the automatic clock-out deadline. */
  deadlineAt: string;
}

/** The occurrence starting on local date `date` (an overnight shift ends the next day). */
type ShiftTimes = Pick<ShiftSettings, "startTime" | "endTime" | "timezone" | "graceMinutes" | "workdays">;

function occurrenceOn(s: ShiftTimes, date: string): ShiftOccurrence {
  const start = wallToUtc(`${date}T${s.startTime}`, s.timezone);
  const end = wallToUtc(`${isOvernight(s) ? addDays(date, 1) : date}T${s.endTime}`, s.timezone);
  return { date, workday: s.workdays.includes(String(isoWeekday(date))), startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), deadlineAt: new Date(end + s.graceMinutes * 60_000).toISOString() };
}

/**
 * The occurrence that work at `atMs` belongs to: the first one whose scheduled end is after it. So clocking
 * in after a shift has ended (even inside its grace period) counts toward the NEXT shift, and is never
 * clocked out moments later.
 */
export function shiftOccurrence(s: ShiftTimes, atMs: number): ShiftOccurrence {
  const today = localDate(atMs, s.timezone);
  for (const d of [-1, 0, 1]) {
    const o = occurrenceOn(s, addDays(today, d));
    if (Date.parse(o.endAt) > atMs) return o;
  }
  return occurrenceOn(s, addDays(today, 2)); // unreachable for valid shifts; kept total
}

/** The next occurrence on a working day whose scheduled end is after `atMs` (null: no working days). */
export function nextWorkingOccurrence(s: ShiftTimes, atMs: number): ShiftOccurrence | null {
  let o = shiftOccurrence(s, atMs);
  for (let i = 0; i < 8 && !o.workday; i++) o = occurrenceOn(s, addDays(o.date, 1));
  return o.workday ? o : null;
}

export interface AutoClockOutPlan {
  occurrence: ShiftOccurrence;
  /**
   * The attendance clock-out time: the deadline, but never before the last recorded change of the session
   * (break start/end) nor before the shift settings were last changed, so an edit never clocks anyone out
   * in the past.
   */
  clockOutAt: string;
}

/**
 * When an open session is clocked out automatically; null when automatic clock-out is off or the session
 * belongs to a shift on a non-working day (work on a day off is never clocked out automatically).
 */
export function autoClockOutPlan(s: ShiftSettings, session: { clockInAt: string; lastChangeAt: string }): AutoClockOutPlan | null {
  if (!s.autoClockOut) return null;
  const occurrence = shiftOccurrence(s, Date.parse(session.clockInAt));
  if (!occurrence.workday) return null;
  const clockOutAt = [occurrence.deadlineAt, s.updatedAt, session.lastChangeAt].sort().at(-1)!;
  return { occurrence, clockOutAt };
}

export const CLOCK_OUT_REASONS = ["MANUAL", "AUTOMATIC_SHIFT_END"] as const;
export type ClockOutReason = (typeof CLOCK_OUT_REASONS)[number];

export const SHIFT_STATUSES = [
  "NO_SHIFT",
  "NOT_CLOCKED_IN",
  "WITHIN_SHIFT",
  "GRACE_PERIOD",
  /** Past the deadline, still open: the worker clocks it out within a minute (or on start after downtime). */
  "AUTO_CLOCK_OUT_PENDING",
  /** Past the scheduled end with automatic clock-out off. */
  "BEYOND_SHIFT",
  /** Clocked in on a non-working day of the shift: no automatic clock-out. */
  "OFF_DAY",
  "AUTO_CLOCKED_OUT",
  "MANUAL_CLOCK_OUT",
] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];
export const BEYOND_SHIFT_STATUSES: readonly ShiftStatus[] = ["GRACE_PERIOD", "AUTO_CLOCK_OUT_PENDING", "BEYOND_SHIFT"];

export function shiftStatus(input: {
  shift: ShiftSettings | null;
  open: { clockInAt: string; lastChangeAt: string } | null;
  lastClockOutReason: ClockOutReason | null;
  now: number;
}): { status: ShiftStatus; occurrence: ShiftOccurrence | null; nextAutoClockOutAt: string | null } {
  const { shift, open, now } = input;
  if (!shift) return { status: "NO_SHIFT", occurrence: null, nextAutoClockOutAt: null };
  if (!open) {
    const next = nextWorkingOccurrence(shift, now);
    return {
      status: input.lastClockOutReason === "AUTOMATIC_SHIFT_END" ? "AUTO_CLOCKED_OUT" : input.lastClockOutReason === "MANUAL" ? "MANUAL_CLOCK_OUT" : "NOT_CLOCKED_IN",
      occurrence: next,
      nextAutoClockOutAt: shift.autoClockOut && next ? next.deadlineAt : null,
    };
  }
  const plan = autoClockOutPlan(shift, open);
  const occurrence = plan?.occurrence ?? shiftOccurrence(shift, Date.parse(open.clockInAt));
  if (!occurrence.workday) return { status: "OFF_DAY", occurrence, nextAutoClockOutAt: null };
  const ended = now >= Date.parse(occurrence.endAt);
  const status: ShiftStatus = !ended ? "WITHIN_SHIFT" : !plan ? "BEYOND_SHIFT" : now >= Date.parse(plan.clockOutAt) ? "AUTO_CLOCK_OUT_PENDING" : "GRACE_PERIOD";
  return { status, occurrence, nextAutoClockOutAt: plan?.clockOutAt ?? null };
}

export const shiftListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  teamId: z.uuid().optional(),
  /** Only people past their scheduled shift end and still clocked in. */
  beyondShift: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  status: z.enum(SHIFT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ShiftListQuery = z.infer<typeof shiftListQuerySchema>;

export interface AutoClockOutRecord {
  attendanceSessionId: string;
  scheduledShiftEndAt: string;
  deadlineAt: string;
  clockOutAt: string;
  processedAt: string;
  reason: "AUTOMATIC_SHIFT_END";
  breakEnded: boolean;
}

/** An org-wide automatic clock-out history row (admin view). */
export interface AutoClockOutHistoryRow extends AutoClockOutRecord {
  employee: EmployeeRef;
  shiftStartTime: string;
  shiftEndTime: string;
  shiftTimezone: string;
  graceMinutes: number;
}

export const autoClockOutHistoryQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  employeeId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type AutoClockOutHistoryQuery = z.infer<typeof autoClockOutHistoryQuerySchema>;

/** A failed automatic clock-out attempt (retried on the next run); kept for operational visibility. */
export interface AutoClockOutFailure {
  employee: EmployeeRef;
  attendanceSessionId: string;
  error: string;
  failedAt: string;
}

export interface ShiftRow {
  employee: EmployeeRef;
  shift: EmployeeShift | null;
  status: ShiftStatus;
  /** The open session's automatic clock-out time, or the next shift's deadline; null when off or no shift. */
  nextAutoClockOutAt: string | null;
  /** The shift occurrence shown: the open session's, else the next one. */
  occurrence: ShiftOccurrence | null;
  clockedInAt: string | null;
  lastAutoClockOut: AutoClockOutRecord | null;
}

export interface ShiftListResponse extends Paginated<ShiftRow> {
  summary: Record<ShiftStatus, number>;
  /** Automatic clock-out attempts that failed in the last 24 h (newest first, at most 20). */
  recentFailures: AutoClockOutFailure[];
}

export interface EmployeeShiftResponse {
  shift: EmployeeShift | null;
  /** Automatic clock-outs of this employee, newest first (at most 20). */
  history: AutoClockOutRecord[];
}

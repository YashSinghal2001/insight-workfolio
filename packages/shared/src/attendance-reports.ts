// Monthly attendance, late arrivals and the monthly export (W1-ATT-DATA). Derived on request from the same
// rules as GET /attendance/daily (status) and GET /attendance/timesheet (minutes, overtime); nothing is stored.
import { z } from "zod";
import type { EmployeeRef, Paginated } from "./api.js";
import { EXPORT_FORMATS, type Cell } from "./export.js";
import { dailyAttendanceStatus, type DailyAttendanceStatus, type WorkScheduleSettings } from "./schedule.js";
import { addDays, buildTimesheet, dateRangeSchema, localTime, type AttendancePolicy, type TimesheetSessionInput } from "./timesheet.js";

// ---- Queries ----------------------------------------------------------------------

const teamId = z.uuid().optional();
const page = z.coerce.number().int().min(1).max(10_000).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(50);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

/** Optional `?teamId=` (docs/IMPLEMENTATION-CONTRACTS.md §4): active members of that team, within the caller's scope. */
export const teamFilterSchema = z.object({ teamId });

export const monthlyAttendanceQuerySchema = z.object({ month, teamId, q: z.string().trim().max(100).optional(), page, pageSize });
export type MonthlyAttendanceQuery = z.infer<typeof monthlyAttendanceQuerySchema>;

export const monthlyExportQuerySchema = z.object({ month, teamId, format: z.enum(EXPORT_FORMATS).default("csv") });
export type MonthlyExportQuery = z.infer<typeof monthlyExportQuerySchema>;

export const lateArrivalsQuerySchema = dateRangeSchema.and(z.object({ teamId, page, pageSize }));
export type LateArrivalsQuery = z.infer<typeof lateArrivalsQuerySchema>;

// ---- Responses [contract §5] ------------------------------------------------------------

export interface MonthlyAttendanceDay {
  date: string;
  /** As /attendance/daily; OPEN when a shift that started that day is still open (totals keep the underlying status). */
  status: DailyAttendanceStatus | "OPEN";
  /** Local HH:MM: earliest clock-in of the day; latest completed clock-out of that day's shifts (may be after midnight). */
  firstInLocal: string | null;
  lastOutLocal: string | null;
  /** Completed shifts only, floored to the minute: the timesheet's values. */
  workedMinutes: number;
  breakMinutes: number;
  overtimeMinutes: number;
  /** Minutes after the expected start, only when the clock-in was late. */
  lateMinutes: number | null;
  /** Local HH:MM after which a clock-in is late (expected start + grace); null when not scheduled. */
  dueLocal: string | null;
}

export interface MonthlyAttendanceTotals {
  /** Days with at least one clock-in. */
  workedDays: number;
  /** PRESENT or LATE (scheduled days attended). */
  presentDays: number;
  lateDays: number;
  absentDays: number;
  leaveDays: number;
  holidayDays: number;
  /** Timesheet totals for the range, floored to the minute. */
  workedMinutes: number;
  overtimeMinutes: number;
}

export interface MonthlyAttendanceRow {
  employee: EmployeeRef;
  days: MonthlyAttendanceDay[];
  totals: MonthlyAttendanceTotals;
}

export interface MonthlyAttendanceResponse extends Paginated<MonthlyAttendanceRow> {
  month: string;
}

export interface LateArrival {
  employee: EmployeeRef;
  date: string;
  dueLocal: string;
  firstClockInLocal: string;
  lateMinutes: number;
}

export interface LateArrivalsResponse extends Paginated<LateArrival> {
  from: string;
  to: string;
}

// ---- Aggregation ----------------------------------------------------------------------

/** First and last local date of a YYYY-MM month. */
export function monthRange(m: string): { from: string; to: string } {
  const from = `${m}-01`;
  return { from, to: addDays(`${addDays(from, 31).slice(0, 7)}-01`, -1) };
}

/** expectedStart + grace on the wall clock (what the schedule says; a DST gap moves the real instant, not this label). */
const dueLabel = (p: WorkScheduleSettings) => {
  const m = (Number(p.expectedStart.slice(0, 2)) * 60 + Number(p.expectedStart.slice(3)) + p.graceMinutes) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const minutes = (ms: number) => Math.floor(ms / 60_000);

/**
 * One employee's local days [from, to]: status by dailyAttendanceStatus (the schedule in force that day),
 * minutes by buildTimesheet. Days before `employedFrom` (local date the profile was created) are NOT_SCHEDULED.
 */
export function attendanceRow(input: {
  employee: EmployeeRef;
  from: string;
  to: string;
  /** The employee's sessions; only those clocked in on a local date in the range count. */
  sessions: TimesheetSessionInput[];
  scheduleFor: (date: string) => WorkScheduleSettings | null;
  onLeave: (date: string) => boolean;
  holiday: (date: string) => boolean;
  employedFrom?: string;
  policy?: AttendancePolicy;
  now: number;
}): MonthlyAttendanceRow {
  const tz = input.employee.timezone;
  const sheet = buildTimesheet(input.sessions, { from: input.from, to: input.to, timeZone: tz, policy: input.policy, now: input.now });
  const byDate = new Map(sheet.days.map((d) => [d.date, d]));
  const count: Partial<Record<DailyAttendanceStatus, number>> = {};
  const days: MonthlyAttendanceDay[] = [];
  for (let date = input.from; date <= input.to; date = addDays(date, 1)) {
    const t = byDate.get(date);
    const policy = input.employedFrom && date < input.employedFrom ? undefined : input.scheduleFor(date);
    const s =
      policy === undefined
        ? { status: "NOT_SCHEDULED" as const, dueAt: null, lateMinutes: null }
        : dailyAttendanceStatus({ date, timeZone: tz, policy, firstClockInAt: t?.firstClockIn ?? null, onLeave: input.onLeave(date), holiday: input.holiday(date), now: input.now });
    count[s.status] = (count[s.status] ?? 0) + 1;
    days.push({
      date,
      status: t?.incomplete ? "OPEN" : s.status,
      firstInLocal: t ? localTime(t.firstClockIn, tz) : null,
      lastOutLocal: t?.lastClockOut ? localTime(t.lastClockOut, tz) : null,
      workedMinutes: minutes(t?.netMs ?? 0),
      breakMinutes: minutes(t?.breakMs ?? 0),
      overtimeMinutes: minutes(t?.overtimeMs ?? 0),
      lateMinutes: s.lateMinutes,
      dueLocal: s.dueAt && policy ? dueLabel(policy) : null,
    });
  }
  const n = (s: DailyAttendanceStatus) => count[s] ?? 0;
  return {
    employee: input.employee,
    days,
    totals: {
      workedDays: sheet.days.length,
      presentDays: n("PRESENT") + n("LATE"),
      lateDays: n("LATE"),
      absentDays: n("ABSENT"),
      leaveDays: n("ON_LEAVE"),
      holidayDays: n("HOLIDAY"),
      workedMinutes: minutes(sheet.totals.netMs),
      overtimeMinutes: minutes(sheet.totals.overtimeMs),
    },
  };
}

// ---- Monthly export ----------------------------------------------------------------------

/** Cell code of a day without a clock-in (a day with one shows "In–Out"). */
export const MONTHLY_STATUS_CODES: Record<DailyAttendanceStatus, string> = {
  PRESENT: "P", LATE: "L", ABSENT: "A", ON_LEAVE: "LV", HOLIDAY: "H", NOT_SCHEDULED: "WO", NO_POLICY: "—", NOT_YET_DUE: "—",
};
export const MONTHLY_EXPORT_LEGEND: [string, string][] = [
  ["HH:MM–HH:MM", "First clock-in – last clock-out (local time); an open shift ends with –"],
  ["P / L", "Present / late (scheduled day attended)"],
  ["A", "Absent (scheduled, no clock-in after the grace period)"],
  ["LV", "Approved leave"],
  ["H", "Holiday"],
  ["WO", "Not a scheduled workday (week off, or before the employee joined)"],
  ["—", "No enabled work schedule, or not yet due"],
];
const TOTAL_COLUMNS: [string, keyof MonthlyAttendanceTotals][] = [
  ["Worked days", "workedDays"], ["Present days", "presentDays"], ["Late days", "lateDays"], ["Absent days", "absentDays"],
  ["Leave days", "leaveDays"], ["Holiday days", "holidayDays"], ["Worked minutes", "workedMinutes"], ["Overtime minutes", "overtimeMinutes"],
];

export const monthlyExportHeader = (m: string): string[] => {
  const { from, to } = monthRange(m);
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return ["Employee code", "Employee name", "Time zone", ...dates, ...TOTAL_COLUMNS.map(([h]) => h)];
};

/** One row per employee: identity, one cell per day, totals. No internal ids or monitoring data. */
export const monthlyExportRows = (rows: MonthlyAttendanceRow[]): Cell[][] =>
  rows.map((r) => [
    r.employee.employeeCode,
    r.employee.fullName,
    r.employee.timezone,
    ...r.days.map((d) => (d.firstInLocal ? `${d.firstInLocal}–${d.lastOutLocal ?? ""}` : MONTHLY_STATUS_CODES[d.status as DailyAttendanceStatus])),
    ...TOTAL_COLUMNS.map(([, k]) => r.totals[k]),
  ]);

export const monthlyAttendanceFilename = (m: string, format: (typeof EXPORT_FORMATS)[number]) => `attendance-${m}.${format}`;

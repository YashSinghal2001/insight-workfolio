import { z } from "zod";
import type { EmployeeRef } from "./api.js";
import { attendanceTotals } from "./attendance.js";
import type { ApplicationCategory } from "./activity.js";
import type { LeaveStatus, LeaveTally } from "./leave.js";
import type { CorrectionStatus } from "./corrections.js";
import { addDays, buildTimesheet, localDate, localTime, MAX_RANGE_DAYS, type AttendancePolicy, type SessionSource, type TimesheetSessionInput } from "./timesheet.js";

// GET /employees/:id/analytics (W2-PROFILE): one employee's personal statistics for a local-date range.

/** Range used when the query has neither `from` nor `to`: the last 14 local days, today included. */
export const EMPLOYEE_ANALYTICS_DEFAULT_DAYS = 14;
const DAY_MS = 86_400_000;

/** Both dates or neither (then the default range in the employee's zone); inclusive, ≤ MAX_RANGE_DAYS. */
export const employeeAnalyticsQuerySchema = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .superRefine((r, ctx) => {
    if (!r.from !== !r.to) ctx.addIssue({ code: "custom", message: "Give both from and to, or neither", path: [r.from ? "to" : "from"] });
    else if (r.from && r.to && r.from > r.to) ctx.addIssue({ code: "custom", message: "from must not be after to", path: ["from"] });
    else if (r.from && r.to && Date.parse(r.to) - Date.parse(r.from) > (MAX_RANGE_DAYS - 1) * DAY_MS) {
      ctx.addIssue({ code: "custom", message: `Range is limited to ${MAX_RANGE_DAYS} days`, path: ["to"] });
    }
  });
export type EmployeeAnalyticsQuery = z.infer<typeof employeeAnalyticsQuerySchema>;

/** The requested range, or the default one ending today in `timeZone`. */
export function analyticsRange(q: EmployeeAnalyticsQuery, timeZone: string, now = Date.now()): { from: string; to: string } {
  if (q.from && q.to) return { from: q.from, to: q.to };
  const to = localDate(now, timeZone);
  return { from: addDays(to, -(EMPLOYEE_ANALYTICS_DEFAULT_DAYS - 1)), to };
}

export interface EmployeeAnalyticsKpis {
  /** Net worked minutes of completed shifts (the timesheet's reportable hours). */
  workedMinutes: number;
  /** Local dates with at least one shift. */
  daysWorked: number;
  /** Activity totals; null when the caller may not read activity. */
  activeMinutes: number | null;
  idleMinutes: number | null;
  /** idle / (active + idle); null without activity access or without any activity. */
  idleShare: number | null;
  /** Productive active time / clocked-in time; null without access or when no app labels are configured. */
  productiveShare: number | null;
  /** Median local "HH:MM" of each day's first clock-in / last clock-out (null when none). */
  typicalFirstInLocal: string | null;
  typicalLastOutLocal: string | null;
}

/** Every local date of the range, zero-filled (for the bar chart). */
export interface EmployeeAnalyticsDay {
  date: string;
  workedMinutes: number;
  breakMinutes: number;
  /** Activity for the date; null without activity access. */
  activeMinutes: number | null;
  idleMinutes: number | null;
}

/** One shift, newest first. A shift belongs to the local date it started on. */
export interface EmployeeClockLogEntry {
  sessionId: string;
  date: string;
  clockInAt: string;
  clockOutAt: string | null;
  startLocal: string;
  endLocal: string | null;
  /** Net minutes (break excluded); for an open shift, so far. */
  workedMinutes: number;
  breakMinutes: number;
  open: boolean;
  /** How the clock-in was recorded (ONLINE, OFFLINE_SYNC, CORRECTION). */
  source: SessionSource;
  /** An approved correction changed this shift or one of its breaks. */
  corrected: boolean;
}

export interface EmployeeTopApp {
  applicationName: string;
  activeMinutes: number;
  category: ApplicationCategory;
}

export interface EmployeeAnalyticsResponse {
  employee: EmployeeRef;
  from: string;
  to: string;
  generatedAt: string;
  kpis: EmployeeAnalyticsKpis;
  days: EmployeeAnalyticsDay[];
  clockLog: EmployeeClockLogEntry[];
  /** Applications by active time (≤ 10); null when the caller may not read activity. */
  topApps: EmployeeTopApp[] | null;
  /** Correction requests created on a local date in the range, by status. */
  corrections: Record<CorrectionStatus, number>;
  /** Leave requests overlapping the range, by status; null when the caller may not read leave. */
  leave: Record<LeaveStatus, LeaveTally> | null;
}

export interface AnalyticsActivityInput {
  days: { date: string; activeMs: number; idleMs: number }[];
  applications: { applicationName: string; activeMs: number; category: ApplicationCategory }[];
  productiveShare: number | null;
  categoriesConfigured: boolean;
}

const minutes = (ms: number) => Math.round(ms / 60_000);
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Median of local "HH:MM" times (lower middle for an even count); null for none. */
export function medianLocalTime(times: string[]): string | null {
  if (!times.length) return null;
  const sorted = times.map(toMin).sort((a, b) => a - b);
  return toHhmm(sorted[Math.floor((sorted.length - 1) / 2)]!);
}

/** Pure aggregation behind the endpoint: timesheet rules from buildTimesheet, activity passed in (or null). */
export function buildEmployeeAnalytics(input: {
  employee: EmployeeRef;
  from: string;
  to: string;
  sessions: TimesheetSessionInput[];
  activity: AnalyticsActivityInput | null;
  corrections: Record<CorrectionStatus, number>;
  leave: Record<LeaveStatus, LeaveTally> | null;
  policy?: AttendancePolicy;
  now?: number;
}): EmployeeAnalyticsResponse {
  const { employee, from, to, activity } = input;
  const tz = employee.timezone;
  const now = input.now ?? Date.now();
  const sheet = buildTimesheet(input.sessions, { from, to, timeZone: tz, policy: input.policy, now });
  const sheetDay = new Map(sheet.days.map((d) => [d.date, d]));
  const actDay = new Map((activity?.days ?? []).map((d) => [d.date, d]));

  const days: EmployeeAnalyticsDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const s = sheetDay.get(d);
    const a = actDay.get(d);
    days.push({
      date: d,
      workedMinutes: minutes(s?.netMs ?? 0),
      breakMinutes: minutes(s?.breakMs ?? 0),
      activeMinutes: activity ? minutes(a?.activeMs ?? 0) : null,
      idleMinutes: activity ? minutes(a?.idleMs ?? 0) : null,
    });
  }

  const clockLog: EmployeeClockLogEntry[] = input.sessions
    .filter((s) => {
      const d = localDate(s.clockInAt, tz);
      return d >= from && d <= to;
    })
    .sort((a, b) => b.clockInAt.localeCompare(a.clockInAt))
    .map((s) => {
      const t = attendanceTotals({ start: s.clockInAt, end: s.clockOutAt }, s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt })), now);
      return {
        sessionId: s.id,
        date: localDate(s.clockInAt, tz),
        clockInAt: s.clockInAt,
        clockOutAt: s.clockOutAt,
        startLocal: localTime(s.clockInAt, tz),
        endLocal: s.clockOutAt ? localTime(s.clockOutAt, tz) : null,
        workedMinutes: minutes(t.netMs),
        breakMinutes: minutes(t.breakMs),
        open: !s.clockOutAt,
        source: s.clockInSource ?? "ONLINE",
        corrected: !!s.corrected,
      };
    });

  const activeMs = activity ? activity.days.reduce((n, d) => n + d.activeMs, 0) : 0;
  const idleMs = activity ? activity.days.reduce((n, d) => n + d.idleMs, 0) : 0;
  return {
    employee, from, to,
    generatedAt: new Date(now).toISOString(),
    kpis: {
      workedMinutes: minutes(sheet.totals.netMs),
      daysWorked: sheet.days.length,
      activeMinutes: activity ? minutes(activeMs) : null,
      idleMinutes: activity ? minutes(idleMs) : null,
      idleShare: activity && activeMs + idleMs > 0 ? idleMs / (activeMs + idleMs) : null,
      productiveShare: activity?.categoriesConfigured ? activity.productiveShare : null,
      typicalFirstInLocal: medianLocalTime(sheet.days.map((d) => localTime(d.firstClockIn, tz))),
      typicalLastOutLocal: medianLocalTime(sheet.days.flatMap((d) => (d.lastClockOut ? [localTime(d.lastClockOut, tz)] : []))),
    },
    days,
    clockLog,
    topApps: activity
      ? [...activity.applications]
          .sort((a, b) => b.activeMs - a.activeMs)
          .slice(0, 10)
          .map((a) => ({ applicationName: a.applicationName, activeMinutes: minutes(a.activeMs), category: a.category }))
      : null,
    corrections: input.corrections,
    leave: input.leave,
  };
}

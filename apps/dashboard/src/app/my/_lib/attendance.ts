// Pure logic of the employee panel's attendance views (no React): the missing clock-out banner rule,
// the monthly calendar and the team-head section helpers.
import {
  addDays,
  ANOMALY_THRESHOLDS,
  dailyAttendanceStatus,
  isoWeekday,
  localDate,
  localTime,
  missingClockOut,
  monthRange,
  type AttendanceCurrent,
  type ExpectedScheduleResponse,
  type LeaveRequest,
  type MonthlyAttendanceDay,
  type TimesheetResponse,
} from "@workfolio/shared";
import { DAY_CODE } from "@/lib/attendance-ui";

/**
 * Clock-in instant of an open session that looks forgotten, else null: clocked in on an earlier local date
 * (employee's zone) or open for more than the max shift (14 h). Same rule as the desktop banner. Flag only.
 */
export function stillClockedInSince(current: AttendanceCurrent, timeZone: string, now = Date.parse(current.serverTime)): string | null {
  const s = current.state === "CLOCKED_OUT" ? null : current.session;
  if (!s || s.clockOutAt) return null;
  return missingClockOut(s, timeZone, now) || now - Date.parse(s.clockInAt) > ANOMALY_THRESHOLDS.maxShiftMinutes * 60_000 ? s.clockInAt : null;
}

/** Holidays are admin-only data, so a day without a scheduled window is "day off or holiday" here. */
export const CALENDAR_CODE = { ...DAY_CODE, NOT_SCHEDULED: { code: "OFF", label: "Day off or holiday", tone: "neutral" as const } };

export interface CalendarDay {
  date: string;
  status: MonthlyAttendanceDay["status"];
  /** Net time of completed shifts that started that day. */
  workedMs: number;
  lateMinutes: number | null;
  today: boolean;
}

/** "2026-11" ± n months. */
export function shiftMonth(month: string, delta: number): string {
  let m = month;
  for (let i = 0; i < Math.abs(delta); i++) m = delta > 0 ? addDays(monthRange(m).to, 1).slice(0, 7) : addDays(`${m}-01`, -1).slice(0, 7);
  return m;
}

/**
 * The month as Monday-first weeks (null = padding). Status per day by the shared dailyAttendanceStatus, with the
 * policy rebuilt from the employee's expected window that day; OPEN when a shift that started that day is open.
 */
export function calendarMonth(input: {
  month: string;
  timeZone: string;
  timesheet: Pick<TimesheetResponse, "days">;
  expected: Pick<ExpectedScheduleResponse, "days">;
  leave: Pick<LeaveRequest, "startDate" | "endDate" | "status">[];
  now: number;
}): (CalendarDay | null)[][] {
  const { from, to } = monthRange(input.month);
  const sheet = new Map(input.timesheet.days.map((d) => [d.date, d]));
  const windows = new Map(input.expected.days.map((d) => [d.date, d]));
  const scheduleOn = input.expected.days.length > 0;
  const today = localDate(input.now, input.timeZone);
  const cells: (CalendarDay | null)[] = Array(isoWeekday(from) - 1).fill(null);
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const t = sheet.get(date);
    const w = windows.get(date);
    const policy = w
      ? { enabled: true, expectedStart: localTime(w.startAt, input.timeZone), graceMinutes: Math.round((Date.parse(w.dueAt) - Date.parse(w.startAt)) / 60_000), workdays: "1234567" }
      : scheduleOn // a schedule exists but not this day (weekly off or holiday): no workdays → NOT_SCHEDULED
        ? { enabled: true, expectedStart: "00:00", graceMinutes: 0, workdays: "" }
        : null;
    const s = dailyAttendanceStatus({
      date,
      timeZone: input.timeZone,
      policy,
      firstClockInAt: t?.firstClockIn ?? null,
      onLeave: input.leave.some((l) => l.status === "APPROVED" && l.startDate <= date && date <= l.endDate),
      now: input.now,
    });
    cells.push({ date, status: t?.incomplete ? "OPEN" : s.status, workedMs: t?.netMs ?? 0, lateMinutes: s.lateMinutes, today: date === today });
  }
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}

/** The team a head's sections filter on: the chosen one if still theirs, else the first; null without teams. */
export const pickTeam = (teams: { id: string }[], chosen: string | null): string | null =>
  teams.find((t) => t.id === chosen)?.id ?? teams[0]?.id ?? null;

/** Late arrivals window of the team attendance page: the 7 days ending at the chosen date. */
export const lateRange = (date: string) => ({ from: addDays(date, -6), to: date });

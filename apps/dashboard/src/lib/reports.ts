// Pure shaping for the Reports pages and the timesheet week grid (W2-REPORTS). No React, no fetch: unit-tested in node.
import {
  addDays,
  DAILY_REPORT_TABS,
  dailyTabRows,
  formatDuration,
  MONTHLY_STATUS_CODES,
  type DailyAttendanceRow,
  type DailyAttendanceStatus,
  type DailyReportRow,
  type DailyReportTab,
  type EmployeeRef,
  type MonthlyAttendanceDay,
  type MonthlyAttendanceResponse,
  type MonthlyAttendanceRow,
  type Paginated,
} from "@workfolio/shared";

/** Whole minutes as "7h 05m" (the timesheet's format). */
export const hm = (minutes: number) => formatDuration(minutes * 60_000);

/** Every page of a paginated read (pageSize ≤ 100), stopping at `maxPages`. */
export async function fetchAllPages<T>(get: (page: number) => Promise<Paginated<T>>, maxPages = 50): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await get(page);
    items.push(...r.items);
    if (!r.items.length || items.length >= r.total) break;
  }
  return items;
}

// ---- Daily attendance (tabs, row shape and export columns live in @workfolio/shared) ----------------------

export const dailyTabCounts = (rows: DailyReportRow[]) =>
  Object.fromEntries(DAILY_REPORT_TABS.map((t) => [t.id, dailyTabRows(rows, t.id).length])) as Record<DailyReportTab, number>;

/** /attendance/daily rows, with that day's clock-out and worked minutes from /attendance/monthly when available. */
export function dailyReportRows(daily: DailyAttendanceRow[], monthly: MonthlyAttendanceRow[] | null): DailyReportRow[] {
  const days = new Map(monthly?.map((m) => [m.employee.id, m.days]) ?? []);
  return daily.map((d) => {
    const m = days.get(d.employee.id)?.find((x) => x.date === d.date);
    return {
      employee: d.employee,
      date: d.date,
      status: d.status,
      clockIn: d.firstClockInLocal?.slice(11, 16) ?? null,
      clockOut: m?.lastOutLocal ?? null,
      workedMinutes: m?.firstInLocal && m.status !== "OPEN" ? m.workedMinutes : null,
      lateMinutes: d.lateMinutes,
    };
  });
}

// ---- Monthly in/out and overtime ------------------------------------------------------------

/** "09:00–17:30" (an open shift ends with "–"), or the export's day code (A, LV, H, WO, …). */
export const inOutCell = (d: MonthlyAttendanceDay) =>
  d.firstInLocal ? `${d.firstInLocal}–${d.lastOutLocal ?? ""}` : (MONTHLY_STATUS_CODES[d.status as DailyAttendanceStatus] ?? "—");

/** Worked = days with a clock-in; non-worked = scheduled days without one (absent + leave); late = late days. */
export const inOutCounts = (r: MonthlyAttendanceRow) => ({ worked: r.totals.workedDays, nonWorked: r.totals.absentDays + r.totals.leaveDays, late: r.totals.lateDays });

export const overtimeSummary = (r: MonthlyAttendanceRow) => ({ days: r.days.filter((d) => d.overtimeMinutes > 0).length, minutes: r.totals.overtimeMinutes });

// ---- Timesheet week grid -------------------------------------------------------------------

export const weekDates = (from: string) => Array.from({ length: 7 }, (_, i) => addDays(from, i));
/** The months (YYYY-MM) a 7-day week touches: one or two monthly reads. */
export const weekMonths = (from: string) => [...new Set(weekDates(from).map((d) => d.slice(0, 7)))];

export interface WeekGridRow {
  employee: EmployeeRef;
  /** One per date; null when the employee is not listed for that month. */
  cells: (MonthlyAttendanceDay | null)[];
  totals: { workedDays: number; workMinutes: number; breakMinutes: number };
}

/** Nothing worked on a scheduled day: tinted red (with a text label, never colour alone). */
export const missedDay = (d: MonthlyAttendanceDay | null) => d?.status === "ABSENT";

/**
 * Merges the monthly reads of a week into employee × 7-day rows. Employees keep the order of the last month's
 * read (it lists everyone who existed by the end of the week), then any listed only earlier.
 */
export function weekGrid(months: MonthlyAttendanceRow[][], from: string): WeekGridRow[] {
  const dates = weekDates(from);
  const byEmployee = new Map<string, { employee: EmployeeRef; days: Map<string, MonthlyAttendanceDay> }>();
  for (const rows of [...months].reverse())
    for (const r of rows) {
      const e = byEmployee.get(r.employee.id) ?? { employee: r.employee, days: new Map() };
      for (const d of r.days) if (d.date >= dates[0]! && d.date <= dates[6]!) e.days.set(d.date, d);
      byEmployee.set(r.employee.id, e);
    }
  return [...byEmployee.values()].map(({ employee, days }) => {
    const cells = dates.map((d) => days.get(d) ?? null);
    const done = cells.filter((c): c is MonthlyAttendanceDay => !!c);
    return {
      employee,
      cells,
      totals: {
        workedDays: done.filter((c) => c.firstInLocal).length,
        workMinutes: done.reduce((a, c) => a + c.workedMinutes, 0),
        breakMinutes: done.reduce((a, c) => a + c.breakMinutes, 0),
      },
    };
  });
}

/** Every page of each month the week touches, merged: no employee is split or missing across page boundaries. */
export async function loadWeekGrid(getMonth: (month: string, page: number) => Promise<MonthlyAttendanceResponse>, from: string): Promise<WeekGridRow[]> {
  const months = await Promise.all(weekMonths(from).map((m) => fetchAllPages((page) => getMonth(m, page))));
  return weekGrid(months, from);
}

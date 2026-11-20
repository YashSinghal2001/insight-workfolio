// Summary report (W2-REPORTS): worked days, worked / active / idle / break minutes per employee for a local-date
// range. Minutes come from the timesheet engine (same rules, floored totals); activity from the recorded intervals
// of the same completed shifts. Derived on request; nothing is stored.
import { z } from "zod";
import type { EmployeeRef, Paginated } from "./api.js";
import type { Cell, ShiftActivity } from "./export.js";
import { buildTimesheet, dateRangeSchema, localDate, type AttendancePolicy, type TimesheetSessionInput } from "./timesheet.js";

export const summaryReportQuerySchema = dateRangeSchema.and(
  z.object({
    teamId: z.uuid().optional(),
    format: z.enum(["json", "xlsx"]).default("json"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
);
export type SummaryReportQuery = z.infer<typeof summaryReportQuerySchema>;

export interface SummaryReportFigures {
  /** Local dates with at least one clock-in. */
  workedDays: number;
  /** Completed shifts only, floored to the minute: equal to the timesheet totals. */
  workedMinutes: number;
  breakMinutes: number;
  /** Recorded ACTIVE / IDLE intervals of those completed shifts, floored. */
  activeMinutes: number;
  idleMinutes: number;
}
export interface SummaryReportRow extends SummaryReportFigures {
  employee: EmployeeRef;
}
export interface SummaryReportResponse extends Paginated<SummaryReportRow> {
  from: string;
  to: string;
  /** Column sums over every matching employee (all pages). */
  totals: SummaryReportFigures & { employees: number };
}

const minutes = (ms: number) => Math.floor(Math.max(0, ms) / 60_000);

/** One employee's figures for [from, to] in their own time zone. */
export function summaryReportRow(
  employee: EmployeeRef,
  sessions: TimesheetSessionInput[],
  activity: ReadonlyMap<string, ShiftActivity>,
  opts: { from: string; to: string; policy?: AttendancePolicy; now?: number },
): SummaryReportRow {
  const sheet = buildTimesheet(sessions, { ...opts, timeZone: employee.timezone });
  let active = 0;
  let idle = 0;
  for (const s of sessions) {
    const d = localDate(s.clockInAt, employee.timezone);
    if (!s.clockOutAt || d < opts.from || d > opts.to) continue;
    active += activity.get(s.id)?.activeMs ?? 0;
    idle += activity.get(s.id)?.idleMs ?? 0;
  }
  return {
    employee,
    workedDays: sheet.days.length,
    workedMinutes: minutes(sheet.totals.netMs),
    breakMinutes: minutes(sheet.totals.breakMs),
    activeMinutes: minutes(active),
    idleMinutes: minutes(idle),
  };
}

export const SUMMARY_REPORT_FIGURES: [string, keyof SummaryReportFigures][] = [
  ["Worked days", "workedDays"],
  ["Worked minutes", "workedMinutes"],
  ["Active minutes", "activeMinutes"],
  ["Idle minutes", "idleMinutes"],
  ["Break minutes", "breakMinutes"],
];

/** Column sums (the totals row). */
export function summaryReportTotals(rows: SummaryReportFigures[]): SummaryReportResponse["totals"] {
  const t = { employees: rows.length, workedDays: 0, workedMinutes: 0, breakMinutes: 0, activeMinutes: 0, idleMinutes: 0 };
  for (const r of rows) for (const [, k] of SUMMARY_REPORT_FIGURES) t[k] += r[k];
  return t;
}

export const SUMMARY_REPORT_HEADER = ["Employee code", "Employee name", "Time zone", ...SUMMARY_REPORT_FIGURES.map(([h]) => h)];

/** File rows: one per employee, then an "All employees" totals row. No internal ids, emails or app data. */
export function summaryReportCells(rows: SummaryReportRow[]): Cell[][] {
  const t = summaryReportTotals(rows);
  return [
    ...rows.map((r) => [r.employee.employeeCode, r.employee.fullName, r.employee.timezone, ...SUMMARY_REPORT_FIGURES.map(([, k]) => r[k])]),
    ["All employees", `${rows.length} employees`, null, ...SUMMARY_REPORT_FIGURES.map(([, k]) => t[k])],
  ];
}

export const summaryReportFilename = (from: string, to: string) => `summary-report_${from}_${to}.xlsx`;

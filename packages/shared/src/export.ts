// Timesheet export (CSV and XLSX), DRAFT format. The business has not approved a payroll or accounting
// format; columns live in one list, shared by both file types, so they are easy to revise. Bump the
// version whenever a column changes.
import type { AttendanceSession, EmployeeRef } from "./api.js";
import { attendanceTotals } from "./attendance.js";
import type { SessionSource } from "./timesheet.js";
import { localDate, zonedIso } from "./timesheet.js";

export const TIMESHEET_CSV_FORMAT = "timesheet-csv-draft-1";

/** Recorded activity of one shift (sums of the stored intervals linked to it). */
export interface ShiftActivity {
  activeMs: number;
  idleMs: number;
}

const SOURCE: Record<SessionSource, string> = { ONLINE: "Desktop app", OFFLINE_SYNC: "Desktop app (offline, synced later)", CORRECTION: "Approved correction" };
const minutes = (ms: number | null) => (ms === null ? null : Math.floor(Math.max(0, ms) / 60_000));

export type Cell = string | number | null;
export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
interface Ctx { employee: EmployeeRef; s: AttendanceSession; a: ShiftActivity; breakMs: number | null; workedMs: number | null }

/**
 * One row per shift whose clock-in falls on a local date in the range. "Recorded" columns are stored
 * values; "calculated" ones are derived from them. Open shifts and open breaks have no end, so every
 * value that would need one is left empty: no clock-out is ever assumed.
 */
/** `type` tells the XLSX writer how to store the cell ("date": a YYYY-MM-DD local date); `width` is in characters. */
export const TIMESHEET_CSV_COLUMNS: { header: string; kind: "recorded" | "calculated"; type: "text" | "number" | "date"; width: number; value: (c: Ctx) => Cell }[] = [
  { header: "Employee code", kind: "recorded", type: "text", width: 14, value: (c) => c.employee.employeeCode },
  { header: "Employee name", kind: "recorded", type: "text", width: 24, value: (c) => c.employee.fullName },
  { header: "Work date", kind: "calculated", type: "date", width: 12, value: (c) => localDate(c.s.clockInAt, c.employee.timezone) },
  { header: "Time zone", kind: "recorded", type: "text", width: 18, value: (c) => c.employee.timezone },
  { header: "Clock in", kind: "recorded", type: "text", width: 26, value: (c) => zonedIso(c.s.clockInAt, c.employee.timezone) },
  { header: "Clock out", kind: "recorded", type: "text", width: 26, value: (c) => (c.s.clockOutAt ? zonedIso(c.s.clockOutAt, c.employee.timezone) : null) },
  { header: "Status", kind: "recorded", type: "text", width: 28, value: (c) => (c.s.clockOutAt ? "Completed" : "Open: no clock-out recorded") },
  {
    header: "Breaks",
    kind: "recorded",
    type: "text",
    width: 54,
    value: (c) => c.s.breaks.map((b) => `${zonedIso(b.startedAt, c.employee.timezone)}/${b.endedAt ? zonedIso(b.endedAt, c.employee.timezone) : ""}`).join("; ") || null,
  },
  { header: "Break count", kind: "calculated", type: "number", width: 12, value: (c) => c.s.breaks.length },
  { header: "Break minutes", kind: "calculated", type: "number", width: 14, value: (c) => minutes(c.breakMs) },
  { header: "Worked minutes", kind: "calculated", type: "number", width: 15, value: (c) => minutes(c.workedMs) },
  { header: "Active minutes", kind: "calculated", type: "number", width: 14, value: (c) => minutes(c.a.activeMs) },
  { header: "Idle minutes", kind: "calculated", type: "number", width: 13, value: (c) => minutes(c.a.idleMs) },
  { header: "No activity record minutes", kind: "calculated", type: "number", width: 26, value: (c) => (c.workedMs === null ? null : minutes(c.workedMs - c.a.activeMs - c.a.idleMs)) },
  { header: "Corrected", kind: "recorded", type: "text", width: 10, value: (c) => (c.s.corrected ? "Yes" : "No") },
  { header: "Clock-in source", kind: "recorded", type: "text", width: 32, value: (c) => SOURCE[c.s.clockInSource] },
];

/**
 * One CSV field (RFC 4180). Text starting with a formula character is prefixed with an apostrophe
 * so spreadsheets show it as text instead of running it (CSV/formula injection).
 */
export function csvCell(v: Cell): string {
  if (v === null) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 BOM (so Excel reads Unicode correctly), CRLF line ends, header row first. */
export const toCsv = (rows: Cell[][]) => `\uFEFF${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;

/** The data rows (no header), one per shift, ordered by clock-in: the single source for CSV and XLSX. */
export function timesheetRows(employee: EmployeeRef, sessions: AttendanceSession[], activity: ReadonlyMap<string, ShiftActivity>): Cell[][] {
  return [...sessions]
    .sort((x, y) => x.clockInAt.localeCompare(y.clockInAt))
    .map((s) => {
      const closed = !!s.clockOutAt && s.breaks.every((b) => b.endedAt);
      // Same arithmetic as the timesheet (attendanceTotals), only for fully closed shifts.
      const t = closed ? attendanceTotals({ start: s.clockInAt, end: s.clockOutAt }, s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt }))) : null;
      const c: Ctx = { employee, s, a: activity.get(s.id) ?? { activeMs: 0, idleMs: 0 }, breakMs: t?.breakMs ?? null, workedMs: t?.netMs ?? null };
      return TIMESHEET_CSV_COLUMNS.map((col) => col.value(c));
    });
}

export const timesheetCsv = (employee: EmployeeRef, sessions: AttendanceSession[], activity: ReadonlyMap<string, ShiftActivity>): string =>
  toCsv([TIMESHEET_CSV_COLUMNS.map((c) => c.header), ...timesheetRows(employee, sessions, activity)]);

/**
 * Column sums for the XLSX "Summary" sheet: only figures that are exact sums or counts of the rows.
 * Blank cells (open shifts) are not counted as zero; each row is already rounded down, so a sum can
 * be a few minutes below a total computed from unrounded time (e.g. the History tab).
 */
export function timesheetSummary(rows: readonly Cell[][]): { label: string; value: number; note: string }[] {
  const col = (header: string) => TIMESHEET_CSV_COLUMNS.findIndex((c) => c.header === header);
  const open = rows.filter((r) => r[col("Clock out")] === null).length;
  const sum = (header: string) => rows.reduce<number>((n, r) => n + (typeof r[col(header)] === "number" ? (r[col(header)] as number) : 0), 0);
  const filled = (header: string) => rows.filter((r) => typeof r[col(header)] === "number").length;
  const total = (header: string, what: string) => ({ label: `${header} (sum of the column)`, value: sum(header), note: `${what}; ${filled(header)} of ${rows.length} rows have a value` });
  return [
    { label: "Shifts (rows)", value: rows.length, note: "Shifts whose clock-in falls in the range" },
    { label: "Completed shifts", value: rows.length - open, note: "With a recorded clock-out" },
    { label: "Open shifts", value: open, note: "No clock-out recorded; their break, worked and no-record minutes are blank and not in the sums below" },
    total("Worked minutes", "Completed shifts with every break ended"),
    total("Break minutes", "Completed shifts with every break ended"),
    total("Active minutes", "All shifts, recorded activity"),
    total("Idle minutes", "All shifts, recorded activity"),
    total("No activity record minutes", "Completed shifts with every break ended"),
  ];
}

/** "workfolio-timesheet-draft1_EMP-7_2026-10-01_2026-10-31.xlsx": safe characters only (no dots in the code part). */
export const timesheetFilename = (employeeCode: string, from: string, to: string, format: ExportFormat = "csv") =>
  `workfolio-timesheet-draft1_${employeeCode.replace(/[^\w-]+/g, "_").slice(0, 40) || "employee"}_${from}_${to}.${format}`;
/** Organisation-wide export: "workfolio-timesheets-draft1_all_2026-10-01_2026-10-31.csv". */
export const orgTimesheetFilename = (from: string, to: string, format: ExportFormat = "csv") => `workfolio-timesheets-draft1_all_${from}_${to}.${format}`;
export const timesheetCsvFilename = (employeeCode: string, from: string, to: string) => timesheetFilename(employeeCode, from, to, "csv");

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8; header=present",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

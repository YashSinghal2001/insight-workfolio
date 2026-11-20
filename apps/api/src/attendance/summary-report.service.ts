import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  buildTimesheet,
  DAILY_EXPORT_HEADER,
  dailyExportCells,
  dailyTabRows,
  localTime,
  SUMMARY_REPORT_HEADER,
  summaryReportCells,
  summaryReportRow,
  summaryReportTotals,
  toCsv,
  type AttendancePolicy,
  type Cell,
  type DailyExportQuery,
  type DailyReportRow,
  type EmployeeRef,
  type SummaryReportFigures,
  type SummaryReportResponse,
  type SummaryReportRow,
} from "@workfolio/shared";
import writeExcelFile, { type SheetData } from "write-excel-file/node";
import type { AuthContext } from "../auth/auth.service.js";
import { POLICY } from "../common/policy.js";
import { assertTeamReadable } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { ScheduleService } from "../schedule/schedule.service.js";
import { chunks, rangeSessions, scopedEmployees } from "./sessions.js";

const PERMISSION = "attendance:read-all";
const HEADER = { fontWeight: "bold", backgroundColor: "#E5E7EB" } as const;
/** Employees computed per pass: bounds memory for the all-employee totals and files. */
const EMPLOYEES_PER_PASS = 200;
const minutes = (ms: number) => Math.floor(ms / 60_000);

/** One-sheet report workbook plus a "Notes" sheet. Text is stored as text (never a formula); numbers as numbers; null blank. */
async function reportXlsx(sheet: string, header: string[], rows: Cell[][], notes: [string, string][]): Promise<Buffer> {
  const text = (v: string) => ({ value: v, type: String, format: "@" });
  const data: SheetData = [
    header.map((v) => ({ value: v, type: String, ...HEADER })),
    ...rows.map((r) => r.map((v) => (v === null ? null : typeof v === "number" ? { value: v, type: Number, format: "0" } : text(v)))),
  ];
  return writeExcelFile([
    { data, sheet, columns: header.map((_, i) => ({ width: i === 1 ? 26 : i === 2 ? 20 : 16 })), stickyRowsCount: 1 },
    { data: notes.map(([k, v]) => [text(k), text(v)]), sheet: "Notes", columns: [{ width: 20 }, { width: 90 }] },
  ]).toBuffer();
}

/**
 * Summary report and the daily attendance export. Same timesheet engine as /attendance/timesheet(s), so worked and
 * break minutes equal the timesheet totals; activity counts the completed shifts of the range only. Employees are
 * processed EMPLOYEES_PER_PASS at a time and sessions read through rangeSessions (chunked), so no head count or
 * 92-day range exceeds SQLite's parameter limit.
 */
@Injectable()
export class SummaryReportService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
    private readonly schedule: ScheduleService,
  ) {}

  /** The requested page's rows, and totals over every employee (an aggregate pass, chunked; only figures are kept). */
  async report(q: { from: string; to: string; teamId?: string; page: number; pageSize: number }, caller: AuthContext, now = Date.now()): Promise<SummaryReportResponse> {
    const employees = await this.employees(q, caller);
    const start = (q.page - 1) * q.pageSize;
    const items: SummaryReportRow[] = [];
    const figures: SummaryReportFigures[] = [];
    for (const [i, part] of chunks(employees, EMPLOYEES_PER_PASS).entries()) {
      for (const [j, row] of (await this.rows(part, q, now)).entries()) {
        const at = i * EMPLOYEES_PER_PASS + j;
        if (at >= start && at < start + q.pageSize) items.push(row);
        figures.push({ workedDays: row.workedDays, workedMinutes: row.workedMinutes, breakMinutes: row.breakMinutes, activeMinutes: row.activeMinutes, idleMinutes: row.idleMinutes });
      }
    }
    return { from: q.from, to: q.to, items, total: employees.length, page: q.page, pageSize: q.pageSize, totals: summaryReportTotals(figures) };
  }

  async xlsx(q: { from: string; to: string; teamId?: string }, caller: AuthContext, now = Date.now()): Promise<{ body: Buffer; rows: number }> {
    const rows: SummaryReportRow[] = [];
    for (const part of chunks(await this.employees(q, caller), EMPLOYEES_PER_PASS)) rows.push(...(await this.rows(part, q, now)));
    const body = await reportXlsx("Summary", SUMMARY_REPORT_HEADER, summaryReportCells(rows), [
      ["Work dates from", q.from],
      ["Work dates to", q.to],
      ["Time zones", "Each employee's own; a shift belongs to the local date of its clock-in"],
      ["Minutes", "Completed shifts only, rounded down to the minute: worked and break equal the timesheet totals"],
      ["Active / idle", "Recorded activity of those completed shifts"],
      ["Generated (UTC)", new Date(now).toISOString()],
    ]);
    return { body, rows: rows.length };
  }

  /** One tab of the daily attendance report as CSV or XLSX: statuses as /attendance/daily, minutes as the timesheet. */
  async daily(q: DailyExportQuery, caller: AuthContext, now = Date.now()): Promise<{ body: string | Buffer; rows: number }> {
    // daily() checks the team and scope; every matching employee in one page (it computes them all anyway).
    const { items } = await this.schedule.daily({ date: q.date, teamId: q.teamId, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, now, caller);
    const { byEmployee } = await rangeSessions(this.db, items.map((r) => r.employee.id), q.date, q.date);
    const rows = items.map((r): DailyReportRow => {
      const day = buildTimesheet(byEmployee.get(r.employee.id) ?? [], { from: q.date, to: q.date, timeZone: r.employee.timezone, policy: this.policy, now }).days[0];
      return {
        employee: r.employee,
        date: r.date,
        status: r.status,
        clockIn: r.firstClockInLocal?.slice(11, 16) ?? null,
        clockOut: day?.lastClockOut ? localTime(day.lastClockOut, r.employee.timezone) : null,
        workedMinutes: day && !day.incomplete ? minutes(day.netMs) : null,
        lateMinutes: r.lateMinutes,
      };
    });
    const cells = dailyExportCells(dailyTabRows(rows, q.tab));
    const body =
      q.format === "xlsx"
        ? await reportXlsx("Daily attendance", DAILY_EXPORT_HEADER, cells, [
            ["Date", `${q.date} (each employee's own time zone)`],
            ["List", q.tab],
            ["Minutes", "Completed shifts only, rounded down; blank while a shift is open"],
            ["Generated (UTC)", new Date(now).toISOString()],
          ])
        : toCsv([DAILY_EXPORT_HEADER, ...cells]);
    return { body, rows: cells.length };
  }

  private async employees(q: { teamId?: string }, caller: AuthContext): Promise<EmployeeRef[]> {
    await assertTeamReadable(this.db, caller, PERMISSION, q.teamId);
    const { items } = await scopedEmployees(this.db, caller, { teamId: q.teamId, activeOnly: true });
    return items.map(({ id, fullName, employeeCode, timezone }) => ({ id, fullName, employeeCode, timezone }));
  }

  private async rows(employees: EmployeeRef[], q: { from: string; to: string }, now: number): Promise<SummaryReportRow[]> {
    const { byEmployee, activity } = await rangeSessions(this.db, employees.map((e) => e.id), q.from, q.to);
    return employees.map((e) => summaryReportRow(e, byEmployee.get(e.id) ?? [], activity, { from: q.from, to: q.to, policy: this.policy, now }));
  }
}

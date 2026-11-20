import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  addDays,
  SUMMARY_REPORT_HEADER,
  summaryReportCells,
  summaryReportRow,
  summaryReportTotals,
  type AttendancePolicy,
  type ShiftActivity,
  type SummaryReportResponse,
  type SummaryReportRow,
} from "@workfolio/shared";
import writeExcelFile, { type SheetData } from "write-excel-file/node";
import type { AuthContext } from "../auth/auth.service.js";
import { POLICY } from "../common/policy.js";
import { assertTeamReadable } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { scopedEmployees, SESSION_COLUMNS, withBreaks } from "./sessions.js";

const PERMISSION = "attendance:read-all";
const HEADER = { fontWeight: "bold", backgroundColor: "#E5E7EB" } as const;

/**
 * Summary report: per active employee in scope, worked days and worked / active / idle / break minutes for a
 * local-date range (each employee's own zone). Same timesheet engine as /attendance/timesheet(s), so worked and
 * break minutes equal the timesheet totals; activity counts the completed shifts of the range only.
 */
@Injectable()
export class SummaryReportService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
  ) {}

  async report(q: { from: string; to: string; teamId?: string; page: number; pageSize: number }, caller: AuthContext, now = Date.now()): Promise<SummaryReportResponse> {
    const rows = await this.rows(q, caller, now);
    return { from: q.from, to: q.to, items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: rows.length, page: q.page, pageSize: q.pageSize, totals: summaryReportTotals(rows) };
  }

  /** "Summary" sheet: one row per employee, then the totals row; a "Notes" sheet with the range and rules. */
  async xlsx(q: { from: string; to: string; teamId?: string }, caller: AuthContext, now = Date.now()): Promise<{ body: Buffer; rows: number }> {
    const rows = await this.rows(q, caller, now);
    const text = (v: string) => ({ value: v, type: String, format: "@" });
    const sheet: SheetData = [
      SUMMARY_REPORT_HEADER.map((v) => ({ value: v, type: String, ...HEADER })),
      ...summaryReportCells(rows).map((r) => r.map((v) => (v === null ? null : typeof v === "number" ? { value: v, type: Number, format: "0" } : text(v)))),
    ];
    const notes: SheetData = [
      [text("Work dates from"), text(q.from)],
      [text("Work dates to"), text(q.to)],
      [text("Time zones"), text("Each employee's own; a shift belongs to the local date of its clock-in")],
      [text("Minutes"), text("Completed shifts only, rounded down to the minute: worked and break equal the timesheet totals")],
      [text("Active / idle"), text("Recorded activity of those completed shifts")],
      [text("Generated (UTC)"), text(new Date(now).toISOString())],
    ];
    const body = await writeExcelFile([
      { data: sheet, sheet: "Summary", columns: SUMMARY_REPORT_HEADER.map((_, i) => ({ width: i === 1 ? 26 : i === 2 ? 20 : 16 })), stickyRowsCount: 1 },
      { data: notes, sheet: "Notes", columns: [{ width: 20 }, { width: 90 }] },
    ]).toBuffer();
    return { body, rows: rows.length };
  }

  private async rows(q: { from: string; to: string; teamId?: string }, caller: AuthContext, now: number): Promise<SummaryReportRow[]> {
    await assertTeamReadable(this.db, caller, PERMISSION, q.teamId);
    const { items } = await scopedEmployees(this.db, caller, { teamId: q.teamId, activeOnly: true });
    if (!items.length) return [];
    const ids = items.map((e) => e.id);
    const marks = ids.map(() => "?").join(", ");
    // A day of slack on each side covers every UTC offset; summaryReportRow keeps each employee's local dates.
    const range = [...ids, `${addDays(q.from, -1)}T00:00:00.000Z`, `${addDays(q.to, 2)}T00:00:00.000Z`];
    const inRange = `employee_id IN (${marks}) AND clock_in_at >= ? AND clock_in_at < ?`;
    const [sessions, sums] = await this.db.batch(
      [
        { sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.${inRange}`, args: range },
        {
          sql: `SELECT attendance_session_id AS id,
                  coalesce(sum(CASE WHEN kind = 'ACTIVE' THEN active_seconds END), 0) AS active,
                  coalesce(sum(CASE WHEN kind = 'IDLE' THEN idle_seconds END), 0) AS idle
                FROM activity_intervals WHERE attendance_session_id IN (SELECT id FROM attendance_sessions WHERE ${inRange})
                GROUP BY attendance_session_id`,
          args: range,
        },
      ],
      "read",
    );
    const all = await withBreaks(this.db, sessions!.rows);
    const ownerOf = new Map(sessions!.rows.map((r) => [String(r.id), String(r.employee_id)]));
    const activity = new Map<string, ShiftActivity>(sums!.rows.map((r) => [String(r.id), { activeMs: Number(r.active) * 1000, idleMs: Number(r.idle) * 1000 }]));
    const byEmployee = new Map<string, typeof all>();
    for (const s of all) byEmployee.set(ownerOf.get(s.id)!, [...(byEmployee.get(ownerOf.get(s.id)!) ?? []), s]);
    return items.map(({ id, fullName, employeeCode, timezone }) =>
      summaryReportRow({ id, fullName, employeeCode, timezone }, byEmployee.get(id) ?? [], activity, { from: q.from, to: q.to, policy: this.policy, now }),
    );
  }
}

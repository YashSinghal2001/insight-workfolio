import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  addDays,
  buildTimesheet,
  localDate,
  missingClockOut,
  TIMESHEET_CSV_COLUMNS,
  timesheetRows,
  toCsv,
  zonedToUtc,
  type AttendancePolicy,
  type Cell,
  type ExportFormat,
  type EmployeeRef,
  type ListEmployeesQuery,
  type Paginated,
  type ShiftActivity,
  type TimesheetResponse,
  type TimesheetSummaryRow,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { POLICY } from "../common/policy.js";
import { assertTeamReadable, scopeSql, teamFilterSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { ACTIVE_EMPLOYEE, scopedEmployees, SESSION_COLUMNS, withBreaks } from "./sessions.js";
import { orgTimesheetXlsx, timesheetXlsx } from "./timesheet-xlsx.js";

/** Read-only timesheets computed on request from sessions (corrections included once approved). */
@Injectable()
export class TimesheetService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
  ) {}

  async forEmployee(employee: EmployeeRef, from: string, to: string): Promise<TimesheetResponse> {
    const [sessions, pending] = await this.db.batch(
      [
        {
          sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s
                WHERE s.employee_id = ? AND s.clock_in_at >= ? AND s.clock_in_at < ? ORDER BY s.clock_in_at`,
          args: [employee.id, zonedToUtc(`${from}T00:00`, employee.timezone), zonedToUtc(`${addDays(to, 1)}T00:00`, employee.timezone)],
        },
        { sql: "SELECT count(*) AS n FROM correction_requests WHERE employee_id = ? AND status = 'PENDING'", args: [employee.id] },
      ],
      "read",
    );
    const sheet = buildTimesheet(await withBreaks(this.db, sessions!.rows), { from, to, timeZone: employee.timezone, policy: this.policy });
    return { ...sheet, employee, pendingCorrections: Number(pending!.rows[0]!.n) };
  }

  /**
   * Draft export (TIMESHEET_CSV_FORMAT): one row per shift that started on a local date in [from, to],
   * with the recorded activity linked to it. CSV and XLSX share these rows. Built in memory per
   * request; nothing is stored.
   */
  async exportRows(employee: EmployeeRef, from: string, to: string): Promise<Cell[][]> {
    const range = [employee.id, zonedToUtc(`${from}T00:00`, employee.timezone), zonedToUtc(`${addDays(to, 1)}T00:00`, employee.timezone)];
    const [sessions, sums] = await this.db.batch(
      [
        { sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.employee_id = ? AND s.clock_in_at >= ? AND s.clock_in_at < ? ORDER BY s.clock_in_at`, args: range },
        // A sub-query rather than one parameter per shift, so a long range never hits a parameter limit.
        {
          sql: `SELECT attendance_session_id AS id,
                  coalesce(sum(CASE WHEN kind = 'ACTIVE' THEN active_seconds END), 0) AS active,
                  coalesce(sum(CASE WHEN kind = 'IDLE' THEN idle_seconds END), 0) AS idle
                FROM activity_intervals WHERE employee_id = ?1 AND attendance_session_id IN
                  (SELECT id FROM attendance_sessions WHERE employee_id = ?1 AND clock_in_at >= ?2 AND clock_in_at < ?3)
                GROUP BY attendance_session_id`,
          args: range,
        },
      ],
      "read",
    );
    const activity = new Map<string, ShiftActivity>(sums!.rows.map((r) => [String(r.id), { activeMs: Number(r.active) * 1000, idleMs: Number(r.idle) * 1000 }]));
    return timesheetRows(employee, await withBreaks(this.db, sessions!.rows), activity);
  }

  /** The file in the requested format, and how many shift rows it has. */
  async export(employee: EmployeeRef, from: string, to: string, format: ExportFormat): Promise<{ body: string | Buffer; rows: number }> {
    const rows = await this.exportRows(employee, from, to);
    const body = format === "xlsx" ? await timesheetXlsx(employee, rows, { from, to }) : toCsv([TIMESHEET_CSV_COLUMNS.map((c) => c.header), ...rows]);
    return { body, rows: rows.length };
  }

  /**
   * Organisation-wide draft export: the per-employee rows (same columns, same values) for every
   * matching employee, ordered by employee code then clock-in. Active employees only unless
   * `includeInactive`. Three queries plus the breaks, whatever the head count.
   */
  async exportAll(
    from: string,
    to: string,
    format: ExportFormat,
    opts: { q?: string; includeInactive: boolean; caller?: AuthContext; teamId?: string },
  ): Promise<{ body: string | Buffer; rows: number }> {
    // Team heads: only their teams' members (W41). The scope's one `?` is bound as ?3.
    if (opts.caller) await assertTeamReadable(this.db, opts.caller, "attendance:read-all", opts.teamId);
    const scope = opts.caller ? scopeSql(opts.caller, "attendance:read-all", "p.id") : { sql: "", args: [] };
    const team = teamFilterSql(opts.teamId, "p.id"); // bound as ?4 (after the scope's ?3, or alone)
    const like = opts.q ? `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    // A day of slack on each side covers every UTC offset; rows are then kept by each employee's local date.
    const window = [`${addDays(from, -1)}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`];
    const [emps, sessions, sums] = await this.db.batch(
      [
        {
          sql: `SELECT p.id, p.full_name, p.employee_code, p.timezone FROM employee_profiles p JOIN users u ON u.id = p.user_id
                WHERE (?1 = 1 OR (${ACTIVE_EMPLOYEE}))
                  AND (?2 IS NULL OR p.full_name LIKE ?2 ESCAPE '\\' OR u.email LIKE ?2 ESCAPE '\\' OR p.employee_code LIKE ?2 ESCAPE '\\')${scope.sql.replace("?", "?3")}${team.sql.replace("?", scope.args.length ? "?4" : "?3")}
                ORDER BY p.employee_code, p.id`,
          args: [opts.includeInactive ? 1 : 0, like, ...scope.args, ...team.args],
        },
        { sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.clock_in_at >= ? AND s.clock_in_at < ?`, args: window },
        {
          sql: `SELECT attendance_session_id AS id,
                  coalesce(sum(CASE WHEN kind = 'ACTIVE' THEN active_seconds END), 0) AS active,
                  coalesce(sum(CASE WHEN kind = 'IDLE' THEN idle_seconds END), 0) AS idle
                FROM activity_intervals WHERE attendance_session_id IN
                  (SELECT id FROM attendance_sessions WHERE clock_in_at >= ? AND clock_in_at < ?)
                GROUP BY attendance_session_id`,
          args: window,
        },
      ],
      "read",
    );
    const employees: EmployeeRef[] = emps!.rows.map((r) => ({ id: String(r.id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) }));
    const wanted = new Set(employees.map((e) => e.id));
    const kept = sessions!.rows.filter((r) => wanted.has(String(r.employee_id)));
    // ponytail: withBreaks binds one parameter per shift; fine to ~30k shifts (SQLite's limit), batch it beyond that.
    const all = await withBreaks(this.db, kept);
    const ownerOf = new Map(kept.map((r) => [String(r.id), String(r.employee_id)]));
    const activity = new Map<string, ShiftActivity>(sums!.rows.map((r) => [String(r.id), { activeMs: Number(r.active) * 1000, idleMs: Number(r.idle) * 1000 }]));
    const perEmployee = employees.map((employee) => {
      const mine = all.filter((x) => {
        if (ownerOf.get(x.id) !== employee.id) return false;
        const d = localDate(x.clockInAt, employee.timezone);
        return d >= from && d <= to;
      });
      return { employee, rows: timesheetRows(employee, mine, activity) };
    });
    const rows = perEmployee.flatMap((e) => e.rows);
    const body = format === "xlsx" ? await orgTimesheetXlsx(perEmployee, { from, to }) : toCsv([TIMESHEET_CSV_COLUMNS.map((c) => c.header), ...rows]);
    return { body, rows: rows.length };
  }

  /** Admin listing: totals per employee for the range (each in the employee's own time zone). Team heads: their teams. */
  async summary(query: ListEmployeesQuery & { from: string; to: string; teamId?: string }, caller?: AuthContext): Promise<Paginated<TimesheetSummaryRow>> {
    if (caller) await assertTeamReadable(this.db, caller, "attendance:read-all", query.teamId);
    const page = { ...(await scopedEmployees(this.db, caller, query)), page: query.page, pageSize: query.pageSize };
    const ids = page.items.map((e) => e.id);
    if (!ids.length) return { ...page, items: [] };
    const marks = ids.map(() => "?").join(", ");
    // A day of slack on each side covers every UTC offset; buildTimesheet filters by local date.
    const [sessions, open, pending] = await this.db.batch(
      [
        {
          sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s
                WHERE s.employee_id IN (${marks}) AND s.clock_in_at >= ? AND s.clock_in_at < ?`,
          args: [...ids, `${addDays(query.from, -1)}T00:00:00.000Z`, `${addDays(query.to, 2)}T00:00:00.000Z`],
        },
        { sql: `SELECT employee_id, clock_in_at FROM attendance_sessions WHERE status = 'OPEN' AND employee_id IN (${marks})`, args: ids },
        {
          sql: `SELECT employee_id, count(*) AS n FROM correction_requests
                WHERE status = 'PENDING' AND employee_id IN (${marks}) GROUP BY employee_id`,
          args: ids,
        },
      ],
      "read",
    );
    const all = await withBreaks(this.db, sessions!.rows);
    const ownerOf = new Map(sessions!.rows.map((r) => [String(r.id), String(r.employee_id)]));
    const openAt = new Map(open!.rows.map((r) => [String(r.employee_id), String(r.clock_in_at)]));
    const pendingBy = new Map(pending!.rows.map((r) => [String(r.employee_id), Number(r.n)]));
    return {
      ...page,
      items: page.items.map((e) => {
        const employee = { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, timezone: e.timezone };
        const mine = all.filter((s) => ownerOf.get(s.id) === e.id);
        const { totals } = buildTimesheet(mine, { from: query.from, to: query.to, timeZone: e.timezone, policy: this.policy });
        const clockInAt = openAt.get(e.id);
        return {
          employee, totals, openShift: !!clockInAt,
          missingClockOut: missingClockOut(clockInAt ? { clockInAt, clockOutAt: null } : null, e.timezone),
          pendingCorrections: pendingBy.get(e.id) ?? 0,
        };
      }),
    };
  }
}

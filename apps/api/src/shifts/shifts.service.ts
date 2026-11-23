import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { DatabaseClient, Row } from "@workfolio/database";
import {
  addDays,
  BEYOND_SHIFT_STATUSES,
  type AutoClockOutHistoryQuery,
  type AutoClockOutHistoryRow,
  type Paginated,
  isOvernight,
  SHIFT_STATUSES,
  shiftInputSchema,
  shiftStatus,
  type AutoClockOutRecord,
  type ClockOutReason,
  type EmployeeShift,
  type EmployeeShiftResponse,
  type ShiftInput,
  type ShiftListQuery,
  type ShiftListResponse,
  type ShiftRow,
  type ShiftStatus,
} from "@workfolio/shared";
import { accountAudit } from "../audit/account-audit.js";
import type { AuthContext } from "../auth/auth.service.js";
import { scopedEmployees, str } from "../attendance/sessions.js";
import { assertTeamReadable, scopeSql, teamFilterSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { EmployeesService } from "../employees/employees.service.js";
import { shiftOf } from "./auto-clock-out.service.js";
import { shiftStatements } from "./shift-statements.js";

const SHIFT = `SELECT sh.employee_id, sh.start_time, sh.end_time, sh.timezone, sh.grace_minutes, sh.auto_clock_out, sh.workdays, sh.updated_at, u.id AS by_id, u.email AS by_email
  FROM employee_shifts sh LEFT JOIN users u ON u.id = sh.updated_by`;
const AUTO_COLUMNS = "a.attendance_session_id, a.employee_id, a.scheduled_shift_end_at, a.deadline_at, a.clock_out_at, a.processed_at, a.break_ended";
const AUTO = `SELECT ${AUTO_COLUMNS} FROM auto_clock_outs a`;

const toShift = (r: Row): EmployeeShift => ({
  employeeId: String(r.employee_id),
  ...shiftOf(r),
  overnight: isOvernight({ startTime: String(r.start_time), endTime: String(r.end_time) }),
  updatedBy: r.by_id ? { id: String(r.by_id), email: String(r.by_email) } : null,
});
const toAuto = (r: Row): AutoClockOutRecord => ({
  attendanceSessionId: String(r.attendance_session_id),
  scheduledShiftEndAt: String(r.scheduled_shift_end_at),
  deadlineAt: String(r.deadline_at),
  clockOutAt: String(r.clock_out_at),
  processedAt: String(r.processed_at),
  reason: "AUTOMATIC_SHIFT_END",
  breakEnded: Number(r.break_ended) === 1,
});
const ref = (r: Row) => ({ id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.employee_timezone) });

/** Shift settings per employee and the admin shift overview (docs/EMPLOYEE-SHIFT-MANAGEMENT.md). */
@Injectable()
export class ShiftsService {
  private readonly logger = new Logger(ShiftsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly employees: EmployeesService,
  ) {}

  /** Own shift, or one the caller may read (admins; team heads for their teams). Anything else is 404. */
  async get(caller: AuthContext, employeeId: string): Promise<EmployeeShiftResponse> {
    const e = await this.employees.attendanceTarget(caller, employeeId, "employees:read");
    const [shift, history] = await this.db.batch(
      [
        { sql: `${SHIFT} WHERE sh.employee_id = ?`, args: [e.id] },
        { sql: `${AUTO} WHERE a.employee_id = ? ORDER BY a.clock_out_at DESC LIMIT 20`, args: [e.id] },
      ],
      "read",
    );
    return { shift: shift!.rows[0] ? toShift(shift!.rows[0]) : null, history: history!.rows.map(toAuto) };
  }

  async put(admin: AuthContext, employeeId: string, input: ShiftInput): Promise<EmployeeShiftResponse> {
    const e = await this.employees.attendanceTarget(admin, employeeId);
    const guard = await this.employees.superAdminGuard(admin, e.userId);
    const [set] = await this.db.batch(shiftStatements(admin, e, shiftInputSchema.parse(input), guard), "write");
    if (!set!.rowsAffected) await this.employees.superAdminGuard(admin, e.userId); // promoted meanwhile → 403
    this.logger.log({ employeeId: e.id, actorId: admin.id }, "Shift assigned");
    return this.get(admin, e.id);
  }

  async remove(admin: AuthContext, employeeId: string): Promise<EmployeeShiftResponse> {
    const e = await this.employees.attendanceTarget(admin, employeeId);
    const guard = await this.employees.superAdminGuard(admin, e.userId);
    const [removed] = await this.db.batch(
      [
        { sql: `DELETE FROM employee_shifts WHERE employee_id = ?${guard.sql}`, args: [e.id, ...guard.args] },
        accountAudit({ actorUserId: admin.id, targetUserId: e.userId, action: "SHIFT_REMOVED", resourceType: "ACCOUNT", resourceId: e.userId, metadata: { employeeId: e.id } }, "changes() > 0"),
      ],
      "write",
    );
    if (!removed!.rowsAffected) throw new NotFoundException("This employee has no shift");
    this.logger.log({ employeeId: e.id, actorId: admin.id }, "Shift removed");
    return this.get(admin, e.id);
  }

  /**
   * Every active employee in the caller's scope with their shift, live shift status and next automatic
   * clock-out. ponytail: reads every shift, open session and latest session, then pages in memory (one
   * organisation's headcount); push the filters into SQL if that ever gets large.
   */
  async list(caller: AuthContext, q: ShiftListQuery, now = Date.now()): Promise<ShiftListResponse> {
    await assertTeamReadable(this.db, caller, "attendance:read-all", q.teamId);
    const { items: people } = await scopedEmployees(this.db, caller, { q: q.q, teamId: q.teamId, activeOnly: true });
    const [shifts, open, latest, autos, failures] = await this.db.batch(
      [
        SHIFT,
        `SELECT s.employee_id, s.clock_in_at,
                max(s.clock_in_at, coalesce((SELECT max(max(b.started_at, coalesce(b.ended_at, b.started_at))) FROM break_sessions b WHERE b.attendance_session_id = s.id), '')) AS last_change
         FROM attendance_sessions s WHERE s.status = 'OPEN'`,
        `SELECT s.employee_id, EXISTS (SELECT 1 FROM auto_clock_outs a WHERE a.attendance_session_id = s.id) AS auto FROM attendance_sessions s
         WHERE s.status = 'CLOSED' AND s.clock_in_at = (SELECT max(clock_in_at) FROM attendance_sessions WHERE employee_id = s.employee_id)`,
        `${AUTO} WHERE a.rowid IN (SELECT max(rowid) FROM auto_clock_outs GROUP BY employee_id)`,
        { sql: "SELECT employee_id, attendance_session_id, error, failed_at FROM auto_clock_out_failures WHERE failed_at >= ? ORDER BY failed_at DESC", args: [new Date(now - 24 * 3_600_000).toISOString()] },
      ],
      "read",
    );
    const by = <T>(rows: Row[], f: (r: Row) => T) => new Map(rows.map((r) => [String(r.employee_id), f(r)]));
    const shiftBy = by(shifts!.rows, toShift);
    const openBy = by(open!.rows, (r) => ({ clockInAt: String(r.clock_in_at), lastChangeAt: String(r.last_change) }));
    const reasonBy = by(latest!.rows, (r): ClockOutReason => (Number(r.auto) ? "AUTOMATIC_SHIFT_END" : "MANUAL"));
    const autoBy = by(autos!.rows, toAuto);
    const rows: ShiftRow[] = people.map((p) => {
      const shift = shiftBy.get(p.id) ?? null;
      const o = openBy.get(p.id) ?? null;
      const s = shiftStatus({ shift, open: o, lastClockOutReason: reasonBy.get(p.id) ?? null, now });
      return {
        employee: { id: p.id, fullName: p.fullName, employeeCode: p.employeeCode, timezone: p.timezone },
        shift,
        status: s.status,
        nextAutoClockOutAt: s.nextAutoClockOutAt,
        occurrence: s.occurrence,
        clockedInAt: str(o?.clockInAt),
        lastAutoClockOut: autoBy.get(p.id) ?? null,
      };
    });
    const summary = Object.fromEntries(SHIFT_STATUSES.map((s) => [s, 0])) as Record<ShiftStatus, number>;
    for (const r of rows) summary[r.status]++;
    const shown = rows.filter((r) => (!q.beyondShift || BEYOND_SHIFT_STATUSES.includes(r.status)) && (!q.status || r.status === q.status));
    const visible = new Map(rows.map((r) => [r.employee.id, r.employee])); // scope: only people the caller may see
    const recentFailures = failures!.rows
      .filter((f) => visible.has(String(f.employee_id)))
      .slice(0, 20)
      .map((f) => ({ employee: visible.get(String(f.employee_id))!, attendanceSessionId: String(f.attendance_session_id), error: String(f.error), failedAt: String(f.failed_at) }));
    return { items: shown.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: shown.length, page: q.page, pageSize: q.pageSize, summary, recentFailures };
  }

  /** Automatic clock-outs across the caller's scope, newest first; from/to are UTC dates of the clock-out. */
  async history(caller: AuthContext, q: AutoClockOutHistoryQuery): Promise<Paginated<AutoClockOutHistoryRow>> {
    await assertTeamReadable(this.db, caller, "attendance:read-all", q.teamId);
    const scope = scopeSql(caller, "attendance:read-all", "a.employee_id");
    const team = teamFilterSql(q.teamId, "a.employee_id");
    const where = `WHERE (? IS NULL OR a.clock_out_at >= ?) AND (? IS NULL OR a.clock_out_at < ?) AND (? IS NULL OR a.employee_id = ?)${scope.sql}${team.sql}`;
    const from = q.from ? `${q.from}T00:00:00.000Z` : null;
    const to = q.to ? `${addDays(q.to, 1)}T00:00:00.000Z` : null;
    const args = [from, from, to, to, q.employeeId ?? null, q.employeeId ?? null, ...scope.args, ...team.args];
    const [items, count] = await this.db.batch(
      [
        {
          sql: `SELECT ${AUTO_COLUMNS}, a.shift_start_time, a.shift_end_time, a.shift_timezone, a.grace_minutes, p.full_name, p.employee_code, p.timezone AS employee_timezone
                FROM auto_clock_outs a JOIN employee_profiles p ON p.id = a.employee_id ${where} ORDER BY a.clock_out_at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
          args: [...args, q.pageSize, (q.page - 1) * q.pageSize],
        },
        { sql: `SELECT count(*) AS n FROM auto_clock_outs a ${where}`, args },
      ],
      "read",
    );
    return {
      items: items!.rows.map((r) => ({ ...toAuto(r), employee: ref(r), shiftStartTime: String(r.shift_start_time), shiftEndTime: String(r.shift_end_time), shiftTimezone: String(r.shift_timezone), graceMinutes: Number(r.grace_minutes) })),
      total: Number(count!.rows[0]!.n),
      page: q.page,
      pageSize: q.pageSize,
    };
  }
}

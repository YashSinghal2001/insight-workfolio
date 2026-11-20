import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  addDays,
  attendanceRow,
  localDate,
  monthlyExportHeader,
  monthlyExportRows,
  monthRange,
  toCsv,
  zonedToUtc,
  type AttendancePolicy,
  type EmployeeRef,
  type ExportFormat,
  type LateArrival,
  type LateArrivalsQuery,
  type LateArrivalsResponse,
  type MonthlyAttendanceQuery,
  type MonthlyAttendanceResponse,
  type MonthlyAttendanceRow,
  type TimesheetSessionInput,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { POLICY } from "../common/policy.js";
import { assertTeamReadable } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { effectiveAt } from "../schedule/schedule.service.js";
import { scopedEmployees, str } from "./sessions.js";
import { monthlyAttendanceXlsx } from "./timesheet-xlsx.js";

const PERMISSION = "attendance:read-all";
/** Profiles created before the local end of `to` in every zone (UTC-12 is the latest). */
const createdBefore = (to: string) => `${addDays(to, 1)}T12:00:00.000Z`;
const ref = ({ id, fullName, employeeCode, timezone }: EmployeeRef): EmployeeRef => ({ id, fullName, employeeCode, timezone });

/**
 * Monthly attendance, late arrivals and the monthly export: per employee per local day, by the rules of
 * /attendance/daily (status) and /attendance/timesheet (minutes). Bulk reads: one batch for any head count.
 */
@Injectable()
export class MonthlyService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
  ) {}

  async monthly(q: MonthlyAttendanceQuery, caller: AuthContext, now = Date.now()): Promise<MonthlyAttendanceResponse> {
    await assertTeamReadable(this.db, caller, PERMISSION, q.teamId);
    const { from, to } = monthRange(q.month);
    const page = await scopedEmployees(this.db, caller, { q: q.q, teamId: q.teamId, activeOnly: true, createdBefore: createdBefore(to), page: q.page, pageSize: q.pageSize });
    return { month: q.month, items: await this.rows(page.items, from, to, now), total: page.total, page: q.page, pageSize: q.pageSize };
  }

  async export(q: { month: string; teamId?: string; format: ExportFormat }, caller: AuthContext, now = Date.now()): Promise<{ body: string | Buffer; rows: number }> {
    await assertTeamReadable(this.db, caller, PERMISSION, q.teamId);
    const { from, to } = monthRange(q.month);
    const emps = await scopedEmployees(this.db, caller, { teamId: q.teamId, activeOnly: true, createdBefore: createdBefore(to) });
    const header = monthlyExportHeader(q.month);
    const rows = monthlyExportRows(await this.rows(emps.items, from, to, now));
    return { body: q.format === "xlsx" ? await monthlyAttendanceXlsx(q.month, header, rows) : toCsv([header, ...rows]), rows: rows.length };
  }

  /** LATE days (incl. a still-open late shift) in [from, to], newest date first, then by employee name. */
  async late(q: LateArrivalsQuery, caller: AuthContext, now = Date.now()): Promise<LateArrivalsResponse> {
    await assertTeamReadable(this.db, caller, PERMISSION, q.teamId);
    const emps = await scopedEmployees(this.db, caller, { teamId: q.teamId, activeOnly: true, createdBefore: createdBefore(q.to) });
    const all: LateArrival[] = (await this.rows(emps.items, q.from, q.to, now))
      .flatMap((r) => r.days.filter((d) => d.lateMinutes !== null).map((d) => ({ employee: r.employee, date: d.date, dueLocal: d.dueLocal!, firstClockInLocal: d.firstInLocal!, lateMinutes: d.lateMinutes! })))
      .sort((a, b) => b.date.localeCompare(a.date)); // stable: employees stay in name order within a date
    return { from: q.from, to: q.to, items: all.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: all.length, page: q.page, pageSize: q.pageSize };
  }

  private async rows(employees: (EmployeeRef & { createdAt: string })[], from: string, to: string, now: number): Promise<MonthlyAttendanceRow[]> {
    if (!employees.length) return [];
    const ids = employees.map((e) => e.id);
    const marks = ids.map(() => "?").join(", ");
    // A day of slack on each side covers every UTC offset; attendanceRow keeps each employee's local dates.
    const window = [`${addDays(from, -1)}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`];
    const inWindow = `employee_id IN (${marks}) AND clock_in_at >= ? AND clock_in_at < ?`;
    const [sessions, breaks, leave, holidays, policies, overrides] = await this.db.batch(
      [
        { sql: `SELECT id, employee_id, clock_in_at, clock_out_at FROM attendance_sessions WHERE ${inWindow}`, args: [...ids, ...window] },
        {
          sql: `SELECT attendance_session_id AS sid, started_at, ended_at FROM break_sessions
                WHERE attendance_session_id IN (SELECT id FROM attendance_sessions WHERE ${inWindow})`,
          args: [...ids, ...window],
        },
        {
          sql: `SELECT employee_id, start_date, end_date FROM leave_requests
                WHERE status = 'APPROVED' AND start_date <= ? AND end_date >= ? AND employee_id IN (${marks})`,
          args: [to, from, ...ids],
        },
        { sql: "SELECT date FROM holidays WHERE date >= ? AND date <= ?", args: [from, to] },
        "SELECT enabled, expected_start, grace_minutes, workdays, effective_at FROM work_schedule_policies ORDER BY effective_at, seq",
        { sql: `SELECT employee_id, expected_start, workdays, effective_at FROM employee_tracking_overrides WHERE employee_id IN (${marks}) ORDER BY effective_at, rowid`, args: ids },
      ],
      "read",
    );
    const group = <T>(rows: T[], key: (r: T) => string) => {
      const m = new Map<string, T[]>();
      for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
      return m;
    };
    const breaksOf = group(breaks!.rows, (r) => String(r.sid));
    const sessionsOf = group(
      sessions!.rows.map((r) => ({
        employeeId: String(r.employee_id),
        s: {
          id: String(r.id),
          clockInAt: String(r.clock_in_at),
          clockOutAt: str(r.clock_out_at),
          breaks: (breaksOf.get(String(r.id)) ?? []).map((b) => ({ startedAt: String(b.started_at), endedAt: str(b.ended_at) })),
        } satisfies TimesheetSessionInput,
      })),
      (x) => x.employeeId,
    );
    const leaveOf = group(leave!.rows, (r) => String(r.employee_id));
    const overridesOf = group(overrides!.rows, (r) => String(r.employee_id));
    const holiday = new Set(holidays!.rows.map((r) => String(r.date)));
    return employees.map((e) => {
      const mine = leaveOf.get(e.id) ?? [];
      const own = overridesOf.get(e.id) ?? [];
      return attendanceRow({
        employee: ref(e),
        from,
        to,
        sessions: (sessionsOf.get(e.id) ?? []).map((x) => x.s),
        scheduleFor: (date) => effectiveAt(policies!.rows, own, zonedToUtc(`${date}T00:00`, e.timezone)),
        onLeave: (date) => mine.some((l) => String(l.start_date) <= date && String(l.end_date) >= date),
        holiday: (date) => holiday.has(date),
        employedFrom: localDate(e.createdAt, e.timezone),
        policy: this.policy,
        now,
      });
    });
  }
}

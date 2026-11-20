import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  addDays,
  analyticsRange,
  buildEmployeeAnalytics,
  CORRECTION_STATUSES,
  tallyLeave,
  zonedToUtc,
  type AttendancePolicy,
  type CorrectionStatus,
  type EmployeeAnalyticsQuery,
  type EmployeeAnalyticsResponse,
  type LeavePortion,
  type LeaveStatus,
} from "@workfolio/shared";
import { ActivityService } from "../activity/activity.service.js";
import { SESSION_COLUMNS, str, withBreaks } from "../attendance/sessions.js";
import type { AuthContext } from "../auth/auth.service.js";
import { POLICY } from "../common/policy.js";
import { canReadEmployee } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { EmployeesService } from "./employees.service.js";

/** One employee's personal statistics (W2-PROFILE). Reuses the timesheet engine and the activity summary. */
@Injectable()
export class EmployeeAnalyticsService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
    private readonly employees: EmployeesService,
    private readonly activity: ActivityService,
  ) {}

  async forEmployee(caller: AuthContext, employeeId: string, q: EmployeeAnalyticsQuery, now = Date.now()): Promise<EmployeeAnalyticsResponse> {
    const employee = await this.employees.attendanceTarget(caller, employeeId); // 404 outside the caller's scope
    const { from, to } = analyticsRange(q, employee.timezone, now);
    const [start, end] = [zonedToUtc(`${from}T00:00`, employee.timezone), zonedToUtc(`${addDays(to, 1)}T00:00`, employee.timezone)];
    const [seeActivity, seeLeave] = await Promise.all([
      canReadEmployee(this.db, caller, "activity:read-all", employee.id),
      canReadEmployee(this.db, caller, "leave:read-all", employee.id),
    ]);
    const [batch, activity] = await Promise.all([
      this.db.batch(
        [
          { sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.employee_id = ? AND s.clock_in_at >= ? AND s.clock_in_at < ? ORDER BY s.clock_in_at`, args: [employee.id, start, end] },
          { sql: "SELECT status, count(*) AS n FROM correction_requests WHERE employee_id = ? AND created_at >= ? AND created_at < ? GROUP BY status", args: [employee.id, start, end] },
          { sql: "SELECT t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.employee_id = ? AND t.active = 1 ORDER BY t.name", args: [employee.id] },
          { sql: "SELECT start_date, end_date, portion, start_time, end_time, status FROM leave_requests WHERE employee_id = ? AND start_date <= ? AND end_date >= ?", args: [employee.id, to, from] },
        ],
        "read",
      ),
      seeActivity ? this.activity.summary(employee, from, to) : null,
    ]);
    const [sessions, corrections, teams, leave] = batch;
    const correctionCounts = Object.fromEntries(CORRECTION_STATUSES.map((s) => [s, 0])) as Record<CorrectionStatus, number>;
    for (const r of corrections!.rows) correctionCounts[r.status as CorrectionStatus] = Number(r.n);

    const result = buildEmployeeAnalytics({
      employee: { id: employee.id, fullName: employee.fullName, employeeCode: employee.employeeCode, timezone: employee.timezone },
      teams: teams!.rows.map((r) => String(r.name)),
      from, to, now, policy: this.policy,
      sessions: await withBreaks(this.db, sessions!.rows),
      activity,
      corrections: correctionCounts,
      leave: seeLeave
        ? tallyLeave(
            leave!.rows.map((r) => ({ startDate: String(r.start_date), endDate: String(r.end_date), portion: r.portion as LeavePortion, startTime: str(r.start_time), endTime: str(r.end_time), status: r.status as LeaveStatus })),
            from, to,
          )
        : null,
    });
    // Audited after the data was produced (refused requests leave no row); nothing for the caller's own record.
    await this.employees.auditRead(caller, employee, "EMPLOYEE_ATTENDANCE_VIEWED", { view: "analytics", from, to });
    if (activity) await this.employees.auditRead(caller, employee, "EMPLOYEE_ACTIVITY_SUMMARY_VIEWED", { view: "analytics", from, to });
    return result;
  }
}

import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  addDays,
  buildTimesheet,
  zonedToUtc,
  type AttendancePolicy,
  type EmployeeRef,
  type ListEmployeesQuery,
  type Paginated,
  type TimesheetResponse,
  type TimesheetSummaryRow,
} from "@workfolio/shared";
import { POLICY } from "../common/policy.js";
import { DATABASE } from "../database/database.module.js";
import { EmployeesService } from "../employees/employees.service.js";
import { SESSION_COLUMNS, withBreaks } from "./sessions.js";

/** Read-only timesheets computed on request from sessions (corrections included once approved). */
@Injectable()
export class TimesheetService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
    private readonly employees: EmployeesService,
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

  /** Admin listing: totals per employee for the range (each in the employee's own time zone). */
  async summary(query: ListEmployeesQuery & { from: string; to: string }): Promise<Paginated<TimesheetSummaryRow>> {
    const page = await this.employees.list(query);
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
        { sql: `SELECT employee_id FROM attendance_sessions WHERE status = 'OPEN' AND employee_id IN (${marks})`, args: ids },
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
    const openSet = new Set(open!.rows.map((r) => String(r.employee_id)));
    const pendingBy = new Map(pending!.rows.map((r) => [String(r.employee_id), Number(r.n)]));
    return {
      ...page,
      items: page.items.map((e) => {
        const employee = { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, timezone: e.timezone };
        const mine = all.filter((s) => ownerOf.get(s.id) === e.id);
        const { totals } = buildTimesheet(mine, { from: query.from, to: query.to, timeZone: e.timezone, policy: this.policy });
        return { employee, totals, openShift: openSet.has(e.id), pendingCorrections: pendingBy.get(e.id) ?? 0 };
      }),
    };
  }
}

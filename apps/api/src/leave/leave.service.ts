import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { guardViolation, isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import {
  addDays,
  DEFAULT_LEAVE_TYPE_ID,
  hasPermission,
  LEAVE_BALANCE_DAY_RULE,
  leaveDaysInYear,
  shortHoursInMonth,
  type LeaveBalance,
  type LeaveBalanceMeResponse,
  type LeaveBalanceRow,
  type LeaveBalancesResponse,
  type LeaveType,
  type LeaveTypeInput,
  type UpdateLeaveTypeInput,
  LEAVE_WINDOW_DAYS,
  leaveOverlaps,
  leaveWhen,
  localDate,
  type CreateLeave,
  type LeavePortion,
  type LeaveRequest,
  LEAVE_SUMMARY_DAY_RULE,
  tallyLeave,
  type LeaveStatus,
  type LeaveSummaryMeResponse,
  type LeaveSummaryMeta,
  type LeaveSummaryQuery,
  type LeaveSummaryResponse,
  type LeaveSummaryRow,
  type EmployeeRef,
  type Paginated,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { EmployeeLocks } from "../common/employee-locks.js";
import { inScope, readScope, scopeSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { EmployeesService } from "../employees/employees.service.js";
import { iso, str } from "../attendance/sessions.js";

const SELECT = `
  SELECT r.id, r.employee_id, r.start_date, r.end_date, r.portion, r.leave_type_id, t.name AS type_name, t.paid AS type_paid, r.start_time, r.end_time, r.reason, r.status,
         r.requested_by, ru.email AS requester_email, r.created_at, r.decided_by, du.email AS decider_email,
         r.decided_at, r.decision_note, p.full_name, p.employee_code, p.timezone
  FROM leave_requests r
  JOIN employee_profiles p ON p.id = r.employee_id
  JOIN users ru ON ru.id = r.requested_by
  JOIN leave_types t ON t.id = r.leave_type_id
  LEFT JOIN users du ON du.id = r.decided_by`;

const toType = (r: Row): LeaveType => ({
  id: String(r.id),
  name: String(r.name),
  paid: Number(r.paid) === 1,
  yearlyAllowanceDays: r.yearly_allowance_days === null ? null : Number(r.yearly_allowance_days),
  shortHoursPerMonth: r.short_hours_per_month === null ? null : Number(r.short_hours_per_month),
  active: Number(r.active) === 1,
});
const TYPE_COLUMNS = "id, name, paid, yearly_allowance_days, short_hours_per_month, active";
type Usage = { leaveTypeId: string; status: LeaveStatus; startDate: string; endDate: string; portion: LeavePortion; startTime: string | null; endTime: string | null };
const round = (n: number) => Math.round(n * 100) / 100;

const SUMMARY_META: LeaveSummaryMeta = { dayRule: LEAVE_SUMMARY_DAY_RULE, balancesConfigured: false };

function toRequest(r: Row): LeaveRequest {
  const requestedBy = { id: String(r.requested_by), email: String(r.requester_email) };
  const decidedBy = r.decided_by ? { id: String(r.decided_by), email: String(r.decider_email) } : null;
  const status = r.status as LeaveStatus;
  return {
    id: String(r.id),
    employee: { id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) },
    startDate: String(r.start_date),
    endDate: String(r.end_date),
    portion: r.portion as LeavePortion,
    leaveType: { id: String(r.leave_type_id), name: String(r.type_name), paid: Number(r.type_paid) === 1 },
    startTime: str(r.start_time),
    endTime: str(r.end_time),
    reason: str(r.reason),
    status,
    requestedBy,
    requestedAt: String(r.created_at),
    decidedBy,
    decidedAt: str(r.decided_at),
    decisionNote: str(r.decision_note),
    history: [
      { action: "SUBMITTED", at: String(r.created_at), by: requestedBy, note: null },
      ...(status !== "PENDING" && decidedBy ? [{ action: status, at: String(r.decided_at), by: decidedBy, note: str(r.decision_note) }] : []),
    ],
  };
}

/**
 * Employees request leave for themselves; an administrator other than the requester approves or
 * rejects; the requester may cancel while it is pending. Approval is refused when it would exceed the
 * type's yearly allowance or monthly short-leave quota. No payroll, and attendance records are never
 * touched. Reasons are never logged.
 */
@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly employees: EmployeesService,
    private readonly locks: EmployeeLocks,
  ) {}

  async create(caller: AuthContext, input: CreateLeave): Promise<LeaveRequest> {
    const employee = await this.employees.attendanceTarget(caller); // always the caller's own profile
    const today = localDate(Date.now(), employee.timezone);
    if (input.startDate < addDays(today, -LEAVE_WINDOW_DAYS) || input.endDate > addDays(today, LEAVE_WINDOW_DAYS)) {
      throw new BadRequestException(`Leave dates must be within ${LEAVE_WINDOW_DAYS} days of today (${today}, ${employee.timezone})`);
    }
    const typeId = input.leaveTypeId ?? DEFAULT_LEAVE_TYPE_ID;
    const type = (await this.db.execute({ sql: "SELECT active FROM leave_types WHERE id = ?", args: [typeId] })).rows[0];
    if (!type || Number(type.active) !== 1) throw new BadRequestException("Choose an active leave type");
    const id = randomUUID();
    await this.locks.run(employee.id, async () => {
      // ponytail: overlap is checked under the per-process lock; several API instances would need a DB-level guard.
      const { rows } = await this.db.execute({
        sql: `SELECT start_date, end_date, portion, start_time, end_time, status FROM leave_requests
              WHERE employee_id = ? AND status IN ('PENDING', 'APPROVED') AND start_date <= ? AND end_date >= ?`,
        args: [employee.id, input.endDate, input.startDate],
      });
      const clash = rows.find((r) => leaveOverlaps(input, { startDate: String(r.start_date), endDate: String(r.end_date), portion: r.portion as LeavePortion, startTime: str(r.start_time), endTime: str(r.end_time) }));
      if (clash) {
        const when = leaveWhen({ startDate: String(clash.start_date), endDate: String(clash.end_date), portion: clash.portion as LeavePortion, startTime: str(clash.start_time), endTime: str(clash.end_time) });
        throw new ConflictException(`This overlaps your ${String(clash.status).toLowerCase()} request for ${when}`);
      }
      await this.db.execute({
        sql: `INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, start_time, end_time, reason, leave_type_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, employee.id, caller.id, input.startDate, input.endDate, input.portion, input.startTime ?? null, input.endTime ?? null, input.reason ?? null, typeId],
      });
    });
    this.logger.log({ leaveId: id, employeeId: employee.id, actorId: caller.id }, "Leave requested");
    return this.get(caller, id);
  }

  /**
   * Employees: their own requests. Admins: everyone's, optionally filtered. Team heads (W41): with no
   * filter, their teams' members' requests; `employeeId` may name a member (else 404).
   */
  async list(caller: AuthContext, q: { status?: LeaveStatus; employeeId?: string; mine?: boolean; page: number; pageSize: number }): Promise<Paginated<LeaveRequest>> {
    const team = !q.mine && !q.employeeId && readScope(caller, "leave:read-all") === "team";
    // mine: the caller's own profile from the session (the schema rejects mine together with employeeId).
    const employeeId = !team && (q.mine || q.employeeId || !this.isReviewer(caller)) ? (await this.employees.attendanceTarget(caller, q.mine ? undefined : q.employeeId, "leave:read-all")).id : null;
    const scope = team ? scopeSql(caller, "leave:read-all", "r.employee_id") : { sql: "", args: [] };
    const where = `WHERE (?1 IS NULL OR r.employee_id = ?1) AND (?2 IS NULL OR r.status = ?2)${scope.sql.replace("?", "?5")}`;
    const [rows, count] = await this.db.batch(
      [
        { sql: `${SELECT} ${where} ORDER BY r.start_date DESC, r.created_at DESC, r.id LIMIT ?3 OFFSET ?4`, args: [employeeId, q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize, ...scope.args] },
        { sql: `SELECT count(*) AS n FROM leave_requests r ${where}`, args: [employeeId, q.status ?? null, null, null, ...scope.args] },
      ],
      "read",
    );
    return { items: rows!.rows.map(toRequest), total: Number(count!.rows[0]!.n), page: q.page, pageSize: q.pageSize };
  }

  async get(caller: AuthContext, id: string): Promise<LeaveRequest> {
    const row = (await this.db.execute({ sql: `${SELECT} WHERE r.id = ?`, args: [id] })).rows[0];
    if (!row) throw new NotFoundException("Leave request not found");
    if (!this.isReviewer(caller)) await this.employees.attendanceTarget(caller, String(row.employee_id), "leave:read-all"); // 404 unless own (or, for a team head, a member)
    return toRequest(row);
  }

  async decide(caller: AuthContext, id: string, status: "APPROVED" | "REJECTED", note?: string): Promise<LeaveRequest> {
    const request = await this.get(caller, id); // 404 outside what the caller may read
    if (request.requestedBy.id === caller.id) throw new ForbiddenException("You cannot review your own leave request");
    // W41 exception, not a role grant: without leave:review only a team head, only for a member of a team
    // they head, and never for their own profile (even when they are a member of their own team).
    if (!hasPermission(caller.role, "leave:review")) {
      const own = (await this.employees.findByUserId(caller.id))?.id === request.employee.id;
      if (!caller.teamHead || own || !(await inScope(this.db, caller, "leave:read-all", request.employee.id))) {
        throw new ForbiddenException("You can only review leave requests of your team members");
      }
    }
    // Under the employee lock so two approvals cannot both fit the same remaining balance.
    await this.locks.run(request.employee.id, async () => {
      if (status === "APPROVED" && request.status === "PENDING") await this.assertWithinBalance(request);
      await this.close(request, status, caller.id, note ?? null);
    });
    return this.get(caller, id);
  }

  /** Only the requester, only while pending. Cancelling approved leave is a policy decision (not built). */
  async cancel(caller: AuthContext, id: string): Promise<LeaveRequest> {
    const request = await this.get(caller, id);
    if (request.requestedBy.id !== caller.id) throw new ForbiddenException("Only the employee who asked can cancel a request");
    await this.close(request, "CANCELLED", caller.id, null);
    return this.get(caller, id);
  }

  /** Admin: per-employee totals of requests overlapping [from, to] (each in the employee's own dates). Two queries per page. */
  async summary(q: LeaveSummaryQuery, caller?: AuthContext): Promise<LeaveSummaryResponse> {
    const page = await this.employees.list(q, caller, "leave:read-all");
    const refs = page.items.map((e) => ({ id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, timezone: e.timezone }));
    return { ...page, items: await this.rows(refs, q.from, q.to), from: q.from, to: q.to, meta: SUMMARY_META };
  }

  /** The caller's own totals (profile from the session). */
  async mySummary(caller: AuthContext, from: string, to: string): Promise<LeaveSummaryMeResponse> {
    const e = await this.employees.attendanceTarget(caller);
    const [row] = await this.rows([{ id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, timezone: e.timezone }], from, to);
    return { from, to, row: row!, meta: SUMMARY_META };
  }

  private async rows(employees: EmployeeRef[], from: string, to: string): Promise<LeaveSummaryRow[]> {
    if (!employees.length) return [];
    const { rows } = await this.db.execute({
      sql: `SELECT employee_id, start_date, end_date, portion, start_time, end_time, status FROM leave_requests
            WHERE employee_id IN (${employees.map(() => "?").join(", ")}) AND start_date <= ? AND end_date >= ?`,
      args: [...employees.map((e) => e.id), to, from],
    });
    return employees.map((employee) => ({
      employee,
      byStatus: tallyLeave(
        rows
          .filter((r) => r.employee_id === employee.id)
          .map((r) => ({ startDate: String(r.start_date), endDate: String(r.end_date), portion: r.portion as LeavePortion, startTime: str(r.start_time), endTime: str(r.end_time), status: r.status as LeaveStatus })),
        from,
        to,
      ),
    }));
  }

  // ---- Leave types and balances (W36 / W35) ----

  async listTypes(caller: AuthContext): Promise<LeaveType[]> {
    const all = hasPermission(caller.role, "leave:manage");
    const { rows } = await this.db.execute(`SELECT ${TYPE_COLUMNS} FROM leave_types ${all ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`);
    return rows.map(toType);
  }

  async createType(admin: AuthContext, input: LeaveTypeInput): Promise<LeaveType> {
    const id = randomUUID();
    await this.saveType(() =>
      this.db.execute({
        sql: "INSERT INTO leave_types (id, name, paid, yearly_allowance_days, short_hours_per_month, created_by) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, input.name, input.paid ? 1 : 0, input.yearlyAllowanceDays, input.shortHoursPerMonth, admin.id],
      }),
    );
    this.logger.log({ leaveTypeId: id, actorId: admin.id }, "Leave type created");
    return this.type(id);
  }

  async updateType(admin: AuthContext, id: string, input: UpdateLeaveTypeInput): Promise<LeaveType> {
    const current = await this.type(id);
    if (id === DEFAULT_LEAVE_TYPE_ID && input.active === false) throw new BadRequestException("The default leave type cannot be deactivated (requests that name no type use it)");
    const next = { ...current, ...input };
    await this.saveType(() =>
      this.db.execute({
        sql: "UPDATE leave_types SET name = ?, paid = ?, yearly_allowance_days = ?, short_hours_per_month = ?, active = ?, updated_at = ? WHERE id = ?",
        args: [next.name, next.paid ? 1 : 0, next.yearlyAllowanceDays, next.shortHoursPerMonth, next.active ? 1 : 0, iso(Date.now()), id],
      }),
    );
    this.logger.log({ leaveTypeId: id, actorId: admin.id }, "Leave type changed");
    return this.type(id);
  }

  private async type(id: string): Promise<LeaveType> {
    const row = (await this.db.execute({ sql: `SELECT ${TYPE_COLUMNS} FROM leave_types WHERE id = ?`, args: [id] })).rows[0];
    if (!row) throw new NotFoundException("Leave type not found");
    return toType(row);
  }

  private async saveType(write: () => Promise<unknown>) {
    try {
      await write();
    } catch (err) {
      if (isUniqueViolation(err, "leave_types.name")) throw new ConflictException("A leave type with this name already exists");
      throw err;
    }
  }

  /** Admin: balances for a page of employees. */
  async balances(q: { month?: string; q?: string; page: number; pageSize: number }, caller?: AuthContext): Promise<LeaveBalancesResponse> {
    const month = q.month ?? localDate(Date.now(), "UTC").slice(0, 7);
    const page = await this.employees.list({ q: q.q, page: q.page, pageSize: q.pageSize }, caller, "leave:read-all");
    const refs = page.items.map((e) => ({ id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, timezone: e.timezone }));
    return { ...page, items: await this.balanceRows(refs, month), month, dayRule: LEAVE_BALANCE_DAY_RULE };
  }

  /** The caller's own balances (profile from the session, never from the query). */
  async myBalances(caller: AuthContext, month?: string): Promise<LeaveBalanceMeResponse> {
    const e = await this.employees.attendanceTarget(caller);
    const m = month ?? localDate(Date.now(), e.timezone).slice(0, 7);
    const [row] = await this.balanceRows([{ id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, timezone: e.timezone }], m);
    return { month: m, row: row!, dayRule: LEAVE_BALANCE_DAY_RULE };
  }

  /**
   * Holidays of the given years and each employee's workdays under the enabled schedule: their own
   * workday override (W17) if set, else the organisation's (null = schedule off, every day counts).
   */
  private async calendar(fromYear: number, toYear: number): Promise<{ holidays: Set<string>; workdays: (employeeId: string) => string | null }> {
    const [h, p, o] = await this.db.batch(
      [
        { sql: "SELECT date FROM holidays WHERE date >= ? AND date <= ?", args: [`${fromYear}-01-01`, `${toYear}-12-31`] },
        "SELECT enabled, workdays FROM work_schedule_policies ORDER BY effective_at DESC, seq DESC LIMIT 1",
        // Ascending, so the Map below keeps each employee's latest override version.
        "SELECT employee_id, workdays FROM employee_tracking_overrides ORDER BY effective_at, rowid",
      ],
      "read",
    );
    const policy = p!.rows[0];
    const org = policy && Number(policy.enabled) === 1 ? String(policy.workdays) : null;
    const own = new Map(o!.rows.map((r) => [String(r.employee_id), r.workdays === null ? null : String(r.workdays)]));
    // ponytail: the current schedule and override apply to the whole year; per-date versions if that matters.
    return { holidays: new Set(h!.rows.map((r) => String(r.date))), workdays: (id) => (org === null ? null : (own.get(id) ?? org)) };
  }

  private async usage(employeeIds: string[], year: number): Promise<(Usage & { employeeId: string })[]> {
    if (!employeeIds.length) return [];
    const { rows } = await this.db.execute({
      sql: `SELECT employee_id, leave_type_id, status, start_date, end_date, portion, start_time, end_time FROM leave_requests
            WHERE employee_id IN (${employeeIds.map(() => "?").join(", ")}) AND status IN ('APPROVED', 'PENDING') AND start_date <= ? AND end_date >= ?`,
      args: [...employeeIds, `${year}-12-31`, `${year}-01-01`],
    });
    return rows.map((r) => ({
      employeeId: String(r.employee_id),
      leaveTypeId: String(r.leave_type_id),
      status: r.status as LeaveStatus,
      startDate: String(r.start_date),
      endDate: String(r.end_date),
      portion: r.portion as LeavePortion,
      startTime: str(r.start_time),
      endTime: str(r.end_time),
    }));
  }

  private async balanceRows(employees: EmployeeRef[], month: string): Promise<LeaveBalanceRow[]> {
    const year = Number(month.slice(0, 4));
    const [{ rows: typeRows }, cal, used] = await Promise.all([
      this.db.execute(`SELECT ${TYPE_COLUMNS} FROM leave_types ORDER BY name COLLATE NOCASE`),
      this.calendar(year, year),
      this.usage(employees.map((e) => e.id), year),
    ]);
    const types = typeRows.map(toType);
    return employees.map((employee) => {
      const mine = used.filter((u) => u.employeeId === employee.id);
      const balances: LeaveBalance[] = [];
      for (const t of types) {
        const of = mine.filter((u) => u.leaveTypeId === t.id);
        if (!t.active && !of.length) continue; // inactive types appear only while they still have usage
        const sum = (status: LeaveStatus, f: (u: Usage) => number) => round(of.filter((u) => u.status === status).reduce((n, u) => n + f(u), 0));
        const days = (u: Usage) => leaveDaysInYear(u, year, cal.holidays, cal.workdays(employee.id));
        const hours = (u: Usage) => shortHoursInMonth(u, month);
        const approvedDays = sum("APPROVED", days);
        const shortApprovedHours = sum("APPROVED", hours);
        balances.push({
          leaveType: t,
          year,
          allowanceDays: t.yearlyAllowanceDays,
          approvedDays,
          pendingDays: sum("PENDING", days),
          remainingDays: t.yearlyAllowanceDays === null ? null : round(t.yearlyAllowanceDays - approvedDays),
          month,
          shortHoursPerMonth: t.shortHoursPerMonth,
          shortApprovedHours,
          shortPendingHours: sum("PENDING", hours),
          shortRemainingHours: t.shortHoursPerMonth === null ? null : round(t.shortHoursPerMonth - shortApprovedHours),
        });
      }
      return { employee, balances };
    });
  }

  /** Refuses (409) an approval that would take the type's yearly days or monthly short hours past the limit. */
  private async assertWithinBalance(request: LeaveRequest) {
    const t = await this.type(request.leaveType.id);
    if (request.portion === "SHORT") {
      if (t.shortHoursPerMonth === null) return;
      const month = request.startDate.slice(0, 7);
      const used = (await this.usage([request.employee.id], Number(month.slice(0, 4))))
        .filter((u) => u.status === "APPROVED" && u.leaveTypeId === t.id)
        .reduce((n, u) => n + shortHoursInMonth(u, month), 0);
      const need = shortHoursInMonth(request, month);
      if (used + need > t.shortHoursPerMonth) {
        throw new ConflictException(
          `Approving this would exceed the ${t.name} short-leave limit for ${month}: ${round(Math.max(0, t.shortHoursPerMonth - used))} of ${t.shortHoursPerMonth} hours remain and this request uses ${round(need)}`,
        );
      }
      return;
    }
    if (t.yearlyAllowanceDays === null) return;
    const first = Number(request.startDate.slice(0, 4));
    const last = Number(request.endDate.slice(0, 4));
    const cal = await this.calendar(first, last);
    for (let year = first; year <= last; year++) {
      const used = (await this.usage([request.employee.id], year))
        .filter((u) => u.status === "APPROVED" && u.leaveTypeId === t.id)
        .reduce((n, u) => n + leaveDaysInYear(u, year, cal.holidays, cal.workdays(request.employee.id)), 0);
      const need = leaveDaysInYear(request, year, cal.holidays, cal.workdays(request.employee.id));
      if (need && used + need > t.yearlyAllowanceDays) {
        throw new ConflictException(
          `Approving this would exceed the ${t.name} balance for ${year}: ${round(Math.max(0, t.yearlyAllowanceDays - used))} of ${t.yearlyAllowanceDays} days remain and this request uses ${round(need)}`,
        );
      }
    }
  }

  private isReviewer(caller: AuthContext) {
    return caller.role === "ADMIN";
  }

  private async close(request: LeaveRequest, status: Exclude<LeaveStatus, "PENDING">, actorId: string, note: string | null) {
    if (request.status !== "PENDING") throw new ConflictException(`This request is already ${request.status.toLowerCase()}`);
    const now = iso(Date.now());
    try {
      // The schema trigger rejects a second decision, so a concurrent one fails here (409).
      await this.db.execute({
        sql: "UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?",
        args: [status, actorId, now, note, now, request.id],
      });
    } catch (err) {
      if (guardViolation(err) === "already_reviewed") throw new ConflictException("This request has already been decided");
      throw err;
    }
    this.logger.log({ leaveId: request.id, employeeId: request.employee.id, actorId, status }, "Leave request decided");
  }
}

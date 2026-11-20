import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { guardViolation, type DatabaseClient, type InStatement, type Row } from "@workfolio/database";
import type {
  AttendanceSession,
  CorrectionRequest,
  CorrectionStatus,
  CorrectionType,
  CreateCorrection,
  Paginated,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { EmployeeLocks } from "../common/employee-locks.js";
import { DATABASE } from "../database/database.module.js";
import { EmployeesService } from "../employees/employees.service.js";
import { iso, SESSION_COLUMNS, str, withBreaks } from "./sessions.js";

/** Requested times may not be in the future (small allowance for clock drift). */
const FUTURE_TOLERANCE_MS = 60_000;

interface Proposal {
  type: CorrectionType;
  sessionId: string | null;
  breakId: string | null;
  proposed: Record<string, string>;
}

const SELECT = `
  SELECT r.id, r.employee_id, r.type, r.status, r.attendance_session_id, r.break_session_id, r.proposed, r.reason,
         r.requested_by, ru.email AS requester_email, r.created_at, r.reviewed_by, rv.email AS reviewer_email,
         r.reviewed_at, r.review_reason, p.full_name, p.employee_code, p.timezone,
         c.id AS correction_id, c.attendance_session_id AS applied_session_id, c.original_values, c.corrected_values
  FROM correction_requests r
  JOIN employee_profiles p ON p.id = r.employee_id
  JOIN users ru ON ru.id = r.requested_by
  LEFT JOIN users rv ON rv.id = r.reviewed_by
  LEFT JOIN attendance_corrections c ON c.request_id = r.id`;

const toRequest = (r: Row): CorrectionRequest => ({
  id: String(r.id),
  employee: { id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) },
  type: r.type as CorrectionType,
  status: r.status as CorrectionStatus,
  sessionId: str(r.attendance_session_id),
  breakId: str(r.break_session_id),
  proposed: JSON.parse(String(r.proposed)),
  reason: String(r.reason),
  requestedBy: { id: String(r.requested_by), email: String(r.requester_email) },
  requestedAt: String(r.created_at),
  reviewedBy: r.reviewed_by ? { id: String(r.reviewed_by), email: String(r.reviewer_email) } : null,
  reviewedAt: str(r.reviewed_at),
  reviewReason: str(r.review_reason),
  applied: r.correction_id
    ? {
        correctionId: String(r.correction_id),
        sessionId: String(r.applied_session_id),
        original: JSON.parse(String(r.original_values)),
        corrected: JSON.parse(String(r.corrected_values)),
      }
    : null,
});

/** The values a correction may change, as stored in the audit trail. */
const valuesOf = (s: AttendanceSession) => ({
  clockInAt: s.clockInAt,
  clockOutAt: s.clockOutAt,
  breaks: s.breaks.map(({ id, startedAt, endedAt }) => ({ id, startedAt, endedAt })),
});

/**
 * Employees request corrections; a different admin approves or rejects. Approval applies the
 * change and its audit row in one transaction. The attendance event log is never touched: it keeps
 * what devices actually sent, and attendance_corrections records what was changed, by whom and why.
 */
@Injectable()
export class CorrectionsService {
  private readonly logger = new Logger(CorrectionsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly employees: EmployeesService,
    private readonly locks: EmployeeLocks,
  ) {}

  async create(caller: AuthContext, input: CreateCorrection): Promise<CorrectionRequest> {
    const { type, reason, employeeId, ...rest } = input;
    // Own profile, or (attendance:review holders only) another employee; anyone else gets a 404.
    const employee = await this.employees.attendanceTarget(caller, employeeId, "attendance:review");
    const { sessionId = null, breakId = null, ...proposed } = rest as Record<string, string | undefined>;
    const proposal: Proposal = { type, sessionId, breakId, proposed: proposed as Record<string, string> };
    await this.validate(employee.id, proposal); // fail early; re-checked at approval
    const id = randomUUID();
    await this.db.execute({
      sql: `INSERT INTO correction_requests (id, employee_id, requested_by, type, attendance_session_id, break_session_id, proposed, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, employee.id, caller.id, type, sessionId, breakId, JSON.stringify(proposal.proposed), reason],
    });
    this.logger.log({ correctionId: id, employeeId: employee.id, actorId: caller.id, type, onBehalf: employee.userId !== caller.id }, "Correction requested");
    return this.get(caller, id);
  }

  /** Employees: their own requests. Admins: everyone's, optionally filtered. */
  async list(
    caller: AuthContext,
    q: { status?: CorrectionStatus; employeeId?: string; mine?: boolean; page: number; pageSize: number },
  ): Promise<Paginated<CorrectionRequest>> {
    const employeeId =
      // mine: the caller's own profile from the session (the schema rejects mine together with employeeId).
      q.mine || q.employeeId || !this.isReviewer(caller) ? (await this.employees.attendanceTarget(caller, q.mine ? undefined : q.employeeId)).id : null;
    const where = "WHERE (?1 IS NULL OR r.employee_id = ?1) AND (?2 IS NULL OR r.status = ?2)";
    const [rows, count] = await this.db.batch(
      [
        {
          sql: `${SELECT} ${where} ORDER BY r.created_at DESC, r.id LIMIT ?3 OFFSET ?4`,
          args: [employeeId, q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize],
        },
        { sql: `SELECT count(*) AS n FROM correction_requests r ${where}`, args: [employeeId, q.status ?? null] },
      ],
      "read",
    );
    return { items: rows!.rows.map(toRequest), total: Number(count!.rows[0]!.n), page: q.page, pageSize: q.pageSize };
  }

  async get(caller: AuthContext, id: string): Promise<CorrectionRequest> {
    const row = (await this.db.execute({ sql: `${SELECT} WHERE r.id = ?`, args: [id] })).rows[0];
    if (!row) throw new NotFoundException("Correction request not found");
    if (!this.isReviewer(caller)) await this.employees.attendanceTarget(caller, String(row.employee_id)); // 404 if not own
    return toRequest(row);
  }

  async approve(caller: AuthContext, id: string, reviewReason: string): Promise<CorrectionRequest> {
    const request = await this.reviewable(caller, id);
    await this.locks.run(request.employee.id, async () => {
      const proposal: Proposal = { type: request.type, sessionId: request.sessionId, breakId: request.breakId, proposed: request.proposed };
      const session = await this.validate(request.employee.id, proposal); // state may have changed since the request
      const now = iso(Date.now());
      const correctionId = randomUUID();
      const statements: InStatement[] = [
        // First, so a concurrent or repeated review aborts the whole transaction (trigger: already_reviewed).
        {
          sql: `UPDATE correction_requests SET status = 'APPROVED', reviewed_by = ?, reviewed_at = ?, review_reason = ?, updated_at = ?
                WHERE id = ?`,
          args: [caller.id, now, reviewReason, now, id],
        },
        ...this.changes(request.employee.id, proposal, session, correctionId, {
          requestId: id,
          requestedBy: request.requestedBy.id,
          approvedBy: caller.id,
          reason: request.reason,
          now,
        }),
      ];
      try {
        await this.db.batch(statements, "write");
      } catch (err) {
        if (guardViolation(err) === "already_reviewed") throw new ConflictException("This request has already been reviewed");
        if (guardViolation(err)) throw new ConflictException("The correction conflicts with existing attendance records");
        throw err;
      }
    });
    this.logger.log({ correctionId: id, employeeId: request.employee.id, actorId: caller.id }, "Correction approved and applied");
    return this.get(caller, id);
  }

  async reject(caller: AuthContext, id: string, reviewReason: string): Promise<CorrectionRequest> {
    const request = await this.reviewable(caller, id);
    const now = iso(Date.now());
    try {
      await this.db.execute({
        sql: `UPDATE correction_requests SET status = 'REJECTED', reviewed_by = ?, reviewed_at = ?, review_reason = ?, updated_at = ?
              WHERE id = ?`,
        args: [caller.id, now, reviewReason, now, id],
      });
    } catch (err) {
      if (guardViolation(err) === "already_reviewed") throw new ConflictException("This request has already been reviewed");
      throw err;
    }
    this.logger.log({ correctionId: id, employeeId: request.employee.id, actorId: caller.id }, "Correction rejected");
    return this.get(caller, id);
  }

  // ---- internals --------------------------------------------------------------

  private isReviewer(caller: AuthContext) {
    return caller.role === "ADMIN";
  }

  private async reviewable(caller: AuthContext, id: string): Promise<CorrectionRequest> {
    const request = await this.get(caller, id);
    if (request.requestedBy.id === caller.id) throw new ForbiddenException("You cannot review your own correction request");
    // A request made on someone's behalf (admin-initiated) is still about their attendance: they never review it.
    const subject = (await this.db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [request.employee.id] })).rows[0];
    if (subject && String(subject.user_id) === caller.id) throw new ForbiddenException("You cannot review a correction of your own attendance");
    if (request.status !== "PENDING") throw new ConflictException("This request has already been reviewed");
    return request;
  }

  private async session(employeeId: string, sessionId: string | null): Promise<AttendanceSession> {
    const { rows } = await this.db.execute({
      sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.id = ? AND s.employee_id = ?`,
      args: [sessionId, employeeId],
    });
    const [session] = await withBreaks(this.db, rows);
    if (!session) throw new NotFoundException("Shift not found");
    return session;
  }

  private async overlaps(employeeId: string, start: string, end: string | null, exceptId: string | null) {
    const { rows } = await this.db.execute({
      sql: `SELECT 1 FROM attendance_sessions WHERE employee_id = ? AND id IS NOT ? AND clock_in_at < ? AND coalesce(clock_out_at, '9999') > ? LIMIT 1`,
      args: [employeeId, exceptId, end ?? "9999", start],
    });
    return rows.length > 0;
  }

  /** Checks the proposal against current records. Returns the target session (null for a new shift). */
  private async validate(employeeId: string, p: Proposal): Promise<AttendanceSession | null> {
    const conflict = (message: string): never => {
      throw new ConflictException(message);
    };
    const latest = iso(Date.now() + FUTURE_TOLERANCE_MS);
    if (Object.values(p.proposed).some((t) => t > latest)) conflict("Corrected times cannot be in the future");
    const v = p.proposed;

    if (p.type === "MISSING_CLOCK_IN") {
      const devices = await this.db.execute({ sql: "SELECT 1 FROM devices WHERE employee_id = ? LIMIT 1", args: [employeeId] });
      if (!devices.rows.length) conflict("Register this device before requesting a missing shift");
      if (await this.overlaps(employeeId, v.clockInAt!, v.clockOutAt!, null)) conflict("This shift overlaps an existing shift");
      return null;
    }
    const s = await this.session(employeeId, p.sessionId);
    const firstBreak = s.breaks[0]?.startedAt;
    const lastBreakEnd = s.breaks.map((b) => b.endedAt ?? "").sort().at(-1);

    if (p.type === "MISSING_CLOCK_OUT") {
      if (s.clockOutAt) conflict("This shift already has a clock-out; request an attendance time correction instead");
      const open = s.breaks.find((b) => !b.endedAt);
      if (open && !v.breakEndedAt) conflict("You are on a break in this shift; also give the break end time");
      if (!open && v.breakEndedAt) conflict("This shift has no open break");
      if (open && (v.breakEndedAt! < open.startedAt || v.breakEndedAt! > v.clockOutAt!)) {
        conflict("The break must end after it started and before the clock-out");
      }
      if (v.clockOutAt! <= s.clockInAt) conflict("Clock-out must be after clock-in");
      if (s.breaks.some((b) => b.endedAt && b.endedAt > v.clockOutAt!)) conflict("Clock-out must be after every break");
    }

    if (p.type === "BREAK_TIME") {
      const brk = s.breaks.find((b) => b.id === p.breakId);
      if (!brk) throw new NotFoundException("Break not found");
      if (!brk.endedAt) conflict("End the break before correcting it");
      if (v.startedAt! < s.clockInAt || (s.clockOutAt && v.endedAt! > s.clockOutAt)) conflict("The break must be within the shift");
      if (s.breaks.some((b) => b.id !== brk.id && b.startedAt < v.endedAt! && (b.endedAt ?? "9999") > v.startedAt!)) {
        conflict("The break overlaps another break");
      }
    }

    if (p.type === "ATTENDANCE_TIME") {
      if (!s.clockOutAt && v.clockOutAt) conflict("This shift is still open; request a missing clock-out instead");
      const clockIn = v.clockInAt ?? s.clockInAt;
      const clockOut = v.clockOutAt ?? s.clockOutAt;
      if (clockOut && clockOut <= clockIn) conflict("Clock-out must be after clock-in");
      if (firstBreak && clockIn > firstBreak) conflict("Clock-in must be before the first break");
      if (clockOut && lastBreakEnd && clockOut < lastBreakEnd) conflict("Clock-out must be after every break");
      if (await this.overlaps(employeeId, clockIn, clockOut, s.id)) conflict("This change would overlap another shift");
    }
    return s;
  }

  /** Audit row first, then the changes that reference it (required by the schema triggers). */
  private changes(
    employeeId: string,
    p: Proposal,
    session: AttendanceSession | null,
    correctionId: string,
    meta: { requestId: string; requestedBy: string; approvedBy: string; reason: string; now: string },
  ): InStatement[] {
    const v = p.proposed;
    const sessionId = session?.id ?? randomUUID();
    const before = session ? valuesOf(session) : null;
    const after = session
      ? valuesOf({
          ...session,
          clockInAt: v.clockInAt ?? session.clockInAt,
          clockOutAt: v.clockOutAt ?? session.clockOutAt,
          breaks: session.breaks.map((b) =>
            b.id === p.breakId
              ? { ...b, startedAt: v.startedAt!, endedAt: v.endedAt! }
              : !b.endedAt && v.breakEndedAt
                ? { ...b, endedAt: v.breakEndedAt }
                : b,
          ),
        })
      : { clockInAt: v.clockInAt!, clockOutAt: v.clockOutAt!, breaks: [] };
    const audit: InStatement = {
      sql: `INSERT INTO attendance_corrections
              (id, attendance_session_id, requested_by, approved_by, original_values, corrected_values, reason, request_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [correctionId, sessionId, meta.requestedBy, meta.approvedBy, JSON.stringify(before), JSON.stringify(after), meta.reason, meta.requestId],
    };
    const touchSession = (sets: string, args: (string | null)[]): InStatement => ({
      sql: `UPDATE attendance_sessions SET ${sets}, correction_id = ?, updated_at = ? WHERE id = ?`,
      args: [...args, correctionId, meta.now, sessionId],
    });

    switch (p.type) {
      case "MISSING_CLOCK_IN":
        return [
          // Attributed to the employee's most recently registered device (the session needs one).
          {
            sql: `INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status)
                  SELECT ?, ?, id, ?, ?, 'CLOSED' FROM devices WHERE employee_id = ? ORDER BY registered_at DESC LIMIT 1`,
            args: [sessionId, employeeId, v.clockInAt!, v.clockOutAt!, employeeId],
          },
          audit,
          touchSession("status = 'CLOSED'", []),
        ];
      case "MISSING_CLOCK_OUT": {
        const open = session!.breaks.find((b) => !b.endedAt);
        return [
          audit,
          ...(open
            ? [{
                sql: "UPDATE break_sessions SET ended_at = ?, status = 'CLOSED', correction_id = ?, updated_at = ? WHERE id = ?",
                args: [v.breakEndedAt!, correctionId, meta.now, open.id],
              }]
            : []),
          touchSession("clock_out_at = ?, status = 'CLOSED'", [v.clockOutAt!]),
        ];
      }
      case "BREAK_TIME":
        return [
          audit,
          {
            sql: "UPDATE break_sessions SET started_at = ?, ended_at = ?, correction_id = ?, updated_at = ? WHERE id = ?",
            args: [v.startedAt!, v.endedAt!, correctionId, meta.now, p.breakId],
          },
        ];
      case "ATTENDANCE_TIME":
        return [
          audit,
          touchSession("clock_in_at = ?, clock_out_at = ?", [after.clockInAt, after.clockOutAt]),
        ];
    }
  }
}

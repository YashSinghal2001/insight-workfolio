import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isUniqueViolation, type DatabaseClient, type InStatement, type Row } from "@workfolio/database";
import { autoClockOutPlan, type ShiftSettings } from "@workfolio/shared";
import { accountAudit } from "../audit/account-audit.js";
import { iso, str } from "../attendance/sessions.js";
import { EmployeeLocks } from "../common/employee-locks.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { ScreenshotsService } from "../screenshots/screenshots.service.js";

/** Worker period. The clock-out time is the deadline itself, so a late run changes nothing but latency. */
const TICK_MS = 30_000;

const OPEN_SESSION = `
  SELECT s.id, s.employee_id, s.clock_in_at, p.user_id,
         sh.start_time, sh.end_time, sh.timezone, sh.grace_minutes, sh.auto_clock_out, sh.workdays, sh.updated_at,
         (SELECT max(max(b.started_at, coalesce(b.ended_at, b.started_at))) FROM break_sessions b WHERE b.attendance_session_id = s.id) AS last_break,
         (SELECT b.id FROM break_sessions b WHERE b.attendance_session_id = s.id AND b.ended_at IS NULL) AS open_break
  FROM attendance_sessions s
  JOIN employee_profiles p ON p.id = s.employee_id
  JOIN employee_shifts sh ON sh.employee_id = s.employee_id
  WHERE s.employee_id = ? AND s.status = 'OPEN'`;

export const shiftOf = (r: Row): ShiftSettings => ({
  startTime: String(r.start_time),
  endTime: String(r.end_time),
  timezone: String(r.timezone),
  graceMinutes: Number(r.grace_minutes),
  autoClockOut: Number(r.auto_clock_out) === 1,
  workdays: String(r.workdays),
  updatedAt: String(r.updated_at),
});

/** The plan for an OPEN_SESSION row (last change = clock-in or the latest break boundary). */
const planOf = (r: Row) => {
  const lastBreak = str(r.last_break);
  const clockInAt = String(r.clock_in_at);
  return autoClockOutPlan(shiftOf(r), { clockInAt, lastChangeAt: lastBreak && lastBreak > clockInAt ? lastBreak : clockInAt });
};

/**
 * Automatic clock-out at shift end + grace (docs/EMPLOYEE-SHIFT-MANAGEMENT.md). A server-side worker, so it
 * needs no desktop app and catches up on start after downtime. One write transaction per session clocks out
 * (at the scheduled time, never the run time), ends an open break and writes the audit rows: all or nothing,
 * so a failure leaves nothing half-done and the next run retries (each failure is recorded in
 * auto_clock_out_failures). Sign-in sessions are never touched: clock-out is not sign-out.
 * Several API instances may run it at once: the record's UNIQUE(session) and the OPEN check let one win.
 * Attendance writes also call processDue first (under the employee lock), so no action can be accepted
 * after the deadline just because the worker has not run yet.
 */
@Injectable()
export class AutoClockOutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoClockOutService.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly locks: EmployeeLocks,
    private readonly screenshots: ScreenshotsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit() {
    if (this.config.get("NODE_ENV", { infer: true }) !== "test") this.start();
  }

  /** Catch-up sweep at once (overdue clock-outs from before a restart or downtime), then every TICK_MS. */
  start() {
    const run = () => void this.sweep().catch((err: Error) => this.logger.error({ err: err.message }, "Automatic clock-out sweep failed"));
    setImmediate(run); // overdue clock-outs from before a restart are processed at once
    this.timer = setInterval(run, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Clocks out every open session whose automatic clock-out time is at or before `now`. Returns how many. */
  async sweep(now = Date.now()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const { rows } = await this.db.execute(
        "SELECT s.employee_id FROM attendance_sessions s JOIN employee_shifts sh ON sh.employee_id = s.employee_id WHERE s.status = 'OPEN' AND sh.auto_clock_out = 1",
      );
      let done = 0;
      for (const r of rows) {
        const employeeId = String(r.employee_id);
        try {
          if (await this.locks.run(employeeId, () => this.processDue(employeeId, now))) done++;
        } catch (err) {
          // Nothing was written (one transaction); the next run retries.
          const error = ((err as Error).message || "unknown error").slice(0, 500);
          this.logger.error({ employeeId, err: error }, "Automatic clock-out failed; will retry");
          await this.db
            .execute({
              sql: "INSERT INTO auto_clock_out_failures (id, employee_id, attendance_session_id, error) SELECT ?, ?, id, ? FROM attendance_sessions WHERE employee_id = ? AND status = 'OPEN' LIMIT 1",
              args: [randomUUID(), employeeId, error, employeeId],
            })
            .catch((e: Error) => this.logger.error({ employeeId, err: e.message }, "Recording the automatic clock-out failure failed"));
        }
      }
      return done;
    } finally {
      this.sweeping = false;
    }
  }

  /** The open session's scheduled shift end and automatic clock-out time, or nulls. */
  async planned(employeeId: string): Promise<{ shiftEndAt: string | null; autoClockOutAt: string | null }> {
    const row = (await this.db.execute({ sql: OPEN_SESSION, args: [employeeId] })).rows[0];
    const plan = row && planOf(row);
    return plan ? { shiftEndAt: plan.occurrence.endAt, autoClockOutAt: plan.clockOutAt } : { shiftEndAt: null, autoClockOutAt: null };
  }

  /**
   * Clocks the employee's open session out when its automatic clock-out time is at or before `atMs`.
   * The caller holds the employee lock (EmployeeLocks). Returns true when this call did it.
   */
  async processDue(employeeId: string, atMs = Date.now()): Promise<boolean> {
    const row = (await this.db.execute({ sql: OPEN_SESSION, args: [employeeId] })).rows[0];
    const plan = row && planOf(row);
    if (!row || !plan || Date.parse(plan.clockOutAt) > Math.min(atMs, Date.now())) return false;

    const id = randomUUID();
    const sessionId = String(row.id);
    const userId = String(row.user_id);
    const openBreak = str(row.open_break);
    const at = plan.clockOutAt;
    const now = iso(Date.now());
    const mine = "EXISTS (SELECT 1 FROM auto_clock_outs WHERE id = ?)";
    const shift = shiftOf(row);
    const statements: InStatement[] = [
      // First: claims the session. Inserts nothing if it was clocked out meanwhile; a concurrent worker's
      // claim hits UNIQUE(attendance_session_id) and rolls back. Every later statement requires this row.
      {
        sql: `INSERT INTO auto_clock_outs (id, attendance_session_id, employee_id, shift_start_time, shift_end_time, shift_timezone, grace_minutes,
                scheduled_shift_end_at, deadline_at, clock_out_at, processed_at, reason, break_ended)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTOMATIC_SHIFT_END', ?
              WHERE EXISTS (SELECT 1 FROM attendance_sessions WHERE id = ? AND status = 'OPEN')`,
        args: [id, sessionId, employeeId, shift.startTime, shift.endTime, shift.timezone, shift.graceMinutes, plan.occurrence.endAt, plan.occurrence.deadlineAt, at, now, openBreak ? 1 : 0, sessionId],
      },
      ...(openBreak ? [{ sql: `UPDATE break_sessions SET ended_at = ?, status = 'CLOSED', updated_at = ? WHERE id = ? AND ended_at IS NULL AND ${mine}`, args: [at, now, openBreak, id] }] : []),
      { sql: `UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED', updated_at = ? WHERE id = ? AND status = 'OPEN' AND ${mine}`, args: [at, now, sessionId, id] },
      // As on a manual clock-out: the device's "active/idle right now" report ends with the session.
      { sql: `UPDATE devices SET activity_state = NULL, activity_state_since = NULL, activity_state_at = NULL WHERE employee_id = ? AND ${mine}`, args: [employeeId, id] },
      // Ids and times only. Actor NULL = the server.
      accountAudit(
        {
          actorUserId: null,
          targetUserId: userId,
          action: "AUTO_CLOCK_OUT",
          resourceType: "ACCOUNT",
          resourceId: userId,
          metadata: { employeeId, attendanceSessionId: sessionId, scheduledShiftEndAt: plan.occurrence.endAt, deadlineAt: plan.occurrence.deadlineAt, clockOutAt: at, processedAt: now, cause: "AUTOMATIC_SHIFT_END" },
        },
        mine,
        { whenArgs: [id] },
      ),
    ];
    let claimed: boolean;
    try {
      claimed = (await this.db.batch(statements, "write"))[0]!.rowsAffected === 1;
    } catch (err) {
      if (isUniqueViolation(err, "auto_clock_outs.attendance_session_id")) return false; // another worker won
      throw err;
    }
    if (!claimed) return false; // clocked out manually meanwhile
    this.logger.log({ employeeId, attendanceSessionId: sessionId, clockOutAt: at }, "Automatic clock-out at shift end");
    // Like a manual clock-out: screenshots captured after it are not work time.
    await this.screenshots.discardOutsideWork(employeeId, Date.parse(at)).catch((err: Error) => this.logger.warn({ employeeId, err: err.message }, "Discarding screenshots after automatic clock-out failed"));
    return true;
  }
}

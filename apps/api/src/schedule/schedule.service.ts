import { Inject, Injectable, Logger } from "@nestjs/common";
import type { DatabaseClient, Row } from "@workfolio/database";
import {
  addDays,
  DAILY_ATTENDANCE_STATUSES,
  dailyAttendanceStatus,
  DEFAULT_WORK_SCHEDULE,
  localDate,
  toZonedLocal,
  withScheduleOverride,
  zonedToUtc,
  type DailyAttendanceQuery,
  type DailyAttendanceResponse,
  type DailyAttendanceRow,
  type DailyAttendanceStatus,
  type ExpectedScheduleResponse,
  type ExpectedWorkDay,
  type LeavePortion,
  type WorkScheduleInput,
  type WorkSchedulePolicy,
  type WorkScheduleResponse,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { str } from "../attendance/sessions.js";
import { scopeSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";

const COLUMNS = "p.seq, p.enabled, p.expected_start, p.grace_minutes, p.workdays, p.reason, p.effective_at, u.id AS user_id, u.email";
const toPolicy = (r: Row): WorkSchedulePolicy => ({
  seq: Number(r.seq),
  enabled: Number(r.enabled) === 1,
  expectedStart: String(r.expected_start),
  graceMinutes: Number(r.grace_minutes),
  workdays: String(r.workdays),
  changedBy: { id: String(r.user_id), email: String(r.email) },
  reason: String(r.reason),
  effectiveAt: String(r.effective_at),
});
/** The organisation policy row in force at `dayStart` with the employee's override in force then (W17); null = no policy yet. */
function effectiveAt(policies: Row[], overrides: Row[], dayStart: string) {
  const p = policies.filter((x) => String(x.effective_at) <= dayStart).at(-1);
  const o = overrides.filter((x) => String(x.effective_at) <= dayStart).at(-1);
  const org = p ? { enabled: Number(p.enabled) === 1, expectedStart: String(p.expected_start), graceMinutes: Number(p.grace_minutes), workdays: String(p.workdays) } : null;
  return org && withScheduleOverride(org, o && { expectedStart: o.expected_start as string | null, workdays: o.workdays as string | null });
}
const DEFAULT_POLICY: WorkSchedulePolicy = { ...DEFAULT_WORK_SCHEDULE, seq: null, changedBy: null, reason: null, effectiveAt: null };

/**
 * Work schedule (W17/W18): one organisation-wide, append-only policy (with per-employee start/workday
 * overrides, see EmployeeTrackingService) and the daily status it implies. Nobody is labelled late or absent without an enabled policy in force on that day.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  async overview(): Promise<WorkScheduleResponse> {
    const { rows } = await this.db.execute(`SELECT ${COLUMNS} FROM work_schedule_policies p JOIN users u ON u.id = p.changed_by ORDER BY p.seq DESC LIMIT 100`);
    const history = rows.map(toPolicy);
    return { current: history[0] ?? DEFAULT_POLICY, history };
  }

  async update(admin: AuthContext, input: WorkScheduleInput): Promise<WorkScheduleResponse> {
    await this.db.execute({
      sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by) VALUES (?, ?, ?, ?, ?, ?)",
      args: [input.enabled ? 1 : 0, input.expectedStart, input.graceMinutes, input.workdays, input.reason, admin.id],
    });
    this.logger.log({ actorId: admin.id, enabled: input.enabled }, "Work schedule changed");
    return this.overview();
  }

  /**
   * Every active employee (active account and employment) whose profile existed on that date, with
   * the date read in their own time zone. The policy version in force at the start of their local day
   * applies, so a change takes effect from the next local day and never relabels the past.
   */
  async daily(q: DailyAttendanceQuery, now = Date.now(), caller?: AuthContext): Promise<DailyAttendanceResponse> {
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    // W41: a team head sees only their teams' members; no caller (the alert evaluator) = whole organisation.
    const scope = caller ? scopeSql(caller, "attendance:read-all", "p.id") : { sql: "", args: [] };
    const [people, policies, sessions, leave, holiday, anyHoliday, overrides] = await this.db.batch(
      [
        {
          sql: `SELECT p.id, p.full_name, p.employee_code, p.timezone, p.created_at FROM employee_profiles p JOIN users u ON u.id = p.user_id
                WHERE p.employment_status = 'ACTIVE' AND u.status = 'ACTIVE'
                  AND (?1 IS NULL OR p.full_name LIKE ?1 ESCAPE '\\' OR u.email LIKE ?1 ESCAPE '\\' OR p.employee_code LIKE ?1 ESCAPE '\\')${scope.sql.replace("?", "?2")}
                ORDER BY p.full_name COLLATE NOCASE, p.id`,
          args: [like, ...scope.args],
        },
        "SELECT enabled, expected_start, grace_minutes, workdays, effective_at FROM work_schedule_policies ORDER BY effective_at, seq",
        // Widened to cover every UTC offset (-12 … +14); each employee's local day is applied below.
        {
          sql: "SELECT employee_id, clock_in_at FROM attendance_sessions WHERE clock_in_at >= ? AND clock_in_at < ?",
          args: [`${addDays(q.date, -1)}T00:00:00.000Z`, `${addDays(q.date, 2)}T00:00:00.000Z`],
        },
        {
          sql: `SELECT id, employee_id, portion, start_time, end_time FROM leave_requests
                WHERE status = 'APPROVED' AND start_date <= ?1 AND end_date >= ?1 ORDER BY portion = 'FULL_DAY' DESC, start_time`,
          args: [q.date],
        },
        // Holidays are local dates: q.date is read in each employee's own zone, so one row applies to all.
        { sql: "SELECT name FROM holidays WHERE date = ?", args: [q.date] },
        "SELECT EXISTS (SELECT 1 FROM holidays) AS any",
        // ponytail: every override version for every employee; filter per employee below (small table).
        "SELECT employee_id, expected_start, workdays, effective_at FROM employee_tracking_overrides ORDER BY effective_at, rowid",
      ],
      "read",
    );
    const clockIns = new Map<string, string[]>();
    for (const r of sessions!.rows) clockIns.set(String(r.employee_id), [...(clockIns.get(String(r.employee_id)) ?? []), String(r.clock_in_at)]);
    const leaveBy = new Map<string, Row>();
    for (const r of leave!.rows) if (!leaveBy.has(String(r.employee_id))) leaveBy.set(String(r.employee_id), r);

    const h = holiday!.rows[0];
    const rows: DailyAttendanceRow[] = [];
    for (const r of people!.rows) {
      const tz = String(r.timezone);
      if (localDate(String(r.created_at), tz) > q.date) continue; // not an employee yet that day
      const dayStart = zonedToUtc(`${q.date}T00:00`, tz);
      const dayEnd = zonedToUtc(`${addDays(q.date, 1)}T00:00`, tz);
      // The employee's override in force at the start of their local day (W17), like the policy itself.
      const policy = effectiveAt(policies!.rows, overrides!.rows.filter((x) => x.employee_id === r.id), dayStart);
      const first = (clockIns.get(String(r.id)) ?? []).filter((t) => t >= dayStart && t < dayEnd).sort()[0] ?? null;
      const l = leaveBy.get(String(r.id));
      const status = dailyAttendanceStatus({
        date: q.date,
        timeZone: tz,
        policy,
        firstClockInAt: first,
        onLeave: !!l,
        holiday: !!h,
        now,
      });
      rows.push({
        employee: { id: String(r.id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: tz },
        date: q.date,
        ...status,
        firstClockInAt: first,
        firstClockInLocal: first ? toZonedLocal(first, tz) : null,
        leave: l ? { id: String(l.id), portion: l.portion as LeavePortion, startTime: str(l.start_time), endTime: str(l.end_time) } : null,
        holiday: h ? { name: String(h.name) } : null,
      });
    }
    const summary = Object.fromEntries(DAILY_ATTENDANCE_STATUSES.map((s) => [s, 0])) as Record<DailyAttendanceStatus, number>;
    for (const row of rows) summary[row.status]++;
    // ponytail: statuses computed for every matching employee, then paged in memory (fine for one organisation's headcount).
    return {
      date: q.date,
      items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      total: rows.length,
      page: q.page,
      pageSize: q.pageSize,
      summary,
      meta: {
        holidaysConfigured: Number(anyHoliday!.rows[0]!.any) === 1,
        perPersonOverrides: true,
        policyRule: "The schedule version (and the employee's start/workday override) in force at the start of each employee's local day applies to that day; changes take effect from the next local day.",
      },
    };
  }

  /**
   * W24: the expected start of each scheduled local date in [from, to] for one employee, by the same
   * rules as daily(): the policy and the employee's override in force at the start of that local day;
   * no enabled policy, non-workdays and holidays have no window.
   */
  async expected(e: { id: string; timezone: string }, from: string, to: string): Promise<ExpectedScheduleResponse> {
    const [policies, overrides, holidays] = await this.db.batch(
      [
        "SELECT enabled, expected_start, grace_minutes, workdays, effective_at FROM work_schedule_policies ORDER BY effective_at, seq",
        { sql: "SELECT expected_start, workdays, effective_at FROM employee_tracking_overrides WHERE employee_id = ? ORDER BY effective_at, rowid", args: [e.id] },
        { sql: "SELECT date FROM holidays WHERE date >= ? AND date <= ?", args: [from, to] },
      ],
      "read",
    );
    const holiday = new Set(holidays!.rows.map((r) => String(r.date)));
    const days: ExpectedWorkDay[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const policy = effectiveAt(policies!.rows, overrides!.rows, zonedToUtc(`${date}T00:00`, e.timezone));
      const { dueAt } = dailyAttendanceStatus({ date, timeZone: e.timezone, policy, firstClockInAt: null, onLeave: false, holiday: holiday.has(date), now: 0 });
      if (policy && dueAt) days.push({ date, startAt: zonedToUtc(`${date}T${policy.expectedStart}`, e.timezone), dueAt });
    }
    return { employeeId: e.id, timezone: e.timezone, days };
  }
}

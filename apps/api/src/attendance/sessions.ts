// Session reads shared by attendance, timesheet and correction services.
import type { DatabaseClient, Row } from "@workfolio/database";
import { addDays, type ShiftActivity } from "@workfolio/shared";
import type { AttendanceBreak, AttendanceSession, AttendanceState, DeviceActivityReport, DeviceActivityState, DeviceScreenshotState, EmployeeRef, SessionSource } from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { scopeSql, teamFilterSql } from "../common/scope.js";

/** Columns for `FROM attendance_sessions s`. Source = how the current clock-in time was recorded. */
export const SESSION_COLUMNS = `s.id, s.employee_id, s.clock_in_at, s.clock_out_at, s.status,
  (s.correction_id IS NOT NULL OR EXISTS (
     SELECT 1 FROM break_sessions b WHERE b.attendance_session_id = s.id AND b.correction_id IS NOT NULL)) AS corrected,
  coalesce((SELECT e.source FROM attendance_events e
            WHERE e.employee_id = s.employee_id AND e.event_type = 'CLOCK_IN' AND e.outcome = 'ACCEPTED'
              AND e.occurred_at = s.clock_in_at LIMIT 1), 'CORRECTION') AS clock_in_source`;

export const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
export const iso = (ms: number) => new Date(ms).toISOString();

/** Splits a list into parts of at most `size` (keeps every query below SQLite's bound-parameter limit). */
export const chunks = <T>(xs: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));
const BREAK_IDS_PER_QUERY = 5000;
const EMPLOYEES_PER_QUERY = 500;

/** Rows selected with SESSION_COLUMNS, with their breaks attached (one extra query per 5000 sessions). */
export async function withBreaks(db: DatabaseClient, rows: Row[]): Promise<AttendanceSession[]> {
  if (!rows.length) return [];
  const bySession = new Map<string, AttendanceBreak[]>();
  for (const part of chunks(rows, BREAK_IDS_PER_QUERY)) {
    const { rows: breaks } = await db.execute({
      sql: `SELECT id, attendance_session_id, started_at, ended_at FROM break_sessions
            WHERE attendance_session_id IN (${part.map(() => "?").join(", ")}) ORDER BY started_at`,
      args: part.map((r) => String(r.id)),
    });
    for (const b of breaks) {
      const key = String(b.attendance_session_id);
      const list = bySession.get(key) ?? [];
      list.push({ id: String(b.id), startedAt: String(b.started_at), endedAt: str(b.ended_at) });
      bySession.set(key, list);
    }
  }
  return rows.map((r) => ({
    id: String(r.id),
    clockInAt: String(r.clock_in_at),
    clockOutAt: str(r.clock_out_at),
    status: r.status as AttendanceSession["status"],
    corrected: Boolean(r.corrected),
    clockInSource: r.clock_in_source as SessionSource,
    breaks: bySession.get(String(r.id)) ?? [],
  }));
}

/**
 * The employees' sessions clocked in within a UTC window that covers local dates [from, to] in every zone (a day of
 * slack each side; callers keep each employee's own local dates), with breaks, owner and the recorded ACTIVE / IDLE
 * sums per session. Queried per 500 employees, so any head count and range stays within SQLite's parameter limit.
 */
export async function rangeSessions(
  db: DatabaseClient,
  employeeIds: readonly string[],
  from: string,
  to: string,
): Promise<{ byEmployee: Map<string, AttendanceSession[]>; activity: Map<string, ShiftActivity> }> {
  const byEmployee = new Map<string, AttendanceSession[]>();
  const activity = new Map<string, ShiftActivity>();
  const window = [`${addDays(from, -1)}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`];
  for (const ids of chunks(employeeIds, EMPLOYEES_PER_QUERY)) {
    const inRange = `employee_id IN (${ids.map(() => "?").join(", ")}) AND clock_in_at >= ? AND clock_in_at < ?`;
    const args = [...ids, ...window];
    const [sessions, sums] = await db.batch(
      [
        { sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.${inRange}`, args },
        {
          sql: `SELECT attendance_session_id AS id,
                  coalesce(sum(CASE WHEN kind = 'ACTIVE' THEN active_seconds END), 0) AS active,
                  coalesce(sum(CASE WHEN kind = 'IDLE' THEN idle_seconds END), 0) AS idle
                FROM activity_intervals WHERE attendance_session_id IN (SELECT id FROM attendance_sessions WHERE ${inRange})
                GROUP BY attendance_session_id`,
          args,
        },
      ],
      "read",
    );
    for (const r of sums!.rows) activity.set(String(r.id), { activeMs: Number(r.active) * 1000, idleMs: Number(r.idle) * 1000 });
    const all = await withBreaks(db, sessions!.rows);
    sessions!.rows.forEach((r, i) => {
      const owner = String(r.employee_id);
      const list = byEmployee.get(owner) ?? [];
      list.push(all[i]!);
      byEmployee.set(owner, list);
    });
  }
  return { byEmployee, activity };
}

export function stateOf(session: AttendanceSession | null): AttendanceState {
  if (!session || session.clockOutAt) return "CLOCKED_OUT";
  return session.breaks.some((b) => !b.endedAt) ? "ON_BREAK" : "CLOCKED_IN";
}

/** Clocked-in, non-break time of one session: what activity and screenshots must fall inside. */
export interface Segment {
  sessionId: string;
  start: number;
  end: number;
  /** Clocked in right now (the segment runs to "now"). */
  open: boolean;
}

/** The query window is widened by this much so edge tolerances can be applied by callers. */
const SEGMENT_QUERY_MARGIN_MS = 60_000;

/** Clocked-in segments (sessions minus breaks) overlapping [from, to]; an open session ends at `openEnd`. */
export async function clockedInSegments(db: DatabaseClient, employeeId: string, from: number, to: number, openEnd: number): Promise<Segment[]> {
  const { rows } = await db.execute({
    sql: `SELECT s.id, s.clock_in_at, s.clock_out_at, b.started_at AS b_start, b.ended_at AS b_end
          FROM attendance_sessions s LEFT JOIN break_sessions b ON b.attendance_session_id = s.id
          WHERE s.employee_id = ? AND coalesce(s.clock_out_at, '9999') > ? AND s.clock_in_at < ?
          ORDER BY s.clock_in_at, b.started_at`,
    args: [employeeId, iso(from - SEGMENT_QUERY_MARGIN_MS), iso(to + SEGMENT_QUERY_MARGIN_MS)],
  });
  const out: Segment[] = [];
  const sessions = new Map<string, { start: number; end: number; open: boolean; breaks: [number, number][] }>();
  for (const r of rows) {
    const id = String(r.id);
    if (!sessions.has(id)) {
      const open = !r.clock_out_at;
      sessions.set(id, { start: Date.parse(String(r.clock_in_at)), end: open ? openEnd : Date.parse(String(r.clock_out_at)), open, breaks: [] });
    }
    if (r.b_start) sessions.get(id)!.breaks.push([Date.parse(String(r.b_start)), r.b_end ? Date.parse(String(r.b_end)) : Infinity]);
  }
  for (const [sessionId, s] of sessions) {
    let cursor = s.start;
    for (const [bs, be] of s.breaks) {
      if (bs > cursor) out.push({ sessionId, start: cursor, end: bs, open: false });
      cursor = be;
    }
    if (s.end > cursor) out.push({ sessionId, start: cursor, end: s.end, open: s.open });
  }
  return out;
}
/** For `employee_profiles p JOIN users u`: account active and employment not ended. */
export const ACTIVE_EMPLOYEE = "u.status = 'ACTIVE' AND p.employment_status <> 'TERMINATED'";

/** Columns of `devices` holding what the desktop last reported about "now" (migration 0029). */
export const DEVICE_LIVE_COLUMNS = "employee_id, last_seen_at, activity_state, activity_state_since, activity_state_at, screenshot_state, screenshot_state_at";

/** The device's last activity report, for deriveLiveStatus; null when it never reported (or was cleared at clock-out). */
export const activityReport = (r?: Row): DeviceActivityReport | null =>
  r?.activity_state && r.activity_state_since && r.activity_state_at
    ? { state: r.activity_state as DeviceActivityState, since: String(r.activity_state_since), reportedAt: String(r.activity_state_at) }
    : null;

/** The device's last screenshot report, for screenshotFeatureState. */
export const screenshotReport = (r?: Row): { state: DeviceScreenshotState; reportedAt: string } | null =>
  r?.screenshot_state && r.screenshot_state_at ? { state: r.screenshot_state as DeviceScreenshotState, reportedAt: String(r.screenshot_state_at) } : null;

/**
 * Employees in the caller's attendance:read-all scope, optionally one team's active members (teamFilterSql;
 * call assertTeamReadable first), searched and ordered like EmployeesService.list. `activeOnly` = active
 * account and employment (as /attendance/daily). Without `page` every match is returned.
 */
export async function scopedEmployees(
  db: DatabaseClient,
  caller: AuthContext | undefined,
  f: { q?: string; teamId?: string; activeOnly?: boolean; createdBefore?: string; page?: number; pageSize?: number },
): Promise<{ items: (EmployeeRef & { createdAt: string })[]; total: number }> {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const scope = caller ? scopeSql(caller, "attendance:read-all", "p.id") : { sql: "", args: [] };
  const team = teamFilterSql(f.teamId, "p.id");
  const where = `FROM employee_profiles p JOIN users u ON u.id = p.user_id
    WHERE (? IS NULL OR p.full_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR p.employee_code LIKE ? ESCAPE '\\')
      ${f.activeOnly ? "AND p.employment_status = 'ACTIVE' AND u.status = 'ACTIVE'" : ""} AND (? IS NULL OR p.created_at < ?)${scope.sql}${team.sql}`;
  const args = [like, like, like, like, f.createdBefore ?? null, f.createdBefore ?? null, ...scope.args, ...team.args];
  const paged = f.page !== undefined && f.pageSize !== undefined;
  const [rows, count] = await db.batch(
    [
      {
        sql: `SELECT p.id, p.full_name, p.employee_code, p.timezone, p.created_at ${where} ORDER BY p.full_name COLLATE NOCASE, p.id${paged ? " LIMIT ? OFFSET ?" : ""}`,
        args: paged ? [...args, f.pageSize!, (f.page! - 1) * f.pageSize!] : args,
      },
      { sql: `SELECT count(*) AS n ${where}`, args },
    ],
    "read",
  );
  return {
    items: rows!.rows.map((r) => ({ id: String(r.id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone), createdAt: String(r.created_at) })),
    total: Number(count!.rows[0]!.n),
  };
}

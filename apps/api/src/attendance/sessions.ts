// Session reads shared by attendance, timesheet and correction services.
import type { DatabaseClient, Row } from "@workfolio/database";
import type { AttendanceBreak, AttendanceSession, AttendanceState, DeviceActivityReport, DeviceActivityState, DeviceScreenshotState, SessionSource } from "@workfolio/shared";

/** Columns for `FROM attendance_sessions s`. Source = how the current clock-in time was recorded. */
export const SESSION_COLUMNS = `s.id, s.employee_id, s.clock_in_at, s.clock_out_at, s.status,
  (s.correction_id IS NOT NULL OR EXISTS (
     SELECT 1 FROM break_sessions b WHERE b.attendance_session_id = s.id AND b.correction_id IS NOT NULL)) AS corrected,
  coalesce((SELECT e.source FROM attendance_events e
            WHERE e.employee_id = s.employee_id AND e.event_type = 'CLOCK_IN' AND e.outcome = 'ACCEPTED'
              AND e.occurred_at = s.clock_in_at LIMIT 1), 'CORRECTION') AS clock_in_source`;

export const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
export const iso = (ms: number) => new Date(ms).toISOString();

/** Rows selected with SESSION_COLUMNS, with their breaks attached (one extra query). */
export async function withBreaks(db: DatabaseClient, rows: Row[]): Promise<AttendanceSession[]> {
  if (!rows.length) return [];
  const { rows: breaks } = await db.execute({
    sql: `SELECT id, attendance_session_id, started_at, ended_at FROM break_sessions
          WHERE attendance_session_id IN (${rows.map(() => "?").join(", ")}) ORDER BY started_at`,
    args: rows.map((r) => String(r.id)),
  });
  return rows.map((r) => ({
    id: String(r.id),
    clockInAt: String(r.clock_in_at),
    clockOutAt: str(r.clock_out_at),
    status: r.status as AttendanceSession["status"],
    corrected: Boolean(r.corrected),
    clockInSource: r.clock_in_source as SessionSource,
    breaks: breaks
      .filter((b) => b.attendance_session_id === r.id)
      .map((b): AttendanceBreak => ({ id: String(b.id), startedAt: String(b.started_at), endedAt: str(b.ended_at) })),
  }));
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

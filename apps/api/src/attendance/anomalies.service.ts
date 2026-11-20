import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient, Row } from "@workfolio/database";
import {
  ANOMALY_THRESHOLDS,
  dailyAttendanceStatus,
  detectAnomalies,
  localDate,
  toZonedLocal,
  zonedToUtc,
  type AccountStatus,
  type AttendanceAnomaly,
  type EmploymentStatus,
  type MissingClockOutsResponse,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { assertTeamReadable, scopeSql, teamFilterSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { effectiveAt } from "../schedule/schedule.service.js";
import { str } from "./sessions.js";

const PERMISSION = "attendance:read-all";

/** Expected start ("HH:MM") when the schedule in force at the start of the local day makes `date` a workday; null otherwise. */
function expectedStart(policies: Row[], overrides: Row[], date: string, timeZone: string, holiday: boolean): string | null {
  const policy = effectiveAt(policies, overrides, zonedToUtc(`${date}T00:00`, timeZone));
  if (!policy) return null;
  const { scheduled } = dailyAttendanceStatus({ date, timeZone, policy, firstClockInAt: null, onLeave: false, holiday, now: 0 });
  return scheduled ? policy.expectedStart : null;
}

/**
 * Open shifts that look forgotten (missing clock-out, stale device, long break). Flag only: nothing is
 * closed or changed; the fix is a correction request. Used by GET /attendance/missing-clock-outs and by
 * other modules (emails, Overview).
 */
@Injectable()
export class AnomaliesService {
  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  /**
   * Every currently open session with at least one reason. `caller` scopes the rows (team heads: their
   * teams; omitted: whole organisation, for schedulers). `teamId` narrows to one active team (404 if not
   * readable). One batched read, whatever the head count.
   */
  async missingClockOuts(caller?: AuthContext, teamId?: string, now = Date.now()): Promise<MissingClockOutsResponse> {
    if (caller) await assertTeamReadable(this.db, caller, PERMISSION, teamId);
    const scope = caller ? scopeSql(caller, PERMISSION, "s.employee_id") : { sql: "", args: [] };
    const team = teamFilterSql(teamId, "s.employee_id");
    const [sessions, policies, overrides, holidays] = await this.db.batch(
      [
        {
          sql: `SELECT s.id, s.employee_id, s.clock_in_at, p.full_name, p.employee_code, p.timezone, p.employment_status, u.status AS account_status,
                  (SELECT max(d.last_seen_at) FROM devices d WHERE d.employee_id = s.employee_id AND d.revoked_at IS NULL) AS last_seen_at,
                  (SELECT b.started_at FROM break_sessions b WHERE b.attendance_session_id = s.id AND b.ended_at IS NULL) AS open_break_since,
                  (SELECT r.id FROM correction_requests r WHERE r.attendance_session_id = s.id AND r.status = 'PENDING'
                    ORDER BY r.created_at, r.id LIMIT 1) AS pending_correction_id
                FROM attendance_sessions s JOIN employee_profiles p ON p.id = s.employee_id JOIN users u ON u.id = p.user_id
                WHERE s.clock_out_at IS NULL${scope.sql}${team.sql}
                ORDER BY s.clock_in_at, s.id`,
          args: [...scope.args, ...team.args],
        },
        "SELECT enabled, expected_start, grace_minutes, workdays, effective_at FROM work_schedule_policies ORDER BY effective_at, seq",
        `SELECT employee_id, expected_start, workdays, effective_at FROM employee_tracking_overrides
         WHERE employee_id IN (SELECT employee_id FROM attendance_sessions WHERE clock_out_at IS NULL) ORDER BY effective_at, rowid`,
        // Local dates of open clock-ins are at most a day before the earliest UTC one.
        "SELECT date FROM holidays WHERE date >= date((SELECT min(clock_in_at) FROM attendance_sessions WHERE clock_out_at IS NULL), '-1 day')",
      ],
      "read",
    );
    const holiday = new Set(holidays!.rows.map((r) => String(r.date)));
    const items: AttendanceAnomaly[] = [];
    for (const r of sessions!.rows) {
      const tz = String(r.timezone);
      const clockInAt = String(r.clock_in_at);
      const date = localDate(clockInAt, tz);
      const input = {
        clockInAt,
        clockOutAt: null,
        timeZone: tz,
        expectedStart: expectedStart(policies!.rows, overrides!.rows.filter((o) => o.employee_id === r.employee_id), date, tz, holiday.has(date)),
        lastDeviceSeenAt: str(r.last_seen_at),
        openBreakSince: str(r.open_break_since),
      };
      const reasons = detectAnomalies(input, now);
      if (!reasons.length) continue;
      items.push({
        employee: { id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: tz },
        accountStatus: r.account_status as AccountStatus,
        employmentStatus: r.employment_status as EmploymentStatus,
        sessionId: String(r.id),
        clockInAt,
        clockInLocal: toZonedLocal(clockInAt, tz),
        openForMinutes: Math.max(0, Math.floor((now - Date.parse(clockInAt)) / 60_000)),
        lastDeviceSeenAt: input.lastDeviceSeenAt,
        openBreakSince: input.openBreakSince,
        reasons,
        pendingCorrectionId: str(r.pending_correction_id),
      });
    }
    return { generatedAt: new Date(now).toISOString(), thresholds: ANOMALY_THRESHOLDS, items };
  }
}

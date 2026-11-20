import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  addDays,
  buildTimesheet,
  DEFAULT_TIMEZONE,
  localDate,
  RECENT_SCREENSHOTS,
  todayIn,
  TOP_APPS,
  UPCOMING_HOLIDAY_DAYS,
  UPCOMING_LEAVE_DAYS,
  WORKLOAD_DAYS,
  WORKLOAD_THRESHOLDS,
  workloadDays,
  zonedToUtc,
  type AttendancePolicy,
  type LeavePortion,
  type OverviewQuery,
  type OverviewResponse,
  type Permission,
} from "@workfolio/shared";
import { ACTIVE_EMPLOYEE, SESSION_COLUMNS, iso, withBreaks } from "../attendance/sessions.js";
import { AnomaliesService } from "../attendance/anomalies.service.js";
import { AttendanceService } from "../attendance/attendance.service.js";
import type { AuthContext } from "../auth/auth.service.js";
import { POLICY } from "../common/policy.js";
import { assertTeamReadable, readScope, scopeSql, teamFilterSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { HolidaysService } from "../holidays/holidays.service.js";
import { ScheduleService } from "../schedule/schedule.service.js";
import { ScreenshotsService } from "../screenshots/screenshots.service.js";

const READ = "attendance:read-all";
/** "All rows" for services that page: one organisation's headcount, computed in one pass anyway. */
const ALL = 100_000;

/**
 * GET /overview: every Overview widget in one round trip. Sections come from the existing services (same rules,
 * same scope); a section the caller may not read is null. Reads run in parallel.
 */
@Injectable()
export class OverviewService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
    private readonly attendance: AttendanceService,
    private readonly schedule: ScheduleService,
    private readonly anomalies: AnomaliesService,
    private readonly screenshots: ScreenshotsService,
    private readonly holidays: HolidaysService,
  ) {}

  async get(caller: AuthContext, q: OverviewQuery, now = Date.now()): Promise<OverviewResponse> {
    await assertTeamReadable(this.db, caller, READ, q.teamId);
    const date = q.date ?? todayIn(DEFAULT_TIMEZONE, now);
    const sees = (p: Permission) => readScope(caller, p) !== "own";
    const scoped = (p: Permission, column: string) => {
      const own = scopeSql(caller, p, column);
      const team = teamFilterSql(q.teamId, column);
      return { sql: own.sql + team.sql, args: [...own.args, ...team.args] };
    };
    const members = { page: 1, pageSize: ALL, teamId: q.teamId, activeOnly: true };

    const [summary, daily, anomalies, live, noDevice, screenshots, holidays, leaves] = await Promise.all([
      this.attendance.summary(date, now, caller, q.teamId),
      this.schedule.daily({ date, teamId: q.teamId, page: 1, pageSize: ALL }, now, caller),
      this.anomalies.missingClockOuts(caller, q.teamId, now),
      this.attendance.overview(members, caller),
      this.noDevice(scoped(READ, "p.id")),
      sees("screenshots:read") ? this.recentScreenshots(caller, date, q.teamId) : null,
      this.upcomingHolidays(date),
      sees("leave:read-all") ? this.upcomingLeaves(date, scoped("leave:read-all", "r.employee_id")) : null,
    ]);

    // Workload and today's hours: the timesheet engine over the last WORKLOAD_DAYS local days of each member.
    const from = addDays(date, 1 - WORKLOAD_DAYS);
    const dates = Array.from({ length: WORKLOAD_DAYS }, (_, i) => addDays(from, i));
    const ids = live.items.map((e) => e.employeeId);
    const sessions = await this.sessions(ids, from, date);
    const sheets = live.items.map((e) => buildTimesheet(sessions.get(e.employeeId) ?? [], { from, to: date, timeZone: e.timezone, policy: this.policy, now }));
    const minutes = (ms: number) => Math.floor(ms / 60_000);
    // Same members as the work-hours table (attendance scope = activity scope: both are the caller's teams or everyone).
    const topApps = sees("activity:read-all") ? await this.topApps(live.items.map((e) => ({ id: e.employeeId, timezone: e.timezone })), date) : null;

    const s = summary;
    const scheduled = daily.items.some((r) => r.scheduled !== null);
    return {
      date,
      teamId: q.teamId ?? null,
      generatedAt: iso(now),
      kpis: {
        totalMembers: s.totalActiveEmployees,
        workingNow: s.currentlyWorking,
        onBreak: s.onBreak,
        clockedOut: s.clockedOutToday,
        notStarted: s.notClockedInToday,
        onLeave: daily.summary.ON_LEAVE,
        appNotInstalled: noDevice,
        late: scheduled ? daily.summary.LATE : null,
        absent: scheduled ? daily.summary.ABSENT : null,
        missingClockOuts: anomalies.items.length,
        screenshotsStored: s.screenshotsStoredToday,
        netWorkMs: s.netWorkMsToday,
        breakMs: s.breakMsToday,
      },
      workload: {
        scheduledDailyMinutes: this.policy.scheduledDailyMinutes,
        thresholds: WORKLOAD_THRESHOLDS,
        days: workloadDays(dates, sheets.map((t) => new Map(t.days.map((d) => [d.date, minutes(d.netMs)]))), this.policy.scheduledDailyMinutes),
      },
      topApps,
      late: daily.items.filter((r) => r.status === "LATE"),
      absent: daily.items.filter((r) => r.status === "ABSENT"),
      missingClockOuts: anomalies.items,
      workHours: live.items.map((e, i) => {
        const day = sheets[i]!.days.find((d) => d.date === date);
        return {
          employee: { id: e.employeeId, fullName: e.fullName, employeeCode: e.employeeCode, timezone: e.timezone },
          workedMinutes: day ? minutes(day.netMs + day.inProgressNetMs) : 0,
          firstClockInAt: day?.firstClockIn ?? null,
          state: e.state,
          missingClockOut: e.missingClockOut,
          online: e.online,
          lastSeenAt: e.lastSeenAt,
        };
      }),
      recentScreenshots: screenshots,
      upcomingHolidays: holidays,
      upcomingLeaves: leaves,
      pendingApprovals: { leave: s.pendingLeaveCount, corrections: s.pendingCorrectionCount },
    };
  }

  /** Sessions (with breaks) of these employees that may start on a local date in [from, to]. */
  private async sessions(ids: string[], from: string, to: string) {
    const by = new Map<string, Awaited<ReturnType<typeof withBreaks>>>();
    if (!ids.length) return by;
    // A day of slack on each side covers every UTC offset; buildTimesheet keeps each employee's local dates.
    const { rows } = await this.db.execute({
      sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.employee_id IN (${ids.map(() => "?").join(", ")}) AND s.clock_in_at >= ? AND s.clock_in_at < ?`,
      args: [...ids, `${addDays(from, -1)}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`],
    });
    const all = await withBreaks(this.db, rows);
    rows.forEach((r, i) => {
      const id = String(r.employee_id);
      by.set(id, [...(by.get(id) ?? []), all[i]!]);
    });
    return by;
  }

  /** Active members in scope without a registered (non-revoked) device: the desktop app is not installed. */
  private async noDevice(scope: { sql: string; args: string[] }): Promise<number> {
    const { rows } = await this.db.execute({
      sql: `SELECT count(*) AS n FROM employee_profiles p JOIN users u ON u.id = p.user_id
            WHERE ${ACTIVE_EMPLOYEE} AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.employee_id = p.id AND d.revoked_at IS NULL)${scope.sql}`,
      args: scope.args,
    });
    return Number(rows[0]!.n);
  }

  /** Active time per application on each member's local date, largest first (rule of ActivityService.overview). */
  private async topApps(employees: { id: string; timezone: string }[], date: string): Promise<OverviewResponse["topApps"]> {
    if (!employees.length) return { totalActiveMs: 0, otherMs: 0, items: [] };
    // ponytail: 3 parameters per member in one VALUES list; split it beyond ~10k members (SQLite's parameter limit).
    const bounds = employees.flatMap((e) => [e.id, zonedToUtc(`${date}T00:00`, e.timezone), zonedToUtc(`${addDays(date, 1)}T00:00`, e.timezone)]);
    const { rows } = await this.db.execute({
      // The bare application_name comes from the latest interval (max), so a renamed app shows its current name.
      sql: `WITH b(emp, s, e) AS (VALUES ${employees.map(() => "(?, ?, ?)").join(", ")})
            SELECT a.application_name AS name, max(a.started_at) AS latest,
                   sum(max(0, round((julianday(min(a.ended_at, b.e)) - julianday(max(a.started_at, b.s))) * 86400000))) AS ms
            FROM b JOIN activity_intervals a ON a.employee_id = b.emp AND a.kind = 'ACTIVE' AND a.started_at < b.e AND a.ended_at > b.s
            GROUP BY coalesce(a.application_identifier, 'name:' || a.application_name)
            ORDER BY ms DESC, name`,
      args: bounds,
    });
    const all = rows.map((r) => ({ applicationName: String(r.name), activeMs: Number(r.ms) })).filter((a) => a.activeMs > 0);
    const items = all.slice(0, TOP_APPS);
    const totalActiveMs = all.reduce((n, a) => n + a.activeMs, 0);
    return { totalActiveMs, otherMs: totalActiveMs - items.reduce((n, a) => n + a.activeMs, 0), items };
  }

  /**
   * The newest stored screenshots captured on the date or the 6 days before, each read in its owner's zone
   * (metadata from the gallery read; the images load through /screenshots/:id/content, which writes the access log).
   */
  private async recentScreenshots(caller: AuthContext, date: string, teamId?: string): Promise<OverviewResponse["recentScreenshots"]> {
    const from = addDays(date, 1 - WORKLOAD_DAYS);
    // The gallery reads dates in one zone; a day of slack each side, then each owner's own local date.
    const page = await this.screenshots.gallery({ from: addDays(from, -1), to: addDays(date, 1), tz: DEFAULT_TIMEZONE, page: 1, pageSize: 60 }, caller);
    let team: Set<string> | null = null;
    if (teamId) {
      const f = teamFilterSql(teamId, "p.id");
      const { rows } = await this.db.execute({ sql: `SELECT p.id FROM employee_profiles p WHERE 1${f.sql}`, args: f.args });
      team = new Set(rows.map((r) => String(r.id)));
    }
    // ponytail: newest 60 then filtered (stored, dates, team); a team with nothing among them shows fewer than 12.
    const day = (i: (typeof page.items)[number]) => localDate(i.capturedAt, i.employee.timezone);
    return page.items
      .filter((i) => i.uploadStatus === "STORED" && day(i) >= from && day(i) <= date && (!team || team.has(i.employeeId)))
      .slice(0, RECENT_SCREENSHOTS);
  }

  private async upcomingHolidays(date: string): Promise<OverviewResponse["upcomingHolidays"]> {
    const to = addDays(date, UPCOMING_HOLIDAY_DAYS);
    const years = [...new Set([date.slice(0, 4), to.slice(0, 4)])].map(Number);
    const lists = await Promise.all(years.map((y) => this.holidays.list(y)));
    return lists.flat().filter((h) => h.date >= date && h.date <= to).map((h) => ({ id: h.id, date: h.date, name: h.name }));
  }

  /** Approved leave overlapping [date, date + UPCOMING_LEAVE_DAYS]. Reasons are never included. */
  private async upcomingLeaves(date: string, scope: { sql: string; args: string[] }): Promise<OverviewResponse["upcomingLeaves"]> {
    const { rows } = await this.db.execute({
      sql: `SELECT r.id, r.employee_id, p.full_name, p.employee_code, p.timezone, r.start_date, r.end_date, r.portion, t.name AS type_name
            FROM leave_requests r JOIN employee_profiles p ON p.id = r.employee_id JOIN leave_types t ON t.id = r.leave_type_id
            WHERE r.status = 'APPROVED' AND r.start_date <= ? AND r.end_date >= ?${scope.sql}
            ORDER BY r.start_date, p.full_name COLLATE NOCASE, r.id LIMIT 50`,
      args: [addDays(date, UPCOMING_LEAVE_DAYS), date, ...scope.args],
    });
    return rows.map((r) => ({
      id: String(r.id),
      employee: { id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) },
      startDate: String(r.start_date),
      endDate: String(r.end_date),
      portion: r.portion as LeavePortion,
      leaveType: String(r.type_name),
    }));
  }
}

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
  type AttendancePolicy,
  type LeavePortion,
  type OverviewQuery,
  type OverviewResponse,
  type Permission,
} from "@workfolio/shared";
import { ActivityService } from "../activity/activity.service.js";
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
    private readonly activity: ActivityService,
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

  /**
   * Active members in scope without a registered (non-revoked) device: the desktop app is not installed. Team heads
   * get this count too (a count only, no device details), as in the reference product: lead decision, W2 review.
   */
  private async noDevice(scope: { sql: string; args: string[] }): Promise<number> {
    const { rows } = await this.db.execute({
      sql: `SELECT count(*) AS n FROM employee_profiles p JOIN users u ON u.id = p.user_id
            WHERE ${ACTIVE_EMPLOYEE} AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.employee_id = p.id AND d.revoked_at IS NULL)${scope.sql}`,
      args: scope.args,
    });
    return Number(rows[0]!.n);
  }

  /** Active time per application on each member's local date (ActivityService.appTotals), top TOP_APPS + the rest. */
  private async topApps(employees: { id: string; timezone: string }[], date: string): Promise<OverviewResponse["topApps"]> {
    const all = await this.activity.appTotals(employees, date, date);
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
    // Stored and team-filtered in SQL (gallery read, scope unchanged); only the zone slack is filtered here.
    // ponytail: the newest 60 of the window; more than 48 stored in the slack day after the date would crowd it out.
    const page = await this.screenshots.gallery({ from: addDays(from, -1), to: addDays(date, 1), tz: DEFAULT_TIMEZONE, page: 1, pageSize: 60, teamId, status: "STORED" }, caller);
    const day = (i: (typeof page.items)[number]) => localDate(i.capturedAt, i.employee.timezone);
    return page.items.filter((i) => day(i) >= from && day(i) <= date).slice(0, RECENT_SCREENSHOTS);
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

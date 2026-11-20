import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient, InStatement } from "@workfolio/database";
import { addDays, buildTimelineSegments, zonedToUtc, type ActivityKind, type TeamTimelineQuery, type TeamTimelineResponse } from "@workfolio/shared";
import { ActivityCategoriesService } from "../activity/categories.service.js";
import { SESSION_COLUMNS, str, withBreaks } from "../attendance/sessions.js";
import { employeeReadAudit } from "../audit/account-audit.js";
import type { AuthContext } from "../auth/auth.service.js";
import { DATABASE } from "../database/database.module.js";
import { EmployeesService } from "../employees/employees.service.js";

/**
 * GET /activity/team-timeline: one page of employees (caller's activity:read-all scope, optional team), each with the
 * Gantt segments of their own local day. Four reads per page, whatever its size. Audited like /activity/timeline
 * (one EMPLOYEE_ACTIVITY_TIMELINE_VIEWED row per other employee shown, written together).
 */
@Injectable()
export class TeamTimelineService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly employees: EmployeesService,
    private readonly categories: ActivityCategoriesService,
  ) {}

  async timeline(q: TeamTimelineQuery, caller: AuthContext, now = Date.now()): Promise<TeamTimelineResponse> {
    const page = await this.employees.list({ page: q.page, pageSize: q.pageSize, teamId: q.teamId }, caller, "activity:read-all");
    const generatedAt = new Date(now).toISOString();
    if (!page.items.length) return { items: [], total: page.total, page: q.page, pageSize: q.pageSize, date: q.date, generatedAt };
    const days = new Map(page.items.map((e) => [e.id, [zonedToUtc(`${q.date}T00:00`, e.timezone), zonedToUtc(`${addDays(q.date, 1)}T00:00`, e.timezone)] as const]));
    const from = [...days.values()].map((d) => d[0]).sort()[0]!;
    const to = [...days.values()].map((d) => d[1]).sort().at(-1)!;
    const ids = page.items.map((e) => e.id);
    const inIds = `(${ids.map(() => "?").join(", ")})`;
    const [labels, [sessions, intervals]] = await Promise.all([
      this.categories.labelsFor(ids),
      this.db.batch(
        [
          { sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.employee_id IN ${inIds} AND s.clock_in_at < ? AND coalesce(s.clock_out_at, '9999') > ?`, args: [...ids, to, from] },
          {
            sql: `SELECT employee_id, kind, application_identifier, application_name, started_at, ended_at FROM activity_intervals
                  WHERE employee_id IN ${inIds} AND started_at < ? AND ended_at > ? ORDER BY started_at`,
            args: [...ids, to, from],
          },
        ],
        "read",
      ),
    ]);
    const withB = await withBreaks(this.db, sessions!.rows);
    const sessionsOf = (id: string) => withB.filter((_, i) => String(sessions!.rows[i]!.employee_id) === id);
    const audits = page.items.map((e) => employeeReadAudit(caller, e, "EMPLOYEE_ACTIVITY_TIMELINE_VIEWED", { date: q.date, view: "team" })).filter((a): a is InStatement => !!a);
    if (audits.length) await this.db.batch(audits, "write");
    const items = page.items.map((e) => {
      const [dayStart, dayEnd] = days.get(e.id)!;
      const segments = buildTimelineSegments({
        dayStart: Date.parse(dayStart),
        dayEnd: Date.parse(dayEnd),
        now,
        sessions: sessionsOf(e.id),
        intervals: intervals!.rows
          .filter((r) => String(r.employee_id) === e.id)
          .map((r) => {
            const app = { applicationIdentifier: str(r.application_identifier), applicationName: str(r.application_name) };
            const kind = r.kind as ActivityKind;
            return { kind, startedAt: String(r.started_at), endedAt: String(r.ended_at), applicationName: app.applicationName, category: kind === "IDLE" ? null : labels.category(e.id, app) };
          }),
      });
      return { employee: { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, timezone: e.timezone }, dayStart, dayEnd, segments };
    });
    return { items, total: page.total, page: q.page, pageSize: q.pageSize, date: q.date, generatedAt };
  }
}

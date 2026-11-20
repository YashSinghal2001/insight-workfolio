import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  addDays,
  zonedToUtc,
  type ActivityAppHistoryQuery,
  type ActivityAppHistoryResponse,
  type ActivityAppsQuery,
  type ActivityAppsResponse,
  type ActivityAppUsage,
  type ApplicationCategory,
  type CategoryTotals,
  type EmployeeRef,
} from "@workfolio/shared";
import { chunks, str } from "../attendance/sessions.js";
import { employeeReadAudit } from "../audit/account-audit.js";
import type { AuthContext } from "../auth/auth.service.js";
import { assertTeamReadable, scopeSql, teamFilterSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { APP_KEY, appKey } from "./activity.service.js";
import { ActivityCategoriesService } from "./categories.service.js";

const PERMISSION = "activity:read-all";
/** Milliseconds of interval `a` inside the bound row `b` (b.s, b.e). */
const CLIPPED = "sum(max(0, round((julianday(min(a.ended_at, b.e)) - julianday(max(a.started_at, b.s))) * 86400000)))";
/** Employees per query: 3 parameters each for totals, 4 per day for the history (31 days → 12.4k parameters). */
const TOTALS_CHUNK = 1000;
const HISTORY_CHUNK = 100;
const emptyTotals = (): CategoryTotals => ({ PRODUCTIVE: 0, NEUTRAL: 0, UNPRODUCTIVE: 0, UNCLASSIFIED: 0 });

type Member = EmployeeRef & { userId: string };

/**
 * App-usage analytics over the caller's scope (team heads: their teams), optionally one team. Same grouping key and
 * clipping as ActivityService.appTotals; labels are applied per employee (team labels). Application names only.
 */
@Injectable()
export class ActivityAppsService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly categories: ActivityCategoriesService,
  ) {}

  async apps(caller: AuthContext, q: ActivityAppsQuery): Promise<ActivityAppsResponse> {
    // ponytail: totals need every member's usage, so all are aggregated and only the page is returned.
    const members = await this.members(caller, q.teamId);
    const labels = await this.categories.labelsFor(members.map((m) => m.id));
    const categories = emptyTotals();
    const apps = new Map<string, ActivityAppUsage & { latest: string; split: CategoryTotals; who: Set<string> }>();
    const rows = new Map(members.map((m) => [m.id, { employee: ref(m), activeMs: 0, idleMs: 0, categories: emptyTotals(), top: { name: null as string | null, ms: 0 } }]));

    for (const part of chunks(members, TOTALS_CHUNK)) {
      const bounds = part.flatMap((m) => [m.id, ...this.bounds(m, q.from, q.to)]);
      const { rows: found } = await this.db.execute({
        // Bare application columns come from the latest interval (max), so a renamed app shows its current name.
        sql: `WITH b(emp, s, e) AS (VALUES ${part.map(() => "(?, ?, ?)").join(", ")})
              SELECT b.emp, a.kind, a.application_identifier, a.application_name, max(a.started_at) AS latest, ${CLIPPED} AS ms
              FROM b JOIN activity_intervals a ON a.employee_id = b.emp AND a.started_at < b.e AND a.ended_at > b.s
              GROUP BY b.emp, a.kind, ${APP_KEY}`,
        args: bounds,
      });
      for (const r of found) {
        const row = rows.get(String(r.emp))!;
        const ms = Number(r.ms);
        if (ms <= 0) continue;
        if (r.kind === "IDLE") {
          row.idleMs += ms;
          continue;
        }
        const app = { applicationIdentifier: str(r.application_identifier), applicationName: String(r.application_name) };
        const category = labels.category(row.employee.id, app);
        row.activeMs += ms;
        row.categories[category] += ms;
        categories[category] += ms;
        if (ms > row.top.ms) row.top = { name: app.applicationName, ms };
        const key = appKey(app);
        const cur = apps.get(key) ?? { key, ...app, activeMs: 0, category, employees: 0, latest: "", split: emptyTotals(), who: new Set<string>() };
        cur.activeMs += ms;
        cur.split[category] += ms;
        cur.who.add(row.employee.id);
        if (String(r.latest) > cur.latest) Object.assign(cur, { latest: String(r.latest), applicationName: app.applicationName });
        apps.set(key, cur);
      }
    }

    const applications = [...apps.values()]
      .map(({ latest: _l, split, who, ...a }): ActivityAppUsage => ({ ...a, employees: who.size, category: dominant(split) }))
      .sort((a, b) => b.activeMs - a.activeMs || a.applicationName.localeCompare(b.applicationName));
    return {
      from: q.from,
      to: q.to,
      teamId: q.teamId ?? null,
      categoriesConfigured: labels.configured,
      categories,
      applications,
      employees: {
        items: [...rows.values()].slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(({ top, ...r }) => ({ ...r, topApplication: top.name })),
        total: rows.size,
        page: q.page,
        pageSize: q.pageSize,
      },
    };
  }

  /** One application: active time per local day, for everyone and per employee. Audited like a per-employee activity read. */
  async history(caller: AuthContext, q: ActivityAppHistoryQuery): Promise<ActivityAppHistoryResponse> {
    const members = await this.members(caller, q.teamId);
    const dates: string[] = [];
    for (let d = q.from; d <= q.to; d = addDays(d, 1)) dates.push(d);
    const total = new Map(dates.map((d) => [d, 0]));
    const used = new Map<string, Map<string, number>>();
    let name: { at: string; value: string } | null = null;

    for (const part of chunks(members, HISTORY_CHUNK)) {
      const values = part.flatMap((m) => dates.map((d) => [m.id, d, ...this.bounds(m, d, d)]));
      const { rows } = await this.db.execute({
        sql: `WITH b(emp, d, s, e) AS (VALUES ${values.map(() => "(?, ?, ?, ?)").join(", ")})
              SELECT b.emp, b.d, a.application_name, max(a.started_at) AS latest, ${CLIPPED} AS ms
              FROM b JOIN activity_intervals a ON a.employee_id = b.emp AND a.kind = 'ACTIVE' AND a.started_at < b.e AND a.ended_at > b.s AND ${APP_KEY} = ?
              GROUP BY b.emp, b.d`,
        args: [...values.flat(), q.app],
      });
      for (const r of rows) {
        const ms = Number(r.ms);
        if (ms <= 0) continue;
        const days = used.get(String(r.emp)) ?? new Map<string, number>();
        days.set(String(r.d), ms);
        used.set(String(r.emp), days);
        total.set(String(r.d), total.get(String(r.d))! + ms);
        if (!name || String(r.latest) > name.at) name = { at: String(r.latest), value: String(r.application_name) };
      }
    }

    const shown = members.filter((m) => used.has(m.id));
    const audits = shown.map((m) => employeeReadAudit(caller, m, "EMPLOYEE_ACTIVITY_SUMMARY_VIEWED", { from: q.from, to: q.to })).filter((s) => s !== null);
    if (audits.length) await this.db.batch(audits, "write");
    return {
      from: q.from,
      to: q.to,
      teamId: q.teamId ?? null,
      key: q.app,
      applicationName: name?.value ?? null,
      days: dates.map((date) => ({ date, activeMs: total.get(date)! })),
      employees: shown
        .map((m) => {
          const days = [...used.get(m.id)!].map(([date, activeMs]) => ({ date, activeMs })).sort((a, b) => a.date.localeCompare(b.date));
          return { employee: ref(m), activeMs: days.reduce((n, d) => n + d.activeMs, 0), days };
        })
        .sort((a, b) => b.activeMs - a.activeMs),
    };
  }

  /** Active employees the caller may read under activity:read-all, optionally one team (a foreign team is a 404). */
  private async members(caller: AuthContext, teamId?: string): Promise<Member[]> {
    await assertTeamReadable(this.db, caller, PERMISSION, teamId);
    const scope = scopeSql(caller, PERMISSION, "p.id");
    const team = teamFilterSql(teamId, "p.id");
    const { rows } = await this.db.execute({
      sql: `SELECT p.id, p.user_id, p.full_name, p.employee_code, p.timezone FROM employee_profiles p JOIN users u ON u.id = p.user_id
            WHERE p.employment_status = 'ACTIVE' AND u.status = 'ACTIVE'${scope.sql}${team.sql}
            ORDER BY p.full_name COLLATE NOCASE, p.id`,
      args: [...scope.args, ...team.args],
    });
    return rows.map((r) => ({ id: String(r.id), userId: String(r.user_id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) }));
  }

  private bounds(e: EmployeeRef, from: string, to: string): [string, string] {
    return [zonedToUtc(`${from}T00:00`, e.timezone), zonedToUtc(`${addDays(to, 1)}T00:00`, e.timezone)];
  }
}

const ref = ({ id, fullName, employeeCode, timezone }: EmployeeRef): EmployeeRef => ({ id, fullName, employeeCode, timezone });
/** The label with the most time (ties: Productive, Neutral, Unproductive, Unclassified order). */
const dominant = (split: CategoryTotals): ApplicationCategory =>
  (Object.entries(split) as [ApplicationCategory, number][]).reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];

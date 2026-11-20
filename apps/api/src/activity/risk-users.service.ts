import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  addDays,
  lessHours,
  RISK_LESS_HOURS_SHARE,
  RISK_TRIGGERS,
  riskRules,
  sortRiskUsers,
  type AttendancePolicy,
  type MonthlyAttendanceRow,
  type RiskTrigger,
  type RiskUser,
  type RiskUsersQuery,
  type RiskUsersResponse,
} from "@workfolio/shared";
import { MonthlyService } from "../attendance/monthly.service.js";
import type { AuthContext } from "../auth/auth.service.js";
import { POLICY } from "../common/policy.js";
import { assertTeamReadable } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";

const PERMISSION = "activity:read-all";

/**
 * Risk users, computed on read (no stored state): alert rows of the range grouped by rule kind, plus "less working
 * hours" from the monthly attendance rows (same status rules as /attendance/daily: holidays, approved leave and
 * unscheduled days never count). Employees = the monthly report's (active, in the caller's scope and team).
 */
@Injectable()
export class RiskUsersService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
    private readonly monthly: MonthlyService,
  ) {}

  async list(caller: AuthContext, q: RiskUsersQuery, now = Date.now()): Promise<RiskUsersResponse> {
    await assertTeamReadable(this.db, caller, PERMISSION, q.teamId);
    // One monthly read per calendar month of the range (≤ 4 for 92 days), days outside the range dropped.
    const rows = new Map<string, MonthlyAttendanceRow>();
    for (let month = q.from.slice(0, 7); month <= q.to.slice(0, 7); month = addDays(`${month}-28`, 7).slice(0, 7)) {
      const page = await this.monthly.monthly({ month, teamId: q.teamId, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, caller, now);
      for (const r of page.items) {
        const days = r.days.filter((d) => d.date >= q.from && d.date <= q.to);
        const cur = rows.get(r.employee.id);
        rows.set(r.employee.id, cur ? { ...cur, days: [...cur.days, ...days] } : { ...r, days });
      }
    }
    const ids = [...rows.keys()];
    const counts = new Map<string, Map<RiskTrigger, number>>();
    if (ids.length) {
      // ponytail: one IN list; chunk it beyond ~30k employees (SQLite's parameter limit).
      const { rows: alerts } = await this.db.execute({
        sql: `SELECT a.employee_id, r.kind, count(*) AS n FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
              WHERE a.date >= ? AND a.date <= ? AND a.employee_id IN (${ids.map(() => "?").join(", ")})
              GROUP BY a.employee_id, r.kind`,
        args: [q.from, q.to, ...ids],
      });
      for (const a of alerts) {
        const m = counts.get(String(a.employee_id)) ?? new Map<RiskTrigger, number>();
        m.set(a.kind as RiskTrigger, Number(a.n));
        counts.set(String(a.employee_id), m);
      }
    }

    const items: RiskUser[] = [];
    for (const [id, row] of rows) {
      const short = lessHours(row.days, this.policy.scheduledDailyMinutes);
      const m = counts.get(id) ?? new Map<RiskTrigger, number>();
      if (short) m.set("LESS_WORKING_HOURS", short.shortDays);
      const triggers = RISK_TRIGGERS.filter((t) => (m.get(t) ?? 0) > 0).map((trigger) => ({ trigger, count: m.get(trigger)! }));
      if (triggers.length) items.push({ employee: row.employee, triggers, total: triggers.reduce((n, t) => n + t.count, 0), lessHours: short });
    }
    const sorted = sortRiskUsers(items);
    return {
      from: q.from,
      to: q.to,
      teamId: q.teamId ?? null,
      scheduledDailyMinutes: this.policy.scheduledDailyMinutes,
      lessHoursShare: RISK_LESS_HOURS_SHARE,
      items: sorted,
      rules: riskRules(sorted),
    };
  }
}

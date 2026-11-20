import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DatabaseClient, Row } from "@workfolio/database";
import {
  addDays,
  createAlertRuleSchema,
  IDLE_SHARE_MIN_TRACKED_MINUTES,
  localDate,
  toZonedLocal,
  zonedToUtc,
  type Alert,
  type AlertRule,
  type AlertRuleInput,
  type AlertRuleKind,
  type AlertRuleUpdate,
  type DailyAttendanceRow,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { iso, str } from "../attendance/sessions.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { NotificationRulesService } from "../notifications/notification-rules.service.js";
import { ScheduleService } from "../schedule/schedule.service.js";

/** Evaluator period. ponytail: fixed; move to env (like REPORT_SCHEDULER_SECONDS) if it ever needs tuning. */
const TICK_MS = 60_000;

const RULE = `SELECT r.id, r.name, r.kind, r.threshold, r.at_time, r.active, r.created_at, r.updated_at, u.id AS user_id, u.email
  FROM alert_rules r JOIN users u ON u.id = r.created_by`;
const toRule = (r: Row): AlertRule => ({
  id: String(r.id),
  name: String(r.name),
  kind: r.kind as AlertRuleKind,
  threshold: r.threshold === null ? null : Number(r.threshold),
  atTime: str(r.at_time),
  active: Number(r.active) === 1,
  createdBy: { id: String(r.user_id), email: String(r.email) },
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

interface NewAlert {
  ruleId: string;
  employeeId: string;
  date: string;
  detail: string;
}

/**
 * Custom alert rules (F06), in-app only. A periodic evaluator turns rules into alert rows, at most one
 * per (rule, employee, local date) (database unique key). Inputs are the daily attendance view (which
 * already applies the work schedule, holidays and approved leave) and activity intervals; nobody is
 * alerted on a holiday or a day with any approved leave. Logs carry ids and counts only.
 *
 * ponytail: one in-process timer, assuming a single API instance. A second instance only repeats work:
 * the unique key still yields one alert per (rule, employee, date).
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertsService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly schedule: ScheduleService,
    private readonly config: ConfigService<Env, true>,
    private readonly notificationRules: NotificationRulesService,
  ) {}

  onModuleInit() {
    if (this.config.get("NODE_ENV", { infer: true }) === "test") return;
    this.timer = setInterval(() => void this.tick().catch((err: Error) => this.logger.error({ err: err.message }, "Alert evaluator failed")), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ---- Rules -----------------------------------------------------------------------------------

  async rules(): Promise<AlertRule[]> {
    return (await this.db.execute(`${RULE} ORDER BY r.active DESC, r.name COLLATE NOCASE, r.id`)).rows.map(toRule);
  }

  private async rule(id: string): Promise<AlertRule> {
    const row = (await this.db.execute({ sql: `${RULE} WHERE r.id = ?`, args: [id] })).rows[0];
    if (!row) throw new NotFoundException("Alert rule not found");
    return toRule(row);
  }

  async create(admin: AuthContext, input: AlertRuleInput): Promise<AlertRule> {
    const id = randomUUID();
    await this.db.execute({
      sql: "INSERT INTO alert_rules (id, name, kind, threshold, at_time, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      args: [id, input.name, input.kind, "threshold" in input ? input.threshold : null, "atTime" in input ? input.atTime : null, admin.id],
    });
    this.logger.log({ ruleId: id, actorId: admin.id }, "Alert rule created");
    return this.rule(id);
  }

  /** Name, active, and the parameter that belongs to the rule's kind (re-validated as a whole). */
  async update(admin: AuthContext, id: string, input: AlertRuleUpdate): Promise<AlertRule> {
    const cur = await this.rule(id);
    const next = { kind: cur.kind, name: input.name ?? cur.name, ...(cur.threshold !== null || input.threshold !== undefined ? { threshold: input.threshold ?? cur.threshold } : {}), ...(cur.atTime !== null || input.atTime !== undefined ? { atTime: input.atTime ?? cur.atTime } : {}) };
    const parsed = createAlertRuleSchema.safeParse(next);
    if (!parsed.success) throw new BadRequestException(`Invalid settings for a ${cur.kind} rule`);
    await this.db.execute({
      sql: "UPDATE alert_rules SET name = ?, threshold = ?, at_time = ?, active = ?, updated_at = ? WHERE id = ?",
      args: [parsed.data.name, "threshold" in parsed.data ? parsed.data.threshold : null, "atTime" in parsed.data ? parsed.data.atTime : null, (input.active ?? cur.active) ? 1 : 0, iso(Date.now()), id],
    });
    this.logger.log({ ruleId: id, actorId: admin.id }, "Alert rule updated");
    return this.rule(id);
  }

  /** Deletes the rule and its alerts (deactivate it instead to keep them). */
  async remove(admin: AuthContext, id: string): Promise<void> {
    await this.rule(id);
    await this.db.batch([{ sql: "DELETE FROM alerts WHERE rule_id = ?", args: [id] }, { sql: "DELETE FROM alert_rules WHERE id = ?", args: [id] }], "write");
    this.logger.log({ ruleId: id, actorId: admin.id }, "Alert rule deleted");
  }

  // ---- Alerts ----------------------------------------------------------------------------------

  async alerts(status: "open" | "acknowledged" | "all"): Promise<Alert[]> {
    const { rows } = await this.db.execute({
      sql: `SELECT a.id, a.date, a.detail, a.created_at, a.acknowledged_at, r.id AS rule_id, r.name AS rule_name, r.kind,
              p.id AS employee_id, p.full_name, p.employee_code, p.timezone, k.id AS ack_id, k.email AS ack_email
            FROM alerts a JOIN alert_rules r ON r.id = a.rule_id JOIN employee_profiles p ON p.id = a.employee_id
            LEFT JOIN users k ON k.id = a.acknowledged_by
            WHERE ?1 = 'all' OR (?1 = 'open') = (a.acknowledged_at IS NULL)
            ORDER BY a.created_at DESC, a.id LIMIT 500`,
      args: [status],
    });
    return rows.map((r) => ({
      id: String(r.id),
      rule: { id: String(r.rule_id), name: String(r.rule_name), kind: r.kind as AlertRuleKind },
      employee: { id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) },
      date: String(r.date),
      detail: String(r.detail),
      createdAt: String(r.created_at),
      acknowledgedBy: r.ack_id === null ? null : { id: String(r.ack_id), email: String(r.ack_email) },
      acknowledgedAt: str(r.acknowledged_at),
    }));
  }

  async acknowledge(admin: AuthContext, id: string): Promise<void> {
    const res = await this.db.execute({ sql: "UPDATE alerts SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL", args: [admin.id, iso(Date.now()), id] });
    if (res.rowsAffected) return;
    if ((await this.db.execute({ sql: "SELECT 1 FROM alerts WHERE id = ?", args: [id] })).rows[0]) throw new ConflictException("Already acknowledged");
    throw new NotFoundException("Alert not found");
  }

  // ---- Evaluator -------------------------------------------------------------------------------

  async tick(now = Date.now()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await this.evaluate(now);
    } finally {
      this.ticking = false;
    }
  }

  /** Creates the alerts due at `now`; returns how many were new. */
  async evaluate(now = Date.now()): Promise<number> {
    const rules = (await this.rules()).filter((r) => r.active);
    if (!rules.length) return 0;
    // Each employee's "today" and "yesterday" in their own zone; the daily view reads a date per employee zone.
    const zones = (await this.db.execute("SELECT DISTINCT timezone FROM employee_profiles WHERE employment_status = 'ACTIVE'")).rows.map((r) => String(r.timezone));
    const dates = [...new Set(zones.flatMap((tz) => [localDate(now, tz), addDays(localDate(now, tz), -1)]))];
    const today: DailyAttendanceRow[] = [];
    const yesterday: DailyAttendanceRow[] = [];
    for (const date of dates) {
      for (const r of (await this.schedule.daily({ date, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, now)).items) {
        const t = localDate(now, r.employee.timezone);
        if (r.date === t) today.push(r);
        else if (r.date === addDays(t, -1)) yesterday.push(r);
      }
    }
    // Never on a holiday or a day with approved leave (any portion).
    const working = (r: DailyAttendanceRow) => !r.holiday && !r.leave;
    const found: NewAlert[] = [];
    for (const rule of rules) {
      if (rule.kind === "LATE_CLOCK_IN") {
        for (const r of today.filter(working)) {
          if (r.status === "LATE") found.push({ ruleId: rule.id, employeeId: r.employee.id, date: r.date, detail: `Clocked in at ${r.firstClockInLocal!.slice(11)}, ${r.lateMinutes} min after the expected start` });
        }
      } else if (rule.kind === "NOT_CLOCKED_IN_BY") {
        for (const r of today.filter(working)) {
          // scheduled is true only on a workday of an enabled work schedule.
          if (r.scheduled === true && !r.firstClockInAt && toZonedLocal(now, r.employee.timezone).slice(11) >= rule.atTime!) {
            found.push({ ruleId: rule.id, employeeId: r.employee.id, date: r.date, detail: `Not clocked in by ${rule.atTime}` });
          }
        }
      } else if (rule.kind === "IDLE_SHARE_ABOVE") {
        found.push(...(await this.idleShare(rule, yesterday.filter(working))));
      } else {
        found.push(...(await this.noActivity(rule, today.filter(working), now)));
      }
    }
    if (!found.length) return 0;
    const results = await this.db.batch(
      found.map((a) => ({ sql: "INSERT INTO alerts (id, rule_id, employee_id, date, detail) VALUES (?, ?, ?, ?, ?) ON CONFLICT (rule_id, employee_id, date) DO NOTHING", args: [randomUUID(), a.ruleId, a.employeeId, a.date, a.detail] })),
      "write",
    );
    const created = found.filter((_, i) => results[i]!.rowsAffected);
    if (created.length) {
      this.logger.log({ created: created.length }, "Alerts created");
      await this.sendAlertEmails(created, now);
    }
    return created.length;
  }

  /** Email hook for new alerts: one PRODUCTIVITY_ALERT notification event per alert, routed by notification rules (never throws). */
  private sendAlertEmails(alerts: NewAlert[], now: number): Promise<void> {
    return this.notificationRules.alertsCreated(alerts, now);
  }

  /** Previous local day: idle share of tracked time (activity intervals started that day). */
  private async idleShare(rule: AlertRule, days: DailyAttendanceRow[]): Promise<NewAlert[]> {
    const out: NewAlert[] = [];
    // ponytail: one query per employee per tick; group into one windowed query if headcount grows large.
    for (const r of days) {
      const tz = r.employee.timezone;
      const row = (
        await this.db.execute({
          sql: `SELECT coalesce(sum(active_seconds), 0) AS active, coalesce(sum(idle_seconds), 0) AS idle FROM activity_intervals
                WHERE employee_id = ? AND started_at >= ? AND started_at < ?`,
          args: [r.employee.id, zonedToUtc(`${r.date}T00:00`, tz), zonedToUtc(`${addDays(r.date, 1)}T00:00`, tz)],
        })
      ).rows[0]!;
      const active = Number(row.active);
      const idle = Number(row.idle);
      const total = active + idle;
      if (total < IDLE_SHARE_MIN_TRACKED_MINUTES * 60 || idle * 100 <= rule.threshold! * total) continue;
      out.push({ ruleId: rule.id, employeeId: r.employee.id, date: r.date, detail: `Idle ${Math.round((idle * 100) / total)}% of ${Math.round(total / 60)} min tracked (rule: above ${rule.threshold}%)` });
    }
    return out;
  }

  /**
   * Open sessions with no ACTIVE interval for `threshold` minutes (since clock-in, the last break or
   * the last active interval), not on a break. Only sessions with at least one recorded interval count,
   * so an employee whose activity is not tracked at all is never flagged.
   */
  private async noActivity(rule: AlertRule, days: DailyAttendanceRow[], now: number): Promise<NewAlert[]> {
    const byEmployee = new Map(days.map((r) => [r.employee.id, r]));
    const { rows } = await this.db.execute(`
      SELECT s.employee_id, s.clock_in_at,
        (SELECT max(ended_at) FROM activity_intervals a WHERE a.attendance_session_id = s.id AND a.kind = 'ACTIVE') AS last_active,
        EXISTS (SELECT 1 FROM activity_intervals a WHERE a.attendance_session_id = s.id) AS tracked,
        EXISTS (SELECT 1 FROM break_sessions b WHERE b.attendance_session_id = s.id AND b.ended_at IS NULL) AS on_break,
        (SELECT max(ended_at) FROM break_sessions b WHERE b.attendance_session_id = s.id) AS last_break
      FROM attendance_sessions s WHERE s.status = 'OPEN'`);
    const out: NewAlert[] = [];
    for (const s of rows) {
      const r = byEmployee.get(String(s.employee_id));
      if (!r || !Number(s.tracked) || Number(s.on_break)) continue;
      const since = [str(s.clock_in_at), str(s.last_active), str(s.last_break)].filter((x): x is string => !!x).sort().at(-1)!;
      const minutes = Math.floor((now - Date.parse(since)) / 60_000);
      if (minutes < rule.threshold!) continue;
      out.push({ ruleId: rule.id, employeeId: r.employee.id, date: r.date, detail: `No active input for ${minutes} min while clocked in (since ${toZonedLocal(since, r.employee.timezone).slice(11)})` });
    }
    return out;
  }
}

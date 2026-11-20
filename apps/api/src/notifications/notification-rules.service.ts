import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isUniqueViolation, type DatabaseClient, type InStatement, type Row } from "@workfolio/database";
import {
  ATTENDANCE_NOTIFICATION_TYPES,
  DEFAULT_TIMEZONE,
  localDate,
  NOTIFICATION_ROUTES,
  platformRoleOf,
  toZonedLocal,
  zonedToUtc,
  type AccountAuditAction,
  type AttendanceEventType,
  type AttendanceNotificationType,
  type NotificationRecipientCandidate,
  type NotificationRecipientRole,
  type NotificationRule,
  type NotificationRuleInput,
  type NotificationRuleMode,
  type NotificationRuleUpdate,
  type Role,
  type SyncResult,
} from "@workfolio/shared";
import { accountAudit } from "../audit/account-audit.js";
import type { AuthContext } from "../auth/auth.service.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { AnomaliesService } from "../attendance/anomalies.service.js";
import { ScheduleService } from "../schedule/schedule.service.js";
import { digestArgs, DIGEST_EVENTS, NotificationsService, RULE_COVERS, RULE_RECIPIENT, sanitize } from "./notifications.service.js";

const TICK_MS = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const RULE = "SELECT id, type, mode, digest_local_time, timezone, team_id, changed_by, created_at, updated_at FROM notification_rules";

interface AttendanceEventInput {
  type: AttendanceNotificationType;
  employeeId: string;
  localDate: string;
  /** The instant the event is about (clock-in time, due time of an absence, …). */
  occurredAt: string;
  dedupeKey: string;
  now: number;
}

/** A recipient account as a delivery row names it (the existing recipient_role values). */
const roleOf = (u: Row): NotificationRecipientRole => {
  const p = platformRoleOf(u.role as Role, u.admin_title === null ? null : String(u.admin_title));
  return p === "SUPER_ADMIN" ? "SUPER_ADMIN" : p === "ADMIN" ? "IT" : "EMPLOYEE"; // EMPLOYEE: a team head without an admin role
};

/**
 * Attendance notification rules (docs/notifications.md §9): which attendance events are emailed, how
 * (IMMEDIATE, DAILY_DIGEST, OFF) and to whom (accounts chosen per rule). Producers record events into the existing
 * notification tables; NotificationsService sends them (retries, re-check of the recipient at send time).
 *
 * An event is recorded only when at least one rule that is not OFF covers the employee: with every rule OFF
 * (the default) attendance writes nothing here. A 60 s timer evaluates late arrivals, absences and digests.
 * ponytail: one in-process timer (single API instance, like the alert evaluator); dedupe keys keep a second
 * instance or a restart from sending anything twice.
 */
/**
 * Who may receive a rule's emails (alias `u` = users; one `?` = the rule's team id or NULL): an ACTIVE admin account
 * or the head of that active team. Used by PUT recipients (validation) and recipient-candidates (the picker).
 */
const ELIGIBLE = `u.status = 'ACTIVE' AND (u.role = 'ADMIN' OR EXISTS (SELECT 1 FROM teams t WHERE t.id = ? AND t.head_user_id = u.id AND t.active = 1))`;

@Injectable()
export class NotificationRulesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationRulesService.name);
  private readonly test: boolean;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly notifications: NotificationsService,
    private readonly schedule: ScheduleService,
    private readonly anomalies: AnomaliesService,
    config: ConfigService<Env, true>,
  ) {
    this.test = config.get("NODE_ENV", { infer: true }) === "test";
  }

  onModuleInit() {
    if (this.test) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ---- Rules -----------------------------------------------------------------------------------

  /** Every rule. Types without an organisation-wide rule get one first (OFF, 18:00 in the default zone). */
  async list(admin: AuthContext): Promise<NotificationRule[]> {
    await this.db.batch(
      ATTENDANCE_NOTIFICATION_TYPES.map((type) => ({
        sql: "INSERT INTO notification_rules (id, type, timezone, changed_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        args: [randomUUID(), type, DEFAULT_TIMEZONE, admin.id],
      })),
      "write",
    );
    const rules = (await this.db.execute(`${RULE} ORDER BY team_id IS NOT NULL, type, team_id, id`)).rows;
    const recipients = await this.recipients();
    return rules.map((r) => this.toRule(r, recipients));
  }

  async get(id: string): Promise<NotificationRule> {
    const row = (await this.db.execute({ sql: `${RULE} WHERE id = ?`, args: [id] })).rows[0];
    if (!row) throw new NotFoundException("Notification rule not found");
    return this.toRule(row, await this.recipients(id));
  }

  async create(admin: AuthContext, input: NotificationRuleInput): Promise<NotificationRule> {
    if (input.teamId && !(await this.db.execute({ sql: "SELECT 1 FROM teams WHERE id = ?", args: [input.teamId] })).rows[0]) throw new NotFoundException("Team not found");
    const id = randomUUID();
    try {
      await this.db.batch(
        [
          {
            sql: "INSERT INTO notification_rules (id, type, mode, digest_local_time, timezone, team_id, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
            args: [id, input.type, input.mode, input.digestLocalTime, input.timezone, input.teamId, admin.id],
          },
          this.audit(admin, "NOTIFICATION_RULE_CREATED", null, { ruleId: id, type: input.type, mode: input.mode, digestLocalTime: input.digestLocalTime, timezone: input.timezone, teamId: input.teamId }),
        ],
        "write",
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A rule for this type and team already exists");
      throw err;
    }
    return this.get(id);
  }

  async update(admin: AuthContext, id: string, input: NotificationRuleUpdate): Promise<NotificationRule> {
    const cur = await this.get(id);
    const next = { mode: input.mode ?? cur.mode, digestLocalTime: input.digestLocalTime ?? cur.digestLocalTime, timezone: input.timezone ?? cur.timezone };
    await this.db.batch(
      [
        { sql: "UPDATE notification_rules SET mode = ?, digest_local_time = ?, timezone = ?, changed_by = ?, updated_at = ? WHERE id = ?", args: [next.mode, next.digestLocalTime, next.timezone, admin.id, iso(Date.now()), id] },
        this.audit(admin, "NOTIFICATION_RULE_UPDATED", null, { ruleId: id, type: cur.type, teamId: cur.teamId, ...next }),
      ],
      "write",
    );
    return this.get(id);
  }

  /**
   * Replaces the rule's recipients. Each must be an ACTIVE account that is an admin or, for a team rule only, the
   * head of that team (else 400, nothing changed). Removed rows are ended, never deleted.
   */
  async setRecipients(admin: AuthContext, id: string, userIds: string[]): Promise<NotificationRule> {
    const rule = await this.get(id);
    if (userIds.length) {
      const ok = await this.db.execute({
        sql: `SELECT u.id FROM users u WHERE u.id IN (${userIds.map(() => "?").join(", ")}) AND ${ELIGIBLE}`,
        args: [...userIds, rule.teamId],
      });
      if (ok.rows.length !== userIds.length) throw new BadRequestException("Recipients must be active admin accounts, or the head of this rule's team");
    }
    const current = new Set(rule.recipients.map((r) => r.userId));
    const wanted = new Set(userIds);
    const at = iso(Date.now());
    const statements: InStatement[] = [];
    for (const userId of current) {
      if (wanted.has(userId)) continue;
      statements.push({ sql: "UPDATE notification_rule_recipients SET removed_by = ?, removed_at = ? WHERE rule_id = ? AND user_id = ? AND removed_at IS NULL", args: [admin.id, at, id, userId] });
      statements.push(this.audit(admin, "NOTIFICATION_RECIPIENT_REMOVED", userId, { ruleId: id, type: rule.type }));
    }
    for (const userId of wanted) {
      if (current.has(userId)) continue;
      statements.push({ sql: "INSERT INTO notification_rule_recipients (id, rule_id, user_id, added_by) VALUES (?, ?, ?, ?)", args: [randomUUID(), id, userId, admin.id] });
      statements.push(this.audit(admin, "NOTIFICATION_RECIPIENT_ADDED", userId, { ruleId: id, type: rule.type }));
    }
    if (statements.length) {
      statements.push({ sql: "UPDATE notification_rules SET changed_by = ?, updated_at = ? WHERE id = ?", args: [admin.id, at, id] });
      await this.db.batch(statements, "write");
    }
    return this.get(id);
  }

  /** Every account PUT recipients would accept for a rule of this scope (same ELIGIBLE check). Unknown team → 404. */
  async recipientCandidates(teamId: string | null): Promise<NotificationRecipientCandidate[]> {
    if (teamId && !(await this.db.execute({ sql: "SELECT 1 FROM teams WHERE id = ?", args: [teamId] })).rows[0]) throw new NotFoundException("Team not found");
    const { rows } = await this.db.execute({
      sql: `SELECT u.id, u.email, u.role, u.admin_title, p.full_name FROM users u LEFT JOIN employee_profiles p ON p.user_id = u.id
            WHERE ${ELIGIBLE} ORDER BY coalesce(p.full_name, u.email) COLLATE NOCASE, u.id`,
      args: [teamId],
    });
    return rows.map((r) => ({
      userId: String(r.id),
      fullName: r.full_name === null ? null : String(r.full_name),
      email: String(r.email),
      platformRole: platformRoleOf(r.role as Role, r.admin_title as string | null),
      teamHead: r.role !== "ADMIN",
    }));
  }

  private async recipients(ruleId?: string) {
    const { rows } = await this.db.execute({
      sql: `SELECT rr.rule_id, u.id, u.email, p.full_name FROM notification_rule_recipients rr JOIN users u ON u.id = rr.user_id
            LEFT JOIN employee_profiles p ON p.user_id = u.id WHERE rr.removed_at IS NULL AND (?1 IS NULL OR rr.rule_id = ?1) ORDER BY u.email`,
      args: [ruleId ?? null],
    });
    return rows;
  }

  private toRule(r: Row, recipients: Row[]): NotificationRule {
    return {
      id: String(r.id),
      type: r.type as AttendanceNotificationType,
      mode: r.mode as NotificationRuleMode,
      digestLocalTime: String(r.digest_local_time),
      timezone: String(r.timezone),
      teamId: r.team_id === null ? null : String(r.team_id),
      recipients: recipients.filter((x) => x.rule_id === r.id).map((x) => ({ userId: String(x.id), fullName: x.full_name === null ? null : String(x.full_name), email: String(x.email) })),
      changedBy: String(r.changed_by),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  /** ponytail: account_audit has no notification resource type (CHECK); the rows use ACCOUNT with the recipient as target. */
  private audit(admin: AuthContext, action: AccountAuditAction, targetUserId: string | null, metadata: Record<string, string | null>): InStatement {
    return accountAudit({ actorUserId: admin.id, targetUserId, action, resourceType: "ACCOUNT", resourceId: targetUserId, metadata });
  }

  // ---- Producers -------------------------------------------------------------------------------

  /**
   * After a committed attendance change (online or offline-synced): accepted clock-ins and clock-outs, one event
   * per attendance event row; a clock-in is also checked for lateness at once. Never throws.
   */
  async attendanceApplied(employeeId: string, applied: [AttendanceEventType, SyncResult][], now = Date.now()): Promise<void> {
    try {
      for (const [kind, r] of applied) {
        if (r.status !== "ACCEPTED" || !r.occurredAt || (kind !== "CLOCK_IN" && kind !== "CLOCK_OUT")) continue;
        const row = (
          await this.db.execute({
            sql: "SELECT a.id, p.timezone, p.employee_code FROM attendance_events a JOIN employee_profiles p ON p.id = a.employee_id WHERE a.employee_id = ? AND a.idempotency_key = ? AND a.outcome = 'ACCEPTED'",
            args: [employeeId, r.id],
          })
        ).rows[0];
        if (!row) continue;
        const type = kind === "CLOCK_IN" ? "ATTENDANCE_CLOCK_IN" : "ATTENDANCE_CLOCK_OUT";
        const date = localDate(r.occurredAt, String(row.timezone));
        await this.record({ type, employeeId, localDate: date, occurredAt: r.occurredAt, dedupeKey: `${type}:${String(row.id)}`, now });
        if (kind === "CLOCK_IN") await this.scanDay(now, { date, employeeId, code: String(row.employee_code) });
      }
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, "Attendance notification could not be recorded");
    }
  }

  /**
   * MISSING_CLOCK_OUT producer: one event per employee and local date of the open session's clock-in. Detection is
   * not done here (the attendance anomaly service calls this). Returns the event id, or null (no rule, duplicate).
   */
  async recordMissingClockOut(input: { employeeId: string; clockInAt: string }, now = Date.now()): Promise<string | null> {
    const tz = (await this.db.execute({ sql: "SELECT timezone FROM employee_profiles WHERE id = ?", args: [input.employeeId] })).rows[0]?.timezone;
    if (tz == null) return null;
    const date = localDate(input.clockInAt, String(tz));
    return this.record({ type: "MISSING_CLOCK_OUT", employeeId: input.employeeId, localDate: date, occurredAt: input.clockInAt, dedupeKey: `MISSING_CLOCK_OUT:${input.employeeId}:${date}`, now });
  }

  /** PRODUCTIVITY_ALERT: one event per created alert (alert rule, employee, local date). Never throws. */
  async alertsCreated(alerts: { ruleId: string; employeeId: string; date: string }[], now = Date.now()): Promise<void> {
    try {
      for (const a of alerts) {
        await this.record({ type: "PRODUCTIVITY_ALERT", employeeId: a.employeeId, localDate: a.date, occurredAt: iso(now), dedupeKey: `PRODUCTIVITY_ALERT:${a.ruleId}:${a.employeeId}:${a.date}`, now });
      }
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, "Alert notification could not be recorded");
    }
  }

  /**
   * Records one attendance event when a rule that is not OFF covers the employee, with one PENDING delivery per
   * current recipient of the matching IMMEDIATE rules (one per account even if several rules name it). DAILY_DIGEST
   * rules pick the event up at digest time. Returns the event id, or null (no matching rule, or a duplicate).
   */
  private async record(e: AttendanceEventInput): Promise<string | null> {
    const rules = (
      await this.db.execute({ sql: `SELECT r.id, r.mode FROM notification_rules r WHERE r.type = ?1 AND r.mode <> 'OFF' AND ${RULE_COVERS("?2")}`, args: [e.type, e.employeeId] })
    ).rows;
    if (!rules.length) return null;
    const p = (await this.db.execute({ sql: "SELECT user_id, employee_code FROM employee_profiles WHERE id = ?", args: [e.employeeId] })).rows[0];
    if (!p) return null;
    const id = randomUUID();
    const label = NOTIFICATION_ROUTES[e.type].label;
    const statements: InStatement[] = [
      {
        sql: `INSERT INTO notification_events (id, type, severity, subject_user_id, description, dedupe_key, employee_id, local_date, occurred_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
        args: [id, e.type, NOTIFICATION_ROUTES[e.type].severity, String(p.user_id), sanitize(`${label}: ${String(p.employee_code)} on ${e.localDate}`), e.dedupeKey.slice(0, 200), e.employeeId, e.localDate, e.occurredAt, iso(e.now)],
      },
      ...(await this.deliveries(id, rules.filter((r) => r.mode === "IMMEDIATE").map((r) => String(r.id)))),
    ];
    const [event] = await this.db.batch(statements, "write");
    if (!event?.rowsAffected) return null;
    this.logger.log({ eventId: id, type: e.type }, "Attendance notification recorded");
    if (statements.length > 1 && !this.test) void this.notifications.tick();
    return id;
  }

  /** One delivery per account eligible under any of `ruleIds` (first rule wins), only if event `eventId` was recorded. */
  private async deliveries(eventId: string, ruleIds: string[]): Promise<InStatement[]> {
    if (!ruleIds.length) return [];
    const { rows } = await this.db.execute({
      sql: `SELECT r.id AS rule_id, u.id, u.role, u.admin_title FROM notification_rules r JOIN users u ON ${RULE_RECIPIENT}
            WHERE r.id IN (${ruleIds.map(() => "?").join(", ")}) ORDER BY r.id, u.id`,
      args: ruleIds,
    });
    const seen = new Set<string>();
    return rows.flatMap((u) => {
      if (seen.has(String(u.id))) return [];
      seen.add(String(u.id));
      return [{
        sql: "INSERT INTO notification_deliveries (id, event_id, recipient_role, recipient_user_id, rule_id) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notification_events WHERE id = ?)",
        args: [randomUUID(), eventId, roleOf(u), String(u.id), String(u.rule_id), eventId],
      }];
    });
  }

  // ---- Timer: late arrivals, absences, digests -------------------------------------------------

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.scanDay(now);
      await this.missingClockOuts(now);
      await this.digests(now);
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, "Notification rule evaluation failed");
    } finally {
      this.ticking = false;
    }
  }

  /**
   * LATE_ARRIVAL and ABSENCE from the daily attendance view (work schedule, overrides, holidays, approved leave):
   * each employee's today in their own zone, or one employee's date (`only`). ABSENT is never set on leave, a
   * holiday, a non-workday or without an enabled schedule. One event per type, employee and local date.
   */
  async scanDay(now: number, only?: { date: string; employeeId: string; code: string }): Promise<void> {
    const types = new Set(
      (await this.db.execute("SELECT DISTINCT type FROM notification_rules WHERE mode <> 'OFF' AND type IN ('LATE_ARRIVAL', 'ABSENCE')")).rows.map((r) => String(r.type)),
    );
    if (!types.size || (only && !types.has("LATE_ARRIVAL"))) return;
    const dates = only
      ? [only.date]
      : [...new Set((await this.db.execute("SELECT DISTINCT timezone FROM employee_profiles WHERE employment_status = 'ACTIVE'")).rows.map((r) => localDate(now, String(r.timezone))))];
    const done = await this.recorded(["LATE_ARRIVAL", "ABSENCE"], dates);
    for (const date of dates) {
      for (const r of (await this.schedule.daily({ date, q: only?.code, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, now)).items) {
        if (only ? r.employee.id !== only.employeeId : r.date !== localDate(now, r.employee.timezone)) continue;
        if (done.has(`${r.status === "LATE" ? "LATE_ARRIVAL" : "ABSENCE"}:${r.employee.id}:${r.date}`)) continue;
        if (r.status === "LATE" && types.has("LATE_ARRIVAL")) {
          await this.record({ type: "LATE_ARRIVAL", employeeId: r.employee.id, localDate: r.date, occurredAt: r.firstClockInAt!, dedupeKey: `LATE_ARRIVAL:${r.employee.id}:${r.date}`, now });
        } else if (r.status === "ABSENT" && types.has("ABSENCE")) {
          await this.record({ type: "ABSENCE", employeeId: r.employee.id, localDate: r.date, occurredAt: r.dueAt!, dedupeKey: `ABSENCE:${r.employee.id}:${r.date}`, now });
        }
      }
    }
  }

  /** Dedupe keys already recorded for these types and local dates (one read per tick instead of a write per row). */
  private async recorded(types: string[], dates: string[]): Promise<Set<string>> {
    if (!dates.length) return new Set();
    const { rows } = await this.db.execute({
      sql: `SELECT dedupe_key FROM notification_events WHERE type IN (${types.map(() => "?").join(", ")}) AND local_date IN (${dates.map(() => "?").join(", ")}) AND employee_id IS NOT NULL`,
      args: [...types, ...dates],
    });
    return new Set(rows.map((r) => String(r.dedupe_key)));
  }

  /**
   * MISSING_CLOCK_OUT from the anomaly detector (whole organisation, flag only): one event per employee and local
   * date of the open shift's clock-in, only while a rule that is not OFF exists; record() applies team scoping.
   * Disabled or terminated people are skipped.
   */
  async missingClockOuts(now: number): Promise<void> {
    if (!(await this.db.execute("SELECT 1 FROM notification_rules WHERE type = 'MISSING_CLOCK_OUT' AND mode <> 'OFF' LIMIT 1")).rows[0]) return;
    const items = (await this.anomalies.missingClockOuts(undefined, undefined, now)).items.filter((a) => a.accountStatus === "ACTIVE" && a.employmentStatus === "ACTIVE");
    const keyed = items.map((a) => ({ a, date: a.clockInLocal.slice(0, 10) }));
    const done = await this.recorded(["MISSING_CLOCK_OUT"], [...new Set(keyed.map((k) => k.date))]);
    for (const { a, date } of keyed) {
      if (done.has(`MISSING_CLOCK_OUT:${a.employee.id}:${date}`)) continue;
      await this.recordMissingClockOut({ employeeId: a.employee.id, clockInAt: a.clockInAt }, now);
    }
  }

  /**
   * DAILY_DIGEST rules: once the rule zone's wall clock reaches digest_local_time, one digest event per rule and
   * local date (dedupe key, checked before anything else), one delivery per current recipient. It covers events of
   * that date (or earlier) recorded up to the digest time and not covered by the previous day's digest, so an event
   * recorded after a day's digest goes into the next one. Wall-clock comparison is DST-safe: a time skipped by spring-forward fires at the first minute
   * after the gap; a repeated hour cannot fire twice (same date, same key). An empty day sends nothing.
   * A digest missed because the API was down from digest time to local midnight is not sent later.
   */
  async digests(now: number): Promise<void> {
    const rules = (await this.db.execute("SELECT id, type, digest_local_time, timezone FROM notification_rules WHERE mode = 'DAILY_DIGEST'")).rows;
    for (const rule of rules) {
      const tz = String(rule.timezone);
      const local = toZonedLocal(now, tz);
      const [date, time] = [local.slice(0, 10), local.slice(11)];
      if (time < String(rule.digest_local_time)) continue;
      const key = `digest:${String(rule.id)}:${date}`;
      if ((await this.db.execute({ sql: "SELECT 1 FROM notification_events WHERE dedupe_key = ?", args: [key] })).rows[0]) continue;
      const cutoff = iso(Math.min(now, Date.parse(zonedToUtc(`${date}T${String(rule.digest_local_time)}`, tz))));
      const count = Number(
        (
          await this.db.execute({
            sql: `SELECT count(*) AS n FROM notification_events x JOIN notification_rules r ON r.id = ? WHERE ${DIGEST_EVENTS}`,
            args: [String(rule.id), ...digestArgs(String(rule.type), date, String(rule.digest_local_time), tz, cutoff)],
          })
        ).rows[0]!.n,
      );
      if (!count) continue;
      const id = randomUUID();
      const label = NOTIFICATION_ROUTES[rule.type as AttendanceNotificationType].label;
      const statements: InStatement[] = [
        {
          sql: `INSERT INTO notification_events (id, type, severity, description, dedupe_key, local_date, occurred_at, created_at) VALUES (?, ?, 'INFO', ?, ?, ?, ?, ?)
                ON CONFLICT (dedupe_key) DO NOTHING`,
          args: [id, String(rule.type), `Daily digest: ${count} ${label} event(s) on ${date}`, key, date, cutoff, iso(now)],
        },
        ...(await this.deliveries(id, [String(rule.id)])),
      ];
      const [event] = await this.db.batch(statements, "write");
      if (event?.rowsAffected) {
        this.logger.log({ eventId: id, ruleId: String(rule.id), date }, "Notification digest recorded");
        if (!this.test) void this.notifications.tick();
      }
    }
  }
}

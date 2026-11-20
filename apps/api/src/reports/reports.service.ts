import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import {
  addDays,
  duePeriod,
  renderReport,
  reportDueAt,
  reportPeriod,
  reportWarnings,
  type AttendancePolicy,
  type CreateReportScheduleInput,
  type ProjectTimeSummary,
  type ReportData,
  type UpdateReportScheduleInput,
  type ReportDeliveryStatus,
  type ReportFrequency,
  type ReportKind,
  type ReportRun,
  type ReportSchedule,
  type EligibleRecipient,
  type RunNowResponse,
  type ReportProviderInfo,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { iso, str } from "../attendance/sessions.js";
import { TimesheetService } from "../attendance/timesheet.service.js";
import { POLICY } from "../common/policy.js";
import { teamFilterSql } from "../common/scope.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { ProjectsService } from "../projects/projects.service.js";
import { ScheduleService } from "../schedule/schedule.service.js";
import { MAIL_TRANSPORT, MailError, type MailTransport } from "./mail.js";

/** Attempts per delivery, then FAILED. Transient errors back off 5, 10, 20 minutes. */
export const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 5 * 60_000;
/** A send that has not finished within this lease was interrupted (e.g. a crash). */
const LEASE_MS = 10 * 60_000;
const FINAL: ReportDeliveryStatus[] = ["SENT", "MOCKED", "NOT_CONFIGURED", "SKIPPED", "FAILED"];

const SCHEDULE = `
  SELECT s.id, s.name, s.kind, s.frequency, s.timezone, s.send_at_local_time, s.employee_id, s.team_id, s.include_projects, s.active, s.created_by,
         cu.email AS creator_email, s.created_at, p.full_name, p.employee_code, p.timezone AS employee_timezone, p.user_id AS employee_user_id,
         t.name AS team_name, CASE WHEN t.active = 1 THEN t.head_user_id END AS team_head_user_id
  FROM report_schedules s JOIN users cu ON cu.id = s.created_by LEFT JOIN employee_profiles p ON p.id = s.employee_id LEFT JOIN teams t ON t.id = s.team_id`;

/** employeeUserId / teamHeadUserId: the extra account (besides admins) that may receive this report. */
type ScheduleRow = ReportSchedule & { employeeUserId: string | null; teamHeadUserId: string | null };

/**
 * Scheduled email reports (F12): generation (attendance and task-time aggregates) is separate from
 * delivery (MailTransport). Recipients are user accounts checked on every send. One run per schedule
 * and period, one delivery per recipient, a lease against double sends, bounded retries, and an
 * attempt log without report content. Logs carry ids and statuses only.
 */
@Injectable()
export class ReportsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportsService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(MAIL_TRANSPORT) readonly transport: MailTransport,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
    private readonly timesheets: TimesheetService,
    private readonly projects: ProjectsService,
    private readonly schedules: ScheduleService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit() {
    const seconds = this.config.get("REPORT_SCHEDULER_SECONDS", { infer: true });
    if (this.config.get("NODE_ENV", { infer: true }) === "test" || !seconds) return;
    this.timer = setInterval(() => void this.tick().catch((err: Error) => this.logger.error({ err: err.message }, "Report scheduler failed")), seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  provider(): ReportProviderInfo {
    return { provider: this.config.get("REPORT_MAIL_PROVIDER", { infer: true }), delivers: this.transport.delivers, schedulerSeconds: this.config.get("REPORT_SCHEDULER_SECONDS", { infer: true }) };
  }

  // ---- Schedules and recipients ---------------------------------------------------------------

  async list(): Promise<ReportSchedule[]> {
    const [schedules, recipients] = await this.db.batch(
      [
        `${SCHEDULE} ORDER BY s.active DESC, s.name`,
        `SELECT r.schedule_id, r.user_id, u.email, u.role, r.added_at FROM report_recipients r JOIN users u ON u.id = r.user_id
         WHERE r.removed_at IS NULL ORDER BY u.email`,
      ],
      "read",
    );
    return schedules!.rows.map((r) => this.toSchedule(r, recipients!.rows));
  }

  async create(caller: AuthContext, input: CreateReportScheduleInput) {
    await this.assertScope(input.employeeId ?? null, input.teamId ?? null);
    const id = randomUUID();
    await this.db.execute({
      sql: `INSERT INTO report_schedules (id, name, kind, frequency, timezone, send_at_local_time, employee_id, team_id, include_projects, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, input.name, input.kind, input.frequency, input.timeZone, input.sendAtLocalTime, input.employeeId ?? null, input.teamId ?? null, input.includeProjects ? 1 : 0, caller.id],
    });
    this.logger.log({ scheduleId: id, actorId: caller.id }, "Report schedule created");
    return this.schedule(id);
  }

  async update(caller: AuthContext, id: string, input: UpdateReportScheduleInput) {
    const s = await this.schedule(id);
    // The scope after this change: one team or one employee, never both (the database refuses it too).
    if (input.employeeId !== undefined || input.teamId !== undefined) {
      await this.assertScope(input.employeeId === undefined ? (s.employee?.id ?? null) : input.employeeId, input.teamId === undefined ? (s.team?.id ?? null) : input.teamId);
    }
    const sets = Object.entries({
      name: input.name,
      kind: input.kind,
      frequency: input.frequency,
      timezone: input.timeZone,
      send_at_local_time: input.sendAtLocalTime,
      employee_id: input.employeeId,
      team_id: input.teamId,
      active: input.active,
      include_projects: input.includeProjects,
    })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, typeof v === "boolean" ? (v ? 1 : 0) : v] as const);
    await this.db.execute({ sql: `UPDATE report_schedules SET ${sets.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, args: [...sets.map(([, v]) => v!), iso(Date.now()), id] });
    this.logger.log({ scheduleId: id, actorId: caller.id }, "Report schedule updated");
    return this.schedule(id);
  }

  /** Who may receive this report: active admins; also that employee (one-employee report) or the head of that active team (team report). */
  async eligible(id: string): Promise<EligibleRecipient[]> {
    const s = await this.schedule(id);
    const { rows } = await this.db.execute({
      sql: "SELECT id, email, role FROM users WHERE status = 'ACTIVE' AND (role = 'ADMIN' OR id = ? OR id = ?) ORDER BY role, email",
      args: [s.employeeUserId, s.teamHeadUserId],
    });
    return rows.map((r) => ({ id: String(r.id), email: String(r.email), role: String(r.role) }));
  }

  async addRecipient(caller: AuthContext, id: string, userId: string) {
    if (!(await this.db.execute({ sql: "SELECT 1 FROM users WHERE id = ?", args: [userId] })).rows[0]) throw new NotFoundException("User not found");
    if (!(await this.eligible(id)).some((u) => u.id === userId)) {
      throw new ForbiddenException("This user may not receive this report: only active administrators, the employee for their own report, or the head of the report's team");
    }
    try {
      await this.db.execute({ sql: "INSERT INTO report_recipients (id, schedule_id, user_id, added_by) VALUES (?, ?, ?, ?)", args: [randomUUID(), id, userId, caller.id] });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("Already a recipient");
      throw err;
    }
    this.logger.log({ scheduleId: id, recipientId: userId, actorId: caller.id }, "Report recipient added");
    return this.schedule(id);
  }

  async removeRecipient(caller: AuthContext, id: string, userId: string) {
    await this.schedule(id);
    const res = await this.db.execute({
      sql: "UPDATE report_recipients SET removed_by = ?, removed_at = ? WHERE schedule_id = ? AND user_id = ? AND removed_at IS NULL",
      args: [caller.id, iso(Date.now()), id, userId],
    });
    if (!res.rowsAffected) throw new NotFoundException("Not a recipient");
    return this.schedule(id);
  }

  // ---- Generation -------------------------------------------------------------------------------

  /** The report for the last complete period, without sending anything. */
  async preview(id: string, now = Date.now()) {
    const s = await this.schedule(id);
    const period = reportPeriod(s.frequency, now, s.timeZone, this.policy.weekStartsOn);
    const data = await this.generate(s, period);
    return { period, ...renderReport(data), warnings: reportWarnings(data) };
  }

  async generate(s: ReportSchedule, period: { from: string; to: string }): Promise<ReportData> {
    const head = {
      name: s.name,
      kind: s.kind,
      scope: s.employee ? `${s.employee.fullName} (${s.employee.employeeCode})` : s.team ? `Team ${s.team.name}` : "Organisation",
      frequency: s.frequency,
      timeZone: s.timeZone,
      period,
      generatedAt: iso(Date.now()),
    };
    if (s.kind !== "WORKED_HOURS") return { ...head, employees: [], projects: null, runningTimers: null, exceptions: await this.exceptions(s, period) };
    const team = teamFilterSql(s.team?.id, "p.id");
    const { rows } = await this.db.execute({
      sql: `SELECT p.id, p.full_name, p.employee_code, p.timezone,
              (SELECT max(d.last_seen_at) FROM devices d WHERE d.employee_id = p.id AND d.revoked_at IS NULL) AS last_seen
            FROM employee_profiles p WHERE ((?1 IS NULL AND p.employment_status <> 'TERMINATED') OR p.id = ?1)${team.sql} ORDER BY p.full_name`,
      args: [s.employee?.id ?? null, ...team.args],
    });
    const time = !s.includeProjects ? null : s.team ? await this.teamProjectTime(period, rows.map((r) => String(r.id))) : await this.projects.summary(period.from, period.to, s.employee?.id);
    const employees: ReportData["employees"] = [];
    for (const r of rows) {
      const employee = { id: String(r.id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) };
      const sheet = await this.timesheets.forEmployee(employee, period.from, period.to);
      const t = sheet.totals;
      employees.push({
        employee,
        shifts: t.shifts,
        workedMs: t.netMs,
        breakMs: t.breakMs,
        overtimeMs: t.overtimeMs,
        openShifts: t.incompleteDays,
        pendingCorrections: sheet.pendingCorrections,
        deviceLastSeenAt: str(r.last_seen),
        taskMs: time ? (time.byEmployee.find((x) => x.employee.id === employee.id)?.taskMs ?? 0) : null,
      });
    }
    return {
      ...head,
      employees,
      projects: time ? time.byProject.map((p) => ({ code: p.project.code, name: p.project.name, archived: p.project.status === "ARCHIVED", taskMs: p.taskMs, entries: p.entries })) : null,
      runningTimers: time ? time.running : null,
      exceptions: null,
    };
  }

  /**
   * LATE / ABSENT days in the period: ScheduleService.daily for each local date (its rules: policy and override in
   * force, approved leave, holidays, each employee's own zone), kept to the report's scope.
   */
  private async exceptions(s: ReportSchedule, period: { from: string; to: string }): Promise<NonNullable<ReportData["exceptions"]>> {
    const team = s.team ? new Set(await this.teamMembers(s.team.id)) : null;
    const people = new Set<string>();
    const noPolicyDays: string[] = [];
    const items: NonNullable<ReportData["exceptions"]>["items"] = [];
    for (let date = period.from; date <= period.to; date = addDays(date, 1)) {
      // ponytail: one daily() per date (31 for a month), each over the whole organisation; fine for one organisation.
      const day = await this.schedules.daily({ date, page: 1, pageSize: 1_000_000 });
      for (const r of day.items) {
        if (s.employee ? r.employee.id !== s.employee.id : team && !team.has(r.employee.id)) continue;
        people.add(r.employee.id);
        if (r.status === "NO_POLICY" && noPolicyDays.at(-1) !== date) noPolicyDays.push(date);
        if (r.status === s.kind) items.push({ employee: r.employee, date, firstClockInLocal: r.firstClockInLocal, lateMinutes: r.lateMinutes });
      }
    }
    return { people: people.size, noPolicyDays, items };
  }

  private async teamMembers(teamId: string): Promise<string[]> {
    const team = teamFilterSql(teamId, "p.id");
    return (await this.db.execute({ sql: `SELECT p.id FROM employee_profiles p WHERE 1${team.sql}`, args: team.args })).rows.map((r) => String(r.id));
  }

  /** Project time of these employees only (never another team's), merged from per-employee summaries. */
  private async teamProjectTime(period: { from: string; to: string }, ids: string[]): Promise<ProjectTimeSummary> {
    const merged: ProjectTimeSummary = { from: period.from, to: period.to, byProject: [], byEmployee: [], running: 0 };
    for (const id of ids) {
      const one = await this.projects.summary(period.from, period.to, id);
      merged.byEmployee.push(...one.byEmployee);
      merged.running += one.running;
      for (const p of one.byProject) {
        const m = merged.byProject.find((x) => x.project.id === p.project.id);
        if (m) {
          m.taskMs += p.taskMs;
          m.entries += p.entries;
        } else merged.byProject.push({ ...p });
      }
    }
    merged.byProject.sort((a, b) => a.project.code.localeCompare(b.project.code));
    return merged;
  }

  // ---- Runs and delivery ------------------------------------------------------------------------

  /** Admin "send now" for the last complete period: the same run (no second email) if it exists. */
  async runNow(caller: AuthContext, id: string, now = Date.now()): Promise<RunNowResponse> {
    const s = await this.schedule(id);
    const { runId, duplicate } = await this.createRun(s, reportPeriod(s.frequency, now, s.timeZone, this.policy.weekStartsOn), caller.id);
    await this.deliverDue(now);
    return { duplicate, run: (await this.runs(s.id)).find((r) => r.id === runId)! };
  }

  /**
   * Scheduler: for every active schedule, a run for the most recent period whose send time has passed (and that
   * became due after the schedule was created: no backfill), then due deliveries. One run per period (unique key).
   */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const s of (await this.list()).filter((x) => x.active)) {
        const period = duePeriod(s.frequency, now, s.timeZone, s.sendAtLocalTime, this.policy.weekStartsOn);
        if (reportDueAt(period, s.timeZone, s.sendAtLocalTime) > s.createdAt) await this.createRun(s, period, null);
      }
      await this.deliverDue(now);
    } finally {
      this.ticking = false;
    }
  }

  async runs(scheduleId?: string): Promise<ReportRun[]> {
    const { rows: runs } = await this.db.execute({
      sql: `SELECT r.id, r.schedule_id, r.period_from, r.period_to, r.triggered_by, u.email, r.created_at FROM report_runs r
            LEFT JOIN users u ON u.id = r.triggered_by WHERE (?1 IS NULL OR r.schedule_id = ?1) ORDER BY r.created_at DESC LIMIT 50`,
      args: [scheduleId ?? null],
    });
    if (!runs.length) return [];
    // Only the selected runs' deliveries and attempts (a run's deliveries are created with it).
    const ids = runs.map((r) => String(r.id));
    const marks = ids.map(() => "?").join(", ");
    const [deliveries, attempts] = await this.db.batch(
      [
        { sql: `SELECT id, run_id, user_id, email, status, provider, last_error, next_attempt_at, finished_at FROM report_deliveries WHERE run_id IN (${marks}) ORDER BY email`, args: ids },
        {
          sql: `SELECT a.delivery_id, a.attempt, a.outcome, a.error, a.created_at FROM report_delivery_attempts a JOIN report_deliveries d ON d.id = a.delivery_id
                WHERE d.run_id IN (${marks}) ORDER BY a.attempt`,
          args: ids,
        },
      ],
      "read",
    );
    return runs.map((r) => {
      const ds = deliveries!.rows
        .filter((d) => d.run_id === r.id)
        .map((d) => ({
          id: String(d.id),
          recipient: { id: String(d.user_id), email: String(d.email) },
          status: d.status as ReportDeliveryStatus,
          provider: String(d.provider ?? this.transport.name),
          attempts: attempts!.rows.filter((a) => a.delivery_id === d.id).map((a) => ({ attempt: Number(a.attempt), outcome: String(a.outcome), error: str(a.error), at: String(a.created_at) })),
          lastError: str(d.last_error),
          nextAttemptAt: str(d.next_attempt_at),
          finishedAt: str(d.finished_at),
        }));
      const status: ReportRun["status"] = !ds.length ? "NO_RECIPIENTS" : ds.some((d) => !FINAL.includes(d.status)) ? "IN_PROGRESS" : ds.some((d) => d.status === "FAILED") ? "FAILED" : ds.some((d) => d.status === "MOCKED" || d.status === "NOT_CONFIGURED") ? "NOT_EMAILED" : "DELIVERED";
      return {
        id: String(r.id),
        scheduleId: String(r.schedule_id),
        period: { from: String(r.period_from), to: String(r.period_to) },
        triggeredBy: r.triggered_by ? { id: String(r.triggered_by), email: String(r.email) } : null,
        createdAt: String(r.created_at),
        status,
        deliveries: ds,
      };
    });
  }

  /** Creates the run and one delivery per current recipient; an existing run for the period is returned instead. */
  private async createRun(s: ReportSchedule, period: { from: string; to: string }, triggeredBy: string | null) {
    const runId = randomUUID();
    const { rows: recipients } = await this.db.execute({ sql: "SELECT user_id FROM report_recipients WHERE schedule_id = ? AND removed_at IS NULL", args: [s.id] });
    try {
      await this.db.batch(
        [
          { sql: "INSERT INTO report_runs (id, schedule_id, period_from, period_to, triggered_by) VALUES (?, ?, ?, ?, ?)", args: [runId, s.id, period.from, period.to, triggeredBy] },
          // One UUID per recipient read above; each still re-checked as current when the row is written.
          ...recipients.map((r) => ({
            sql: `INSERT INTO report_deliveries (id, run_id, user_id, email)
                  SELECT ?, ?, r.user_id, u.email FROM report_recipients r JOIN users u ON u.id = r.user_id
                  WHERE r.schedule_id = ? AND r.user_id = ? AND r.removed_at IS NULL`,
            args: [randomUUID(), runId, s.id, String(r.user_id)],
          })),
        ],
        "write",
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = (await this.db.execute({ sql: "SELECT id FROM report_runs WHERE schedule_id = ? AND period_from = ?", args: [s.id, period.from] })).rows[0]!;
      return { runId: String(existing.id), duplicate: true };
    }
    this.logger.log({ runId, scheduleId: s.id, period }, "Report run created");
    return { runId, duplicate: false };
  }

  /** Sends every due delivery once per claim; returns how many were attempted. */
  async deliverDue(now = Date.now()): Promise<number> {
    const nowIso = iso(now);
    // A claim whose lease expired was interrupted mid-send; it may or may not have gone out, so it is not retried.
    const stale = await this.db.execute({ sql: "SELECT id, attempts FROM report_deliveries WHERE status = 'SENDING' AND claimed_until < ?", args: [nowIso] });
    for (const d of stale.rows) await this.finish(String(d.id), Number(d.attempts), "FAILED", "INTERRUPTED", "Interrupted while sending; not retried automatically to avoid a duplicate email", null, nowIso);

    const due = await this.db.execute({
      sql: `SELECT d.id, d.run_id, d.user_id, r.schedule_id, r.period_from, r.period_to FROM report_deliveries d JOIN report_runs r ON r.id = d.run_id
            WHERE d.status IN ('PENDING', 'RETRYING') AND coalesce(d.next_attempt_at, '') <= ? ORDER BY d.created_at`,
      args: [nowIso],
    });
    const reports = new Map<string, { subject: string; text: string } | null>();
    let attempted = 0;
    for (const d of due.rows) {
      const id = String(d.id);
      const claim = await this.db.execute({
        sql: "UPDATE report_deliveries SET status = 'SENDING', attempts = attempts + 1, claimed_until = ?, updated_at = ? WHERE id = ? AND status IN ('PENDING', 'RETRYING')",
        args: [iso(now + LEASE_MS), nowIso, id],
      });
      if (!claim.rowsAffected) continue; // another tick took it
      attempted++;
      const attempt = Number((await this.db.execute({ sql: "SELECT attempts FROM report_deliveries WHERE id = ?", args: [id] })).rows[0]!.attempts);
      const s = await this.schedule(String(d.schedule_id));
      const recipient = await this.authorizedRecipient(s, String(d.user_id));
      if (!s.active || !recipient) {
        await this.finish(id, attempt, "SKIPPED", "SKIPPED", !s.active ? "The report was deactivated" : "The recipient is no longer authorized (removed, disabled or not eligible)", null, nowIso);
        continue;
      }
      if (this.transport.name === "none") {
        await this.finish(id, attempt, "NOT_CONFIGURED", "NOT_CONFIGURED", "No email provider is configured; nothing was sent", null, nowIso);
        continue;
      }
      const runId = String(d.run_id);
      if (!reports.has(runId)) reports.set(runId, renderReport(await this.generate(s, { from: String(d.period_from), to: String(d.period_to) })));
      const report = reports.get(runId)!;
      const sha = createHash("sha256").update(report.text).digest("hex");
      try {
        const { messageId } = await this.transport.send({ to: recipient.email, ...report });
        const status = this.transport.delivers ? "SENT" : "MOCKED";
        await this.finish(id, attempt, status, status, null, sha, nowIso, messageId);
      } catch (err) {
        const message = (err instanceof MailError ? err.message : "Provider error").slice(0, 300); // never the report content
        if ((err instanceof MailError && err.permanent) || attempt >= MAX_ATTEMPTS) {
          await this.finish(id, attempt, "FAILED", err instanceof MailError && err.permanent ? "PERMANENT_ERROR" : "TRANSIENT_ERROR", message, sha, nowIso);
        } else {
          await this.db.batch(
            [
              { sql: "UPDATE report_deliveries SET status = 'RETRYING', provider = ?, last_error = ?, next_attempt_at = ?, claimed_until = NULL, updated_at = ? WHERE id = ?", args: [this.transport.name, message, iso(now + BACKOFF_MS * 2 ** (attempt - 1)), nowIso, id] },
              { sql: "INSERT INTO report_delivery_attempts (id, delivery_id, attempt, outcome, error, content_sha256) VALUES (?, ?, ?, 'TRANSIENT_ERROR', ?, ?)", args: [randomUUID(), id, attempt, message, sha] },
            ],
            "write",
          );
          this.logger.warn({ deliveryId: id, attempt }, "Report delivery will be retried");
        }
      }
    }
    return attempted;
  }

  // ---- internals ---------------------------------------------------------------------------------

  /** A report covers one team or one employee, never both (400); either must exist (404, as for other references). */
  private async assertScope(employeeId: string | null, teamId: string | null) {
    if (employeeId && teamId) throw new BadRequestException("Choose a team or one employee, not both");
    if (employeeId && !(await this.db.execute({ sql: "SELECT 1 FROM employee_profiles WHERE id = ?", args: [employeeId] })).rows[0]) throw new NotFoundException("Employee not found");
    if (teamId && !(await this.db.execute({ sql: "SELECT 1 FROM teams WHERE id = ?", args: [teamId] })).rows[0]) throw new NotFoundException("Team not found");
  }

  private async finish(id: string, attempt: number, status: ReportDeliveryStatus, outcome: string, error: string | null, sha: string | null, at: string, messageId: string | null = null) {
    await this.db.batch(
      [
        {
          sql: "UPDATE report_deliveries SET status = ?, provider = ?, last_error = ?, message_id = ?, finished_at = ?, claimed_until = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
          args: [status, this.transport.name, error, messageId, at, at, id],
        },
        { sql: "INSERT INTO report_delivery_attempts (id, delivery_id, attempt, outcome, error, content_sha256) VALUES (?, ?, ?, ?, ?, ?)", args: [randomUUID(), id, Math.max(1, attempt), outcome, error, sha] },
      ],
      "write",
    );
    this.logger.log({ deliveryId: id, status, attempt }, "Report delivery finished");
  }

  /** Still a current recipient, active, and eligible for this schedule (checked on every send). */
  private async authorizedRecipient(s: ScheduleRow, userId: string) {
    const { rows } = await this.db.execute({
      sql: `SELECT u.email FROM report_recipients r JOIN users u ON u.id = r.user_id
            WHERE r.schedule_id = ? AND r.user_id = ? AND r.removed_at IS NULL AND u.status = 'ACTIVE' AND (u.role = 'ADMIN' OR u.id = ? OR u.id = ?)`,
      args: [s.id, userId, s.employeeUserId, s.teamHeadUserId],
    });
    return rows[0] ? { email: String(rows[0].email) } : null;
  }

  private toSchedule(r: Row, recipients: Row[]): ScheduleRow {
    return {
      id: String(r.id),
      name: String(r.name),
      kind: r.kind as ReportKind,
      frequency: r.frequency as ReportFrequency,
      timeZone: String(r.timezone),
      sendAtLocalTime: str(r.send_at_local_time),
      employee: r.employee_id ? { id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.employee_timezone) } : null,
      team: r.team_id ? { id: String(r.team_id), name: String(r.team_name) } : null,
      employeeUserId: str(r.employee_user_id),
      teamHeadUserId: str(r.team_head_user_id),
      includeProjects: r.include_projects === 1 || r.include_projects === 1n,
      active: r.active === 1 || r.active === 1n,
      createdBy: { id: String(r.created_by), email: String(r.creator_email) },
      createdAt: String(r.created_at),
      recipients: recipients.filter((x) => x.schedule_id === r.id).map((x) => ({ id: String(x.user_id), email: String(x.email), role: String(x.role), addedAt: String(x.added_at) })),
    };
  }

  private async schedule(id: string): Promise<ScheduleRow> {
    const [s, recipients] = await this.db.batch(
      [
        { sql: `${SCHEDULE} WHERE s.id = ?`, args: [id] },
        { sql: "SELECT r.schedule_id, r.user_id, u.email, u.role, r.added_at FROM report_recipients r JOIN users u ON u.id = r.user_id WHERE r.schedule_id = ? AND r.removed_at IS NULL ORDER BY u.email", args: [id] },
      ],
      "read",
    );
    if (!s!.rows[0]) throw new NotFoundException("Report not found");
    return this.toSchedule(s!.rows[0], recipients!.rows);
  }
}

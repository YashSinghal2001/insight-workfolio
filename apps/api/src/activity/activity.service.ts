import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import { guardViolation, isUniqueViolation, type DatabaseClient, type InStatement } from "@workfolio/database";
import {
  addDays,
  deriveLiveStatus,
  todayIn,
  weekStart,
  zonedToUtc,
  type ActivityAppTotal,
  type ActivityKind,
  type ActivityOverviewRow,
  type ApplicationCategory,
  type CategorizedActivityDay,
  type CategorizedTimelineItem,
  type ActivityPeriodTotals,
  type ActivityReportWeek,
  type ActivityStatusResponse,
  type CategorizedActivitySummary,
  type ActivitySyncRequest,
  type ActivitySyncResponse,
  type ActivitySyncResult,
  type ActivityTimelineItem,
  type ActivityWarning,
  type AttendancePolicy,
  type ConsentRecord,
  type EmployeeRef,
  type Paginated,
} from "@workfolio/shared";
import { activityReport, clockedInSegments, DEVICE_LIVE_COLUMNS, iso, SESSION_COLUMNS, str, withBreaks, type Segment } from "../attendance/sessions.js";
import { employeeReadAudit } from "../audit/account-audit.js";
import type { AuthContext } from "../auth/auth.service.js";
import { EmployeeLocks } from "../common/employee-locks.js";
import { POLICY } from "../common/policy.js";
import { DATABASE } from "../database/database.module.js";
import type { DeviceContext } from "../devices/devices.service.js";
import { MonitoringSettingsService, type PolicyPeriod } from "../settings/monitoring-settings.service.js";
import { ActivityCategoriesService } from "./categories.service.js";

/** Edges this far outside a clocked-in segment (or into a neighbouring interval) are trimmed; more is rejected. */
const EDGE_TOLERANCE_MS = 60_000;
/** Clocked in for longer than this without an upload = stale. Desktop uploads every minute. */
const FRESHNESS_MS = 15 * 60_000;
/** Unobserved time on a day is reported once it exceeds both of these. */
const UNOBSERVED_WARN_MS = 5 * 60_000;
const UNOBSERVED_WARN_SHARE = 0.1;
const DAY_MS = 86_400_000;

const TIMELINE_COLUMNS = "id, kind, application_identifier, application_name, started_at, ended_at";
const toItem = (r: Record<string, unknown>): ActivityTimelineItem => ({
  id: String(r.id),
  kind: r.kind as ActivityKind,
  applicationIdentifier: str(r.application_identifier),
  applicationName: str(r.application_name),
  startedAt: String(r.started_at),
  endedAt: String(r.ended_at),
});
/** Milliseconds of an interval inside [?, ?) (end bound first). ISO strings compare chronologically. */
const CLIPPED_MS = "round((julianday(min(ended_at, ?)) - julianday(max(started_at, ?))) * 86400000)";
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
/** Same grouping key as the per-application totals (identifier, else the name). */
const APP_KEY = "coalesce(a.application_identifier, 'name:' || a.application_name)";
const appKey = (a: { applicationIdentifier: string | null; applicationName: string | null }) => a.applicationIdentifier ?? `name:${a.applicationName}`;
type Split = Record<ApplicationCategory, number>;
const emptySplit = (): Split => ({ PRODUCTIVE: 0, NEUTRAL: 0, UNPRODUCTIVE: 0, UNCLASSIFIED: 0 });

/**
 * Activity intervals uploaded by the desktop agent. Accepted only from the employee's active
 * device, only while monitoring was enabled and the then-required notice had been acknowledged,
 * and only inside clocked-in, non-break time. Stored intervals never overlap, so totals never
 * double count.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly attendancePolicy: AttendancePolicy,
    private readonly settings: MonitoringSettingsService,
    private readonly locks: EmployeeLocks,
    private readonly categories: ActivityCategoriesService,
  ) {}

  async status(employee: EmployeeRef): Promise<ActivityStatusResponse> {
    const settings = await this.settings.current();
    const today = todayIn(employee.timezone);
    const [notice, [consent, session, last, latest, device], totals, policy] = await Promise.all([
      this.settings.notice(settings.noticeVersion),
      this.db.batch(
        [
          {
            sql: "SELECT acknowledged_at FROM monitoring_consents WHERE employee_id = ? AND notice_version = ?",
            args: [employee.id, settings.noticeVersion],
          },
          {
            sql: `SELECT s.id,
                    coalesce(sum(CASE WHEN a.kind = 'ACTIVE' THEN a.active_seconds END), 0) AS active,
                    coalesce(sum(CASE WHEN a.kind = 'IDLE' THEN a.idle_seconds END), 0) AS idle
                  FROM attendance_sessions s LEFT JOIN activity_intervals a ON a.attendance_session_id = s.id
                  WHERE s.id = (SELECT id FROM attendance_sessions WHERE employee_id = ? ORDER BY clock_in_at DESC LIMIT 1)
                  GROUP BY s.id`,
            args: [employee.id],
          },
          { sql: "SELECT max(received_at) AS at FROM activity_intervals WHERE employee_id = ?", args: [employee.id] },
          { sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.employee_id = ? ORDER BY s.clock_in_at DESC LIMIT 1`, args: [employee.id] },
          { sql: `SELECT ${DEVICE_LIVE_COLUMNS} FROM devices WHERE employee_id = ? AND revoked_at IS NULL`, args: [employee.id] },
        ],
        "read",
      ),
      this.aggregate(employee, today, today),
      this.settings.policyFor(employee.id, settings), // effective for this employee (W21/W22)
    ]);
    const s = session!.rows[0];
    const [latestSession = null] = await withBreaks(this.db, latest!.rows);
    return {
      // Monitoring off or the notice in force not acknowledged: the device's last report is not shown.
      ...deriveLiveStatus(latestSession, settings.enabled && consent!.rows[0] ? activityReport(device!.rows[0]) : null),
      policy,
      notice,
      consent: { noticeVersion: settings.noticeVersion, acknowledgedAt: str(consent!.rows[0]?.acknowledged_at) },
      today: { date: today, activeMs: totals.activeMs, idleMs: totals.idleMs },
      currentSession: s ? { sessionId: String(s.id), activeMs: Number(s.active) * 1000, idleMs: Number(s.idle) * 1000 } : null,
      lastReceivedAt: str(last!.rows[0]?.at),
    };
  }

  /** Records that the employee acknowledged the currently required notice. Idempotent; history is kept. */
  async consent(employee: EmployeeRef, noticeVersion: string): Promise<ActivityStatusResponse> {
    const { noticeVersion: required } = await this.settings.current();
    if (noticeVersion !== required) throw new BadRequestException("This is not the current monitoring notice");
    await this.db.execute({
      sql: "INSERT OR IGNORE INTO monitoring_consents (id, employee_id, notice_version) VALUES (?, ?, ?)",
      args: [randomUUID(), employee.id, noticeVersion],
    });
    this.logger.log({ employeeId: employee.id, noticeVersion }, "Monitoring notice acknowledged");
    return this.status(employee);
  }

  /** Every acknowledgement the employee made, newest first (records are never changed or deleted). */
  async consents(employee: EmployeeRef): Promise<{ items: ConsentRecord[] }> {
    const { rows } = await this.db.execute({
      sql: `SELECT c.notice_version, coalesce(n.title, c.notice_version) AS title, c.acknowledged_at
            FROM monitoring_consents c LEFT JOIN monitoring_notices n ON n.version = c.notice_version
            WHERE c.employee_id = ? ORDER BY c.acknowledged_at DESC`,
      args: [employee.id],
    });
    return { items: rows.map((r) => ({ noticeVersion: String(r.notice_version), noticeTitle: String(r.title), acknowledgedAt: String(r.acknowledged_at) })) };
  }

  async sync(device: DeviceContext, req: ActivitySyncRequest): Promise<ActivitySyncResponse> {
    const [{ rows: acks }, periods] = await Promise.all([
      this.db.execute({ sql: "SELECT notice_version, acknowledged_at FROM monitoring_consents WHERE employee_id = ?", args: [device.employeeId] }),
      this.settings.periods(),
    ]);
    const receivedAt = Date.now();
    const skew = receivedAt - Date.parse(req.sentAt); // same correction as attendance sync
    const ackAt = new Map(acks.map((r) => [String(r.notice_version), Date.parse(String(r.acknowledged_at))]));
    if (req.current) await this.recordCurrent(device, req.current, { skew, receivedAt, periods, ackAt });
    if (!acks.length) throw new ForbiddenException("The monitoring notice has not been acknowledged");
    if (!req.intervals.length) return { results: [] };
    // Processed chronologically; results go back in the caller's order (by position: ids may repeat).
    const order = req.intervals.map((_, k) => k).sort((a, b) => req.intervals[a]!.startedAt.localeCompare(req.intervals[b]!.startedAt));
    const intervals = req.intervals;
    const from = Math.min(...intervals.map((i) => Date.parse(i.startedAt))) + skew - EDGE_TOLERANCE_MS;
    const to = Math.max(...intervals.map((i) => Date.parse(i.endedAt))) + skew + EDGE_TOLERANCE_MS;

    const results = await this.locks.run(device.employeeId, async () => {
      // Three reads for the whole batch (not per interval): matters on a remote Turso database.
      const [segments, [prior, existing]] = await Promise.all([
        clockedInSegments(this.db, device.employeeId, from, Math.min(to, receivedAt), receivedAt + EDGE_TOLERANCE_MS),
        this.db.batch(
          [
            {
              sql: `SELECT idempotency_key FROM activity_intervals WHERE employee_id = ? AND idempotency_key IN (${intervals.map(() => "?").join(", ")})`,
              args: [device.employeeId, ...intervals.map((i) => i.id)],
            },
            { sql: "SELECT started_at, ended_at FROM activity_intervals WHERE employee_id = ? AND ended_at > ? AND started_at < ?", args: [device.employeeId, iso(from), iso(to)] },
          ],
          "read",
        ),
      ]);
      const seen = new Set(prior!.rows.map((r) => String(r.idempotency_key)));
      const taken = existing!.rows.map((r) => ({ start: Date.parse(String(r.started_at)), end: Date.parse(String(r.ended_at)) }));
      const out: ActivitySyncResult[] = new Array(intervals.length);
      const inserts: { result: ActivitySyncResult; stmt: InStatement }[] = [];
      for (const k of order) {
        const i = intervals[k]!;
        if (seen.has(i.id)) {
          out[k] = { id: i.id, status: "DUPLICATE" };
          continue;
        }
        seen.add(i.id);
        const r = this.check(device, i, { skew, receivedAt, segments, periods, ackAt, taken, source: req.platform === "macos" ? "DESKTOP_MACOS" : "DESKTOP_WINDOWS" });
        out[k] = "stmt" in r ? { id: i.id, status: "ACCEPTED" } : r;
        if ("stmt" in r) inserts.push({ result: out[k], stmt: r.stmt });
      }
      await this.insert(inserts);
      return out;
    });
    const accepted = results.filter((r) => r.status === "ACCEPTED").length;
    if (accepted) this.logger.log({ employeeId: device.employeeId, accepted, received: results.length }, "Activity synced");
    return { results };
  }

  async summary(employee: EmployeeRef, from: string, to: string): Promise<CategorizedActivitySummary> {
    const now = Date.now();
    const [start, end] = this.bounds(employee, from, to).map(Date.parse) as [number, number];
    const [agg, segments, settings, [last, device], labels] = await Promise.all([
      this.aggregate(employee, from, to, true),
      clockedInSegments(this.db, employee.id, start, Math.min(end, now), now),
      this.settings.current(),
      this.db.batch(
        [
          { sql: "SELECT max(received_at) AS at FROM activity_intervals WHERE employee_id = ?", args: [employee.id] },
          {
            // device_activity_at: whether this device has ever uploaded activity (Windows support arrived in a later app version).
            sql: `SELECT d.platform, d.last_seen_at, (SELECT max(a.received_at) FROM activity_intervals a WHERE a.device_id = d.id) AS device_activity_at
                  FROM devices d WHERE d.employee_id = ? AND d.revoked_at IS NULL ORDER BY d.registered_at DESC LIMIT 1`,
            args: [employee.id],
          },
        ],
        "read",
      ),
      this.categories.labelsFor([employee.id]),
    ]);
    const consent = await this.db.execute({
      sql: "SELECT acknowledged_at FROM monitoring_consents WHERE employee_id = ? AND notice_version = ?",
      args: [employee.id, settings.noticeVersion],
    });

    // Labels apply at read time (retroactive), with the employee's team labels (F05). Only ACTIVE time is labelled; idle is never productive.
    const applications = agg.applications.map((a) => ({ ...a, category: labels.category(employee.id, a) }));
    const categoryOf = new Map(applications.map((a) => [appKey(a), a.category]));
    const splitByDay = new Map<string, Split>();
    for (const r of agg.dayApps) {
      const split = splitByDay.get(r.date) ?? emptySplit();
      split[categoryOf.get(r.key) ?? "UNCLASSIFIED"] += r.ms;
      splitByDay.set(r.date, split);
    }
    const days: CategorizedActivityDay[] = agg.days.map((d) => {
      const clockedInMs = segments.reduce((n, s) => n + Math.max(0, Math.min(s.end, d.end) - Math.max(s.start, d.start)), 0);
      const split = splitByDay.get(d.date) ?? emptySplit();
      return {
        date: d.date, activeMs: d.activeMs, idleMs: d.idleMs, clockedInMs, unobservedMs: Math.max(0, clockedInMs - d.activeMs - d.idleMs),
        productiveMs: split.PRODUCTIVE, neutralMs: split.NEUTRAL, unproductiveMs: split.UNPRODUCTIVE, unclassifiedMs: split.UNCLASSIFIED,
        productiveShare: clockedInMs > 0 ? split.PRODUCTIVE / clockedInMs : null,
      };
    });
    const sum = (list: ActivityPeriodTotals[]): ActivityPeriodTotals => ({
      activeMs: list.reduce((n, d) => n + d.activeMs, 0),
      idleMs: list.reduce((n, d) => n + d.idleMs, 0),
      clockedInMs: list.reduce((n, d) => n + d.clockedInMs, 0),
      unobservedMs: list.reduce((n, d) => n + d.unobservedMs, 0),
    });
    const byWeek = new Map<string, CategorizedActivityDay[]>();
    for (const d of days) {
      const w = weekStart(d.date, this.attendancePolicy.weekStartsOn);
      byWeek.set(w, [...(byWeek.get(w) ?? []), d]);
    }
    const weeks: ActivityReportWeek[] = [...byWeek].map(([w, list]) => ({ weekStart: w, ...sum(list) }));

    const lastReceivedAt = str(last!.rows[0]?.at);
    const dev = device!.rows[0];
    const working = segments.find((s) => s.open);
    const stale = !!working && now - working.start > FRESHNESS_MS && (!lastReceivedAt || now - Date.parse(lastReceivedAt) > FRESHNESS_MS);
    const acknowledgedAt = str(consent.rows[0]?.acknowledged_at);

    const warnings: ActivityWarning[] = [];
    if (!settings.enabled) warnings.push({ code: "MONITORING_DISABLED", message: "Activity monitoring is turned off in the settings; nothing is being recorded." });
    if (!acknowledgedAt) warnings.push({ code: "NO_CONSENT", message: `The employee has not acknowledged the current monitoring notice (${settings.noticeVersion}); nothing is recorded until they do.` });
    if (!dev) warnings.push({ code: "NO_ACTIVE_DEVICE", message: "No active device is registered; activity cannot be recorded." });
    else if (dev.platform === "windows" && !dev.device_activity_at) {
      // Older desktop builds recorded attendance only on Windows; current builds collect activity there too.
      warnings.push({ code: "UNSUPPORTED_PLATFORM", message: "The employee's Windows device has not sent any activity yet. Older versions of the desktop app record attendance only on Windows; ask the employee to update the app." });
    }
    if (stale) {
      warnings.push({
        code: "STALE_SYNC",
        message: `Clocked in, but no activity has been uploaded ${lastReceivedAt ? `for ${minutes(now - Date.parse(lastReceivedAt))}` : "yet"}. The computer may be offline, asleep or the app closed.`,
      });
    }
    for (const d of days) {
      if (d.unobservedMs > UNOBSERVED_WARN_MS && d.unobservedMs > d.clockedInMs * UNOBSERVED_WARN_SHARE) {
        warnings.push({
          code: "UNOBSERVED_TIME",
          date: d.date,
          message: `${minutes(d.unobservedMs)} of ${minutes(d.clockedInMs)} clocked-in time has no activity record (computer asleep or off, app not running, monitoring paused, or not uploaded yet). It is not counted as active or idle.`,
        });
      }
    }

    const byCategory = (c: string) => applications.reduce((n, a) => n + (a.category === c ? a.activeMs : 0), 0);
    const totals = sum(days);
    const productiveMs = byCategory("PRODUCTIVE");

    return {
      employee, from, to,
      ...totals,
      applications,
      days,
      weeks,
      lastReceivedAt,
      deviceLastSeenAt: str(dev?.last_seen_at),
      freshness: stale ? "STALE" : !lastReceivedAt && !segments.length ? "NO_DATA" : "CURRENT",
      consent: { noticeVersion: settings.noticeVersion, acknowledgedAt },
      warnings,
      productiveMs,
      neutralMs: byCategory("NEUTRAL"),
      unproductiveMs: byCategory("UNPRODUCTIVE"),
      unclassifiedMs: byCategory("UNCLASSIFIED"),
      productiveShare: totals.clockedInMs > 0 ? productiveMs / totals.clockedInMs : null,
      categoriesConfigured: labels.configured,
    };
  }

  /** `caller` reading someone else's timeline is audited (one row per request). */
  async timeline(employee: EmployeeRef & { userId: string }, q: { from: string; to: string; page: number; pageSize: number }, caller: AuthContext): Promise<Paginated<CategorizedTimelineItem>> {
    const audit = employeeReadAudit(caller, employee, "EMPLOYEE_ACTIVITY_TIMELINE_VIEWED", { from: q.from, to: q.to });
    if (audit) await this.db.execute(audit);
    const [start, end] = this.bounds(employee, q.from, q.to);
    const where = "employee_id = ? AND started_at < ? AND ended_at > ?";
    const [labels, [rows, count]] = await Promise.all([this.categories.labelsFor([employee.id]), this.db.batch(
      [
        {
          sql: `SELECT ${TIMELINE_COLUMNS} FROM activity_intervals WHERE ${where} ORDER BY started_at, id LIMIT ? OFFSET ?`,
          args: [employee.id, end, start, q.pageSize, (q.page - 1) * q.pageSize],
        },
        { sql: `SELECT count(*) AS n FROM activity_intervals WHERE ${where}`, args: [employee.id, end, start] },
      ],
      "read",
    )]);
    const items = rows!.rows.map((r): CategorizedTimelineItem => {
      const item = toItem(r);
      return { ...item, category: item.kind === "IDLE" ? null : labels.category(employee.id, item) };
    });
    return { items, total: Number(count!.rows[0]!.n), page: q.page, pageSize: q.pageSize };
  }

  /**
   * Admin overview: range totals for one page of employees, each range in the employee's own time zone.
   * Five reads for the whole page (no per-employee queries). Clocked-in time is computed in SQL with the
   * same rule as clockedInSegments (sessions minus breaks, open ones running to now).
   */
  async overview(employees: EmployeeRef[], from: string, to: string): Promise<{ items: ActivityOverviewRow[]; categoriesConfigured: boolean }> {
    const labels = await this.categories.labelsFor(employees.map((e) => e.id));
    const configured = labels.configured;
    if (!employees.length) return { items: [], categoriesConfigured: configured };
    const now = iso(Date.now());
    const bounds = employees.map((e) => {
      const [s, end] = this.bounds(e, from, to);
      return [e.id, s, end < now ? end : now];
    });
    const b = { sql: `WITH b(emp, s, e) AS (VALUES ${bounds.map(() => "(?, ?, ?)").join(", ")})`, args: bounds.flat() };
    const clip = (endExpr: string, startExpr: string) => `sum(max(0, round((julianday(${endExpr}) - julianday(${startExpr})) * 86400000)))`;
    const sessionJoin = "JOIN attendance_sessions s ON s.employee_id = b.emp AND s.clock_in_at < b.e AND coalesce(s.clock_out_at, b.e) > b.s";
    const [activity, worked, breaks, last] = await this.db.batch(
      [
        {
          // Bare application columns come from the latest interval (max), as in the per-employee summary.
          sql: `${b.sql} SELECT b.emp, a.kind, a.application_identifier, a.application_name, max(a.started_at) AS latest, ${clip("min(a.ended_at, b.e)", "max(a.started_at, b.s)")} AS ms
                FROM b JOIN activity_intervals a ON a.employee_id = b.emp AND a.started_at < b.e AND a.ended_at > b.s
                GROUP BY b.emp, a.kind, ${APP_KEY}`,
          args: b.args,
        },
        { sql: `${b.sql} SELECT b.emp, ${clip("min(coalesce(s.clock_out_at, b.e), b.e)", "max(s.clock_in_at, b.s)")} AS ms FROM b ${sessionJoin} GROUP BY b.emp`, args: b.args },
        {
          sql: `${b.sql} SELECT b.emp, ${clip("min(coalesce(br.ended_at, b.e), coalesce(s.clock_out_at, b.e), b.e)", "max(br.started_at, s.clock_in_at, b.s)")} AS ms
                FROM b ${sessionJoin} JOIN break_sessions br ON br.attendance_session_id = s.id AND br.started_at < b.e AND coalesce(br.ended_at, b.e) > b.s
                GROUP BY b.emp`,
          args: b.args,
        },
        {
          sql: `SELECT employee_id, max(received_at) AS at FROM activity_intervals WHERE employee_id IN (${employees.map(() => "?").join(", ")}) GROUP BY employee_id`,
          args: employees.map((e) => e.id),
        },
      ],
      "read",
    );
    const byEmp = (rows: Record<string, unknown>[]) => new Map(rows.map((r) => [String(r.emp), Number(r.ms)]));
    const workedMs = byEmp(worked!.rows);
    const breakMs = byEmp(breaks!.rows);
    const lastAt = new Map(last!.rows.map((r) => [String(r.employee_id), str(r.at)]));
    const items = employees.map((employee): ActivityOverviewRow => {
      let activeMs = 0;
      let idleMs = 0;
      let productive = 0;
      for (const r of activity!.rows) {
        if (r.emp !== employee.id) continue;
        if (r.kind === "IDLE") idleMs += Number(r.ms);
        else {
          activeMs += Number(r.ms);
          const app = { applicationIdentifier: str(r.application_identifier), applicationName: str(r.application_name) };
          if (labels.category(employee.id, app) === "PRODUCTIVE") productive += Number(r.ms);
        }
      }
      const clockedInMs = Math.max(0, (workedMs.get(employee.id) ?? 0) - (breakMs.get(employee.id) ?? 0));
      return {
        employee,
        clockedInMs,
        activeMs,
        idleMs,
        unobservedMs: Math.max(0, clockedInMs - activeMs - idleMs),
        productiveMs: configured ? productive : null,
        productiveShare: configured && clockedInMs > 0 ? productive / clockedInMs : null,
        lastReceivedAt: lastAt.get(employee.id) ?? null,
      };
    });
    return { items, categoriesConfigured: configured };
  }

  // ---- internals ------------------------------------------------------------------

  private bounds(employee: EmployeeRef, from: string, to: string): [string, string] {
    return [zonedToUtc(`${from}T00:00`, employee.timezone), zonedToUtc(`${addDays(to, 1)}T00:00`, employee.timezone)];
  }

  /** Per-day and per-application totals computed by the database (no interval rows transferred). */
  private async aggregate(employee: EmployeeRef, from: string, to: string, byDayApp = false) {
    const days: { date: string; start: number; end: number; activeMs: number; idleMs: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const [s, e] = this.bounds(employee, d, d);
      days.push({ date: d, start: Date.parse(s), end: Date.parse(e), activeMs: 0, idleMs: 0 });
    }
    const [start, end] = this.bounds(employee, from, to);
    const dayValues = `WITH b(d, s, e) AS (VALUES ${days.map(() => "(?, ?, ?)").join(", ")})`;
    const dayArgs = days.flatMap((d) => [d.date, iso(d.start), iso(d.end)]);
    const [perDay, perApp, perDayApp] = await this.db.batch(
      [
        {
          sql: `${dayValues}
                SELECT b.d, a.kind, sum(round((julianday(min(a.ended_at, b.e)) - julianday(max(a.started_at, b.s))) * 86400000)) AS ms
                FROM b JOIN activity_intervals a ON a.employee_id = ? AND a.started_at < b.e AND a.ended_at > b.s
                GROUP BY b.d, a.kind`,
          args: [...dayArgs, employee.id],
        },
        {
          // The bare application_name comes from the latest interval (max), so a renamed app shows its current name.
          sql: `SELECT application_identifier, application_name, max(started_at) AS latest, sum(${CLIPPED_MS}) AS ms
                FROM activity_intervals WHERE employee_id = ? AND kind = 'ACTIVE' AND started_at < ? AND ended_at > ?
                GROUP BY coalesce(application_identifier, 'name:' || application_name) ORDER BY ms DESC, application_name`,
          args: [end, start, employee.id, end, start],
        },
        // Per day and application (ACTIVE only), for the per-day label split of the summary.
        ...(byDayApp
          ? [{
              sql: `${dayValues}
                    SELECT b.d, ${APP_KEY} AS k, sum(round((julianday(min(a.ended_at, b.e)) - julianday(max(a.started_at, b.s))) * 86400000)) AS ms
                    FROM b JOIN activity_intervals a ON a.employee_id = ? AND a.kind = 'ACTIVE' AND a.started_at < b.e AND a.ended_at > b.s
                    GROUP BY b.d, k`,
              args: [...dayArgs, employee.id],
            }]
          : []),
      ],
      "read",
    );
    const byDate = new Map(days.map((d) => [d.date, d]));
    for (const r of perDay!.rows) {
      const d = byDate.get(String(r.d))!;
      if (r.kind === "IDLE") d.idleMs = Number(r.ms);
      else d.activeMs = Number(r.ms);
    }
    const applications: ActivityAppTotal[] = perApp!.rows.map((r) => ({
      applicationIdentifier: str(r.application_identifier),
      applicationName: String(r.application_name),
      activeMs: Number(r.ms),
    }));
    const dayApps = (perDayApp?.rows ?? []).map((r) => ({ date: String(r.d), key: String(r.k), ms: Number(r.ms) }));
    return {
      days,
      dayApps,
      applications,
      activeMs: days.reduce((n, d) => n + d.activeMs, 0),
      idleMs: days.reduce((n, d) => n + d.idleMs, 0),
    };
  }

  /**
   * Stores what the device says it is doing now. The activity state only when it could also be recorded
   * as activity: monitoring on, the current notice acknowledged, and a session open (the UPDATE checks
   * that itself); otherwise it is ignored, not an error. The screenshot capture state is about the device
   * (permission, capture failures), so it is kept whenever reported.
   */
  private async recordCurrent(
    device: DeviceContext,
    current: NonNullable<ActivitySyncRequest["current"]>,
    ctx: { skew: number; receivedAt: number; periods: PolicyPeriod[]; ackAt: Map<string, number> },
  ) {
    const at = iso(ctx.receivedAt);
    const now = ctx.periods.at(-1)!;
    const statements: InStatement[] = [];
    if (current.screenshot) statements.push({ sql: "UPDATE devices SET screenshot_state = ?, screenshot_state_at = ? WHERE id = ?", args: [current.screenshot, at, device.deviceId] });
    if (now.enabled && ctx.ackAt.has(now.noticeVersion)) {
      statements.push({
        sql: `UPDATE devices SET activity_state = ?, activity_state_since = ?, activity_state_at = ?
              WHERE id = ? AND EXISTS (SELECT 1 FROM attendance_sessions WHERE employee_id = ? AND clock_out_at IS NULL)`,
        args: [current.state, iso(Math.min(Date.parse(current.since) + ctx.skew, ctx.receivedAt)), at, device.deviceId, device.employeeId],
      });
    }
    if (statements.length) await this.db.batch(statements, "write");
  }


  /** Validates and trims one interval; returns its INSERT or the rejection. `taken` grows with accepted intervals. */
  private check(
    device: DeviceContext,
    i: ActivitySyncRequest["intervals"][number],
    ctx: {
      skew: number;
      receivedAt: number;
      segments: Segment[];
      periods: PolicyPeriod[];
      ackAt: Map<string, number>;
      taken: { start: number; end: number }[];
      source: string;
    },
  ): { stmt: InStatement } | ActivitySyncResult {
    const reject = (reason: string): ActivitySyncResult => ({ id: i.id, status: "REJECTED", reason });
    let start = Date.parse(i.startedAt) + ctx.skew;
    let end = Math.min(Date.parse(i.endedAt) + ctx.skew, ctx.receivedAt);
    if (end <= start) return reject("Interval is in the future");
    if (ctx.receivedAt - start > this.attendancePolicy.maxOfflineAgeDays * DAY_MS) return reject("Interval is older than the offline limit");

    // Must lie inside clocked-in, non-break time; small edge differences (clock rounding,
    // the moment of a button press) are trimmed rather than rejected.
    const best = ctx.segments
      .map((s) => ({ s, overlap: Math.min(end, s.end) - Math.max(start, s.start) }))
      .sort((a, b) => b.overlap - a.overlap)[0];
    if (!best || best.overlap <= 0 || end - start - best.overlap > EDGE_TOLERANCE_MS) {
      return reject("Recorded outside clocked-in time (before clock-in, during a break or after clock-out)");
    }
    start = Math.max(start, best.s.start);
    end = Math.min(end, best.s.end);

    // Monitoring must have been enabled, and the notice required at that time acknowledged before it.
    for (let k = 0; k < ctx.periods.length; k++) {
      const p = ctx.periods[k]!;
      const until = ctx.periods[k + 1]?.from ?? Infinity;
      if (p.from >= end || until <= start) continue;
      if (!p.enabled) return reject("Monitoring was turned off by the organization at that time");
      const ack = ctx.ackAt.get(p.noticeVersion);
      if (ack === undefined || ack > Math.max(start, p.from) + EDGE_TOLERANCE_MS) {
        return reject(`Recorded before the required monitoring notice (${p.noticeVersion}) was acknowledged`);
      }
    }

    // Never count time twice: trim small overlaps with stored (or earlier accepted) intervals, reject large ones.
    // Short intervals are real (e.g. 0.9 s between resuming work and starting a break); only a sliver
    // left over by overlap trimming is dropped.
    let trimmed = false;
    for (const o of ctx.taken) {
      if (o.start >= end || o.end <= start) continue;
      if (Math.min(end, o.end) - Math.max(start, o.start) > EDGE_TOLERANCE_MS) return reject("Overlaps activity already recorded");
      if (o.start <= start) start = Math.max(start, o.end);
      else end = Math.min(end, o.start);
      trimmed = true;
    }
    if (end <= start || (trimmed && end - start < 1000)) return reject("Overlaps activity already recorded");
    ctx.taken.push({ start, end });

    const seconds = Math.round((end - start) / 1000);
    return {
      stmt: {
        sql: `INSERT INTO activity_intervals
                (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name,
                 started_at, ended_at, active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          randomUUID(), device.employeeId, device.deviceId, best.s.sessionId, i.kind,
          i.kind === "ACTIVE" ? (i.applicationIdentifier ?? null) : null, i.kind === "ACTIVE" ? i.applicationName! : null,
          iso(start), iso(end), i.kind === "ACTIVE" ? seconds : 0, i.kind === "IDLE" ? seconds : 0,
          ctx.source, iso(Date.parse(i.startedAt)), iso(ctx.receivedAt), i.id,
        ],
      },
    };
  }

  /**
   * One write transaction for the batch. If it fails (e.g. another API instance stored an
   * overlapping interval meanwhile), retry row by row so only the conflicting ones are rejected.
   */
  private async insert(inserts: { result: ActivitySyncResult; stmt: InStatement }[]) {
    if (!inserts.length) return;
    try {
      await this.db.batch(inserts.map((x) => x.stmt), "write");
      return;
    } catch (err) {
      if (!isUniqueViolation(err) && !guardViolation(err)) throw err;
    }
    for (const { result, stmt } of inserts) {
      try {
        await this.db.execute(stmt);
      } catch (err) {
        if (isUniqueViolation(err, "activity_intervals.idempotency_key")) Object.assign(result, { status: "DUPLICATE" });
        else if (guardViolation(err)) Object.assign(result, { status: "REJECTED", reason: "Overlaps activity already recorded" });
        else throw err;
      }
    }
  }
}

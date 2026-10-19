import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import { guardViolation, isUniqueViolation, type DatabaseClient, type InStatement } from "@workfolio/database";
import {
  addDays,
  todayIn,
  weekStart,
  zonedToUtc,
  type ActivityAppTotal,
  type ActivityKind,
  type ActivityPeriodTotals,
  type ActivityReportDay,
  type ActivityReportWeek,
  type ActivityStatusResponse,
  type ActivitySummaryResponse,
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
import { clockedInSegments, iso, str, type Segment } from "../attendance/sessions.js";
import { EmployeeLocks } from "../common/employee-locks.js";
import { POLICY } from "../common/policy.js";
import { DATABASE } from "../database/database.module.js";
import type { DeviceContext } from "../devices/devices.service.js";
import { MonitoringSettingsService, type PolicyPeriod } from "../settings/monitoring-settings.service.js";

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
  ) {}

  async status(employee: EmployeeRef): Promise<ActivityStatusResponse> {
    const settings = await this.settings.current();
    const today = todayIn(employee.timezone);
    const [notice, [consent, session, last], totals] = await Promise.all([
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
        ],
        "read",
      ),
      this.aggregate(employee, today, today),
    ]);
    const s = session!.rows[0];
    return {
      policy: { enabled: settings.enabled, sampleSeconds: settings.sampleSeconds, idleThresholdSeconds: settings.idleThresholdSeconds },
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
    if (!acks.length) throw new ForbiddenException("The monitoring notice has not been acknowledged");
    const ackAt = new Map(acks.map((r) => [String(r.notice_version), Date.parse(String(r.acknowledged_at))]));

    const receivedAt = Date.now();
    const skew = receivedAt - Date.parse(req.sentAt); // same correction as attendance sync
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

  async summary(employee: EmployeeRef, from: string, to: string): Promise<ActivitySummaryResponse> {
    const now = Date.now();
    const [start, end] = this.bounds(employee, from, to).map(Date.parse) as [number, number];
    const [agg, segments, settings, [last, device]] = await Promise.all([
      this.aggregate(employee, from, to),
      clockedInSegments(this.db, employee.id, start, Math.min(end, now), now),
      this.settings.current(),
      this.db.batch(
        [
          { sql: "SELECT max(received_at) AS at FROM activity_intervals WHERE employee_id = ?", args: [employee.id] },
          { sql: "SELECT platform, last_seen_at FROM devices WHERE employee_id = ? AND revoked_at IS NULL ORDER BY registered_at DESC LIMIT 1", args: [employee.id] },
        ],
        "read",
      ),
    ]);
    const consent = await this.db.execute({
      sql: "SELECT acknowledged_at FROM monitoring_consents WHERE employee_id = ? AND notice_version = ?",
      args: [employee.id, settings.noticeVersion],
    });

    const days: ActivityReportDay[] = agg.days.map((d) => {
      const clockedInMs = segments.reduce((n, s) => n + Math.max(0, Math.min(s.end, d.end) - Math.max(s.start, d.start)), 0);
      return { date: d.date, activeMs: d.activeMs, idleMs: d.idleMs, clockedInMs, unobservedMs: Math.max(0, clockedInMs - d.activeMs - d.idleMs) };
    });
    const sum = (list: ActivityPeriodTotals[]): ActivityPeriodTotals => ({
      activeMs: list.reduce((n, d) => n + d.activeMs, 0),
      idleMs: list.reduce((n, d) => n + d.idleMs, 0),
      clockedInMs: list.reduce((n, d) => n + d.clockedInMs, 0),
      unobservedMs: list.reduce((n, d) => n + d.unobservedMs, 0),
    });
    const byWeek = new Map<string, ActivityReportDay[]>();
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
    else if (dev.platform === "windows") warnings.push({ code: "UNSUPPORTED_PLATFORM", message: "The employee's device runs Windows, where activity collection is not available yet. Only attendance is recorded." });
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

    return {
      employee, from, to,
      ...sum(days),
      applications: agg.applications,
      days,
      weeks,
      lastReceivedAt,
      deviceLastSeenAt: str(dev?.last_seen_at),
      freshness: stale ? "STALE" : !lastReceivedAt && !segments.length ? "NO_DATA" : "CURRENT",
      consent: { noticeVersion: settings.noticeVersion, acknowledgedAt },
      warnings,
    };
  }

  async timeline(employee: EmployeeRef, q: { from: string; to: string; page: number; pageSize: number }): Promise<Paginated<ActivityTimelineItem>> {
    const [start, end] = this.bounds(employee, q.from, q.to);
    const where = "employee_id = ? AND started_at < ? AND ended_at > ?";
    const [rows, count] = await this.db.batch(
      [
        {
          sql: `SELECT ${TIMELINE_COLUMNS} FROM activity_intervals WHERE ${where} ORDER BY started_at, id LIMIT ? OFFSET ?`,
          args: [employee.id, end, start, q.pageSize, (q.page - 1) * q.pageSize],
        },
        { sql: `SELECT count(*) AS n FROM activity_intervals WHERE ${where}`, args: [employee.id, end, start] },
      ],
      "read",
    );
    return { items: rows!.rows.map(toItem), total: Number(count!.rows[0]!.n), page: q.page, pageSize: q.pageSize };
  }

  // ---- internals ------------------------------------------------------------------

  private bounds(employee: EmployeeRef, from: string, to: string): [string, string] {
    return [zonedToUtc(`${from}T00:00`, employee.timezone), zonedToUtc(`${addDays(to, 1)}T00:00`, employee.timezone)];
  }

  /** Per-day and per-application totals computed by the database (no interval rows transferred). */
  private async aggregate(employee: EmployeeRef, from: string, to: string) {
    const days: { date: string; start: number; end: number; activeMs: number; idleMs: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const [s, e] = this.bounds(employee, d, d);
      days.push({ date: d, start: Date.parse(s), end: Date.parse(e), activeMs: 0, idleMs: 0 });
    }
    const [start, end] = this.bounds(employee, from, to);
    const [perDay, perApp] = await this.db.batch(
      [
        {
          sql: `WITH b(d, s, e) AS (VALUES ${days.map(() => "(?, ?, ?)").join(", ")})
                SELECT b.d, a.kind, sum(round((julianday(min(a.ended_at, b.e)) - julianday(max(a.started_at, b.s))) * 86400000)) AS ms
                FROM b JOIN activity_intervals a ON a.employee_id = ? AND a.started_at < b.e AND a.ended_at > b.s
                GROUP BY b.d, a.kind`,
          args: [...days.flatMap((d) => [d.date, iso(d.start), iso(d.end)]), employee.id],
        },
        {
          // The bare application_name comes from the latest interval (max), so a renamed app shows its current name.
          sql: `SELECT application_identifier, application_name, max(started_at) AS latest, sum(${CLIPPED_MS}) AS ms
                FROM activity_intervals WHERE employee_id = ? AND kind = 'ACTIVE' AND started_at < ? AND ended_at > ?
                GROUP BY coalesce(application_identifier, 'name:' || application_name) ORDER BY ms DESC, application_name`,
          args: [end, start, employee.id, end, start],
        },
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
    return {
      days,
      applications,
      activeMs: days.reduce((n, d) => n + d.activeMs, 0),
      idleMs: days.reduce((n, d) => n + d.idleMs, 0),
    };
  }

  /** Clocked-in, non-break time of the employee overlapping [from, to); open sessions/breaks run to `openEnd`. */


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

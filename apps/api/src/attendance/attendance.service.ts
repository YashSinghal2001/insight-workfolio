import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { guardViolation, isUniqueViolation, type DatabaseClient, type InStatement } from "@workfolio/database";
import {
  addDays,
  deriveLiveStatus,
  invalidTransitionMessage,
  missingClockOut,
  screenshotFeatureState,
  todayIn,
  transition,
  uuidSchema,
  zonedToUtc,
  type AttendancePolicy,
  type AttendanceCurrent,
  type AttendanceEventType,
  type AttendanceOverviewRow,
  type AttendanceSession,
  type AttendanceState,
  type AttendanceSummary,
  type AttendanceTimelineItem,
  type AttendanceTimelineQuery,
  type AttendanceTimelineResponse,
  type EmployeeRef,
  type ListEmployeesQuery,
  type Paginated,
  type SyncRequest,
  type SyncResponse,
  type SyncResult,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { EmployeeLocks } from "../common/employee-locks.js";
import { POLICY } from "../common/policy.js";
import { scopeSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import type { DeviceContext } from "../devices/devices.service.js";
import { EmployeesService } from "../employees/employees.service.js";
import { employeeReadAudit } from "../audit/account-audit.js";
import { ScreenshotSettingsService } from "../screenshots/screenshot-settings.service.js";
import { ScreenshotsService } from "../screenshots/screenshots.service.js";
import { MonitoringSettingsService } from "../settings/monitoring-settings.service.js";
import { ACTIVE_EMPLOYEE, activityReport, DEVICE_LIVE_COLUMNS, iso, screenshotReport, SESSION_COLUMNS, stateOf, str, withBreaks } from "./sessions.js";

/** Device timestamps may lead the send time by this much (sub-second clock jitter, rounding). */
const FUTURE_TOLERANCE_MS = 5_000;
/** Events sent within this long of occurring count as online; older ones were queued offline. */
const ONLINE_WINDOW_MS = 60_000;

interface Incoming {
  key: string;
  type: AttendanceEventType;
  /** Effective UTC time (ISO). */
  occurredAt: string;
  deviceTime: string | null;
  source: "ONLINE" | "OFFLINE_SYNC";
  /** Pre-validation failure; recorded as a rejected event. */
  invalid?: string;
}

interface Snapshot {
  state: AttendanceState;
  session: AttendanceSession | null;
  /** Latest recorded boundary (clock-in/out, break start/end). New events may not precede it. */
  lastChange: string | null;
}

/**
 * Server-side attendance state machine. Every action becomes an append-only event (accepted or
 * rejected) keyed by the client's idempotency key, so retries and replays never double-apply.
 */
@Injectable()
export class AttendanceService {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly policy: AttendancePolicy,
    private readonly employees: EmployeesService,
    private readonly locks: EmployeeLocks,
    private readonly screenshotSettings: ScreenshotSettingsService,
    private readonly monitoring: MonitoringSettingsService,
    private readonly screenshots: ScreenshotsService,
  ) {}

  /** Online action from a direct endpoint: server time is authoritative. */
  async act(device: DeviceContext, type: AttendanceEventType, key: string | undefined): Promise<AttendanceCurrent> {
    if (!uuidSchema.safeParse(key).success) throw new BadRequestException("Idempotency-Key header must be a UUID");
    const result = await this.locks.run(device.employeeId, async () => {
      const r = await this.apply(device, { key: key!, type, occurredAt: iso(Date.now()), deviceTime: null, source: "ONLINE" });
      await this.endWorkTime(device.employeeId, [[type, r]]);
      return r;
    });
    if (result.status === "REJECTED") throw new ConflictException(result.reason);
    return this.current(device.employeeId);
  }

  /**
   * Offline queue upload, applied in the order given. Device clock skew is estimated as
   * (server receive time - device send time) and added to each device timestamp.
   */
  async sync(device: DeviceContext, req: SyncRequest): Promise<SyncResponse> {
    const receivedAt = Date.now();
    const sentAt = Date.parse(req.sentAt);
    const skew = receivedAt - sentAt;
    const results = await this.locks.run(device.employeeId, async () => {
      const out: SyncResult[] = [];
      for (const ev of req.events) {
        const deviceMs = Date.parse(ev.occurredAt);
        const effective = Math.min(deviceMs + skew, receivedAt);
        const invalid =
          deviceMs > sentAt + FUTURE_TOLERANCE_MS
            ? "Event time is later than the time it was sent"
            : receivedAt - effective > this.policy.maxOfflineAgeDays * 86_400_000
              ? `Event is older than ${this.policy.maxOfflineAgeDays} days; request a correction instead`
              : undefined;
        out.push(
          await this.apply(device, {
            key: ev.id,
            type: ev.type,
            occurredAt: iso(effective),
            deviceTime: iso(deviceMs),
            source: sentAt - deviceMs > ONLINE_WINDOW_MS ? "OFFLINE_SYNC" : "ONLINE",
            invalid,
          }),
        );
      }
      await this.endWorkTime(device.employeeId, req.events.map((ev, i) => [ev.type, out[i]!]));
      return out;
    });
    return { results, current: await this.current(device.employeeId) };
  }

  async current(employeeId: string): Promise<AttendanceCurrent> {
    const [{ state, session }, { rows }] = await Promise.all([
      this.snapshot(employeeId),
      this.db.execute({ sql: "SELECT timezone FROM employee_profiles WHERE id = ?", args: [employeeId] }),
    ]);
    const now = Date.now();
    return { state, session, serverTime: iso(now), missingClockOut: missingClockOut(session, String(rows[0]?.timezone ?? "UTC"), now) };
  }

  /**
   * One local day of an employee as stored: clock-in/out, breaks and activity intervals, oldest first.
   * Real rows only (no computed gaps). Periods that began before the day but reach into it are included.
   * Reading someone else's is audited (one row per request).
   */
  async timeline(caller: AuthContext, employee: EmployeeRef & { userId: string }, q: AttendanceTimelineQuery): Promise<AttendanceTimelineResponse> {
    const date = q.date ?? todayIn(employee.timezone);
    const start = zonedToUtc(`${date}T00:00`, employee.timezone);
    const end = zonedToUtc(`${addDays(date, 1)}T00:00`, employee.timezone);
    // ?1 employee, ?2 day start, ?3 day end. `rank` orders records sharing an instant: what ends (clock-out) before
    // what starts (the next clock-in, then the periods beginning with it).
    const union = `
      SELECT 'CLOCK_IN:' || id AS id, 'CLOCK_IN' AS type, clock_in_at AS at, NULL AS end_at, NULL AS app, 1 AS rank
        FROM attendance_sessions WHERE employee_id = ?1 AND clock_in_at >= ?2 AND clock_in_at < ?3
      UNION ALL
      SELECT 'CLOCK_OUT:' || id, 'CLOCK_OUT', clock_out_at, NULL, NULL, 0
        FROM attendance_sessions WHERE employee_id = ?1 AND clock_out_at >= ?2 AND clock_out_at < ?3
      UNION ALL
      SELECT 'BREAK:' || b.id, 'BREAK', b.started_at, b.ended_at, NULL, 2
        FROM break_sessions b JOIN attendance_sessions s ON s.id = b.attendance_session_id
        WHERE s.employee_id = ?1 AND b.started_at < ?3 AND coalesce(b.ended_at, '9999') > ?2
      UNION ALL
      SELECT kind || ':' || id, kind, started_at, ended_at, application_name, 2
        FROM activity_intervals WHERE employee_id = ?1 AND started_at < ?3 AND ended_at > ?2`;
    const args = [employee.id, start, end];
    const audit = employeeReadAudit(caller, employee, "EMPLOYEE_ATTENDANCE_TIMELINE_VIEWED", { date });
    const [rows, count] = await this.db.batch(
      [
        { sql: `SELECT * FROM (${union}) ORDER BY at, rank, id LIMIT ?4 OFFSET ?5`, args: [...args, q.pageSize, (q.page - 1) * q.pageSize] },
        { sql: `SELECT count(*) AS n FROM (${union})`, args },
        ...(audit ? [audit] : []),
      ],
      audit ? "write" : "read",
    );
    return {
      employee: { id: employee.id, fullName: employee.fullName, employeeCode: employee.employeeCode },
      date,
      timezone: employee.timezone,
      items: rows!.rows.map((r): AttendanceTimelineItem => ({ id: String(r.id), type: r.type as AttendanceTimelineItem["type"], at: String(r.at), endAt: str(r.end_at), applicationName: str(r.app) })),
      total: Number(count!.rows[0]!.n),
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** Sessions newest first, optionally limited to clock-in local dates [from, to] in `timeZone`. */
  async history(
    employee: { id: string; timezone: string },
    q: { page: number; pageSize: number; from?: string; to?: string },
  ): Promise<Paginated<AttendanceSession>> {
    const start = q.from ? zonedToUtc(`${q.from}T00:00`, employee.timezone) : null;
    const end = q.to ? zonedToUtc(`${addDays(q.to, 1)}T00:00`, employee.timezone) : null;
    const where = "s.employee_id = ?1 AND (?2 IS NULL OR s.clock_in_at >= ?2) AND (?3 IS NULL OR s.clock_in_at < ?3)";
    const [rows, count] = await this.db.batch(
      [
        {
          sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE ${where} ORDER BY s.clock_in_at DESC LIMIT ?4 OFFSET ?5`,
          args: [employee.id, start, end, q.pageSize, (q.page - 1) * q.pageSize],
        },
        { sql: `SELECT count(*) AS n FROM attendance_sessions s WHERE ${where}`, args: [employee.id, start, end] },
      ],
      "read",
    );
    return { items: await withBreaks(this.db, rows!.rows), total: Number(count!.rows[0]!.n), page: q.page, pageSize: q.pageSize };
  }

  /** Admin view: one row per employee with their latest session and last sync. Read-only. Team heads: their teams. */
  async overview(query: ListEmployeesQuery, caller: AuthContext): Promise<Paginated<AttendanceOverviewRow>> {
    const page = await this.employees.list(query, caller, "attendance:read-all");
    const ids = page.items.map((e) => e.id);
    if (!ids.length) return { ...page, items: [] };
    const marks = ids.map(() => "?").join(", ");
    const [shots, mon] = await Promise.all([this.screenshotSettings.current(), this.monitoring.current()]);
    const [sessions, events, devices, shotConsents] = await this.db.batch(
      [
        {
          sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s
                WHERE s.employee_id IN (${marks})
                  AND s.clock_in_at = (SELECT max(clock_in_at) FROM attendance_sessions WHERE employee_id = s.employee_id)`,
          args: ids,
        },
        {
          sql: `SELECT employee_id, event_type, received_at, source, outcome FROM attendance_events
                WHERE rowid IN (SELECT max(rowid) FROM attendance_events WHERE employee_id IN (${marks}) GROUP BY employee_id)`,
          args: ids,
        },
        {
          sql: `SELECT ${DEVICE_LIVE_COLUMNS} FROM devices WHERE revoked_at IS NULL AND employee_id IN (${marks})`,
          args: ids,
        },
        {
          sql: `SELECT employee_id, notice_version FROM monitoring_consents WHERE notice_version IN (?, ?) AND employee_id IN (${marks})`,
          args: [shots.noticeVersion, mon.noticeVersion, ...ids],
        },
      ],
      "read",
    );
    const sessionBy = new Map(
      (await withBreaks(this.db, sessions!.rows)).map((s, i) => [String(sessions!.rows[i]!.employee_id), s]),
    );
    const eventBy = new Map(events!.rows.map((r) => [String(r.employee_id), r]));
    const deviceBy = new Map(devices!.rows.map((r) => [String(r.employee_id), r]));
    const acked = (version: string) => new Set(shotConsents!.rows.filter((r) => r.notice_version === version).map((r) => String(r.employee_id)));
    const consented = acked(shots.noticeVersion);
    // ACTIVE/IDLE is activity monitoring: shown only while it is on and this employee acknowledged the notice in force.
    const monitored = mon.enabled ? acked(mon.noticeVersion) : new Set<string>();
    const now = Date.now();
    return {
      ...page,
      items: page.items.map((e) => {
        const session = sessionBy.get(e.id) ?? null;
        const ev = eventBy.get(e.id);
        return {
          employeeId: e.id,
          fullName: e.fullName,
          employeeCode: e.employeeCode,
          timezone: e.timezone,
          state: stateOf(session),
          session,
          lastEvent: ev
            ? {
                type: ev.event_type as AttendanceEventType,
                receivedAt: String(ev.received_at),
                source: ev.source as "ONLINE" | "OFFLINE_SYNC",
                outcome: ev.outcome as "ACCEPTED" | "REJECTED",
              }
            : null,
          deviceLastSeenAt: str(deviceBy.get(e.id)?.last_seen_at),
          ...deriveLiveStatus(session, monitored.has(e.id) ? activityReport(deviceBy.get(e.id)) : null, now),
          missingClockOut: missingClockOut(session, e.timezone, now),
          screenshotState: screenshotFeatureState({ enabled: shots.enabled, consented: consented.has(e.id), report: screenshotReport(deviceBy.get(e.id)) }, now),
        };
      }),
    };
  }

  /**
   * Organisation-wide counts for one local date (each employee's own time zone; default: each one's
   * today). Five queries in two round trips, whatever the head count; the day's sessions are clipped in memory.
   * Team heads (W41): people, pending leave/corrections and screenshots of their teams only; project and
   * task counts stay organisation-wide (not per employee).
   */
  async summary(date?: string, now = Date.now(), caller?: AuthContext): Promise<AttendanceSummary> {
    const scope = (column: string) => (caller ? scopeSql(caller, "attendance:read-all", column) : { sql: "", args: [] });
    const [emps, zones, counts] = await this.db.batch(
      [
        { sql: `SELECT p.id, p.timezone FROM employee_profiles p JOIN users u ON u.id = p.user_id WHERE ${ACTIVE_EMPLOYEE}${scope("p.id").sql}`, args: scope("p.id").args },
        "SELECT DISTINCT timezone FROM employee_profiles",
        {
          sql: `SELECT (SELECT count(*) FROM leave_requests WHERE status = 'PENDING'${scope("employee_id").sql}) AS leave,
                (SELECT count(*) FROM correction_requests WHERE status = 'PENDING'${scope("employee_id").sql}) AS corrections,
                (SELECT count(*) FROM projects WHERE status = 'ACTIVE') AS projects,
                (SELECT count(*) FROM project_tasks t JOIN projects pr ON pr.id = t.project_id WHERE t.status = 'OPEN' AND pr.status = 'ACTIVE') AS tasks`,
          args: [...scope("employee_id").args, ...scope("employee_id").args],
        },
      ],
      "read",
    );
    // The local day [start, end) as UTC instants, per time zone.
    const day = new Map<string, [number, number]>();
    for (const r of zones!.rows) {
      const tz = String(r.timezone);
      const d = date ?? todayIn(tz, now);
      day.set(tz, [Date.parse(zonedToUtc(`${d}T00:00`, tz)), Date.parse(zonedToUtc(`${addDays(d, 1)}T00:00`, tz))]);
    }
    const windows = [...day.entries()];
    const minStart = iso(Math.min(...windows.map(([, w]) => w[0]), now));
    const maxEnd = iso(Math.max(...windows.map(([, w]) => w[1]), now));
    const shotWhere = windows.map(() => "(p.timezone = ? AND s.captured_at >= ? AND s.captured_at < ?)").join(" OR ") || "0";
    const [sessions, shots] = await this.db.batch(
      [
        {
          // Every session overlapping the widest day window (which reaches now, so open sessions are all included), with breaks.
          // ponytail: scans attendance_sessions (no index on clock_out_at); add one if the table gets large.
          sql: `SELECT s.id, s.employee_id, s.clock_in_at, s.clock_out_at, b.started_at AS b_start, b.ended_at AS b_end
                FROM attendance_sessions s LEFT JOIN break_sessions b ON b.attendance_session_id = s.id
                WHERE s.clock_in_at < ? AND coalesce(s.clock_out_at, '9999') > ?`,
          args: [maxEnd, minStart],
        },
        {
          sql: `SELECT count(*) AS n FROM screenshots s JOIN employee_profiles p ON p.id = s.employee_id
                WHERE s.upload_status = 'STORED' AND (${shotWhere})${scope("s.employee_id").sql}`,
          args: [...windows.flatMap(([tz, [a, b]]) => [tz, iso(a), iso(b)]), ...scope("s.employee_id").args],
        },
      ],
      "read",
    );
    const bySession = new Map<string, { employeeId: string; start: number; end: number | null; breaks: [number, number | null][] }>();
    for (const r of sessions!.rows) {
      const id = String(r.id);
      if (!bySession.has(id)) bySession.set(id, { employeeId: String(r.employee_id), start: Date.parse(String(r.clock_in_at)), end: r.clock_out_at ? Date.parse(String(r.clock_out_at)) : null, breaks: [] });
      if (r.b_start) bySession.get(id)!.breaks.push([Date.parse(String(r.b_start)), r.b_end ? Date.parse(String(r.b_end)) : null]);
    }
    const tzOf = new Map(emps!.rows.map((r) => [String(r.id), String(r.timezone)]));
    const per = new Map<string, { open: "WORKING" | "BREAK" | null; overlapped: boolean; clockedIn: boolean }>();
    let netWorkMsToday = 0;
    let breakMsToday = 0;
    for (const s of bySession.values()) {
      const tz = tzOf.get(s.employeeId);
      if (!tz) continue; // not an active employee
      const [ws, we] = day.get(tz)!;
      const e = per.get(s.employeeId) ?? { open: null, overlapped: false, clockedIn: false };
      per.set(s.employeeId, e);
      if (s.end === null) e.open = s.breaks.some(([, be]) => be === null) ? "BREAK" : "WORKING";
      if (s.start >= ws && s.start < we) e.clockedIn = true;
      const clip = (a: number, b: number) => Math.max(0, Math.min(b, we) - Math.max(a, ws));
      const sessionEnd = s.end ?? now;
      if (s.start < we && sessionEnd > ws) e.overlapped = true;
      const sessionMs = clip(s.start, sessionEnd);
      const breakMs = Math.min(sessionMs, s.breaks.reduce((n, [bs, be]) => n + clip(Math.max(bs, s.start), Math.min(be ?? now, sessionEnd)), 0));
      netWorkMsToday += sessionMs - breakMs;
      breakMsToday += breakMs;
    }
    const states = [...per.values()];
    const c = counts!.rows[0]!;
    return {
      date: date ?? null,
      totalActiveEmployees: emps!.rows.length,
      currentlyWorking: states.filter((e) => e.open === "WORKING").length,
      onBreak: states.filter((e) => e.open === "BREAK").length,
      clockedOutToday: states.filter((e) => e.overlapped && !e.open).length,
      notClockedInToday: emps!.rows.length - states.filter((e) => e.clockedIn).length,
      netWorkMsToday,
      breakMsToday,
      pendingLeaveCount: Number(c.leave),
      pendingCorrectionCount: Number(c.corrections),
      activeProjectCount: Number(c.projects),
      openTaskCount: Number(c.tasks),
      screenshotsStoredToday: Number(shots!.rows[0]!.n),
      generatedAt: iso(now),
    };
  }

  // ---- internals --------------------------------------------------------------

  /**
   * After a break start or clock-out was accepted (caller holds the employee lock): screenshots received
   * earlier but captured after that moment are not work time and are discarded. Breaks win over screenshots
   * in either order: a break persisted first makes register/upload reject them; one persisted after them removes them.
   */
  private async endWorkTime(employeeId: string, applied: [AttendanceEventType, SyncResult][]): Promise<void> {
    const ends = applied.flatMap(([type, r]) => (r.status === "ACCEPTED" && r.occurredAt && (type === "BREAK_START" || type === "CLOCK_OUT") ? [Date.parse(r.occurredAt)] : []));
    if (ends.length) await this.screenshots.discardOutsideWork(employeeId, Math.min(...ends));
  }

  private async apply(device: DeviceContext, ev: Incoming, retried = false): Promise<SyncResult> {
    const prior = (
      await this.db.execute({
        sql: "SELECT event_type, occurred_at, outcome, reject_reason FROM attendance_events WHERE employee_id = ? AND idempotency_key = ?",
        args: [device.employeeId, ev.key],
      })
    ).rows[0];
    if (prior) {
      // Replays get the original outcome; nothing is applied twice.
      if (prior.event_type !== ev.type) {
        return { id: ev.key, status: "REJECTED", reason: "Idempotency key was already used for a different action" };
      }
      return prior.outcome === "ACCEPTED"
        ? { id: ev.key, status: "DUPLICATE", occurredAt: String(prior.occurred_at) }
        : { id: ev.key, status: "REJECTED", reason: String(prior.reject_reason) };
    }

    const snap = await this.snapshot(device.employeeId);
    let reason = ev.invalid;
    if (!reason && !transition(snap.state, ev.type)) reason = invalidTransitionMessage(snap.state, ev.type);
    if (!reason && snap.lastChange && ev.occurredAt < snap.lastChange) {
      reason = "Event time is earlier than the last recorded attendance change";
    }

    const statements: InStatement[] = reason ? [] : this.changes(device, ev, snap);
    statements.push({
      sql: `INSERT INTO attendance_events
              (id, employee_id, device_id, event_type, occurred_at, device_time, received_at, idempotency_key, source, outcome, reject_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(), device.employeeId, device.deviceId, ev.type, ev.occurredAt, ev.deviceTime, iso(Date.now()),
        ev.key, ev.source, reason ? "REJECTED" : "ACCEPTED", reason ?? null,
      ],
    });
    try {
      await this.db.batch(statements, "write");
    } catch (err) {
      // Same key raced in from another request: report the stored outcome.
      if (!retried && isUniqueViolation(err, "attendance_events.idempotency_key")) return this.apply(device, ev, true);
      if (guardViolation(err) || isUniqueViolation(err)) {
        throw new ConflictException("Attendance was changed by another request; retry");
      }
      throw err;
    }
    return reason
      ? { id: ev.key, status: "REJECTED", reason }
      : { id: ev.key, status: "ACCEPTED", occurredAt: ev.occurredAt };
  }

  /** The state change for an already-validated transition. */
  private changes(device: DeviceContext, ev: Incoming, snap: Snapshot): InStatement[] {
    const at = ev.occurredAt;
    const session = snap.session!;
    switch (ev.type) {
      case "CLOCK_IN":
        return [{
          sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')",
          args: [randomUUID(), device.employeeId, device.deviceId, at],
        }];
      case "BREAK_START":
        return [{
          sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, status) VALUES (?, ?, ?, 'OPEN')",
          args: [randomUUID(), session.id, at],
        }];
      case "BREAK_END":
        return [{
          sql: "UPDATE break_sessions SET ended_at = ?, status = 'CLOSED', updated_at = ? WHERE id = ?",
          args: [at, iso(Date.now()), session.breaks.find((b) => !b.endedAt)!.id],
        }];
      case "CLOCK_OUT":
        return [
          {
            sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED', updated_at = ? WHERE id = ?",
            args: [at, iso(Date.now()), session.id],
          },
          // The device's "active/idle right now" report ends with the session.
          { sql: "UPDATE devices SET activity_state = NULL, activity_state_since = NULL, activity_state_at = NULL WHERE employee_id = ?", args: [device.employeeId] },
        ];
    }
  }

  private async snapshot(employeeId: string): Promise<Snapshot> {
    const { rows } = await this.db.execute({
      sql: `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE s.employee_id = ? ORDER BY s.clock_in_at DESC LIMIT 1`,
      args: [employeeId],
    });
    const [session = null] = await withBreaks(this.db, rows);
    const times = session
      ? [session.clockInAt, session.clockOutAt, ...session.breaks.flatMap((b) => [b.startedAt, b.endedAt])]
      : [];
    const lastChange = times.filter((t): t is string => !!t).sort().at(-1) ?? null;
    return { state: stateOf(session), session, lastChange };
  }
}

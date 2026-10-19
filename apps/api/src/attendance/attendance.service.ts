import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { guardViolation, isUniqueViolation, type DatabaseClient, type InStatement } from "@workfolio/database";
import {
  addDays,
  invalidTransitionMessage,
  transition,
  uuidSchema,
  zonedToUtc,
  type AttendancePolicy,
  type AttendanceCurrent,
  type AttendanceEventType,
  type AttendanceOverviewRow,
  type AttendanceSession,
  type AttendanceState,
  type ListEmployeesQuery,
  type Paginated,
  type SyncRequest,
  type SyncResponse,
  type SyncResult,
} from "@workfolio/shared";
import { EmployeeLocks } from "../common/employee-locks.js";
import { POLICY } from "../common/policy.js";
import { DATABASE } from "../database/database.module.js";
import type { DeviceContext } from "../devices/devices.service.js";
import { EmployeesService } from "../employees/employees.service.js";
import { iso, SESSION_COLUMNS, stateOf, str, withBreaks } from "./sessions.js";

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
  ) {}

  /** Online action from a direct endpoint: server time is authoritative. */
  async act(device: DeviceContext, type: AttendanceEventType, key: string | undefined): Promise<AttendanceCurrent> {
    if (!uuidSchema.safeParse(key).success) throw new BadRequestException("Idempotency-Key header must be a UUID");
    const result = await this.locks.run(device.employeeId, () =>
      this.apply(device, { key: key!, type, occurredAt: iso(Date.now()), deviceTime: null, source: "ONLINE" }),
    );
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
      return out;
    });
    return { results, current: await this.current(device.employeeId) };
  }

  async current(employeeId: string): Promise<AttendanceCurrent> {
    const { state, session } = await this.snapshot(employeeId);
    return { state, session, serverTime: iso(Date.now()) };
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

  /** Admin view: one row per employee with their latest session and last sync. Read-only. */
  async overview(query: ListEmployeesQuery): Promise<Paginated<AttendanceOverviewRow>> {
    const page = await this.employees.list(query);
    const ids = page.items.map((e) => e.id);
    if (!ids.length) return { ...page, items: [] };
    const marks = ids.map(() => "?").join(", ");
    const [sessions, events, devices] = await this.db.batch(
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
          sql: `SELECT employee_id, last_seen_at FROM devices WHERE revoked_at IS NULL AND employee_id IN (${marks})`,
          args: ids,
        },
      ],
      "read",
    );
    const sessionBy = new Map(
      (await withBreaks(this.db, sessions!.rows)).map((s, i) => [String(sessions!.rows[i]!.employee_id), s]),
    );
    const eventBy = new Map(events!.rows.map((r) => [String(r.employee_id), r]));
    const seenBy = new Map(devices!.rows.map((r) => [String(r.employee_id), str(r.last_seen_at)]));
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
          deviceLastSeenAt: seenBy.get(e.id) ?? null,
        };
      }),
    };
  }

  // ---- internals --------------------------------------------------------------

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
        return [{
          sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED', updated_at = ? WHERE id = ?",
          args: [at, iso(Date.now()), session.id],
        }];
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

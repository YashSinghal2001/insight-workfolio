// Employee shifts + automatic clock-out (docs/EMPLOYEE-SHIFT-MANAGEMENT.md).
// In-process API, in-memory database. Clock-ins are backdated through the offline sync path; the worker is
// driven by calling AutoClockOutService.sweep() (the timer is off under NODE_ENV=test).
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { AutoClockOutService } = await import("../dist/shifts/auto-clock-out.service.js");

const ORIGIN = "http://localhost:3000";
const ADMIN = { email: "shift-admin@example.com", password: "admin password 123" };
const PASSWORD = "employee password 1";
const H = 3_600_000;
const M = 60_000;

type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let app: INestApplication;
let base: string;
let db: Db;
let worker: { sweep: (now?: number) => Promise<number>; processDue: (id: string, at?: number) => Promise<boolean> };
let adminCookie: string;
let passwordHash: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string; key?: string };
async function api(path: string, { method = "GET", body, cookie, bearer, device, key }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  if (key) headers["idempotency-key"] = key;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, cookies: res.headers.getSetCookie() };
}
const cookieOf = (cookies: string[]) => cookies.map((c) => c.split(";")[0]).join("; ");

let seq = 0;
/** A fresh employee signed in on the desktop (registered device) and, with `web`, also on the dashboard. */
async function employee(opts: { shift?: object; timezone?: string; web?: boolean } = {}) {
  const n = ++seq;
  const email = `shift${n}@example.com`;
  const r = await api("/employees", {
    method: "POST",
    cookie: adminCookie,
    body: { email, employeeCode: `SH-${n}`, fullName: `Shift ${n}`, timezone: opts.timezone ?? "UTC", ...(opts.shift ? { shift: opts.shift } : {}) },
  });
  assert.equal(r.status, 201, r.text);
  // Direct, as other suites do: the setup-link route is rate limited per IP (20 / 15 min).
  await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE email = ?", args: [passwordHash, email] });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  assert.equal(login.status, 200, login.text);
  const e = { id: r.body.employee.id as string, userId: r.body.employee.userId as string, email, bearer: login.body.accessToken as string, refresh: login.body.refreshToken as string, device: randomUUID(), webCookie: "" };
  const reg = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Work Mac", platform: "macos" } });
  assert.equal(reg.status, 201, reg.text);
  if (opts.web) e.webCookie = cookieOf((await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } })).cookies);
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

const iso = (ms: number) => new Date(ms).toISOString();
const hm = (ms: number) => iso(ms).slice(11, 16);
const floorMin = (ms: number) => Math.floor(ms / M) * M;
const act = (e: Emp, action: string) => api(`/attendance/${action}`, { method: "POST", bearer: e.bearer, device: e.device, key: randomUUID() });
const sync = (e: Emp, events: { type: string; occurredAt: string }[]) =>
  api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: events.map((ev) => ({ id: randomUUID(), ...ev })) } });
const clockInAt = async (e: Emp, ms: number) => assert.equal((await sync(e, [{ type: "CLOCK_IN", occurredAt: iso(ms) }])).body.results[0].status, "ACCEPTED");

/** A UTC shift that ended `endAgo` ago (minute precision), 8 h long unless given; every day a working day. */
function shiftEndedAgo(endAgo: number, extra: Record<string, unknown> = {}, length = 8 * H) {
  const end = floorMin(Date.now() - endAgo);
  return { body: { startTime: hm(end - length), endTime: hm(end), timezone: "UTC", workdays: "1234567", ...extra }, end };
}
/** PUT the shift; `since` backdates when it was set (a shift assigned before today's deadline). */
async function assign(e: Emp, body: object, since?: number) {
  const r = await api(`/employees/${e.id}/shift`, { method: "PUT", cookie: adminCookie, body });
  assert.equal(r.status, 200, r.text);
  if (since !== undefined) await db.execute({ sql: "UPDATE employee_shifts SET updated_at = ? WHERE employee_id = ?", args: [iso(since), e.id] });
  return r.body;
}
const openSessions = async (e: Emp) => Number((await db.execute({ sql: "SELECT count(*) AS n FROM attendance_sessions WHERE employee_id = ? AND status = 'OPEN'", args: [e.id] })).rows[0]!.n);
const autos = async (e: Emp) => (await db.execute({ sql: "SELECT * FROM auto_clock_outs WHERE employee_id = ?", args: [e.id] })).rows;
const latest = async (e: Emp) => (await api(`/attendance/history?employeeId=${e.id}&pageSize=1`, { cookie: adminCookie })).body.items[0];

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  worker = app.get(AutoClockOutService);
  passwordHash = await hashPassword(PASSWORD);
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, 'ADMIN', 'SUPER_ADMIN', ?)", args: [randomUUID(), ADMIN.email, await hashPassword(ADMIN.password)] });
  adminCookie = cookieOf((await api("/auth/login", { method: "POST", body: ADMIN })).cookies);
});
after(() => app.close());

describe("shift configuration", () => {
  test("add employee with a shift: stored in 24 h form, zone defaults to the employee's, grace 60 and on by default", async () => {
    const e = await employee({ timezone: "Asia/Kolkata", shift: { startTime: "09:00", endTime: "18:00" } });
    const r = await api(`/employees/${e.id}/shift`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.deepEqual(
      { ...r.body.shift, updatedAt: undefined, updatedBy: undefined },
      { employeeId: e.id, startTime: "09:00", endTime: "18:00", timezone: "Asia/Kolkata", graceMinutes: 60, autoClockOut: true, workdays: "12345", overnight: false, updatedAt: undefined, updatedBy: undefined },
    );
    assert.equal(r.body.shift.updatedBy.email, ADMIN.email);
    assert.deepEqual(r.body.history, []);
  });

  test("edit an existing shift; different employees keep different shifts; overnight accepted; remove", async () => {
    const [a, b] = [await employee({ shift: { startTime: "09:00", endTime: "18:00" } }), await employee({ shift: { startTime: "13:00", endTime: "21:30" } })];
    const edited = await assign(a, { startTime: "22:00", endTime: "06:00", timezone: "Europe/London", graceMinutes: 30, autoClockOut: false });
    assert.deepEqual([edited.shift.startTime, edited.shift.endTime, edited.shift.timezone, edited.shift.graceMinutes, edited.shift.autoClockOut, edited.shift.overnight], ["22:00", "06:00", "Europe/London", 30, false, true]);
    assert.equal((await api(`/employees/${b.id}/shift`, { cookie: adminCookie })).body.shift.startTime, "13:00", "the other employee is unchanged");
    const audit = (await db.execute({ sql: "SELECT action, metadata FROM account_audit WHERE target_user_id = ? AND action LIKE 'SHIFT_%' ORDER BY rowid", args: [a.userId] })).rows;
    assert.deepEqual(audit.map((x) => x.action), ["SHIFT_ASSIGNED", "SHIFT_ASSIGNED"]);
    assert.equal(JSON.parse(String(audit[1]!.metadata)).startTime, "22:00");
    const removed = await api(`/employees/${a.id}/shift`, { method: "DELETE", cookie: adminCookie });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.shift, null);
    assert.equal((await api(`/employees/${a.id}/shift`, { method: "DELETE", cookie: adminCookie })).status, 404, "nothing left to remove");
  });

  test("invalid or incomplete shifts are rejected (400) and nothing is created", async () => {
    const e = await employee();
    for (const body of [
      { startTime: "09:00", endTime: "09:00" },
      { startTime: "25:00", endTime: "18:00" },
      { startTime: "9am", endTime: "18:00" },
      { startTime: "09:00" },
      { startTime: "09:00", endTime: "18:00", graceMinutes: 1000 },
      { startTime: "09:00", endTime: "18:00", timezone: "Mars/Olympus" },
      { startTime: "09:00", endTime: "18:00", employeeId: randomUUID() },
      { startTime: "09:00", endTime: "18:00", workdays: "" },
      { startTime: "09:00", endTime: "18:00", workdays: "118" },
    ]) assert.equal((await api(`/employees/${e.id}/shift`, { method: "PUT", cookie: adminCookie, body })).status, 400, JSON.stringify(body));
    const bad = await api("/employees", { method: "POST", cookie: adminCookie, body: { email: "noshift@example.com", employeeCode: "SH-BAD", fullName: "Bad", shift: { startTime: "18:00", endTime: "18:00" } } });
    assert.equal(bad.status, 400);
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM users WHERE email = 'noshift@example.com'", args: [] })).rows[0]!.n, 0, "no half-created account");
    assert.equal((await api(`/employees/${e.id}/shift`, { cookie: adminCookie })).body.shift, null);
  });
});

describe("automatic clock-out", () => {
  test("no shift: existing behaviour, a 20 h open session is never clocked out", async () => {
    const e = await employee();
    await clockInAt(e, Date.now() - 20 * H);
    await worker.sweep();
    assert.equal(await openSessions(e), 1);
    assert.equal((await api("/attendance/current", { bearer: e.bearer })).body.autoClockOutAt, null);
  });

  test("still clocked in after the deadline: clocked out AT the deadline (job ran late), once, with a full record", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(3 * H);
    await clockInAt(e, end - 7 * H);
    await assign(e, body, end - 10 * H);
    assert.equal(await worker.sweep(), 1);
    assert.equal(await worker.sweep(), 0, "second run: nothing to do");
    const [rec, ...more] = await autos(e);
    assert.equal(more.length, 0, "exactly one record");
    const deadline = iso(end + 60 * M);
    assert.deepEqual(
      [rec!.scheduled_shift_end_at, rec!.deadline_at, rec!.clock_out_at, rec!.reason, rec!.grace_minutes, rec!.shift_start_time, rec!.shift_end_time, rec!.shift_timezone],
      [iso(end), deadline, deadline, "AUTOMATIC_SHIFT_END", 60, body.startTime, body.endTime, "UTC"],
    );
    assert.ok(String(rec!.processed_at) > deadline, "processed ~2 h after the deadline; the clock-out keeps the deadline");
    const s = await latest(e);
    assert.deepEqual([s.clockOutAt, s.status, s.clockOutReason], [deadline, "CLOSED", "AUTOMATIC_SHIFT_END"]);
    assert.equal(Number((await db.execute({ sql: "SELECT count(*) AS n FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows[0]!.n), 1, "no extra attendance rows");
    const shift = await api(`/employees/${e.id}/shift`, { cookie: adminCookie });
    assert.equal(shift.body.history[0].clockOutAt, deadline);
  });

  test("an open break is ended at the deadline too", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(2 * H);
    await sync(e, [{ type: "CLOCK_IN", occurredAt: iso(end - 6 * H) }, { type: "BREAK_START", occurredAt: iso(end - 30 * M) }]);
    await assign(e, body, end - 10 * H);
    assert.equal(await worker.sweep(), 1);
    const s = await latest(e);
    assert.deepEqual([s.clockOutAt, s.breaks[0].endedAt], [iso(end + H), iso(end + H)]);
    assert.equal((await autos(e))[0]!.break_ended, 1);
  });

  test("manual clock-out before the deadline: no second clock-out", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(-30 * M); // ends in 30 min
    await assign(e, body);
    await clockInAt(e, end - 7 * H);
    assert.equal((await act(e, "clock-out")).status, 200);
    await worker.sweep(end + 2 * H);
    assert.equal((await autos(e)).length, 0);
    assert.equal((await latest(e)).clockOutReason, "MANUAL");
  });

  test("within shift or grace: nothing happens yet; the employee sees when it will", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(20 * M); // ended 20 min ago: in the 60 min grace
    await clockInAt(e, end - 7 * H);
    await assign(e, body, end - 10 * H);
    assert.equal(await worker.sweep(), 0, "not at 18:00 + 20 min");
    assert.equal(await openSessions(e), 1);
    const cur = (await api("/attendance/current", { bearer: e.bearer })).body;
    assert.deepEqual([cur.shiftEndAt, cur.autoClockOutAt], [iso(end), iso(end + H)], "the employee sees shift end and the clock-out time");
  });

  test("clocking in after the shift ended belongs to the next shift: no immediate clock-out", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(2 * H);
    await assign(e, body, end - 10 * H);
    await clockInAt(e, end + 30 * M); // in the grace period, after the end
    await worker.sweep();
    assert.equal(await openSessions(e), 1);
    assert.equal((await api("/attendance/current", { bearer: e.bearer })).body.autoClockOutAt, iso(end + 24 * H + H), "tomorrow's deadline");
  });

  test("disabled automatic clock-out: stays open; re-enabling later clocks out at that moment, never in the past", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(3 * H, { autoClockOut: false });
    await clockInAt(e, end - 7 * H);
    await assign(e, body, end - 10 * H);
    await worker.sweep();
    assert.equal(await openSessions(e), 1);
    const enabledAt = Date.now();
    await assign(e, { ...body, autoClockOut: true });
    await worker.sweep();
    const rec = (await autos(e))[0]!;
    assert.equal(rec.deadline_at, iso(end + H));
    assert.ok(Date.parse(String(rec.clock_out_at)) >= enabledAt - 1000, "clocked out when it was switched on, not 3 h ago");
  });

  test("grace period changes apply to the open session: raised = later, cut = now (not retroactively)", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(90 * M);
    await clockInAt(e, end - 7 * H);
    await assign(e, { ...body, graceMinutes: 180 }, end - 10 * H);
    assert.equal(await worker.sweep(), 0, "deadline end + 3 h is still ahead");
    assert.equal((await api("/attendance/current", { bearer: e.bearer })).body.autoClockOutAt, iso(end + 3 * H));
    await assign(e, { ...body, graceMinutes: 30 }, end - 10 * H); // as if the cut had been made before the shift ended
    assert.equal(await worker.sweep(), 1);
    assert.equal((await autos(e))[0]!.clock_out_at, iso(end + 30 * M));
  });

  test("overnight shift (18:xx–02:xx local): clocked out at the next morning's deadline", async () => {
    const end = floorMin(Date.now() - 3 * H);
    // A whole-hour zone where this end time reads 02:xx, so the shift crosses local midnight.
    const offset = ((2 - new Date(end).getUTCHours() + 24) % 24) > 14 ? ((2 - new Date(end).getUTCHours() + 24) % 24) - 24 : (2 - new Date(end).getUTCHours() + 24) % 24;
    const tz = offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    const local = (ms: number) => iso(ms + offset * H).slice(11, 16);
    const e = await employee({ timezone: tz });
    await clockInAt(e, end - 7 * H);
    const set = await assign(e, { startTime: local(end - 8 * H), endTime: local(end), timezone: tz, workdays: "1234567" }, end - 10 * H);
    assert.equal(set.shift.overnight, true, `${set.shift.startTime}–${set.shift.endTime} ${tz}`);
    assert.equal(await worker.sweep(), 1);
    assert.equal((await latest(e)).clockOutAt, iso(end + H));
  });

  test("DST (America/New_York): spring-forward and fall-back overnight shifts end at real local times", async () => {
    // Stored sessions from those nights (older than the offline-sync window, so inserted as fixtures).
    for (const [clockIn, deadline] of [
      ["2026-03-08T03:00:00.000Z", "2026-03-08T11:00:00.000Z"], // 22:00 EST -> 07:00 EDT (7 h shift + 1 h)
      ["2026-11-01T02:00:00.000Z", "2026-11-01T12:00:00.000Z"], // 22:00 EDT -> 07:00 EST (9 h shift + 1 h)
    ] as const) {
      const e = await employee({ timezone: "America/New_York" });
      const device = (await db.execute({ sql: "SELECT id FROM devices WHERE employee_id = ?", args: [e.id] })).rows[0]!.id;
      await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [randomUUID(), e.id, device, clockIn] });
      await assign(e, { startTime: "22:00", endTime: "06:00", workdays: "1234567" }, Date.parse(clockIn) - 10 * H);
      assert.equal(await worker.sweep(), 1);
      assert.equal((await latest(e)).clockOutAt, deadline, clockIn);
    }
  });

  test("an action after the deadline, before the worker ran: clocked out at the deadline first, the action is refused", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(2 * H);
    await clockInAt(e, end - 7 * H);
    await assign(e, body, end - 10 * H); // overdue, and the worker has not run
    const r = await act(e, "break/start");
    assert.equal(r.status, 409, r.text);
    assert.equal((await latest(e)).clockOutAt, iso(end + H), "closed at the deadline, not at the request time");
    assert.equal((await api("/auth/me", { bearer: e.bearer })).status, 200, "still signed in: clock-out is not sign-out");
  });

  test("queue upload past the deadline: the sync itself closes an overdue session at its deadline", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(2 * H);
    await assign(e, body, end - 10 * H);
    await clockInAt(e, end - 7 * H); // a clock-in queued offline hours ago, uploaded now
    assert.equal((await autos(e)).length, 1);
    assert.equal((await latest(e)).clockOutAt, iso(end + H));
  });

  test("offline queue synced after the automatic clock-out: a late clock-out and a break after the deadline are rejected", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(3 * H);
    await clockInAt(e, end - 7 * H);
    await assign(e, body, end - 10 * H);
    await worker.sweep();
    // The desktop was offline: it signs in again and uploads what it queued.
    const login = await api("/auth/login", { method: "POST", body: { email: e.email, password: PASSWORD, client: "desktop", installationId: e.device } });
    assert.equal(login.status, 200, login.text);
    e.bearer = login.body.accessToken;
    const r = await sync(e, [{ type: "BREAK_START", occurredAt: iso(end + 90 * M) }, { type: "CLOCK_OUT", occurredAt: iso(end + 2 * H) }]);
    assert.deepEqual(r.body.results.map((x: { status: string }) => x.status), ["REJECTED", "REJECTED"]);
    assert.equal(r.body.current.state, "CLOCKED_OUT");
    assert.equal((await autos(e)).length, 1);
  });
});

/** Today's local ISO weekday in UTC and the day after (shifts below are UTC). */
const weekday = (ms: number) => String(new Date(ms).getUTCDay() || 7);
const allBut = (d: string) => "1234567".replace(d, "");

describe("working days, sign-in, concurrency, failures", () => {
  test("the shift's day is not a working day: never clocked out automatically (status OFF_DAY); a working day is", async () => {
    const { body, end } = shiftEndedAgo(3 * H);
    const off = await employee();
    await clockInAt(off, end - 7 * H);
    await assign(off, { ...body, workdays: allBut(weekday(end - 8 * H)) }, end - 10 * H);
    const on = await employee();
    await clockInAt(on, end - 7 * H);
    await assign(on, { ...body, workdays: weekday(end - 8 * H) }, end - 10 * H);
    await worker.sweep();
    assert.equal(await openSessions(off), 1, "day off: still open");
    assert.equal((await api("/attendance/current", { bearer: off.bearer })).body.autoClockOutAt, null);
    assert.equal(await openSessions(on), 0, "working day: clocked out");
    const r = await api("/attendance/shifts?status=OFF_DAY&pageSize=100", { cookie: adminCookie });
    assert.ok(r.body.items.some((x: { employee: { id: string } }) => x.employee.id === off.id));
  });

  test("automatic clock-out never signs anyone out: desktop, web and refresh all keep working; audit is complete", async () => {
    const e = await employee({ web: true });
    const { body, end } = shiftEndedAgo(3 * H);
    await clockInAt(e, end - 7 * H);
    await assign(e, body, end - 10 * H);
    assert.equal(await worker.sweep(), 1);
    assert.equal((await api("/auth/me", { bearer: e.bearer })).status, 200, "desktop token");
    assert.equal((await api("/auth/me", { cookie: e.webCookie })).status, 200, "web session");
    assert.equal((await api("/auth/refresh", { method: "POST", body: { refreshToken: e.refresh } })).status, 200, "refresh");
    assert.equal((await api("/attendance/current", { bearer: e.bearer })).body.state, "CLOCKED_OUT");
    const audit = (await db.execute({ sql: "SELECT actor_user_id, metadata FROM account_audit WHERE action = 'AUTO_CLOCK_OUT' AND target_user_id = ?", args: [e.userId] })).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor_user_id, null, "the server, not a person");
    const meta = JSON.parse(String(audit[0]!.metadata));
    const session = await latest(e);
    assert.deepEqual(
      [meta.employeeId, meta.attendanceSessionId, meta.scheduledShiftEndAt, meta.deadlineAt, meta.clockOutAt, meta.cause],
      [e.id, session.id, iso(end), iso(end + H), iso(end + H), "AUTOMATIC_SHIFT_END"],
    );
    assert.ok(meta.processedAt >= meta.clockOutAt, "execution time recorded");
    assert.doesNotMatch(String(audit[0]!.metadata), /token|hash|eyJ/i);
  });

  test("concurrent workers on one employee (two direct calls, two sweeps): exactly one clock-out and one audit row", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(3 * H);
    await clockInAt(e, end - 7 * H);
    await assign(e, body, end - 10 * H);
    const results = await Promise.all([worker.processDue(e.id), worker.processDue(e.id), worker.sweep(), worker.sweep()]);
    assert.equal(results.filter((x) => x === true || x === 1).length, 1, JSON.stringify(results));
    assert.equal((await autos(e)).length, 1);
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM account_audit WHERE action = 'AUTO_CLOCK_OUT' AND target_user_id = ?", args: [e.userId] })).rows[0]!.n, 1);
  });

  test("concurrent manual and automatic clock-out: one clock-out only, whichever wins", async () => {
    for (const overdue of [true, false]) {
      const e = await employee();
      const { body, end } = shiftEndedAgo(overdue ? 3 * H : -30 * M);
      await clockInAt(e, end - 7 * H);
      await assign(e, body, end - 10 * H);
      const [manual] = await Promise.all([act(e, "clock-out"), worker.sweep(), worker.processDue(e.id)]);
      const sessions = (await db.execute({ sql: "SELECT status, clock_out_at FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows;
      assert.deepEqual(sessions.map((x) => x.status), ["CLOSED"]);
      const recs = await autos(e);
      if (overdue) {
        assert.equal(manual.status, 409, "the deadline passed first: the automatic clock-out is applied, the late manual one refused");
        assert.deepEqual([recs.length, sessions[0]!.clock_out_at], [1, iso(end + H)]);
      } else {
        assert.equal(manual.status, 200);
        assert.equal(recs.length, 0, "manual clock-out before the deadline: nothing automatic");
        assert.equal((await latest(e)).clockOutReason, "MANUAL");
      }
    }
  });

  test("an already clocked-out employee: nothing happens; a manual clock-out is never overwritten", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(3 * H);
    await sync(e, [{ type: "CLOCK_IN", occurredAt: iso(end - 7 * H) }, { type: "CLOCK_OUT", occurredAt: iso(end - H) }]);
    await assign(e, body, end - 10 * H);
    assert.equal(await worker.sweep(), 0);
    assert.equal(await worker.processDue(e.id), false);
    const s = await latest(e);
    assert.deepEqual([s.clockOutAt.slice(0, 19), s.clockOutReason, (await autos(e)).length], [iso(end - H).slice(0, 19), "MANUAL", 0], "the manual time (sync keeps ms order)");
  });

  test("a failed attempt rolls back completely, is recorded for admins, and the next run succeeds", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(3 * H);
    await clockInAt(e, end - 7 * H);
    await assign(e, body, end - 10 * H);
    await db.execute(`CREATE TRIGGER fail_once BEFORE UPDATE ON attendance_sessions WHEN OLD.employee_id = '${e.id}' BEGIN SELECT RAISE(ABORT, 'simulated outage'); END`);
    assert.equal(await worker.sweep(), 0);
    assert.equal(await openSessions(e), 1, "still open");
    assert.equal((await autos(e)).length, 0, "the claim rolled back with it");
    const view = await api("/attendance/shifts?pageSize=100", { cookie: adminCookie });
    const f = view.body.recentFailures.find((x: { employee: { id: string } }) => x.employee.id === e.id);
    assert.match(f.error, /simulated outage/);
    await db.execute("DROP TRIGGER fail_once");
    assert.equal(await worker.sweep(), 1, "retried");
    assert.equal((await autos(e))[0]!.clock_out_at, iso(end + H), "still at the deadline");
  });
});

describe("authorization and admin view", () => {
  test("employees cannot change any shift (their own included) and cannot read another's; they may read their own", async () => {
    const [a, b] = [await employee({ shift: { startTime: "09:00", endTime: "18:00" } }), await employee({ shift: { startTime: "10:00", endTime: "19:00" } })];
    const body = { startTime: "00:00", endTime: "23:59", autoClockOut: false };
    assert.equal((await api(`/employees/${a.id}/shift`, { method: "PUT", bearer: a.bearer, body })).status, 403, "own shift");
    assert.equal((await api(`/employees/${a.id}/shift`, { method: "DELETE", bearer: a.bearer })).status, 403);
    assert.equal((await api(`/employees/${b.id}/shift`, { method: "PUT", bearer: a.bearer, body })).status, 403);
    assert.equal((await api(`/employees/${b.id}/shift`, { bearer: a.bearer })).status, 404, "another employee's: as if missing");
    assert.equal((await api(`/employees/${randomUUID()}/shift`, { bearer: a.bearer })).status, 404);
    assert.equal((await api(`/employees/${a.id}/shift`, { bearer: a.bearer })).body.shift.startTime, "09:00");
    assert.equal((await api("/attendance/shifts", { bearer: a.bearer })).status, 403);
    assert.equal((await api("/attendance/shifts")).status, 401);
    assert.equal((await api(`/employees/${a.id}/shift`, { cookie: adminCookie })).body.shift.startTime, "09:00", "unchanged");
  });

  test("an Admin (IT) cannot change a Super Admin's shift; a Super Admin can", async () => {
    const it = { email: "it-admin@example.com", password: "it admin password 1" };
    await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'ADMIN', ?)", args: [randomUUID(), it.email, await hashPassword(it.password)] });
    const itCookie = cookieOf((await api("/auth/login", { method: "POST", body: it })).cookies);
    const e = await employee();
    await db.execute({ sql: "UPDATE users SET role = 'ADMIN', admin_title = 'SUPER_ADMIN' WHERE id = ?", args: [e.userId] });
    const body = { startTime: "09:00", endTime: "17:00" };
    assert.equal((await api(`/employees/${e.id}/shift`, { method: "PUT", cookie: itCookie, body })).status, 403);
    assert.equal((await api(`/employees/${e.id}/shift`, { method: "PUT", cookie: adminCookie, body })).status, 200);
    assert.equal((await api(`/employees/${e.id}/shift`, { method: "DELETE", cookie: itCookie })).status, 403);
  });

  test("shift overview: statuses, next deadline, completed automatic clock-outs, beyond-shift filter", async () => {
    const within = await employee({ shift: shiftEndedAgo(-2 * H).body });
    await act(within, "clock-in");
    const grace = await employee();
    const g = shiftEndedAgo(20 * M);
    await clockInAt(grace, g.end - 7 * H);
    await assign(grace, g.body, g.end - 10 * H);
    const done = await employee();
    const d = shiftEndedAgo(3 * H);
    await clockInAt(done, d.end - 7 * H);
    await assign(done, d.body, d.end - 10 * H);
    await worker.sweep();
    const none = await employee();

    const r = await api("/attendance/shifts?pageSize=100", { cookie: adminCookie });
    assert.equal(r.status, 200, r.text);
    const row = (e: Emp) => r.body.items.find((x: { employee: { id: string } }) => x.employee.id === e.id);
    assert.equal(row(within).status, "WITHIN_SHIFT");
    assert.equal(row(grace).status, "GRACE_PERIOD");
    assert.equal(row(grace).nextAutoClockOutAt, iso(g.end + H));
    assert.equal(row(done).status, "AUTO_CLOCKED_OUT");
    assert.equal(row(done).lastAutoClockOut.clockOutAt, iso(d.end + H));
    assert.equal(row(none).status, "NO_SHIFT");
    assert.ok(r.body.summary.AUTO_CLOCKED_OUT >= 1 && r.body.summary.NO_SHIFT >= 1);
    assert.doesNotMatch(r.text, /refresh|token_hash|accessToken/i);

    const beyond = await api("/attendance/shifts?beyondShift=true&pageSize=100", { cookie: adminCookie });
    const ids = beyond.body.items.map((x: { employee: { id: string } }) => x.employee.id);
    assert.ok(ids.includes(grace.id) && !ids.includes(within.id) && !ids.includes(done.id));
    assert.equal((await api("/attendance/shifts?beyondShift=maybe", { cookie: adminCookie })).status, 400);
  });

  test("automatic clock-out history: newest first, date and employee filters, validation", async () => {
    const e = await employee();
    const { body, end } = shiftEndedAgo(3 * H);
    await clockInAt(e, end - 7 * H);
    await assign(e, body, end - 10 * H);
    await worker.sweep();
    const day = iso(end + H).slice(0, 10);
    const r = await api(`/attendance/auto-clock-outs?employeeId=${e.id}&from=${day}&to=${day}`, { cookie: adminCookie });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.total, 1);
    const row = r.body.items[0];
    assert.deepEqual([row.employee.id, row.clockOutAt, row.deadlineAt, row.scheduledShiftEndAt, row.graceMinutes, row.reason], [e.id, iso(end + H), iso(end + H), iso(end), 60, "AUTOMATIC_SHIFT_END"]);
    assert.equal((await api(`/attendance/auto-clock-outs?employeeId=${e.id}&from=2001-01-01&to=2001-01-02`, { cookie: adminCookie })).body.total, 0);
    const all = await api("/attendance/auto-clock-outs?pageSize=100", { cookie: adminCookie });
    const times = all.body.items.map((x: { clockOutAt: string }) => x.clockOutAt);
    assert.deepEqual(times, [...times].sort().reverse());
    assert.equal((await api("/attendance/auto-clock-outs?from=yesterday", { cookie: adminCookie })).status, 400);
    assert.equal((await api("/attendance/auto-clock-outs", { bearer: e.bearer })).status, 403, "employees: no");
  });

  test("team head: sees only their team's shifts and automatic clock-outs; cannot change shifts", async () => {
    const head = await employee();
    const member = await employee();
    const outsider = await employee();
    for (const x of [member, outsider]) {
      const { body, end } = shiftEndedAgo(3 * H);
      await clockInAt(x, end - 7 * H);
      await assign(x, body, end - 10 * H);
    }
    await worker.sweep();
    const team = await api("/teams", { method: "POST", cookie: adminCookie, body: { name: `Shift team ${seq}`, headUserId: head.userId } });
    assert.equal(team.status, 201, team.text);
    assert.equal((await api(`/teams/${team.body.id}/members`, { method: "PUT", cookie: adminCookie, body: { employeeIds: [member.id] } })).status, 200);
    const ids = (b: { items: { employee: { id: string } }[] }) => b.items.map((x) => x.employee.id);
    const overview = await api("/attendance/shifts?pageSize=100", { bearer: head.bearer });
    assert.equal(overview.status, 200, overview.text);
    assert.ok(ids(overview.body).includes(member.id) && !ids(overview.body).includes(outsider.id));
    const hist = await api("/attendance/auto-clock-outs?pageSize=100", { bearer: head.bearer });
    assert.ok(ids(hist.body).includes(member.id) && !ids(hist.body).includes(outsider.id), JSON.stringify(ids(hist.body)));
    assert.equal((await api(`/attendance/auto-clock-outs?employeeId=${outsider.id}`, { bearer: head.bearer })).body.total, 0, "an outsider by id: nothing");
    assert.equal((await api(`/employees/${outsider.id}/shift`, { bearer: head.bearer })).status, 404);
    assert.equal((await api(`/employees/${member.id}/shift`, { method: "PUT", bearer: head.bearer, body: { startTime: "01:00", endTime: "02:00" } })).status, 403);
  });
});

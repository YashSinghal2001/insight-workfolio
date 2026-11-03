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

const ORIGIN = "http://localhost:3000";
const ADMIN = { email: "admin@example.com", password: "admin password 123" };
const PASSWORD = "employee password 1";
const H = 3_600_000;
const M = 60_000;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let adminCookie: string;

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
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

let seq = 0;
/** A fresh employee signed in on the desktop with a registered device. */
async function employee(opts: { register?: boolean } = {}) {
  const n = ++seq;
  const r = await api("/employees", {
    method: "POST",
    cookie: adminCookie,
    body: { email: `att${n}@example.com`, employeeCode: `ATT-${n}`, fullName: `Attendance ${n}`, timezone: "Asia/Kolkata" },
  });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `att${n}@example.com`, password: PASSWORD, client: "desktop" } });
  assert.equal(login.status, 200, login.text);
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID() };
  if (opts.register !== false) {
    const reg = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Work Mac", platform: "macos" } });
    assert.equal(reg.status, 201, reg.text);
  }
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

const act = (e: Emp, action: string, key: string = randomUUID()) =>
  api(`/attendance/${action}`, { method: "POST", bearer: e.bearer, device: e.device, key });

const sync = (e: Emp, events: { id?: string; type: string; occurredAt: string }[], sentAt = new Date().toISOString()) =>
  api("/attendance/sync", {
    method: "POST",
    bearer: e.bearer,
    device: e.device,
    body: { sentAt, events: events.map((ev) => ({ id: randomUUID(), ...ev })) },
  });

const iso = (ms: number) => new Date(ms).toISOString();
const sessionsOf = async (e: Emp) =>
  Number((await db.execute({ sql: "SELECT count(*) AS n FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows[0]!.n);

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({
    sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'ADMIN', ?)",
    args: [randomUUID(), ADMIN.email, await hashPassword(ADMIN.password)],
  });
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(ADMIN),
  });
  adminCookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
after(() => app.close());

describe("devices", () => {
  test("registration: idempotent per installation, one active device, identifiers never returned", async () => {
    const e = await employee({ register: false });
    assert.equal((await act(e, "clock-in")).status, 403, "unregistered device cannot clock in");
    const me0 = await api("/devices/me", { bearer: e.bearer, device: e.device });
    assert.deepEqual(me0.body, { status: "NOT_REGISTERED", device: null, otherActiveDevice: false });

    const body = { installationId: e.device, deviceName: "Work Mac", platform: "macos" };
    const first = await api("/devices/register", { method: "POST", bearer: e.bearer, body });
    const again = await api("/devices/register", { method: "POST", bearer: e.bearer, body });
    assert.equal(first.status, 201);
    assert.equal(again.body.id, first.body.id, "same installation -> same device");
    assert.ok(!first.text.includes(e.device), "installation id is not echoed");
    assert.deepEqual(Object.keys(first.body).sort(), ["deviceName", "id", "lastSeenAt", "platform", "registeredAt", "revokedAt"]);

    const second = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { ...body, installationId: randomUUID() } });
    assert.equal(second.status, 409, "one active device per employee");
    const other = await api("/devices/me", { bearer: e.bearer, device: randomUUID() });
    assert.deepEqual([other.body.status, other.body.otherActiveDevice], ["NOT_REGISTERED", true]);

    const bad = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { ...body, installationId: "serial-C02XYZ", platform: "linux" } });
    assert.equal(bad.status, 400);
  });

  test("last-seen is updated by device activity", async () => {
    const e = await employee();
    const before = (await api("/devices/me", { bearer: e.bearer, device: e.device })).body.device.lastSeenAt;
    await new Promise((r) => setTimeout(r, 5));
    await act(e, "clock-in");
    const after = (await api("/devices/me", { bearer: e.bearer, device: e.device })).body.device.lastSeenAt;
    assert.ok(after > before);
  });

  test("revoked devices are rejected and cannot re-register; a new device can then be enrolled", async () => {
    const e = await employee();
    const me = await api("/devices/me", { bearer: e.bearer, device: e.device });
    assert.equal((await api(`/devices/${me.body.device.id}/revoke`, { method: "POST", bearer: e.bearer })).status, 403, "employees cannot revoke");
    const revoked = await api(`/devices/${me.body.device.id}/revoke`, { method: "POST", cookie: adminCookie });
    assert.equal(revoked.status, 200);
    assert.ok(revoked.body.revokedAt);

    // The device's session was revoked with it (API-08); sign in again on the same installation.
    assert.equal((await act(e, "clock-in")).status, 401);
    const email = String((await db.execute({ sql: "SELECT u.email FROM users u JOIN employee_profiles p ON p.user_id = u.id WHERE p.id = ?", args: [e.id] })).rows[0]!.email);
    e.bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
    assert.equal((await act(e, "clock-in")).status, 403);
    assert.equal((await sync(e, [{ type: "CLOCK_IN", occurredAt: iso(Date.now()) }])).status, 403);
    assert.equal((await api("/devices/me", { bearer: e.bearer, device: e.device })).body.status, "REVOKED");
    const reRegister = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
    assert.equal(reRegister.status, 403);

    const fresh = randomUUID();
    const enrolled = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: fresh, deviceName: "New Mac", platform: "macos" } });
    assert.equal(enrolled.status, 201);
    assert.equal((await act({ ...e, device: fresh }, "clock-in")).status, 200);
  });

  test("admins without an employee profile cannot register devices or clock in", async () => {
    const r = await api("/devices/register", { method: "POST", cookie: adminCookie, body: { installationId: randomUUID(), deviceName: "x", platform: "macos" } });
    assert.equal(r.status, 403);
  });
});

describe("attendance state machine", () => {
  test("clock in, break start/end, clock out; clock-out is refused while on break", async () => {
    const e = await employee();
    const cur0 = await api("/attendance/current", { bearer: e.bearer });
    assert.deepEqual([cur0.body.state, cur0.body.session], ["CLOCKED_OUT", null]);

    const t0 = Date.now();
    const inRes = await act(e, "clock-in");
    assert.equal(inRes.status, 200, inRes.text);
    assert.equal(inRes.body.state, "CLOCKED_IN");
    const clockIn = Date.parse(inRes.body.session.clockInAt);
    assert.ok(clockIn >= t0 - 1000 && clockIn <= Date.now(), "server-authoritative time");

    assert.equal((await act(e, "break/start")).body.state, "ON_BREAK");
    const blocked = await act(e, "clock-out");
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.message, "End your break before clocking out");
    assert.equal((await act(e, "break/end")).body.state, "CLOCKED_IN");
    const out = await act(e, "clock-out");
    assert.equal(out.status, 200);
    assert.equal(out.body.state, "CLOCKED_OUT");
    assert.equal(out.body.session.status, "CLOSED");
    assert.equal(out.body.session.breaks.length, 1);
    assert.match(out.body.session.clockOutAt, /Z$/, "UTC");

    const history = await api("/attendance/history?page=1&pageSize=5", { bearer: e.bearer });
    assert.equal(history.body.total, 1);
    assert.equal(history.body.items[0].id, out.body.session.id);
    const events = await db.execute({ sql: "SELECT event_type, outcome FROM attendance_events WHERE employee_id = ? ORDER BY rowid", args: [e.id] });
    assert.deepEqual(
      events.rows.map((r) => `${r.event_type}:${r.outcome}`),
      ["CLOCK_IN:ACCEPTED", "BREAK_START:ACCEPTED", "CLOCK_OUT:REJECTED", "BREAK_END:ACCEPTED", "CLOCK_OUT:ACCEPTED"],
      "rejected attempts are kept in the audit log",
    );
  });

  test("invalid transitions are rejected with 409", async () => {
    const e = await employee();
    for (const action of ["clock-out", "break/start", "break/end"]) assert.equal((await act(e, action)).status, 409, action);
    await act(e, "clock-in");
    assert.equal((await act(e, "clock-in")).status, 409);
    assert.equal((await act(e, "break/end")).status, 409);
    assert.equal(await sessionsOf(e), 1);
  });

  test("duplicate requests with the same Idempotency-Key apply once; key is required and action-bound", async () => {
    const e = await employee();
    const key = randomUUID();
    const a = await act(e, "clock-in", key);
    const b = await act(e, "clock-in", key);
    assert.deepEqual([a.status, b.status], [200, 200], "retry gets the same success");
    assert.equal(b.body.session.id, a.body.session.id);
    assert.equal(await sessionsOf(e), 1);
    assert.equal((await act(e, "break/start", key)).status, 409, "key reused for another action");
    const noKey = await api("/attendance/break/start", { method: "POST", bearer: e.bearer, device: e.device });
    assert.equal(noKey.status, 400);
  });

  test("concurrent clock-in attempts create exactly one session", async () => {
    const e = await employee();
    const results = await Promise.all(Array.from({ length: 10 }, () => act(e, "clock-in")));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, ...Array(9).fill(409)]);
    assert.equal(await sessionsOf(e), 1);
  });
});

describe("ownership and RBAC", () => {
  test("employees see only their own attendance and cannot use another employee's device", async () => {
    const a = await employee();
    const b = await employee();
    await act(a, "clock-in");
    assert.equal((await api("/attendance/history", { bearer: b.bearer })).body.total, 0);
    assert.equal((await api("/attendance/current", { bearer: b.bearer })).body.state, "CLOCKED_OUT");
    assert.equal((await act({ ...b, device: a.device }, "clock-out")).status, 403, "A's device is not B's");
    assert.equal((await api("/attendance/current", { bearer: a.bearer })).body.state, "CLOCKED_IN", "A untouched");
    assert.equal((await api("/attendance/overview", { bearer: a.bearer })).status, 403);
    assert.equal((await api("/attendance/current")).status, 401);
  });

  test("admin overview shows status, clock-in and last sync, read-only", async () => {
    const e = await employee();
    await act(e, "clock-in");
    await act(e, "break/start");
    const r = await api(`/attendance/overview?q=${encodeURIComponent(`ATT-${seq}`)}`, { cookie: adminCookie });
    assert.equal(r.status, 200, r.text);
    const row = r.body.items.find((i: { employeeId: string }) => i.employeeId === e.id);
    assert.equal(row.state, "ON_BREAK");
    assert.ok(row.session.clockInAt);
    assert.deepEqual([row.lastEvent.type, row.lastEvent.source, row.lastEvent.outcome], ["BREAK_START", "ONLINE", "ACCEPTED"]);
    assert.ok(row.deviceLastSeenAt);
  });
});

describe("offline sync", () => {
  test("queued offline events apply in order; replaying the batch creates no duplicates", async () => {
    const e = await employee();
    const now = Date.now();
    const events = [
      { id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(now - 3 * H) },
      { id: randomUUID(), type: "BREAK_START", occurredAt: iso(now - 2 * H) },
      { id: randomUUID(), type: "BREAK_END", occurredAt: iso(now - 2 * H + 30 * M) },
      { id: randomUUID(), type: "CLOCK_OUT", occurredAt: iso(now - 10 * M) },
    ];
    const first = await sync(e, events);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.body.results.map((r: { status: string }) => r.status), Array(4).fill("ACCEPTED"));
    assert.equal(first.body.current.state, "CLOCKED_OUT");

    const replay = await sync(e, events);
    assert.deepEqual(replay.body.results.map((r: { status: string }) => r.status), Array(4).fill("DUPLICATE"));
    assert.equal(await sessionsOf(e), 1);
    const sources = await db.execute({ sql: "SELECT DISTINCT source FROM attendance_events WHERE employee_id = ?", args: [e.id] });
    assert.deepEqual(sources.rows.map((r) => r.source), ["OFFLINE_SYNC"]);
  });

  test("clock skew: a device clock 2 h slow is corrected using its send time; raw time is kept", async () => {
    const e = await employee();
    const skew = -2 * H;
    const now = Date.now();
    const r = await sync(e, [{ type: "CLOCK_IN", occurredAt: iso(now + skew - 15 * M) }], iso(now + skew));
    assert.equal(r.body.results[0].status, "ACCEPTED");
    const corrected = Date.parse(r.body.results[0].occurredAt);
    assert.ok(Math.abs(corrected - (now - 15 * M)) < 5_000, `corrected to ~15 min ago, got ${r.body.results[0].occurredAt}`);
    const raw = await db.execute({ sql: "SELECT device_time FROM attendance_events WHERE employee_id = ?", args: [e.id] });
    assert.equal(raw.rows[0]!.device_time, iso(now + skew - 15 * M));

    // A device that claims an event happened after it was sent is lying or broken.
    const future = await sync(e, [{ type: "CLOCK_OUT", occurredAt: iso(now + H) }], iso(now));
    assert.equal(future.body.results[0].status, "REJECTED");
    assert.equal(future.body.current.state, "CLOCKED_IN");
  });

  test("conflicts are rejected, never overwrite, and replays return the same rejection", async () => {
    const e = await employee();
    const now = Date.now();
    await act(e, "clock-in"); // online, now
    const stale = { id: randomUUID(), type: "CLOCK_OUT", occurredAt: iso(now - H) };
    const r = await sync(e, [stale, { type: "CLOCK_IN", occurredAt: iso(now - 30 * M) }]);
    assert.deepEqual(r.body.results.map((x: { status: string }) => x.status), ["REJECTED", "REJECTED"]);
    assert.match(r.body.results[0].reason, /earlier than the last recorded/);
    assert.match(r.body.results[1].reason, /Cannot clock in while clocked in/);
    assert.equal(r.body.current.state, "CLOCKED_IN", "online session untouched");

    const replay = await sync(e, [stale]);
    assert.equal(replay.body.results[0].status, "REJECTED");
    assert.equal(replay.body.results[0].reason, r.body.results[0].reason);

    const old = await sync(e, [{ type: "CLOCK_OUT", occurredAt: iso(now - 8 * 24 * H) }]);
    assert.match(old.body.results[0].reason, /older than 7 days/);
  });

  test("midnight-crossing shift (Asia/Kolkata) is one session with correct totals", async () => {
    const e = await employee();
    // Most recent IST midnight at least 1 h ago; IST is UTC+05:30 with no DST.
    const IST = 5.5 * H;
    let midnight = Math.floor((Date.now() + IST) / (24 * H)) * 24 * H - IST;
    if (Date.now() - midnight < H) midnight -= 24 * H;
    const r = await sync(e, [
      { type: "CLOCK_IN", occurredAt: iso(midnight - 2 * H) },
      { type: "BREAK_START", occurredAt: iso(midnight - 15 * M) },
      { type: "BREAK_END", occurredAt: iso(midnight + 15 * M) },
      { type: "CLOCK_OUT", occurredAt: iso(midnight + H) },
    ]);
    assert.deepEqual(r.body.results.map((x: { status: string }) => x.status), Array(4).fill("ACCEPTED"), r.text);
    const s = r.body.current.session;
    const { attendanceTotals } = await import("@workfolio/shared");
    const totals = attendanceTotals({ start: s.clockInAt, end: s.clockOutAt }, s.breaks.map((b: { startedAt: string; endedAt: string }) => ({ start: b.startedAt, end: b.endedAt })));
    const near = (a: number, b: number) => Math.abs(a - b) < 2_000;
    assert.ok(near(totals.elapsedMs, 3 * H) && near(totals.breakMs, 30 * M) && near(totals.netMs, 2.5 * H), JSON.stringify(totals));
    const day = (t: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(t));
    assert.notEqual(day(s.clockInAt), day(s.clockOutAt), "spans two local dates");
  });
});

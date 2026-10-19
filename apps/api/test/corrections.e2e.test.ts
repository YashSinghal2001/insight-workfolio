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
const { localDate, addDays, zonedToUtc } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const TZ = "Asia/Kolkata";
const H = 3_600_000;
const M = 60_000;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string; // cookie
let admin2: { cookie: string; userId: string; employeeId: string; bearer: string; device: string }; // admin with an employee profile

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
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
async function employee() {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `c${n}@example.com`, employeeCode: `COR-${n}`, fullName: `Correction ${n}`, timezone: TZ } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `c${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, userId: r.body.employee.userId as string, bearer: login.body.accessToken as string, device: randomUUID() };
  const reg = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  assert.equal(reg.status, 201, reg.text);
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

/** Records past events through the offline sync path (times relative to now). */
async function record(e: Emp, events: [string, number][]) {
  const r = await api("/attendance/sync", {
    method: "POST", bearer: e.bearer, device: e.device,
    body: { sentAt: iso(Date.now()), events: events.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) },
  });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
  return r.body.current;
}

const request = (who: { bearer?: string; cookie?: string }, body: object) =>
  api("/attendance/corrections", { method: "POST", ...who, body: { reason: "Forgot to press the button", ...body } });
const review = (id: string, action: "approve" | "reject", cookie = admin, reason = "Checked with the team lead") =>
  api(`/attendance/corrections/${id}/${action}`, { method: "POST", cookie, body: { reason } });
const count = async (table: string, employeeId: string) =>
  Number((await db.execute({ sql: `SELECT count(*) AS n FROM ${table} WHERE employee_id = ?`, args: [employeeId] })).rows[0]!.n);

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  for (const email of ["admin@example.com", "admin2@example.com"]) {
    await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'ADMIN', ?)", args: [randomUUID(), email, await hashPassword(PASSWORD)] });
  }
  admin = cookiesOf((await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res);
  // An admin who is also an employee (e.g. a team lead who clocks in).
  const userId = String((await db.execute("SELECT id FROM users WHERE email = 'admin2@example.com'")).rows[0]!.id);
  const employeeId = randomUUID();
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, 'LEAD-1', 'Team Lead', ?)", args: [employeeId, userId, TZ] });
  const login = await api("/auth/login", { method: "POST", body: { email: "admin2@example.com", password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email: "admin2@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken;
  const device = randomUUID();
  await api("/devices/register", { method: "POST", bearer, body: { installationId: device, deviceName: "Lead Mac", platform: "macos" } });
  admin2 = { cookie: cookiesOf(login.res), userId, employeeId, bearer, device };
});
after(() => app.close());

describe("timesheets and history", () => {
  test("daily/weekly totals with multiple shifts, overtime and an incomplete (open) shift", async () => {
    const e = await employee();
    const now = Date.now();
    // Two shifts 3 days ago from 08:00 local (10.5 h net incl. a 30 min break -> 2.5 h overtime), one open shift now.
    const d = Date.parse(zonedToUtc(`${localDate(now - 3 * 24 * H, TZ)}T08:00`, TZ));
    await record(e, [
      ["CLOCK_IN", d], ["BREAK_START", d + 2 * H], ["BREAK_END", d + 2.5 * H], ["CLOCK_OUT", d + 6 * H],
      ["CLOCK_IN", d + 7 * H], ["CLOCK_OUT", d + 12 * H],
      ["CLOCK_IN", now - 2 * H],
    ]);
    const from = localDate(now - 7 * 24 * H, TZ);
    const to = localDate(now, TZ);
    const r = await api(`/attendance/timesheet?from=${from}&to=${to}`, { bearer: e.bearer });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.employee.id, e.id);
    assert.deepEqual(r.body.policy, { weekStartsOn: 1, scheduledDailyMinutes: 480, maxOfflineAgeDays: 7 });
    const near = (a: number, b: number) => Math.abs(a - b) < 2_000;
    const totalNet = r.body.days.reduce((n: number, x: { netMs: number }) => n + x.netMs, 0);
    assert.ok(near(totalNet, 10.5 * H), `net ${totalNet}`);
    assert.ok(near(r.body.totals.breakMs, 30 * M));
    assert.ok(near(r.body.totals.overtimeMs, 2.5 * H), "overtime vs 8 h, reported separately");
    assert.ok(near(Date.parse(r.body.days.find((x: { shifts: number }) => x.shifts === 2).lastClockOut), d + 12 * H), "last clock-out");
    const today = r.body.days.find((x: { date: string }) => x.date === to);
    assert.equal(today.incomplete, true);
    assert.equal(today.netMs, 0, "open shift not counted as finalized hours");
    assert.ok(near(today.inProgressNetMs, 2 * H));
    assert.equal(r.body.totals.incompleteDays, 1);
    assert.ok(r.body.days.every((x: { offlineShifts: number }) => x.offlineShifts >= 1), "offline-synced shifts flagged");
    assert.ok(r.body.weeks.length >= 1 && r.body.weeks.length <= 2);

    const history = await api(`/attendance/history?from=${to}&to=${to}`, { bearer: e.bearer });
    assert.deepEqual([history.body.total, history.body.items[0].clockOutAt], [1, null], "range filter by local date");
    assert.equal(history.body.items[0].clockInSource, "OFFLINE_SYNC");

    assert.equal((await api(`/attendance/timesheet?from=${to}&to=${from}`, { bearer: e.bearer })).status, 400);
    assert.equal((await api(`/attendance/timesheet?from=2026-01-01&to=2026-12-31`, { bearer: e.bearer })).status, 400);
  });

  test("employees see only their own timesheets, history and corrections; admins see anyone's", async () => {
    const a = await employee();
    const b = await employee();
    await record(a, [["CLOCK_IN", Date.now() - H]]);
    const today = localDate(Date.now(), TZ);
    const q = `from=${addDays(today, -1)}&to=${today}`;
    assert.equal((await api(`/attendance/timesheet?${q}&employeeId=${a.id}`, { bearer: b.bearer })).status, 404);
    assert.equal((await api(`/attendance/history?employeeId=${a.id}`, { bearer: b.bearer })).status, 404);
    assert.equal((await api(`/attendance/timesheet?${q}&employeeId=${b.id}`, { bearer: b.bearer })).status, 200, "own id is fine");
    assert.equal((await api(`/attendance/timesheets?${q}`, { bearer: b.bearer })).status, 403);

    const asAdmin = await api(`/attendance/timesheet?${q}&employeeId=${a.id}`, { cookie: admin });
    assert.equal(asAdmin.body.employee.id, a.id);
    assert.equal((await api(`/attendance/timesheet?${q}`, { cookie: admin })).status, 403, "admin without profile must pick an employee");
    const list = await api(`/attendance/timesheets?${q}&q=${encodeURIComponent(`COR-${seq - 1}`)}`, { cookie: admin });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual([list.body.items.length, list.body.items[0].employee.id, list.body.items[0].openShift], [1, a.id, true]);

    const ra = await request({ bearer: a.bearer }, { type: "MISSING_CLOCK_OUT", sessionId: (await api("/attendance/current", { bearer: a.bearer })).body.session.id, clockOutAt: iso(Date.now() - 10 * M) });
    assert.equal(ra.status, 201, ra.text);
    assert.equal((await api(`/attendance/corrections/${ra.body.id}`, { bearer: b.bearer })).status, 404);
    assert.equal((await api("/attendance/corrections", { bearer: b.bearer })).body.total, 0);
    assert.equal((await api(`/attendance/corrections?employeeId=${a.id}`, { bearer: b.bearer })).status, 404);
    assert.equal((await review(ra.body.id, "approve", "")).status, 401);
    assert.equal((await api(`/attendance/corrections/${ra.body.id}/approve`, { method: "POST", bearer: b.bearer, body: { reason: "looks fine" } })).status, 403);
    assert.equal((await api(`/attendance/corrections/${ra.body.id}/approve`, { method: "POST", bearer: a.bearer, body: { reason: "approve myself" } })).status, 403);
    // Employees cannot target someone else's shift either: it is simply not found.
    const rb = await request({ bearer: b.bearer }, { type: "MISSING_CLOCK_OUT", sessionId: ra.body.sessionId, clockOutAt: iso(Date.now()) });
    assert.equal(rb.status, 404);
  });
});

describe("correction workflow", () => {
  test("missing clock-out: pending changes nothing; approval applies it transactionally with a full audit trail", async () => {
    const e = await employee();
    const now = Date.now();
    const current = await record(e, [["CLOCK_IN", now - 10 * H], ["BREAK_START", now - 6 * H]]);
    const events = await count("attendance_events", e.id);

    const noBreakEnd = await request({ bearer: e.bearer }, { type: "MISSING_CLOCK_OUT", sessionId: current.session.id, clockOutAt: iso(now - H) });
    assert.equal(noBreakEnd.status, 409, "the open break must be closed too");
    const r = await request({ bearer: e.bearer }, {
      type: "MISSING_CLOCK_OUT", sessionId: current.session.id, breakEndedAt: iso(now - 5.5 * H), clockOutAt: iso(now - H),
    });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.status, r.body.reviewedBy, r.body.applied], ["PENDING", null, null]);
    assert.equal((await api("/attendance/current", { bearer: e.bearer })).body.state, "ON_BREAK", "nothing applied before approval");
    assert.equal((await review(r.body.id, "approve", admin, "")).status, 400, "reviewer reason required");

    const ok = await review(r.body.id, "approve");
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.status, "APPROVED");
    assert.equal(ok.body.reviewedBy.email, "admin@example.com");
    assert.equal(ok.body.reviewReason, "Checked with the team lead");
    assert.ok(ok.body.reviewedAt);
    assert.deepEqual([ok.body.applied.original.clockOutAt, ok.body.applied.corrected.clockOutAt], [null, iso(now - H)]);
    assert.equal(ok.body.applied.corrected.breaks[0].endedAt, iso(now - 5.5 * H));

    const after = await api("/attendance/current", { bearer: e.bearer });
    assert.deepEqual([after.body.state, after.body.session.corrected, after.body.session.clockInSource], ["CLOCKED_OUT", true, "OFFLINE_SYNC"]);
    const day = localDate(now - 10 * H, TZ);
    const sheet = await api(`/attendance/timesheet?from=${day}&to=${localDate(now, TZ)}`, { bearer: e.bearer });
    assert.equal(sheet.body.totals.netMs, 9 * H - 30 * M, "timesheet recalculated: 9 h minus 30 min break");
    assert.equal(sheet.body.days[0].corrected, true);
    assert.equal(await count("attendance_events", e.id), events, "event log untouched");

    // The employee can clock in again afterwards.
    assert.equal((await api("/attendance/clock-in", { method: "POST", bearer: e.bearer, device: e.device, key: randomUUID() })).status, 200);
  });

  test("duplicate and concurrent approvals apply exactly once", async () => {
    const e = await employee();
    const s = await record(e, [["CLOCK_IN", Date.now() - 5 * H]]);
    const r = await request({ bearer: e.bearer }, { type: "MISSING_CLOCK_OUT", sessionId: s.session.id, clockOutAt: iso(Date.now() - H) });
    const both = await Promise.all([review(r.body.id, "approve"), review(r.body.id, "approve", admin2.cookie)]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
    assert.equal((await review(r.body.id, "approve")).status, 409);
    assert.equal((await review(r.body.id, "reject")).status, 409, "cannot reject after approval");
    const audits = await db.execute({ sql: "SELECT count(*) AS n FROM attendance_corrections WHERE request_id = ?", args: [r.body.id] });
    assert.equal(Number(audits.rows[0]!.n), 1);
  });

  test("rejection needs a reason, changes nothing and is final", async () => {
    const e = await employee();
    const s = await record(e, [["CLOCK_IN", Date.now() - 3 * H]]);
    const r = await request({ bearer: e.bearer }, { type: "MISSING_CLOCK_OUT", sessionId: s.session.id, clockOutAt: iso(Date.now() - H) });
    assert.equal((await api(`/attendance/corrections/${r.body.id}/reject`, { method: "POST", cookie: admin, body: {} })).status, 400);
    const rej = await review(r.body.id, "reject", admin, "Badge records show you left at 18:00");
    assert.deepEqual([rej.status, rej.body.status, rej.body.applied], [200, "REJECTED", null]);
    assert.equal((await api("/attendance/current", { bearer: e.bearer })).body.state, "CLOCKED_IN");
    assert.equal((await review(r.body.id, "approve")).status, 409);
    const mine = await api("/attendance/corrections?status=REJECTED", { bearer: e.bearer });
    assert.equal(mine.body.items[0].reviewReason, "Badge records show you left at 18:00", "employee sees the outcome");
  });

  test("an admin cannot approve their own request; another admin can (missing shift is created)", async () => {
    const start = Date.now() - 30 * H;
    const r = await request({ bearer: admin2.bearer }, { type: "MISSING_CLOCK_IN", clockInAt: iso(start), clockOutAt: iso(start + 8 * H) });
    assert.equal(r.status, 201, r.text);
    const self = await review(r.body.id, "approve", admin2.cookie);
    assert.equal(self.status, 403);
    assert.equal(self.body.message, "You cannot review your own correction request");
    const ok = await review(r.body.id, "approve", admin);
    assert.equal(ok.status, 200, ok.text);
    const h = await api(`/attendance/history?employeeId=${admin2.employeeId}`, { cookie: admin });
    assert.deepEqual(
      [h.body.items[0].clockInAt, h.body.items[0].clockOutAt, h.body.items[0].clockInSource, h.body.items[0].corrected],
      [iso(start), iso(start + 8 * H), "CORRECTION", true],
    );
    // Overlapping or future shifts are refused up front.
    assert.equal((await request({ bearer: admin2.bearer }, { type: "MISSING_CLOCK_IN", clockInAt: iso(start + H), clockOutAt: iso(start + 2 * H) })).status, 409);
    assert.equal((await request({ bearer: admin2.bearer }, { type: "MISSING_CLOCK_IN", clockInAt: iso(Date.now() + H), clockOutAt: iso(Date.now() + 2 * H) })).status, 409);
  });

  test("break and attendance time corrections; invalid changes are refused; approval re-validates current state", async () => {
    const e = await employee();
    const t = Date.now() - 12 * H;
    const cur = await record(e, [["CLOCK_IN", t], ["BREAK_START", t + 3 * H], ["BREAK_END", t + 3.25 * H], ["CLOCK_OUT", t + 8 * H]]);
    const s = cur.session;
    const brk = await request({ bearer: e.bearer }, { type: "BREAK_TIME", sessionId: s.id, breakId: s.breaks[0].id, startedAt: iso(t + 3 * H), endedAt: iso(t + 4 * H) });
    assert.equal((await review(brk.body.id, "approve")).status, 200);
    const late = await request({ bearer: e.bearer }, { type: "ATTENDANCE_TIME", sessionId: s.id, clockInAt: iso(t + 3.5 * H) });
    assert.equal(late.status, 409, "clock-in after the break start");
    const moved = await request({ bearer: e.bearer }, { type: "ATTENDANCE_TIME", sessionId: s.id, clockInAt: iso(t - H), clockOutAt: iso(t + 9 * H) });
    assert.equal((await review(moved.body.id, "approve")).status, 200);
    const sheet = await api(`/attendance/history?employeeId=${e.id}`, { cookie: admin });
    const fixed = sheet.body.items[0];
    assert.deepEqual([fixed.clockInAt, fixed.clockOutAt, fixed.breaks[0].endedAt], [iso(t - H), iso(t + 9 * H), iso(t + 4 * H)]);
    const audits = await db.execute({ sql: "SELECT count(*) AS n FROM attendance_corrections WHERE attendance_session_id = ?", args: [s.id] });
    assert.equal(Number(audits.rows[0]!.n), 2, "one audit row per applied correction");

    // Requested while clocked in; the employee then clocks out normally; approval must not overwrite it.
    const open = await record(e, [["CLOCK_IN", Date.now() - H]]);
    const stale = await request({ bearer: e.bearer }, { type: "MISSING_CLOCK_OUT", sessionId: open.session.id, clockOutAt: iso(Date.now() - 30 * M) });
    assert.equal((await api("/attendance/clock-out", { method: "POST", bearer: e.bearer, device: e.device, key: randomUUID() })).status, 200);
    const refused = await review(stale.body.id, "approve");
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /already has a clock-out/);
    assert.equal((await api(`/attendance/corrections/${stale.body.id}`, { bearer: e.bearer })).body.status, "PENDING", "still pending; admin can reject it");
  });

  test("admins list and filter pending requests across employees", async () => {
    const r = await api("/attendance/corrections?status=PENDING&pageSize=100", { cookie: admin });
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length >= 1);
    assert.ok(r.body.items.every((x: { status: string }) => x.status === "PENDING"));
    assert.ok(r.body.items.every((x: { requestedBy: { email: string } }) => x.requestedBy.email), "requester recorded");
  });
});

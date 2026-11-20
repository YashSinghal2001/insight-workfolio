// W1-ATT-ANOMALY: GET /attendance/missing-clock-outs (flag only) and admin-initiated corrections
// (in-process API, in-memory DB, synthetic people). Times are relative to the real clock; every person
// lives in a fixed-offset zone where it is ~21:00 now, so "same local day" never depends on when CI runs.
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
const { AnomaliesService } = await import("../dist/attendance/anomalies.service.js");
const { toZonedLocal } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const H = 3_600_000;
const M = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
// Fixed-offset zone where the local time now is about 21:00 (Etc/GMT signs are inverted).
const offset = ((21 - new Date().getUTCHours() + 36) % 24) - 12;
const TZ = offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string; // cookie, no employee profile
let admin2: { cookie: string; userId: string; employeeId: string };
let adminUserId: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string };
async function api(path: string, { method = "GET", body, cookie, bearer }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

interface Emp { id: string; userId: string; bearer: string; device: string }
let seq = 0;
async function person(): Promise<Emp> {
  const n = ++seq;
  const email = `anom${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: `ANOM-${n}`, fullName: `Anomaly ${n}`, timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const id = r.body.employee.id as string;
  await db.execute({ sql: "UPDATE employee_profiles SET timezone = ? WHERE id = ?", args: [TZ, id] });
  const device = randomUUID();
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, id, randomUUID()] });
  return { id, userId: r.body.employee.userId, bearer: login.body.accessToken, device };
}

/** An open session that started `hoursAgo`, device last seen `seenMinAgo` (null: never), optional open break. */
async function openShift(e: { id: string; device: string }, hoursAgo: number, seenMinAgo: number | null, breakMinAgo?: number) {
  const now = Date.now();
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [id, e.id, e.device, iso(now - hoursAgo * H)] });
  await db.execute({ sql: "UPDATE devices SET last_seen_at = ? WHERE id = ?", args: [seenMinAgo === null ? null : iso(now - seenMinAgo * M), e.device] });
  if (breakMinAgo !== undefined) {
    await db.execute({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, status) VALUES (?, ?, ?, 'OPEN')", args: [randomUUID(), id, iso(now - breakMinAgo * M)] });
  }
  return id;
}

const list = (who: Opts = { cookie: admin }, query = "") => api(`/attendance/missing-clock-outs${query}`, who);
type Item = { sessionId: string; employee: { id: string }; reasons: string[]; pendingCorrectionId: string | null; accountStatus: string; employmentStatus: string; lastDeviceSeenAt: string | null; openBreakSince: string | null; clockInLocal: string; openForMinutes: number };
const find = (r: { body: { items: Item[] } }, sessionId: string) => r.body.items.find((i) => i.sessionId === sessionId);
const reasonsOf = async (sessionId: string) => find(await list(), sessionId)?.reasons ?? [];

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
  adminUserId = String((await db.execute("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0]!.id);
  // A second admin who is also an employee.
  const userId = String((await db.execute("SELECT id FROM users WHERE email = 'admin2@example.com'")).rows[0]!.id);
  const employeeId = randomUUID();
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, 'LEAD-1', 'Lead Admin', ?)", args: [employeeId, userId, TZ] });
  admin2 = { cookie: cookiesOf((await api("/auth/login", { method: "POST", body: { email: "admin2@example.com", password: PASSWORD } })).res), userId, employeeId };
  // An enabled every-day 09:00 schedule since 2020 (WORKDAY_ENDED with a schedule).
  await db.execute({
    sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 15, '1234567', 'test schedule', ?, '2020-01-01T00:00:00.000Z')",
    args: [adminUserId],
  });
});
after(() => app.close());

describe("missing clock-outs", () => {
  test("a healthy open shift is not listed; closed shifts are ignored; nothing is modified", async () => {
    const e = await person();
    const healthy = await openShift(e, 1, 2);
    const closedEmp = await person();
    const start = Date.now() - 40 * H;
    const closed = randomUUID();
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')", args: [closed, closedEmp.id, closedEmp.device, iso(start), iso(start + 30 * H)] });
    const r = await list();
    assert.equal(r.status, 200, r.text);
    assert.equal(find(r, healthy), undefined);
    assert.equal(find(r, closed), undefined);
    assert.deepEqual(r.body.thresholds, { workdayMinutes: 480, workdayGraceMinutes: 120, maxShiftMinutes: 840, staleDeviceMinutes: 30, longBreakMinutes: 120 });
    assert.ok(Math.abs(Date.parse(r.body.generatedAt) - Date.now()) < 60_000);
    assert.equal(r.body.items.every((i: Item) => i.reasons.length > 0), true, "never an empty reason list");
    const s = (await db.execute({ sql: "SELECT status, clock_out_at FROM attendance_sessions WHERE id = ?", args: [healthy] })).rows[0]!;
    assert.deepEqual([s.status, s.clock_out_at], ["OPEN", null], "flag only");
  });

  test("DEVICE_STALE, and two devices: the fresh one wins", async () => {
    const e = await person();
    const id = await openShift(e, 2, 45);
    assert.deepEqual(await reasonsOf(id), ["DEVICE_STALE"]);
    const item = find(await list(), id)!;
    assert.ok(item.lastDeviceSeenAt && item.openForMinutes >= 119 && item.clockInLocal === toZonedLocal(Date.now() - 2 * H, TZ));
    // Second device, seen a minute ago.
    await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at) VALUES (?, ?, 'PC', 'windows', ?, ?)", args: [randomUUID(), e.id, randomUUID(), iso(Date.now() - M)] });
    assert.deepEqual(await reasonsOf(id), []);
  });

  test("LONG_BREAK (no DEVICE_STALE while on a break)", async () => {
    const e = await person();
    const id = await openShift(e, 4, 180, 150);
    const item = find(await list(), id)!;
    assert.deepEqual(item.reasons, ["LONG_BREAK"]);
    assert.ok(item.openBreakSince);
  });

  test("WORKDAY_ENDED with a per-person schedule start; MAX_SHIFT_EXCEEDED; PREVIOUS_DAY", async () => {
    const w = await person();
    // Expected start = the clock-in (local), so the workday ended 8 h later and the 2 h grace is over at 11 h.
    const clockIn = Date.now() - 11 * H;
    await db.execute({
      sql: "INSERT INTO employee_tracking_overrides (id, employee_id, expected_start, reason, changed_by, effective_at) VALUES (?, ?, ?, 'test start', ?, '2020-01-01T00:00:00.000Z')",
      args: [randomUUID(), w.id, toZonedLocal(clockIn, TZ).slice(11), adminUserId],
    });
    const workday = await openShift(w, 11, 1);
    assert.deepEqual(await reasonsOf(workday), ["WORKDAY_ENDED"]);

    // 15 h open from ~06:00 local today: the 09:00 schedule's end (17:00 + 2 h) has passed too.
    const m = await person();
    const long = await openShift(m, 15, 1);
    assert.deepEqual(await reasonsOf(long), ["WORKDAY_ENDED", "MAX_SHIFT_EXCEEDED"]);

    // Regression (production case 2): a shift left open 26 h overnight.
    const p = await person();
    const overnight = await openShift(p, 26, 18 * 60);
    assert.deepEqual(await reasonsOf(overnight), ["PREVIOUS_DAY", "WORKDAY_ENDED", "MAX_SHIFT_EXCEEDED", "DEVICE_STALE"]);
  });

  test("disabled and terminated employees with an open shift are still listed, with their status", async () => {
    const d = await person();
    const t = await person();
    const ds = await openShift(d, 3, 120);
    const ts = await openShift(t, 3, 120);
    await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE id = ?", args: [d.userId] });
    await db.execute({ sql: "UPDATE employee_profiles SET employment_status = 'TERMINATED' WHERE id = ?", args: [t.id] });
    const r = await list();
    assert.deepEqual([find(r, ds)?.accountStatus, find(r, ds)?.employmentStatus], ["DISABLED", "ACTIVE"]);
    assert.deepEqual([find(r, ts)?.accountStatus, find(r, ts)?.employmentStatus], ["ACTIVE", "TERMINATED"]);
  });

  test("an admin who is also an employee is listed", async () => {
    const id = await openShift({ id: admin2.employeeId, device: await adminDevice() }, 2, null);
    assert.deepEqual(await reasonsOf(id), ["DEVICE_STALE"]);
  });

  test("team filter and permissions", async () => {
    const head = await person();
    const member = await person();
    const outsider = await person();
    const plain = await person();
    const ms = await openShift(member, 2, 60);
    const os = await openShift(outsider, 2, 60);
    const alpha = await api("/teams", { method: "POST", cookie: admin, body: { name: "Anomaly Alpha", headUserId: head.userId } });
    assert.equal(alpha.status, 201, alpha.text);
    assert.equal((await api(`/teams/${alpha.body.id}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [member.id] } })).status, 200);
    const beta = await api("/teams", { method: "POST", cookie: admin, body: { name: "Anomaly Beta" } });
    assert.equal(beta.status, 201, beta.text);

    const adminTeam = await list({ cookie: admin }, `?teamId=${alpha.body.id}`);
    assert.equal(adminTeam.status, 200, adminTeam.text);
    assert.deepEqual(adminTeam.body.items.map((i: Item) => i.sessionId), [ms]);
    assert.equal((await list({ cookie: admin }, `?teamId=${beta.body.id}`)).body.items.length, 0, "empty team");
    assert.equal((await list({ cookie: admin }, `?teamId=${randomUUID()}`)).status, 404, "unknown team");
    assert.equal((await list({ cookie: admin }, "?teamId=nope")).status, 400);
    assert.equal((await list({ cookie: admin }, "?other=1")).status, 400, "strict query");

    const headAll = await list({ bearer: head.bearer });
    assert.equal(headAll.status, 200, headAll.text);
    assert.deepEqual(headAll.body.items.map((i: Item) => i.sessionId), [ms], "a head sees only their team");
    assert.equal(find(headAll, os), undefined);
    assert.equal((await list({ bearer: head.bearer }, `?teamId=${alpha.body.id}`)).status, 200);
    assert.equal((await list({ bearer: head.bearer }, `?teamId=${beta.body.id}`)).status, 404, "a team they do not head");
    assert.equal((await list({ bearer: plain.bearer })).status, 403);
    assert.equal((await list({ bearer: member.bearer })).status, 403);
  });

  test("bulk: 200 open shifts in one batched read", async (t) => {
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const pid = randomUUID();
      const uid = randomUUID();
      const dev = randomUUID();
      await db.execute({ sql: "INSERT INTO users (id, email, role) VALUES (?, ?, 'EMPLOYEE')", args: [uid, `bulk${i}@example.com`] });
      await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, ?)", args: [pid, uid, `BULK-${i}`, `Bulk ${i}`, TZ] });
      await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [dev, pid, randomUUID()] });
      ids.push(await openShift({ id: pid, device: dev }, 3, 60));
    }
    await list(); // warm up
    const started = performance.now();
    const r = await list();
    const ms = performance.now() - started;
    t.diagnostic(`missing-clock-outs with 200+ open shifts: ${ms.toFixed(0)} ms`);
    assert.ok(ids.every((id) => find(r, id)?.reasons.includes("DEVICE_STALE")));
    // Target < 300 ms (≈190 ms alone); only reported: under the parallel full suite the machine is shared.
  });

  test("public service method: whole organisation without a caller, injected clock", async () => {
    const e = await person();
    const id = await openShift(e, 1, 1);
    const svc = app.get(AnomaliesService);
    assert.equal((await svc.missingClockOuts()).items.find((i: Item) => i.sessionId === id), undefined);
    const later = await svc.missingClockOuts(undefined, undefined, Date.now() + 15 * H);
    assert.ok(later.items.find((i: Item) => i.sessionId === id)?.reasons.includes("MAX_SHIFT_EXCEEDED"));
  });
});

let admin2Device: string | undefined;
async function adminDevice() {
  admin2Device ??= randomUUID();
  await db.execute({ sql: "INSERT OR IGNORE INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Lead Mac', 'macos', ?)", args: [admin2Device, admin2.employeeId, randomUUID()] });
  return admin2Device;
}

describe("admin-initiated corrections", () => {
  const fileFor = (who: Opts, body: object) => api("/attendance/corrections", { method: "POST", ...who, body: { reason: "Forgot to clock out", ...body } });

  test("an admin files for an employee; the employee sees it; a different admin approves; the anomaly is gone", async () => {
    const e = await person();
    const sessionId = await openShift(e, 26, 18 * 60);
    const clockOutAt = iso(Date.now() - 18 * H);
    const r = await fileFor({ cookie: admin }, { type: "MISSING_CLOCK_OUT", sessionId, clockOutAt, employeeId: e.id });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.employee.id, e.id);
    assert.equal(r.body.requestedBy.id, adminUserId);
    assert.equal(r.body.status, "PENDING");
    assert.equal(find(await list(), sessionId)?.pendingCorrectionId, r.body.id);

    const own = await api("/attendance/corrections", { bearer: e.bearer });
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(own.body.items.map((i: { id: string }) => i.id), [r.body.id], "visible to the employee");

    const self = await api(`/attendance/corrections/${r.body.id}/approve`, { method: "POST", cookie: admin, body: { reason: "Checked with the team" } });
    assert.equal(self.status, 403, "the filing admin cannot approve it");
    const ok = await api(`/attendance/corrections/${r.body.id}/approve`, { method: "POST", cookie: admin2.cookie, body: { reason: "Checked with the team" } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.applied.corrected.clockOutAt, clockOutAt);
    const audit = (await db.execute({ sql: "SELECT requested_by, approved_by FROM attendance_corrections WHERE request_id = ?", args: [r.body.id] })).rows[0]!;
    assert.deepEqual([audit.requested_by, audit.approved_by], [adminUserId, admin2.userId]);
    assert.equal(find(await list(), sessionId), undefined, "anomaly gone once closed");
  });

  test("own requests unchanged (with or without own employeeId); others refused with 404", async () => {
    const e = await person();
    const other = await person();
    const s1 = await openShift(e, 3, 1);
    const s2 = await openShift(other, 3, 1);
    const clockOutAt = iso(Date.now() - H);
    const own = await fileFor({ bearer: e.bearer }, { type: "MISSING_CLOCK_OUT", sessionId: s1, clockOutAt });
    assert.equal(own.status, 201, own.text);
    assert.equal(own.body.requestedBy.id, e.userId);
    const ownExplicit = await fileFor({ bearer: e.bearer }, { type: "ATTENDANCE_TIME", sessionId: s1, clockInAt: iso(Date.now() - 3.5 * H), employeeId: e.id });
    assert.equal(ownExplicit.status, 201, ownExplicit.text);
    // A plain employee filing for someone else.
    assert.equal((await fileFor({ bearer: e.bearer }, { type: "MISSING_CLOCK_OUT", sessionId: s2, clockOutAt, employeeId: other.id })).status, 404);
    // A team head filing for their own member.
    const head = await person();
    const team = await api("/teams", { method: "POST", cookie: admin, body: { name: "Anomaly Gamma", headUserId: head.userId } });
    await api(`/teams/${team.body.id}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [other.id] } });
    assert.equal((await fileFor({ bearer: head.bearer }, { type: "MISSING_CLOCK_OUT", sessionId: s2, clockOutAt, employeeId: other.id })).status, 404);
    // Admin: unknown employee 404; session of a different employee 404.
    assert.equal((await fileFor({ cookie: admin }, { type: "MISSING_CLOCK_OUT", sessionId: s2, clockOutAt, employeeId: randomUUID() })).status, 404);
    assert.equal((await fileFor({ cookie: admin }, { type: "MISSING_CLOCK_OUT", sessionId: s2, clockOutAt, employeeId: e.id })).status, 404);
    // An admin who is also an employee files for themself without employeeId (existing behaviour).
    const leadSession = (await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ? AND clock_out_at IS NULL", args: [admin2.employeeId] })).rows[0]!.id;
    const lead = await fileFor({ cookie: admin2.cookie }, { type: "MISSING_CLOCK_OUT", sessionId: leadSession, clockOutAt: iso(Date.now() - H) });
    assert.equal(lead.status, 201, lead.text);
    assert.equal(lead.body.employee.id, admin2.employeeId);
  });

  test("validation: bad employeeId uuid, missing reason", async () => {
    const e = await person();
    const sessionId = await openShift(e, 3, 1);
    const body = { type: "MISSING_CLOCK_OUT", sessionId, clockOutAt: iso(Date.now() - H) };
    assert.equal((await api("/attendance/corrections", { method: "POST", cookie: admin, body: { ...body, reason: "Forgot", employeeId: "nope" } })).status, 400);
    assert.equal((await api("/attendance/corrections", { method: "POST", cookie: admin, body: { ...body, employeeId: e.id } })).status, 400);
  });
});

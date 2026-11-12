// Remediation round: Super Admin-only actions (IT Admin and team heads refused), live status from the
// device's `current` report, screenshot feature state, missing clock-out, the attendance timeline,
// audited reads of another employee's records, the team-head retention leak, separate notices.
// In-memory database, local storage in a temp dir; nothing external.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-remediation-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-remediation-videos-"));
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.SCREENSHOT_STORAGE = "local";
process.env.SCREENSHOT_LOCAL_DIR = STORAGE_DIR;
process.env.TIMELAPSE_DIR = VIDEO_DIR;

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { DEFAULT_NOTICE_VERSION, DEFAULT_SCREENSHOT_NOTICE_VERSION } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let superAdmin: string; // cookies
let itAdmin: string;
let superId: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string; key?: string };
async function api(path: string, { method = "GET", body, cookie, bearer, device, key }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  if (key) headers["idempotency-key"] = key;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, text };
}
const iso = (ms: number) => new Date(ms).toISOString();
const one = async (sql: string, args: unknown[] = []) => (await db.execute({ sql, args })).rows[0];
const count = async (sql: string, args: unknown[] = []) => Number((await one(sql, args))!.n);

async function adminUser(email: string, title: "SUPER_ADMIN" | "ADMIN") {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, 'ADMIN', ?, ?)", args: [id, email, title, await hashPassword(PASSWORD)] });
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  return { id, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

let seq = 0;
/** An employee signed in on the desktop (bearer) and the web (cookie), with a registered device. */
async function employee({ timezone = "UTC", consent = true } = {}) {
  const n = ++seq;
  const email = `rem${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: itAdmin, body: { email, employeeCode: `REM-${n}`, fullName: `Remediation ${n}`, timezone } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const desktop = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const web = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  const e = {
    id: r.body.employee.id as string, userId: r.body.employee.userId as string, bearer: desktop.body.accessToken as string,
    cookie: web.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), device: randomUUID(), deviceId: "",
  };
  const reg = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  assert.equal(reg.status, 201, reg.text);
  e.deviceId = reg.body.id;
  if (consent) await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_NOTICE_VERSION, iso(Date.now() - 3 * 86_400_000)] });
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

const act = (e: Emp, action: "clock-in" | "clock-out" | "break/start" | "break/end") => api(`/attendance/${action}`, { method: "POST", bearer: e.bearer, device: e.device, key: randomUUID() });
const report = (e: Emp, current: unknown, intervals: unknown[] = []) =>
  api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals, ...(current ? { current } : {}) } });
const overviewRow = async (e: Emp, cookie = itAdmin) => {
  const r = await api("/attendance/overview?pageSize=100", { cookie });
  assert.equal(r.status, 200, r.text);
  return r.body.items.find((x: { employeeId: string }) => x.employeeId === e.id);
};
const deviceRow = (e: Emp) => one("SELECT activity_state, activity_state_since, activity_state_at, screenshot_state FROM devices WHERE id = ?", [e.deviceId]);
/** Makes `head` the head of a new active team containing `members`. */
async function team(head: Emp, members: Emp[]) {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO teams (id, name, head_user_id, created_by) VALUES (?, ?, ?, ?)", args: [id, `Team ${id.slice(0, 8)}`, head.userId, superId] });
  for (const m of members) await db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [id, m.id, superId] });
}
const audits = (action: string, targetUserId: string) => count("SELECT count(*) AS n FROM account_audit WHERE action = ? AND target_user_id = ?", [action, targetUserId]);

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  const s = await adminUser("ceo@example.com", "SUPER_ADMIN");
  [superAdmin, superId] = [s.cookie, s.id];
  itAdmin = (await adminUser("it@example.com", "ADMIN")).cookie;
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
});

describe("Super Admin-only actions", () => {
  const reason = { reason: "Captured a private document" };
  // [method, path, body, what a Super Admin gets (the route's own answer: it got past the permission check)]
  const routes = (): [string, string, unknown, number[]][] => [
    ["DELETE", `/screenshots/${randomUUID()}`, reason, [404]],
    ["POST", "/screenshots/retention/run", { confirm: true }, [409]], // retention not approved
    ["POST", "/activity/retention/run", { confirm: true }, [409]],
    ["DELETE", `/timelapses/${randomUUID()}`, undefined, [404]],
    ["GET", "/storage/onedrive/oauth/start", undefined, [302, 404]], // 404 "OneDrive is not configured": the service's own answer
    ["POST", "/storage/onedrive/disconnect", undefined, [204, 500]], // existing behaviour when OneDrive is not configured (past the permission check); the connected case is in onedrive.e2e.test.ts
    ["GET", "/storage/google-drive/oauth/start", undefined, [302, 404]],
    ["GET", "/roles/users", undefined, [200]],
    ["GET", "/roles/history", undefined, [200]],
  ];

  test("IT Admin (ADMIN, admin_title ADMIN) gets 403; the Super Admin reaches the route", async () => {
    for (const [method, path, body, ok] of routes()) {
      const it = await api(path, { method, body, cookie: itAdmin });
      assert.equal(it.status, 403, `IT Admin ${method} ${path}: ${it.text}`);
      assert.equal(it.body.message, "Your role does not allow this action");
      const su = await api(path, { method, body, cookie: superAdmin });
      assert.ok(ok.includes(su.status), `Super Admin ${method} ${path}: ${su.status} ${su.text}`);
      if (su.status === 404 && path.startsWith("/storage/")) assert.match(su.body.message, /not configured/, "the route exists; storage is just not set up in tests");
    }
  });

  test("IT Admin cannot change roles; the Super Admin can", async () => {
    const e = await employee();
    const body = { platformRole: "ADMIN", reason: "Joined the IT team" };
    assert.equal((await api(`/roles/users/${e.userId}`, { method: "PATCH", cookie: itAdmin, body })).status, 403);
    assert.equal((await one("SELECT role FROM users WHERE id = ?", [e.userId]))!.role, "EMPLOYEE");
    assert.equal((await api(`/roles/users/${e.userId}`, { method: "PATCH", cookie: superAdmin, body })).status, 200);
    assert.equal((await one("SELECT role FROM users WHERE id = ?", [e.userId]))!.role, "ADMIN");
  });

  test("IT Admin keeps the shared admin routes (monitoring data and settings)", async () => {
    const today = iso(Date.now()).slice(0, 10);
    for (const path of ["/employees", "/attendance/overview", `/screenshots/gallery?from=${today}&to=${today}`, "/settings/screenshots", "/settings/monitoring", "/screenshots/retention", `/audit?from=${today}&to=${today}`]) {
      assert.equal((await api(path, { cookie: itAdmin })).status, 200, path);
    }
  });

  test("employees and team heads cannot delete anything", async () => {
    const [head, member] = [await employee(), await employee()];
    await team(head, [member]);
    for (const who of [head, member]) {
      for (const [method, path, body] of routes()) {
        const r = await api(path, { method, body, cookie: who.cookie });
        assert.equal(r.status, 403, `${method} ${path}: ${r.status}`);
      }
    }
    // The team head still reads their team's timelapses (class permission), only deletion is refused.
    const today = iso(Date.now()).slice(0, 10);
    assert.equal((await api(`/timelapses?from=${today}&to=${today}&employeeId=${member.id}`, { cookie: head.cookie })).status, 200);
  });
});

describe("live status from the device's `current` report", () => {
  test("zero intervals with a `current` is accepted; neither is a 400", async () => {
    const e = await employee();
    assert.equal((await act(e, "clock-in")).status, 200);
    const r = await report(e, { state: "IDLE", since: iso(Date.now() - 5 * M) });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { results: [] });
    assert.equal((await report(e, null)).status, 400, "nothing to store");
    assert.equal((await report(e, { state: "TYPING", since: iso(Date.now()) })).status, 400);
    assert.equal((await report(e, { state: "IDLE", since: iso(Date.now()), windowTitle: "secret" })).status, 400, "strict: nothing else rides along");
  });

  test("attendance wins; ACTIVE/IDLE only from a fresh report; cleared on clock-out", async () => {
    const e = await employee();
    assert.deepEqual([(await overviewRow(e)).liveStatus, (await overviewRow(e)).liveSince], ["NOT_CLOCKED_IN", null]);

    // Not clocked in: the report is ignored (input never implies clocked in).
    assert.equal((await report(e, { state: "ACTIVE", since: iso(Date.now() - M) })).status, 200);
    assert.equal((await deviceRow(e))!.activity_state, null);
    assert.equal((await overviewRow(e)).liveStatus, "NOT_CLOCKED_IN");

    assert.equal((await act(e, "clock-in")).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "UNKNOWN", "clocked in, no report yet: never guessed");

    assert.equal((await report(e, { state: "IDLE", since: iso(Date.now() + 5_000) })).status, 200); // device clock slightly ahead
    let row = await overviewRow(e);
    assert.equal(row.liveStatus, "IDLE");
    assert.ok(Date.parse(row.liveSince) <= Date.now(), "since is capped at the server's receive time");
    const me = await api("/activity/me", { bearer: e.bearer });
    assert.deepEqual([me.body.liveStatus, me.body.liveSince], [row.liveStatus, row.liveSince], "the employee's own status endpoint agrees");

    assert.equal((await report(e, { state: "ACTIVE", since: iso(Date.now()) })).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "ACTIVE");

    assert.equal((await report(e, { state: "UNOBSERVED", since: iso(Date.now()) })).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "UNKNOWN");

    // A report received before this working stretch began (here: before the clock-in) is not believed.
    assert.equal((await report(e, { state: "ACTIVE", since: iso(Date.now()) })).status, 200);
    await db.execute({ sql: "UPDATE devices SET activity_state_at = ? WHERE id = ?", args: [iso(Date.now() - 2 * M), e.deviceId] });
    assert.equal((await overviewRow(e)).liveStatus, "UNKNOWN");
    assert.equal((await report(e, { state: "ACTIVE", since: iso(Date.now()) })).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "ACTIVE");

    assert.equal((await act(e, "break/start")).status, 200);
    row = await overviewRow(e);
    assert.deepEqual([row.liveStatus, row.liveSince], ["ON_BREAK", row.session.breaks[0].startedAt], "on a break whatever the device says");
    assert.equal((await act(e, "break/end")).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "UNKNOWN", "the report predates the end of the break");
    assert.equal((await report(e, { state: "IDLE", since: iso(Date.now()) })).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "IDLE");

    assert.equal((await act(e, "clock-out")).status, 200);
    assert.deepEqual({ ...(await deviceRow(e)) }, { activity_state: null, activity_state_since: null, activity_state_at: null, screenshot_state: null });
    row = await overviewRow(e);
    assert.deepEqual([row.liveStatus, row.liveSince], ["NOT_CLOCKED_IN", row.session.clockOutAt]);
  });

  test("a report older than 3 minutes gives UNKNOWN", async () => {
    const e = await employee();
    // Clocked in an hour ago (offline sync keeps the original time), so only staleness can make it UNKNOWN.
    const c = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 60 * M) }] } });
    assert.equal(c.body.results[0].status, "ACCEPTED", c.text);
    assert.equal((await report(e, { state: "IDLE", since: iso(Date.now() - 10 * M) })).status, 200);
    const fresh = await overviewRow(e);
    assert.equal(fresh.liveStatus, "IDLE");
    assert.ok(Math.abs(Date.parse(fresh.liveSince) - (Date.now() - 10 * M)) < 5_000, fresh.liveSince);
    await db.execute({ sql: "UPDATE devices SET activity_state_at = ? WHERE id = ?", args: [iso(Date.now() - 3 * M - 1_000), e.deviceId] });
    assert.deepEqual([(await overviewRow(e)).liveStatus, (await overviewRow(e)).liveSince], ["UNKNOWN", null]);
    assert.equal((await api("/activity/me", { bearer: e.bearer })).body.liveStatus, "UNKNOWN");
    await db.execute({ sql: "UPDATE devices SET activity_state_at = ? WHERE id = ?", args: [iso(Date.now() - 2 * M), e.deviceId] });
    assert.equal((await overviewRow(e)).liveStatus, "IDLE", "within the window");
  });

  test("ignored without consent: nothing stored, status stays UNKNOWN", async () => {
    const e = await employee({ consent: false });
    assert.equal((await act(e, "clock-in")).status, 200);
    const r = await report(e, { state: "ACTIVE", since: iso(Date.now()) });
    assert.equal(r.status, 403, "no monitoring notice acknowledged at all: same refusal as before");
    assert.equal((await deviceRow(e))!.activity_state, null);
    // An acknowledgement of some other notice (not the one in force) does not count either.
    await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version) VALUES (?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION] });
    assert.equal((await report(e, { state: "ACTIVE", since: iso(Date.now()) })).status, 200);
    assert.equal((await deviceRow(e))!.activity_state, null);
    assert.equal((await overviewRow(e)).liveStatus, "UNKNOWN");
  });

  test("GET /activity/me carries the per-person idle threshold", async () => {
    const e = await employee();
    const org = (await api("/activity/me", { bearer: e.bearer })).body.policy.idleThresholdSeconds;
    const r = await api(`/settings/employees/${e.id}/tracking`, { method: "PUT", cookie: itAdmin, body: { expectedStart: null, workdays: null, idleThresholdSeconds: org + 240, reason: "long calls" } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await api("/activity/me", { bearer: e.bearer })).body.policy.idleThresholdSeconds, org + 240);
  });
});

describe("missing clock-out", () => {
  test("an open session clocked in on an earlier local date is flagged for the employee and the admins; nothing is closed", async () => {
    const [late, today] = [await employee(), await employee()];
    const c = await api("/attendance/sync", { method: "POST", bearer: late.bearer, device: late.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 26 * 60 * M) }] } });
    assert.equal(c.body.results[0].status, "ACCEPTED", c.text);
    assert.equal((await act(today, "clock-in")).status, 200);

    assert.equal((await api("/attendance/current", { bearer: late.bearer })).body.missingClockOut, true);
    assert.equal((await api("/attendance/current", { bearer: today.bearer })).body.missingClockOut, false);
    assert.deepEqual([(await overviewRow(late)).missingClockOut, (await overviewRow(today)).missingClockOut], [true, false]);
    const day = iso(Date.now()).slice(0, 10);
    const sheets = (await api(`/attendance/timesheets?from=${day}&to=${day}&pageSize=100`, { cookie: itAdmin })).body.items;
    const of = (e: Emp) => sheets.find((x: { employee: { id: string } }) => x.employee.id === e.id);
    assert.deepEqual([of(late).openShift, of(late).missingClockOut], [true, true]);
    assert.deepEqual([of(today).openShift, of(today).missingClockOut], [true, false]);
    assert.equal((await one("SELECT status FROM attendance_sessions WHERE employee_id = ?", [late.id]))!.status, "OPEN", "never auto-closed");

    assert.equal((await act(late, "clock-out")).status, 200);
    assert.equal((await api("/attendance/current", { bearer: late.bearer })).body.missingClockOut, false);
  });
});

describe("screenshot feature state", () => {
  test("DISABLED -> AWAITING_CONSENT -> ENABLED -> device problem -> stale problem ignored", async () => {
    const e = await employee();
    const state = async () => (await api("/screenshots/me", { bearer: e.bearer })).body.state;
    assert.equal(await state(), "DISABLED", "off by default");
    assert.equal((await overviewRow(e)).screenshotState, "DISABLED");
    // Even a device problem report does not change DISABLED.
    assert.equal((await report(e, { state: "UNOBSERVED", since: iso(Date.now()), screenshot: "PERMISSION_DENIED" })).status, 200);
    assert.equal(await state(), "DISABLED");

    await db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
              retention_approved, notice_version, reason, changed_by) VALUES (1, 300, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test', ?)`,
      args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, superId],
    });
    assert.equal(await state(), "AWAITING_CONSENT", "the activity acknowledgement is not screenshot consent");
    assert.equal((await overviewRow(e)).screenshotState, "AWAITING_CONSENT");

    assert.equal((await api("/screenshots/consent", { method: "POST", bearer: e.bearer, body: { noticeVersion: DEFAULT_SCREENSHOT_NOTICE_VERSION } })).status, 200);
    assert.equal(await state(), "PERMISSION_DENIED", "the device's fresh report");
    assert.equal((await overviewRow(e)).screenshotState, "PERMISSION_DENIED");

    assert.equal((await report(e, { state: "UNOBSERVED", since: iso(Date.now()), screenshot: "CAPTURE_FAILED" })).status, 200);
    assert.equal(await state(), "CAPTURE_FAILED");
    await db.execute({ sql: "UPDATE devices SET screenshot_state_at = ? WHERE id = ?", args: [iso(Date.now() - 16 * M), e.deviceId] });
    assert.equal(await state(), "ENABLED", "a stale problem report is ignored");
    assert.equal((await overviewRow(e)).screenshotState, "ENABLED");

    assert.equal((await report(e, { state: "UNOBSERVED", since: iso(Date.now()), screenshot: "OK" })).status, 200);
    assert.equal(await state(), "ENABLED");
    // A report without `screenshot` leaves the stored one alone.
    assert.equal((await report(e, { state: "UNOBSERVED", since: iso(Date.now()), screenshot: "PERMISSION_DENIED" })).status, 200);
    assert.equal((await report(e, { state: "UNOBSERVED", since: iso(Date.now()) })).status, 200);
    assert.equal(await state(), "PERMISSION_DENIED");
  });
});

describe("GET /attendance/timeline", () => {
  // An employee in Asia/Kolkata (UTC+05:30): the local day D runs from 18:30Z the day before to 18:30Z.
  const H = 60 * M;
  const d0 = Math.floor((Date.now() - 5 * 86_400_000) / 86_400_000) * 86_400_000; // 00:00Z, five days ago
  const D = iso(d0).slice(0, 10);
  const z = (hours: number) => iso(d0 + hours * H); // hours relative to 00:00Z of D (negative: the day before)
  let e: Emp, other: Emp, head: Emp;

  before(async () => {
    [e, other, head] = [await employee({ timezone: "Asia/Kolkata" }), await employee(), await employee()];
    await team(head, [e]);
    const session = async (id: string, from: number, to: number, fill: () => Promise<unknown> = async () => {}) => {
      await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [id, e.id, e.deviceId, z(from)] });
      await fill();
      await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [z(to), id] });
    };
    const interval = (id: string, sessionId: string, kind: "ACTIVE" | "IDLE", from: number, to: number) =>
      db.execute({
        sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name, started_at, ended_at,
                active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'DESKTOP_MACOS', ?, ?, ?)`,
        args: [id, e.id, e.deviceId, sessionId, kind, kind === "ACTIVE" ? "Editor" : null, z(from), z(to), kind === "ACTIVE" ? (to - from) * 3600 : 0, kind === "IDLE" ? (to - from) * 3600 : 0, z(from), z(to), id],
      });
    // S1: 22:30 local the day before to 01:00 local on D; its activity straddles local midnight.
    await session("s1", -7, -4.5, () => interval("a1", "s1", "ACTIVE", -6, -5));
    // S2: on D, with an active and an idle period and a break.
    await session("s2", 4, 6, async () => {
      await interval("a2", "s2", "ACTIVE", 4, 4.5);
      await interval("i2", "s2", "IDLE", 4.5, 5);
      await db.execute({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES ('b2', 's2', ?, ?, 'CLOSED')", args: [z(5), z(5.25)] });
    });
    // S3: 00:15 local on the NEXT day (18:45Z on D): not part of D.
    await session("s3", 18.75, 19);
  });

  const EXPECTED = (): [string, string, string, string | null, string | null][] => [
    ["ACTIVE:a1", "ACTIVE", z(-6), z(-5), "Editor"], // began before local midnight, reaches into D
    ["CLOCK_OUT:s1", "CLOCK_OUT", z(-4.5), null, null],
    ["CLOCK_IN:s2", "CLOCK_IN", z(4), null, null],
    ["ACTIVE:a2", "ACTIVE", z(4), z(4.5), "Editor"], // same instant as the clock-in: after it
    ["IDLE:i2", "IDLE", z(4.5), z(5), null],
    ["BREAK:b2", "BREAK", z(5), z(5.25), null],
    ["CLOCK_OUT:s2", "CLOCK_OUT", z(6), null, null],
  ];
  const flat = (items: { id: string; type: string; at: string; endAt: string | null; applicationName: string | null }[]) => items.map((i) => [i.id, i.type, i.at, i.endAt, i.applicationName]);

  test("own day: real rows only, chronological, in the employee's local day; time zone returned", async () => {
    const r = await api(`/attendance/timeline?date=${D}`, { bearer: e.bearer });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(flat(r.body.items), EXPECTED());
    assert.deepEqual([r.body.total, r.body.page, r.body.pageSize, r.body.date, r.body.timezone, r.body.employee.id], [7, 1, 100, D, "Asia/Kolkata", e.id]);
    assert.ok(!r.text.includes("userId") && !r.text.includes("device"), "no internals");
    // The neighbouring local days hold the rest; nothing is on two days except periods that straddle midnight.
    const next = await api(`/attendance/timeline?date=${iso(d0 + 24 * H).slice(0, 10)}`, { bearer: e.bearer });
    assert.deepEqual(flat(next.body.items), [["CLOCK_IN:s3", "CLOCK_IN", z(18.75), null, null], ["CLOCK_OUT:s3", "CLOCK_OUT", z(19), null, null]]);
    const prev = await api(`/attendance/timeline?date=${iso(d0 - 24 * H).slice(0, 10)}`, { bearer: e.bearer });
    assert.deepEqual(flat(prev.body.items), [["CLOCK_IN:s1", "CLOCK_IN", z(-7), null, null], ["ACTIVE:a1", "ACTIVE", z(-6), z(-5), "Editor"]]);
    // Default date: the employee's today (nothing recorded).
    const now = await api("/attendance/timeline", { bearer: e.bearer });
    assert.deepEqual([now.status, now.body.total, now.body.timezone], [200, 0, "Asia/Kolkata"]);
  });

  test("pagination", async () => {
    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      const r = await api(`/attendance/timeline?date=${D}&pageSize=3&page=${page}`, { bearer: e.bearer });
      assert.deepEqual([r.status, r.body.total, r.body.page, r.body.pageSize], [200, 7, page, 3]);
      pages.push(flat(r.body.items));
    }
    assert.deepEqual(pages.map((p) => p.length), [3, 3, 1, 0]);
    assert.deepEqual(pages.flat(), EXPECTED());
  });

  test("validation", async () => {
    for (const q of ["date=yesterday", "date=2026-13-01", `date=${D}&pageSize=0`, `date=${D}&pageSize=201`, `date=${D}&employeeId=nope`, `date=${D}&from=${D}`]) {
      assert.equal((await api(`/attendance/timeline?${q}`, { bearer: e.bearer })).status, 400, q);
    }
    assert.equal((await api(`/attendance/timeline?date=${D}`)).status, 401);
  });

  test("access: self; team head for the team; admins for all; anyone else 404. Reads of another employee are audited", async () => {
    const path = `/attendance/timeline?date=${D}&employeeId=${e.id}`;
    const action = "EMPLOYEE_ATTENDANCE_TIMELINE_VIEWED";
    const before = await audits(action, e.userId);
    assert.equal((await api(path, { cookie: e.cookie })).status, 200, "own id");
    assert.equal(await audits(action, e.userId), before, "own reads are not audited");

    const refused = await api(path, { cookie: other.cookie });
    assert.equal(refused.status, 404);
    assert.ok(!refused.text.includes("Editor"));
    assert.equal((await api(`/attendance/timeline?date=${D}&employeeId=${randomUUID()}`, { cookie: itAdmin })).status, 404);
    assert.equal(await audits(action, e.userId), before, "refused reads leave no row");

    for (const cookie of [itAdmin, superAdmin, head.cookie]) {
      const r = await api(path, { cookie });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(flat(r.body.items), EXPECTED());
    }
    assert.equal(await audits(action, e.userId), before + 3, "one row per request");
    assert.equal((await api(`/attendance/timeline?date=${D}&employeeId=${other.id}`, { cookie: head.cookie })).status, 404, "not in the head's team");
    const row = (await one("SELECT actor_user_id, resource_type, metadata FROM account_audit WHERE action = ? AND target_user_id = ? ORDER BY rowid DESC LIMIT 1", [action, e.userId]))!;
    assert.deepEqual([row.actor_user_id, row.resource_type, JSON.parse(String(row.metadata))], [head.userId, "ACCOUNT", { employeeId: e.id, date: D }]);
  });

  test("the other audited reads: screenshot list and gallery, activity timeline; shown in the audit view", async () => {
    const [shots, activity] = ["EMPLOYEE_SCREENSHOTS_VIEWED", "EMPLOYEE_ACTIVITY_TIMELINE_VIEWED"];
    const [s0, a0] = [await audits(shots, e.userId), await audits(activity, e.userId)];
    // Own reads: none.
    assert.equal((await api(`/screenshots?from=${D}&to=${D}`, { cookie: e.cookie })).status, 200);
    assert.equal((await api(`/activity/timeline?from=${D}&to=${D}`, { cookie: e.cookie })).status, 200);
    assert.deepEqual([await audits(shots, e.userId), await audits(activity, e.userId)], [s0, a0]);
    // Another employee's attempt: 404, none.
    assert.equal((await api(`/screenshots?employeeId=${e.id}`, { cookie: other.cookie })).status, 404);
    assert.equal((await api(`/activity/timeline?from=${D}&to=${D}&employeeId=${e.id}`, { cookie: other.cookie })).status, 404);
    assert.deepEqual([await audits(shots, e.userId), await audits(activity, e.userId)], [s0, a0]);
    // Admin and team head.
    assert.equal((await api(`/screenshots?employeeId=${e.id}&from=${D}&to=${D}`, { cookie: itAdmin })).status, 200);
    assert.equal((await api(`/screenshots/gallery?from=${D}&to=${D}&employeeId=${e.id}`, { cookie: head.cookie })).status, 200);
    assert.equal((await api(`/screenshots/gallery?from=${D}&to=${D}&employeeId=${other.id}`, { cookie: head.cookie })).status, 200, "out of scope: an empty page");
    assert.equal(await audits(shots, other.userId), 0, "and no audit row naming someone the head cannot read");
    assert.equal((await api(`/screenshots/gallery?from=${D}&to=${D}`, { cookie: itAdmin })).status, 200, "all-employees page: not audited per employee");
    assert.equal((await api(`/activity/timeline?from=${D}&to=${D}&employeeId=${e.id}`, { cookie: itAdmin })).status, 200);
    assert.deepEqual([await audits(shots, e.userId), await audits(activity, e.userId)], [s0 + 2, a0 + 1]);

    const today = iso(Date.now()).slice(0, 10);
    const view = await api(`/audit?from=${today}&to=${today}&source=ACCOUNT&action=${activity}&targetUserId=${e.userId}`, { cookie: itAdmin });
    assert.equal(view.status, 200, view.text);
    assert.equal(view.body.items.length, 1);
    assert.deepEqual([view.body.items[0].actor.email, view.body.items[0].target.userId, view.body.items[0].details], ["it@example.com", e.userId, { employeeId: e.id, from: D, to: D }]);
  });

  test("team heads no longer get the organisation's retention status in /screenshots/overview", async () => {
    const path = `/screenshots/overview?from=${D}&to=${D}`;
    const forHead = await api(path, { cookie: head.cookie });
    assert.equal(forHead.status, 200, forHead.text);
    assert.ok(!("retention" in forHead.body) && !forHead.text.includes("ceo@example.com") && !forHead.text.includes("retentionDays"));
    assert.equal(typeof forHead.body.total, "number");
    for (const cookie of [itAdmin, superAdmin]) assert.equal(typeof (await api(path, { cookie })).body.retention.retentionDays, "number");
  });
});

describe("screenshot consent is a separate acknowledgement", () => {
  const shots = (noticeVersion: string) => ({
    enabled: false, intervalSeconds: 300, webpQuality: 70, maxDimension: 1920, captureScope: "PRIMARY_DISPLAY", retentionDays: 30, retentionApproved: false,
    noticeVersion, employeeSelfView: true, reason: "test",
  });
  const monitoring = (noticeVersion: string) => ({ enabled: true, sampleSeconds: 15, idleThresholdSeconds: 300, retentionDays: 30, retentionApproved: false, noticeVersion, reason: "test" });

  test("the screenshot notice cannot be an activity notice, nor the reverse", async () => {
    const a = await api("/settings/screenshots", { method: "PUT", cookie: itAdmin, body: shots(DEFAULT_NOTICE_VERSION) });
    assert.equal(a.status, 400, a.text);
    assert.match(a.body.message, /screenshots need a separate notice/);
    const b = await api("/settings/monitoring", { method: "PUT", cookie: itAdmin, body: monitoring(DEFAULT_SCREENSHOT_NOTICE_VERSION) });
    assert.equal(b.status, 400, b.text);
    assert.match(b.body.message, /activity monitoring needs a separate notice/);

    // A notice once used for activity monitoring stays off limits for screenshots, also after monitoring moved on.
    const notice = (version: string) => api("/settings/monitoring/notices", { method: "POST", cookie: itAdmin, body: { version, title: `Notice ${version}`, points: ["What is collected"], draft: true } });
    for (const v of ["rem-activity-1", "rem-activity-2", "rem-shots-1"]) assert.equal((await notice(v)).status, 201, v);
    assert.equal((await api("/settings/monitoring", { method: "PUT", cookie: itAdmin, body: monitoring("rem-activity-1") })).status, 200);
    assert.equal((await api("/settings/monitoring", { method: "PUT", cookie: itAdmin, body: monitoring("rem-activity-2") })).status, 200);
    assert.equal((await api("/settings/screenshots", { method: "PUT", cookie: itAdmin, body: shots("rem-activity-1") })).status, 400);
    assert.equal((await api("/settings/screenshots", { method: "PUT", cookie: itAdmin, body: shots("rem-shots-1") })).status, 200, "its own notice is fine");
    assert.equal((await api("/settings/monitoring", { method: "PUT", cookie: itAdmin, body: monitoring("rem-shots-1") })).status, 400);
    assert.equal((await api("/settings/monitoring", { method: "PUT", cookie: itAdmin, body: monitoring("rem-activity-2") })).status, 200, "re-saving the current settings still works");
  });
});

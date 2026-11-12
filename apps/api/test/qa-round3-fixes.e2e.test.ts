// QA round 3 (independent): verifies the fix round. Retention changes and the website purge are Super
// Admin-only; scheduled purges show in the audit view; the added read audits; live status display gating;
// timeline order at shared instants. In-memory database, local storage in a temp dir; nothing external.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-qa3-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-qa3-videos-"));
const SECRET = "qa-round3-secret-qa-round3-secret-0123";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = SECRET;
process.env.SCREENSHOT_STORAGE = "local";
process.env.SCREENSHOT_LOCAL_DIR = STORAGE_DIR;
process.env.TIMELAPSE_DIR = VIDEO_DIR;

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { ScreenshotsService } = await import("../dist/screenshots/screenshots.service.js");
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

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; bearer?: string; device?: string; key?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, raw, cookie, bearer, device, key, headers: extra }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  if (key) headers["idempotency-key"] = key;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  const text = await res.text();
  return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, text };
}
const iso = (ms: number) => new Date(ms).toISOString();
const one = async (sql: string, args: unknown[] = []) => (await db.execute({ sql, args })).rows[0];
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const webLogin = (email: string) => fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });

async function adminUser(email: string, title: "SUPER_ADMIN" | "ADMIN") {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, 'ADMIN', ?, ?)", args: [id, email, title, await hashPassword(PASSWORD)] });
  return { id, cookie: cookieOf(await webLogin(email)) };
}

let seq = 0;
let passwordHash: string | undefined;
/** An employee signed in on the desktop (bearer + refresh token) and the web (cookie), with a registered device. */
async function employee({ timezone = "UTC", consent = true } = {}) {
  const n = ++seq;
  const email = `qc${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: itAdmin, body: { email, employeeCode: `QC-${n}`, fullName: `QA ${n}`, timezone } });
  assert.equal(r.status, 201, r.text);
  // Password set directly: POST /auth/setup-password is limited to 20 per IP per 15 minutes (covered in sessions.e2e.test.ts).
  await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [(passwordHash ??= await hashPassword(PASSWORD)), r.body.employee.userId] });
  const desktop = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const e = {
    id: r.body.employee.id as string, userId: r.body.employee.userId as string, email,
    bearer: desktop.body.accessToken as string, refreshToken: desktop.body.refreshToken as string,
    cookie: cookieOf(await webLogin(email)), device: randomUUID(), deviceId: "",
  };
  const reg = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  assert.equal(reg.status, 201, reg.text);
  e.deviceId = reg.body.id;
  if (consent) await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_NOTICE_VERSION, iso(Date.now() - 3 * 86_400_000)] });
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

const act = (e: Emp, action: "clock-in" | "clock-out" | "break/start" | "break/end") => api(`/attendance/${action}`, { method: "POST", bearer: e.bearer, device: e.device, key: randomUUID() });
const overviewRow = async (e: Emp) => {
  const r = await api("/attendance/overview?pageSize=100", { cookie: itAdmin });
  assert.equal(r.status, 200, r.text);
  return r.body.items.find((x: { employeeId: string }) => x.employeeId === e.id);
};
async function team(head: Emp, members: Emp[]) {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO teams (id, name, head_user_id, created_by) VALUES (?, ?, ?, ?)", args: [id, `Team ${id.slice(0, 8)}`, head.userId, superId] });
  for (const m of members) await db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [id, m.id, superId] });
}
/** A closed session inserted directly (the triggers allow open -> closed only). */
async function closedSession(e: Emp, id: string, inAt: string, outAt: string) {
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [id, e.id, e.deviceId, inAt] });
  await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [outAt, id] });
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  const s = await adminUser("qc-ceo@example.com", "SUPER_ADMIN");
  [superAdmin, superId] = [s.cookie, s.id];
  itAdmin = (await adminUser("qc-it@example.com", "ADMIN")).cookie;
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
});

// ---- Retention changes are Super Admin-only; everything else in the same forms is shared ----------

describe("retention settings: only a Super Admin changes the period or its approval", () => {
  const shot = (c: Record<string, unknown>, over: Record<string, unknown>) => ({
    enabled: c.enabled, intervalSeconds: c.intervalSeconds, webpQuality: c.webpQuality, maxDimension: c.maxDimension, captureScope: c.captureScope,
    maskRegions: c.maskRegions, blur: c.blur, noticeVersion: DEFAULT_SCREENSHOT_NOTICE_VERSION, employeeSelfView: c.employeeSelfView, autoTimelapse: c.autoTimelapse,
    retentionDays: c.retentionDays, retentionApproved: c.retentionApproved, reason: "qa round 3", ...over,
  });
  const mon = (c: Record<string, unknown>, over: Record<string, unknown>) => ({
    enabled: c.enabled, sampleSeconds: c.sampleSeconds, idleThresholdSeconds: c.idleThresholdSeconds, retentionDays: c.retentionDays,
    retentionApproved: c.retentionApproved, noticeVersion: c.noticeVersion, reason: "qa round 3", ...over,
  });
  const web = (c: Record<string, unknown>, over: Record<string, unknown>) => ({ enabled: c.enabled, retentionDays: c.retentionDays, noticeVersion: c.noticeVersion, reason: "qa round 3", ...over });

  test("screenshots: IT Admin 403 for the period and for the approval; other fields save; Super Admin may change both", async () => {
    const get = async () => (await api("/settings/screenshots", { cookie: superAdmin })).body.effective;
    const c = await get();
    const put = (cookie: string, over: Record<string, unknown>) => api("/settings/screenshots", { method: "PUT", cookie, body: shot(c, over) });
    assert.equal((await put(itAdmin, { retentionDays: c.retentionDays + 1 })).status, 403);
    assert.equal((await put(itAdmin, { retentionDays: 7 })).status, 403);
    assert.equal((await put(itAdmin, { retentionApproved: !c.retentionApproved })).status, 403);
    assert.deepEqual([(await get()).retentionDays, (await get()).retentionApproved], [c.retentionDays, c.retentionApproved], "nothing changed");
    const other = await put(itAdmin, { webpQuality: c.webpQuality === 70 ? 71 : 70 });
    assert.equal(other.status, 200, other.text);
    assert.deepEqual([(await get()).retentionDays, (await get()).retentionApproved, (await get()).enabled], [c.retentionDays, c.retentionApproved, false], "retention untouched; capture still off");
    const s = await put(superAdmin, { retentionDays: c.retentionDays + 1 });
    assert.equal(s.status, 200, s.text);
    assert.equal((await put(superAdmin, { retentionDays: c.retentionDays })).status, 200);
  });

  test("activity monitoring: same rule", async () => {
    const get = async () => (await api("/settings/monitoring", { cookie: superAdmin })).body.effective;
    const c = await get();
    const put = (cookie: string, over: Record<string, unknown>) => api("/settings/monitoring", { method: "PUT", cookie, body: mon(c, over) });
    assert.equal((await put(itAdmin, { retentionDays: c.retentionDays + 1 })).status, 403);
    assert.equal((await put(itAdmin, { retentionApproved: !c.retentionApproved })).status, 403);
    assert.deepEqual([(await get()).retentionDays, (await get()).retentionApproved], [c.retentionDays, c.retentionApproved]);
    const other = await put(itAdmin, { idleThresholdSeconds: c.idleThresholdSeconds + 60 });
    assert.equal(other.status, 200, other.text);
    assert.equal((await put(itAdmin, { idleThresholdSeconds: c.idleThresholdSeconds })).status, 200);
    assert.equal((await put(superAdmin, { retentionDays: c.retentionDays + 1 })).status, 200);
    assert.equal((await put(superAdmin, { retentionDays: c.retentionDays })).status, 200);
  });

  test("website usage: IT Admin cannot change the period or run the purge; employees and team heads neither", async () => {
    const policy = async () => (await api("/websites/policy", { cookie: superAdmin })).body.current;
    const c = await policy();
    const [head, member] = [await employee(), await employee()];
    await team(head, [member]);
    assert.equal((await api("/websites/policy", { method: "PUT", cookie: itAdmin, body: web(c, { retentionDays: c.retentionDays === 1 ? 2 : c.retentionDays - 1 }) })).status, 403);
    assert.equal((await policy()).retentionDays, c.retentionDays);
    for (const cookie of [itAdmin, head.cookie, member.cookie]) {
      assert.equal((await api("/websites/retention/run", { method: "POST", cookie, body: { confirm: true } })).status, 403);
    }
    const s = await api("/websites/retention/run", { method: "POST", cookie: superAdmin, body: { confirm: true } });
    assert.ok(s.status !== 401 && s.status !== 403, `Super Admin: ${s.status}`);
    assert.equal((await policy()).enabled, c.enabled, "website tracking was not switched on by this test");
  });
});

// ---- The scheduled purge is visible in the audit view -------------------------------------------------

describe("scheduled retention deletions are listed in the audit view", () => {
  test("a screenshot purged by the scheduled job appears as SCREENSHOT_DELETED_BY_RETENTION with no actor; a person's delete keeps its own action and reason", async () => {
    const e = await employee();
    const sessionId = randomUUID();
    const old = Date.now() - 400 * 86_400_000;
    await closedSession(e, sessionId, iso(old), iso(old + 60 * M));
    const insert = async (id: string, capturedAt: string) => db.execute({
      sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height, mime_type,
              file_size_bytes, checksum, storage_provider, storage_key, upload_status, mask_count, blurred)
            VALUES (?, ?, ?, ?, ?, ?, ?, 10, 10, 'image/webp', 100, ?, 'LOCAL_DEV', ?, 'REGISTERED', 0, 0)`,
      args: [id, e.id, e.deviceId, sessionId, randomUUID(), capturedAt, capturedAt, "0".repeat(64), `screenshots/unassigned/${e.id}/${id}.webp`],
    });
    const [byJob, byPerson] = [randomUUID(), randomUUID()];
    await insert(byJob, iso(old + 10 * M));
    await insert(byPerson, iso(old + 20 * M));
    assert.equal((await api(`/screenshots/${byPerson}`, { method: "DELETE", cookie: superAdmin, body: { reason: "Captured a private document" } })).status, 200);
    // Retention approved in this in-memory database only (capture stays off), then the job itself, as the scheduler calls it.
    await db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
              retention_approved, notice_version, reason, changed_by) VALUES (0, 300, 70, 1920, 'PRIMARY_DISPLAY', 30, 1, ?, 'qa: approve retention', ?)`,
      args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, superId],
    });
    await app.get(ScreenshotsService).retentionRun(null);
    const row = (await one("SELECT upload_status, deleted_by, deleted_reason FROM screenshots WHERE id = ?", [byJob]))!;
    assert.deepEqual([row.upload_status, row.deleted_by, row.deleted_reason], ["DELETED", null, null]);

    const today = iso(Date.now()).slice(0, 10);
    const view = await api(`/audit?from=${today}&to=${today}&source=SCREENSHOT_DELETION&targetUserId=${e.userId}&pageSize=200`, { cookie: itAdmin });
    assert.equal(view.status, 200, view.text);
    const by = (id: string) => view.body.items.find((i: { resource: { id: string } }) => i.resource?.id === id) ?? view.body.items.find((i: { details: { screenshotId: string } }) => i.details?.screenshotId === id);
    const [job, person] = [by(byJob), by(byPerson)];
    assert.ok(job && person, view.text.slice(0, 400));
    assert.equal(job.action, "SCREENSHOT_DELETED_BY_RETENTION");
    assert.equal(job.actor ?? null, null, "no person acted");
    assert.equal(person.action, "SCREENSHOT_DELETED");
    assert.equal(person.reason, "Captured a private document");
    assert.equal(person.actor.email, "qc-ceo@example.com");
  });
});

// ---- Audited reads added in the fix round ---------------------------------------------------------------

describe("audited reads: attendance history / timesheet / export, activity summary, screenshot detail", () => {
  const day = iso(Date.now()).slice(0, 10);
  const actions = async (targetUserId: string) => (await db.execute({ sql: "SELECT action, actor_user_id FROM account_audit WHERE target_user_id = ? AND action LIKE 'EMPLOYEE_%' ORDER BY rowid", args: [targetUserId] })).rows.map((r) => `${r.action}`);

  test("each served read of another employee writes one row with its own action; own, refused and failed reads write none", async () => {
    const [e, head, stranger] = [await employee(), await employee(), await employee()];
    await team(head, [e]);
    const sessionId = randomUUID();
    await closedSession(e, sessionId, iso(Date.now() - 120 * M), iso(Date.now() - 60 * M));
    const shot = randomUUID();
    await db.execute({
      sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height, mime_type,
              file_size_bytes, checksum, storage_provider, storage_key, upload_status, mask_count, blurred)
            VALUES (?, ?, ?, ?, ?, ?, ?, 10, 10, 'image/webp', 100, ?, 'LOCAL_DEV', ?, 'REGISTERED', 0, 0)`,
      args: [shot, e.id, e.deviceId, sessionId, randomUUID(), iso(Date.now() - 90 * M), iso(Date.now() - 90 * M), "0".repeat(64), `screenshots/unassigned/${e.id}/${shot}.webp`],
    });
    const reads: [string, string][] = [
      [`/attendance/history?employeeId=${e.id}`, "EMPLOYEE_ATTENDANCE_VIEWED"],
      [`/attendance/timesheet?employeeId=${e.id}&from=${day}&to=${day}`, "EMPLOYEE_ATTENDANCE_VIEWED"],
      [`/attendance/export?employeeId=${e.id}&from=${day}&to=${day}`, "EMPLOYEE_ATTENDANCE_EXPORTED"],
      [`/activity/summary?employeeId=${e.id}&from=${day}&to=${day}`, "EMPLOYEE_ACTIVITY_SUMMARY_VIEWED"],
      [`/screenshots/${shot}`, "EMPLOYEE_SCREENSHOTS_VIEWED"],
    ];
    // Own reads (the employee), a stranger's attempts, signed out, and an invalid query: nothing.
    for (const [path] of reads) {
      const own = await api(path.replace(`employeeId=${e.id}&`, "").replace(`?employeeId=${e.id}`, ""), { cookie: e.cookie });
      assert.equal(own.status, 200, `own ${path}: ${own.text.slice(0, 100)}`);
      assert.ok([403, 404].includes((await api(path, { cookie: stranger.cookie })).status), `stranger ${path}`);
      assert.equal((await api(path)).status, 401);
    }
    assert.equal((await api(`/attendance/timesheet?employeeId=${e.id}&from=${day}&to=2020-01-01`, { cookie: itAdmin })).status, 400);
    assert.equal((await api(`/screenshots/${shot}/content`, { cookie: itAdmin })).status, 409, "not stored yet: refused");
    assert.deepEqual(await actions(e.userId), []);

    const expected: string[] = [];
    for (const cookie of [itAdmin, superAdmin, head.cookie]) {
      for (const [path, action] of reads) {
        const r = await api(path, { cookie });
        assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 120)}`);
        expected.push(action);
        assert.deepEqual(await actions(e.userId), expected, path);
      }
    }
    assert.deepEqual(await actions(stranger.userId), []);
    assert.ok([403, 404].includes((await api(`/attendance/history?employeeId=${stranger.id}`, { cookie: head.cookie })).status), "outside the head's team");
    assert.deepEqual(await actions(stranger.userId), []);
  });
});

// ---- Live status display gating ---------------------------------------------------------------------------

describe("live status is UNKNOWN whenever the report may not be shown", () => {
  test("a stored report is not displayed for an employee who has not acknowledged the notice in force, nor while monitoring is off", async () => {
    const [acked, unacked] = [await employee(), await employee({ consent: false })];
    for (const e of [acked, unacked]) {
      assert.equal((await act(e, "clock-in")).status, 200);
      // Written directly: the display rule must hold even if a value is already in the row.
      await db.execute({ sql: "UPDATE devices SET activity_state = 'ACTIVE', activity_state_since = ?, activity_state_at = ? WHERE id = ?", args: [iso(Date.now()), iso(Date.now()), e.deviceId] });
    }
    assert.equal((await overviewRow(acked)).liveStatus, "ACTIVE", "control");
    assert.deepEqual([(await overviewRow(unacked)).liveStatus, (await overviewRow(unacked)).liveSince], ["UNKNOWN", null]);
    assert.equal((await api("/activity/me", { bearer: unacked.bearer })).body.liveStatus, "UNKNOWN");

    const c = (await api("/settings/monitoring", { cookie: superAdmin })).body.effective;
    const put = (enabled: boolean) => api("/settings/monitoring", { method: "PUT", cookie: itAdmin, body: { enabled, sampleSeconds: c.sampleSeconds, idleThresholdSeconds: c.idleThresholdSeconds, retentionDays: c.retentionDays, retentionApproved: c.retentionApproved, noticeVersion: c.noticeVersion, reason: "qa round 3" } });
    assert.equal((await put(false)).status, 200);
    try {
      assert.equal((await overviewRow(acked)).liveStatus, "UNKNOWN");
      assert.equal((await api("/activity/me", { bearer: acked.bearer })).body.liveStatus, "UNKNOWN");
      await db.execute({ sql: "UPDATE devices SET activity_state_at = ? WHERE id = ?", args: [iso(Date.now()), acked.deviceId] });
      assert.equal((await overviewRow(acked)).liveStatus, "UNKNOWN", "however fresh");
    } finally {
      assert.equal((await put(c.enabled)).status, 200);
    }
    assert.equal((await act(acked, "break/start")).status, 200);
    assert.equal((await overviewRow(acked)).liveStatus, "ON_BREAK", "attendance states are unaffected");
  });
});

// ---- Timeline order at shared instants -----------------------------------------------------------------------

describe("timeline order when records share an instant", () => {
  test("clock-out, then the next clock-in, then the periods that begin with it; the same on every page size", async () => {
    const e = await employee();
    const t = "2026-06-15T09:00:00.000Z";
    await closedSession(e, "r3-a", "2026-06-15T08:00:00.000Z", t);
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('r3-b', ?, ?, ?, 'OPEN')", args: [e.id, e.deviceId, t] });
    await db.execute({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES ('r3-br', 'r3-b', ?, '2026-06-15T09:05:00.000Z', 'CLOSED')", args: [t] });
    await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = '2026-06-15T10:00:00.000Z', status = 'CLOSED' WHERE id = 'r3-b'", args: [] });
    const want = ["CLOCK_IN:r3-a", "CLOCK_OUT:r3-a", "CLOCK_IN:r3-b", "BREAK:r3-br", "CLOCK_OUT:r3-b"];
    const whole = await api("/attendance/timeline?date=2026-06-15", { bearer: e.bearer });
    assert.deepEqual(whole.body.items.map((i: { id: string }) => i.id), want);
    const paged: string[] = [];
    for (let page = 1; page <= 5; page++) paged.push(...(await api(`/attendance/timeline?date=2026-06-15&pageSize=1&page=${page}`, { bearer: e.bearer })).body.items.map((i: { id: string }) => i.id));
    assert.deepEqual(paged, want);
  });
});

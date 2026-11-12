// P2 employee web panel: security / isolation (in-process API, in-memory DB, local screenshot storage,
// synthetic data). Employees use the web cookie session exactly as the browser panel does. Convention
// observed: another employee's id (query param or URL id) is 404, indistinguishable from "missing";
// admin-only routes are 403; signed out / revoked / forged sessions are 401.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-panel-"));
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.SCREENSHOT_STORAGE = "local";
process.env.SCREENSHOT_LOCAL_DIR = STORAGE_DIR;

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { DEFAULT_NOTICE_VERSION, DEFAULT_SCREENSHOT_NOTICE_VERSION, addDays, localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "panel password 1";
const M = 60_000;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; bearer?: string; device?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, raw, cookie, bearer, device, headers: extra = {} }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : undefined;
  return { status: res.status, body: json, text, res };
}
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const webLogin = async (email: string) => {
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  return cookiesOf(r.res);
};
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function fakeWebp(width: number, height: number, payload: number): Uint8Array {
  const chunk = 5 + payload;
  const b = new Uint8Array(20 + chunk + (chunk % 2));
  const dv = new DataView(b.buffer);
  b.set(new TextEncoder().encode("RIFF"), 0);
  dv.setUint32(4, b.length - 8, true);
  b.set(new TextEncoder().encode("WEBPVP8L"), 8);
  dv.setUint32(16, chunk, true);
  b[20] = 0x2f;
  dv.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  for (let i = 25; i < b.length; i++) b[i] = (i * 7 + payload) & 0xff;
  return b;
}

let admin: string; // Admin, no employee profile
let superAdmin: string; // Super Admin, no employee profile
let adminId: string;

let seq = 0;
/** An employee with a desktop session (to seed data, as the app does) and a web cookie session (the panel). */
async function employee(name: string) {
  const n = ++seq;
  const email = `panel${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: `PN-${n}`, fullName: name, timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken as string;
  const e = { id: r.body.employee.id as string, email, name, bearer, device: randomUUID(), cookie: await webLogin(email) };
  await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  for (const v of new Set([DEFAULT_NOTICE_VERSION, DEFAULT_SCREENSHOT_NOTICE_VERSION])) {
    await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, v, iso(Date.now() - 5 * 60 * M)] });
  }
  const c = await api("/attendance/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 180 * M) }] } });
  assert.equal(c.body.results[0].status, "ACCEPTED", c.text);
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

async function activity(e: Emp, appName: string) {
  const interval = { id: randomUUID(), kind: "ACTIVE", applicationIdentifier: `com.example.${appName}`, applicationName: appName, startedAt: iso(Date.now() - 120 * M), endedAt: iso(Date.now() - 100 * M) };
  const r = await api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals: [interval] } });
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
}
async function screenshot(e: Emp, minutesAgo: number) {
  const bytes = fakeWebp(1920, 1080, 1000 + seq++);
  const key = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id: key, sentAt: iso(Date.now()), capturedAt: iso(Date.now() - minutesAgo * M), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp", masks: [] } });
  assert.equal(reg.body.status, "REGISTERED", reg.text);
  assert.equal((await api(`/screenshots/${key}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  return String((await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [key] })).rows[0]!.id);
}
const selfView = (on: boolean) =>
  db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, employee_self_view, reason, changed_by) VALUES (1, '[]', 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, ?, 'test: self-view', ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, on ? 1 : 0, adminId],
  });

const today = localDate(Date.now(), "UTC");
const RANGE = `from=${addDays(today, -6)}&to=${today}`;

let a: Emp;
let b: Emp;
const B_SECRET = "Bob-Secret-App";
const A_APP = "Alice-Own-App";
let aShot: string;
let bShot: string;
let aLeave: string;
let bLeave: string;
let bCorrection: string;
let projA: { id: string; task: string };
let projB: { id: string; task: string };

/** No trace of B (id, name, app, project) in a response meant for A. */
function noB(r: { text: string }, what: string) {
  for (const leak of [b.id, b.name, B_SECRET, "PROJ-B", "Bob task"]) assert.ok(!r.text.includes(leak), `${what}: leaked ${leak}`);
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'ceo@example.com', 'ADMIN', 'SUPER_ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  admin = await webLogin("admin@example.com");
  superAdmin = await webLogin("ceo@example.com");
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, '[]', 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test', ?, ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, adminId, iso(Date.now() - 2 * 86_400_000)],
  });
  [a, b] = [await employee("Alice Panel"), await employee("Bob Panel")];
  await activity(a, A_APP);
  await activity(b, B_SECRET);
  aShot = await screenshot(a, 90);
  bShot = await screenshot(b, 90);

  const leave = async (e: Emp, d: number) => {
    const r = await api("/leave", { method: "POST", cookie: e.cookie, body: { startDate: addDays(today, d), endDate: addDays(today, d), portion: "FULL_DAY" } });
    assert.equal(r.status, 201, r.text);
    return r.body.id as string;
  };
  aLeave = await leave(a, 10);
  bLeave = await leave(b, 11);

  const corr = await api("/attendance/corrections", { method: "POST", bearer: b.bearer, body: { type: "MISSING_CLOCK_IN", clockInAt: iso(Date.now() - 50 * 60 * M), clockOutAt: iso(Date.now() - 42 * 60 * M), reason: "Forgot to press the button" } });
  assert.equal(corr.status, 201, corr.text);
  bCorrection = corr.body.id;

  const project = async (code: string, task: string, member: Emp) => {
    const p = await api("/projects", { method: "POST", cookie: admin, body: { code, name: `Project ${code}` } });
    assert.equal(p.status, 201, p.text);
    const t = await api(`/projects/${p.body.id}/tasks`, { method: "POST", cookie: admin, body: { title: task } });
    assert.equal((await api(`/projects/${p.body.id}/members`, { method: "POST", cookie: admin, body: { employeeId: member.id } })).status, 201);
    return { id: p.body.id as string, task: t.body.tasks[0].id as string };
  };
  projA = await project("PROJ-A", "Alice task", a);
  projB = await project("PROJ-B", "Bob task", b);
  // B tracked time on B's task (open shift, server time).
  const s = await api("/task-time/start", { method: "POST", bearer: b.bearer, body: { taskId: projB.task } });
  assert.equal(s.status, 200, s.text);
  assert.equal((await api(`/task-time/${s.body.id}/stop`, { method: "POST", bearer: b.bearer })).status, 200, s.text);
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe("employee web panel: data isolation (cookie session)", () => {
  test("1/6. attendance: B's id is 404 on history/timesheet/export; own data only without it", async () => {
    for (const path of ["/attendance/history", "/attendance/timesheet", "/attendance/export"]) {
      const r = await api(`${path}?${RANGE}&employeeId=${b.id}`, { cookie: a.cookie });
      assert.equal(r.status, 404, `${path}?employeeId=B`);
      noB(r, path);
      const own = await api(`${path}?${RANGE}`, { cookie: a.cookie });
      assert.equal(own.status, 200, `${path} own: ${own.text}`);
      noB(own, `${path} own`);
    }
    const hist = await api(`/attendance/history?${RANGE}`, { cookie: a.cookie });
    assert.equal(hist.body.total, 1, "A's open shift only");
    const csv = await api(`/attendance/export?${RANGE}`, { cookie: a.cookie });
    const rows = csv.text.replace(/^\uFEFF/, "").trim().split("\r\n").slice(1);
    assert.equal(rows.length, 1);
    assert.ok(rows.every((r) => r.startsWith("PN-1,Alice Panel,")), csv.text);
    assert.equal((await api(`/attendance/export?${RANGE}&employeeId=${b.id}&format=xlsx`, { cookie: a.cookie })).status, 404);
    assert.equal((await api("/attendance/current", { cookie: a.cookie })).status, 200);
  });

  test("1b. corrections: B's correction is 404; B's id on the list is 404; own list has none of B", async () => {
    assert.equal((await api(`/attendance/corrections/${bCorrection}`, { cookie: a.cookie })).status, 404);
    assert.equal((await api(`/attendance/corrections?employeeId=${b.id}`, { cookie: a.cookie })).status, 404);
    const own = await api("/attendance/corrections", { cookie: a.cookie });
    assert.equal(own.status, 200);
    assert.equal(own.body.total, 0);
    noB(own, "corrections");
  });

  test("2. screenshots: B's id on the list is 404; B's screenshot detail and content are 404; own works", async () => {
    const r = await api(`/screenshots?employeeId=${b.id}`, { cookie: a.cookie });
    assert.equal(r.status, 404);
    for (const path of [`/screenshots/${bShot}`, `/screenshots/${bShot}/content`, `/screenshots/${bShot}/content?variant=thumbnail`]) {
      assert.equal((await api(path, { cookie: a.cookie })).status, 404, path);
    }
    const mine = await api("/screenshots", { cookie: a.cookie });
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual(mine.body.items.map((i: { id: string }) => i.id), [aShot]);
    noB(mine, "screenshots list");
    assert.equal((await api(`/screenshots/${aShot}`, { cookie: a.cookie })).status, 200);
    assert.equal((await api(`/screenshots/${aShot}/content`, { cookie: a.cookie })).status, 200);
    assert.equal((await api("/screenshots/me", { cookie: a.cookie })).status, 200);
  });

  test("3. activity: B's id on summary/timeline is 404; own works and has only A's applications", async () => {
    for (const path of ["/activity/summary", "/activity/timeline"]) {
      assert.equal((await api(`${path}?${RANGE}&employeeId=${b.id}`, { cookie: a.cookie })).status, 404, path);
      const own = await api(`${path}?${RANGE}`, { cookie: a.cookie });
      assert.equal(own.status, 200, own.text);
      noB(own, path);
    }
    const s = await api(`/activity/summary?${RANGE}`, { cookie: a.cookie });
    assert.deepEqual(s.body.applications.map((x: { applicationName: string }) => x.applicationName), [A_APP]);
    const me = await api("/activity/me", { cookie: a.cookie });
    assert.equal(me.status, 200);
    noB(me, "/activity/me");
  });

  test("4. projects/tasks: only A's assignments; entries?employeeId=B is 404; B's entries never visible", async () => {
    const asg = await api("/task-time/assignments", { cookie: a.cookie });
    assert.equal(asg.status, 200);
    assert.deepEqual(asg.body.map((p: { id: string }) => p.id), [projA.id]);
    assert.deepEqual(asg.body[0].tasks.map((t: { id: string }) => t.id), [projA.task]);
    noB(asg, "assignments");
    assert.equal((await api(`/task-time/entries?${RANGE}&employeeId=${b.id}`, { cookie: a.cookie })).status, 404);
    const entries = await api(`/task-time/entries?${RANGE}`, { cookie: a.cookie });
    assert.equal(entries.status, 200);
    assert.deepEqual(entries.body, [], "A tracked nothing; B's entry is not shown");
    const cur = await api("/task-time/current", { cookie: a.cookie });
    assert.equal(cur.status, 200);
    noB(cur, "current");
    // B cannot be targeted through a body either: A cannot start a timer on B's task.
    const start = await api("/task-time/start", { method: "POST", cookie: a.cookie, body: { taskId: projB.task } });
    assert.equal(start.status, 404, `start on B task: ${start.text}`);
  });

  test("5. leave: B's request is 404 to read and cancel; list is A's only; body employeeId is rejected (400)", async () => {
    assert.equal((await api(`/leave/${bLeave}`, { cookie: a.cookie })).status, 404);
    assert.equal((await api(`/leave/${bLeave}/cancel`, { method: "POST", cookie: a.cookie })).status, 404);
    assert.equal((await api(`/leave/${bLeave}`, { cookie: admin })).body.status, "PENDING", "B's request untouched");
    assert.equal((await api(`/leave?employeeId=${b.id}`, { cookie: a.cookie })).status, 404);
    const list = await api("/leave", { cookie: a.cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((x: { id: string }) => x.id), [aLeave]);
    noB(list, "leave list");
    const before = Number((await db.execute({ sql: "SELECT count(*) AS n FROM leave_requests WHERE employee_id = ?", args: [b.id] })).rows[0]!.n);
    const forged = await api("/leave", { method: "POST", cookie: a.cookie, body: { startDate: addDays(today, 20), endDate: addDays(today, 20), portion: "FULL_DAY", employeeId: b.id } });
    assert.equal(forged.status, 400, `body employeeId is rejected, not ignored: ${forged.text}`);
    const after = Number((await db.execute({ sql: "SELECT count(*) AS n FROM leave_requests WHERE employee_id = ?", args: [b.id] })).rows[0]!.n);
    assert.equal(after, before, "nothing created for B");
    assert.equal((await api(`/leave/${aLeave}`, { cookie: a.cookie })).status, 200);
  });

  test("9/10. profile: own record and devices are 200; B's are 404", async () => {
    assert.equal((await api(`/employees/${a.id}`, { cookie: a.cookie })).status, 200);
    assert.equal((await api(`/employees/${a.id}/devices`, { cookie: a.cookie })).status, 200);
    for (const path of [`/employees/${b.id}`, `/employees/${b.id}/devices`]) {
      const r = await api(path, { cookie: a.cookie });
      assert.equal(r.status, 404, path);
      assert.equal(r.body.message, "Employee not found");
      noB({ text: JSON.stringify({ ...r.body, path: undefined }) }, `${path} (error envelope echoes only the requested path)`);
    }
  });

  test("websites: own status/usage 200; usage with an employeeId (B's) is refused with 400", async () => {
    assert.equal((await api("/websites/me", { cookie: a.cookie })).status, 200);
    const own = await api(`/websites/me/usage?${RANGE}`, { cookie: a.cookie });
    assert.equal(own.status, 200, own.text);
    noB(own, "websites usage");
    assert.equal((await api(`/websites/me/usage?${RANGE}&employeeId=${b.id}`, { cookie: a.cookie })).status, 400);
  });
});

/** Admin-only routes; [method, path, body?]. */
const ADMIN_ROUTES = (): [string, string, object?][] => [
  ["GET", "/employees"],
  ["GET", `/attendance/timesheets?${RANGE}`],
  ["GET", "/attendance/overview"],
  ["GET", `/screenshots/gallery?${RANGE}`],
  ["GET", "/projects"],
  ["GET", `/websites/report?${RANGE}`],
  ["GET", "/roles/users"],
  ["GET", `/timelapses?${RANGE}&employeeId=${a.id}`],
  ["GET", "/settings/monitoring"],
];

describe("employee web panel: admin-only routes", () => {
  test("7/8. employee gets 403 on every admin-only route (cookie session), including approving leave", async () => {
    for (const [method, path] of ADMIN_ROUTES()) {
      const r = await api(path, { method, cookie: a.cookie });
      assert.equal(r.status, 403, `${method} ${path}: ${r.status}`);
      noB(r, path);
    }
    for (const id of [bLeave, aLeave]) assert.equal((await api(`/leave/${id}/approve`, { method: "POST", cookie: a.cookie, body: {} })).status, 403, id);
    assert.equal((await api(`/leave/${bLeave}`, { cookie: admin })).body.status, "PENDING");
  });

  test("15. Admin and Super Admin can use admin routes (200)", async () => {
    for (const cookie of [admin, superAdmin]) {
      for (const [method, path] of ADMIN_ROUTES()) {
        const r = await api(path, { method, cookie });
        // Role management is Super Admin-only (SUPER_ADMIN_ONLY); every other admin route is shared.
        assert.equal(r.status, path.startsWith("/roles/") && cookie === admin ? 403 : 200, `${method} ${path}: ${r.text.slice(0, 120)}`);
      }
      assert.equal((await api(`/screenshots/${bShot}`, { cookie })).status, 200);
      assert.equal((await api(`/activity/summary?${RANGE}&employeeId=${b.id}`, { cookie })).status, 200);
    }
    const leave = await api("/leave", { method: "POST", cookie: b.cookie, body: { startDate: addDays(today, 30), endDate: addDays(today, 30), portion: "FULL_DAY" } });
    const ok = await api(`/leave/${leave.body.id}/approve`, { method: "POST", cookie: superAdmin, body: {} });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.status, "APPROVED");
  });
});

describe("employee web panel: identity and sessions", () => {
  test("11. spoofed headers and forged cookies never change identity", async () => {
    const spoof = { "x-role": "ADMIN", "x-platform-role": "SUPER_ADMIN", "x-employee-id": b.id, "x-user-id": b.id };
    assert.equal((await api("/employees", { cookie: a.cookie, headers: spoof })).status, 403);
    for (const path of [`/attendance/history?${RANGE}`, `/activity/summary?${RANGE}`, "/screenshots", "/leave", "/task-time/assignments"]) {
      const r = await api(path, { cookie: a.cookie, headers: spoof });
      assert.equal(r.status, 200, path);
      noB(r, `${path} (spoofed headers)`);
    }
    const me = await api("/auth/me", { cookie: a.cookie, headers: spoof });
    assert.equal(me.body.user.email, a.email);
    assert.equal(me.body.user.role, "EMPLOYEE");

    // Tamper with the access JWT payload (claim B's / an admin's identity) without the key.
    const access = /wf_access=([^;]+)/.exec(a.cookie)![1]!;
    const [h, p] = access.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    const bUser = String((await db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [b.id] })).rows[0]!.user_id);
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, sub: bUser, role: "ADMIN" })).toString("base64url");
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    for (const token of [`${h}.${forgedPayload}.${access.split(".")[2]}`, `${none}.${forgedPayload}.`, "garbage", ""]) {
      const r = await api("/auth/me", { cookie: `wf_access=${token}` });
      assert.equal(r.status, 401, `forged cookie ${token.slice(0, 20)}`);
      assert.equal((await api("/screenshots", { cookie: `wf_access=${token}` })).status, 401);
    }
  });

  test("12. logout, disabled account and garbage cookies: 401 on employee routes", async () => {
    const routes = [`/attendance/history?${RANGE}`, "/screenshots", "/leave", "/task-time/assignments", `/employees/${a.id}`];
    const c = await employee("Carol Panel");
    const old = c.cookie;
    assert.equal((await api("/leave", { cookie: old })).status, 200);
    assert.equal((await api("/auth/logout", { method: "POST", cookie: old })).status, 204);
    for (const path of routes) assert.equal((await api(path, { cookie: old })).status, 401, `after logout: ${path}`);
    assert.equal((await api("/auth/refresh", { method: "POST", cookie: old })).status, 401, "refresh cookie revoked too");

    const d = await employee("Dave Panel");
    assert.equal((await api(`/employees/${d.id}/status`, { method: "PATCH", cookie: admin, body: { status: "DISABLED" } })).status, 200);
    for (const path of routes) assert.equal((await api(path, { cookie: d.cookie })).status, 401, `disabled: ${path}`);
    assert.equal((await api("/auth/refresh", { method: "POST", cookie: d.cookie })).status, 401);

    for (const path of routes) {
      assert.equal((await api(path, { cookie: "wf_access=not.a.jwt" })).status, 401, `garbage: ${path}`);
      assert.equal((await api(path)).status, 401, `signed out: ${path}`);
    }
  });

  test("13. self-view off: own screenshot list/detail/content are 403; B's stays 404; on again: own only", async () => {
    await selfView(false);
    try {
      for (const path of ["/screenshots", `/screenshots/${aShot}`, `/screenshots/${aShot}/content`]) {
        const r = await api(path, { cookie: a.cookie });
        assert.equal(r.status, 403, path);
        assert.match(r.body.message, /does not allow employees to view screenshots/);
      }
      assert.equal((await api(`/screenshots/${bShot}`, { cookie: a.cookie })).status, 404);
      assert.equal((await api(`/screenshots/${aShot}/content`, { cookie: admin })).status, 200, "admins unaffected");
    } finally {
      await selfView(true);
    }
    const mine = await api("/screenshots", { cookie: a.cookie });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.items.map((i: { id: string }) => i.id), [aShot]);
    assert.equal((await api(`/screenshots/${bShot}/content`, { cookie: a.cookie })).status, 404);
  });
});

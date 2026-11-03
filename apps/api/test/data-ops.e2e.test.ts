// Data operations: atomic screenshot retention (per-chunk marks + run row), provider mismatch,
// normalized device times, timelapse access-log atomicity, report run reads and delivery ids,
// project timer start re-checks. In-process API, in-memory DB, local dev storage, synthetic data.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-dataops-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-dataops-videos-"));
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.SCREENSHOT_STORAGE = "local";
process.env.SCREENSHOT_LOCAL_DIR = STORAGE_DIR;
process.env.TIMELAPSE_DIR = VIDEO_DIR;
process.env.REPORT_MAIL_PROVIDER = "mock";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { SCREENSHOT_STORAGE, FILE_STORAGE, StorageError } = await import("../dist/screenshots/storage.js");
const { ScreenshotsService } = await import("../dist/screenshots/screenshots.service.js");
const { TimelapseService } = await import("../dist/screenshots/timelapse.service.js");
const { TIMELAPSE_ENCODER } = await import("../dist/screenshots/timelapse-encoder.js");
const { ReportsService } = await import("../dist/reports/reports.service.js");
const { ProjectsService } = await import("../dist/projects/projects.service.js");
const { DEFAULT_SCREENSHOT_NOTICE_VERSION } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const D = 86_400_000;
const M = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Rows = { rows: Record<string, unknown>[]; rowsAffected: number };
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<Rows> };

let app: INestApplication;
let base: string;
let db: Db;
let admin: string;
let adminId: string;
let caller: { id: string; role: string; email: string; sessionId: string };

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
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function fakeWebp(width: number, height: number, payload = 2000): Uint8Array {
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

let seq = 0;
async function employee() {
  const n = ++seq;
  const email = `ops${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: `OPS-${n}`, fullName: `Ops ${n}`, timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

/** Clocked in two hours ago, screenshot notice acknowledged before that; returns its device row and session. */
async function ready() {
  const e = await employee();
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 3 * 60 * M)] });
  const r = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 120 * M) }] } });
  assert.equal(r.body.results[0].status, "ACCEPTED", r.text);
  const ids = (await db.execute({ sql: "SELECT d.id AS device_id, s.id AS session_id FROM devices d JOIN attendance_sessions s ON s.employee_id = d.employee_id WHERE d.employee_id = ?", args: [e.id] })).rows[0]!;
  return { ...e, deviceId: String(ids.device_id), sessionId: String(ids.session_id) };
}
type Ready = Awaited<ReturnType<typeof ready>>;

const bytes = fakeWebp(1920, 1080);
/** A screenshot row written directly (bulk seeding); the file is put in storage for STORED LOCAL_DEV rows. */
async function seed(a: Ready, capturedAt: number, provider: "LOCAL_DEV" | "MICROSOFT_GRAPH" = "LOCAL_DEV") {
  const id = randomUUID();
  const key = `${a.id}/${iso(capturedAt).slice(0, 7)}/${id}.webp`;
  if (provider === "LOCAL_DEV") await app.get(SCREENSHOT_STORAGE).put(key, bytes);
  await db.execute({
    sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height,
            mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1920, 1080, 'image/webp', ?, ?, ?, ?, 'STORED', ?)`,
    args: [id, a.id, a.deviceId, a.sessionId, randomUUID(), iso(capturedAt), iso(capturedAt), bytes.length, sha(bytes), provider, key, iso(capturedAt)],
  });
  return { id, key };
}
async function policy(approved: boolean) {
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at)
          VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, ?, ?, 'test', ?, ?)`,
    args: [approved ? 1 : 0, DEFAULT_SCREENSHOT_NOTICE_VERSION, adminId, iso(Date.now() - 2 * D - seq)],
  });
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const r = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  caller = { id: adminId, role: "ADMIN", email: "admin@example.com", sessionId: randomUUID() };
  await policy(false);
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
});

describe("storage abstraction", () => {
  test("FILE_STORAGE and SCREENSHOT_STORAGE are the same injection token", () => {
    assert.equal(FILE_STORAGE, SCREENSHOT_STORAGE);
    assert.equal(app.get(FILE_STORAGE), app.get(SCREENSHOT_STORAGE));
  });
});

describe("screenshots", () => {
  test("device_captured_at is stored as ISO UTC (same instant), not the client's offset text", async () => {
    await policy(false);
    const a = await ready();
    const at = Date.now() - 30 * M;
    const local = new Date(at + 330 * M).toISOString().replace("Z", "+05:30"); // same instant, +05:30 offset
    const s = fakeWebp(1920, 1080, 2100);
    const r = await api("/screenshots/register", {
      method: "POST", bearer: a.bearer, device: a.device,
      body: { id: randomUUID(), sentAt: iso(Date.now()), capturedAt: local, width: 1920, height: 1080, sizeBytes: s.length, checksum: sha(s), mimeType: "image/webp" },
    });
    assert.equal(r.body.status, "REGISTERED", r.text);
    const row = (await db.execute({ sql: "SELECT device_captured_at FROM screenshots WHERE employee_id = ?", args: [a.id] })).rows[0]!;
    assert.equal(row.device_captured_at, iso(at));
  });

  test("retention: per-chunk marks and run rows stay consistent with a failing key; other-provider rows skipped and not readable", async () => {
    const a = await ready();
    const old = Date.now() - 40 * D;
    const rows = [];
    for (let i = 0; i < 105; i++) rows.push(await seed(a, old + i * M)); // more than one chunk (100)
    const foreign = await seed(a, old - M, "MICROSOFT_GRAPH");
    const failing = rows[37]!;

    // Another provider's row: a clear 409, no misleading read, no access-log row.
    const content = await api(`/screenshots/${foreign.id}/content`, { cookie: admin });
    assert.equal(content.status, 409, content.text);
    assert.match(content.body.message, /stored with MICROSOFT_GRAPH/);
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM screenshot_access_log WHERE screenshot_id = ?", args: [foreign.id] })).rows[0]!.n, 0);

    await policy(true);
    const storage = app.get(SCREENSHOT_STORAGE);
    const del = storage.delete.bind(storage);
    const deletedKeys: string[] = [];
    storage.delete = async (key: string) => {
      if (key === failing.key) throw new StorageError("Microsoft Graph delete failed (HTTP 503)");
      deletedKeys.push(key);
      return del(key);
    };
    const runsBefore = Number((await db.execute("SELECT count(*) AS n FROM screenshot_retention_runs")).rows[0]!.n);
    try {
      const result = await app.get(ScreenshotsService).retentionRun(null);
      assert.equal(result.failed, 1);
    } finally {
      storage.delete = del;
      await policy(false);
    }
    assert.ok(!deletedKeys.includes(foreign.key), "the other provider's file was never touched");

    const status = async (id: string) => (await db.execute({ sql: "SELECT upload_status FROM screenshots WHERE id = ?", args: [id] })).rows[0]!.upload_status;
    assert.equal(await status(failing.id), "STORED", "a failed storage delete leaves the row STORED");
    assert.equal(await status(foreign.id), "STORED", "another provider's row is skipped, not marked DELETED");
    const mine = (await db.execute({ sql: "SELECT upload_status, count(*) AS n FROM screenshots WHERE employee_id = ? AND captured_at < ? GROUP BY upload_status", args: [a.id, iso(Date.now() - 30 * D)] })).rows;
    assert.deepEqual(Object.fromEntries(mine.map((r) => [r.upload_status, Number(r.n)])), { DELETED: 104, STORED: 2 });

    // The run rows of this run add up exactly to what happened (one per chunk with work).
    const runs = (await db.execute({ sql: "SELECT deleted, failed FROM screenshot_retention_runs ORDER BY rowid LIMIT -1 OFFSET ?", args: [runsBefore] })).rows;
    assert.equal(runs.length, 2, "two chunks");
    assert.deepEqual([runs.reduce((n, r) => n + Number(r.deleted), 0), runs.reduce((n, r) => n + Number(r.failed), 0)], [104, 1]);
    // Every DELETED row's file is gone; the failing one's file is still there.
    for (const r of rows) assert.equal((await storage.stat(r.key)) === null, r !== failing, r.key);
  });
});

describe("timelapse access log", () => {
  test("create writes the job and its CREATE row together; concurrent cancels log one CANCEL", async () => {
    await policy(false);
    const a = await ready();
    for (let i = 0; i < 3; i++) await seed(a, Date.now() - (90 - i * 10) * M);
    const service = app.get(TimelapseService);
    const encoder = app.get(TIMELAPSE_ENCODER);
    const realEncode = encoder.encode;
    const realReason = (service as unknown as { encoderReason: string | null }).encoderReason;
    Object.assign(service, { encoderReason: null });
    // Never finishes on its own: stays RUNNING until cancelled.
    encoder.encode = (_frames: unknown, _out: string, o: { signal: AbortSignal }) =>
      new Promise<void>((_, reject) => o.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    try {
      const job = await service.create(caller, { sessionId: a.sessionId, fps: 8, confirm: false });
      const again = await service.create(caller, { sessionId: a.sessionId, fps: 8, confirm: false });
      assert.equal(again.id, job.id, "same active job");
      const logs = async (action: string) => Number((await db.execute({ sql: "SELECT count(*) AS n FROM timelapse_access_log WHERE timelapse_id = ? AND action = ?", args: [job.id, action] })).rows[0]!.n);
      assert.equal(await logs("CREATE"), 1);

      const results = await Promise.allSettled([service.cancel(caller, job.id), service.cancel(caller, job.id)]);
      assert.ok(results.every((r) => r.status === "fulfilled" ? r.value.status === "CANCELLED" : r.reason.status === 409), "both see it cancelled (or already finished)");
      assert.equal(await logs("CANCEL"), 1, "only the request that changed the status is logged");
      assert.equal((await service.job(job.id)).status, "CANCELLED");
    } finally {
      encoder.encode = realEncode;
      Object.assign(service, { encoderReason: realReason });
    }
  });
});

describe("reports", () => {
  test("delivery ids are UUIDs, one per current recipient; runs() returns only the selected schedule's runs", async () => {
    const reports = app.get(ReportsService);
    const a = await reports.create(caller, { name: "Ops A", frequency: "DAILY", timeZone: "UTC", includeProjects: false });
    const b = await reports.create(caller, { name: "Ops B", frequency: "DAILY", timeZone: "UTC", includeProjects: false });
    await reports.addRecipient(caller, a.id, adminId);
    await reports.addRecipient(caller, b.id, adminId);
    const runA = await reports.runNow(caller, a.id);
    const runB = await reports.runNow(caller, b.id);
    assert.equal((await reports.runNow(caller, a.id)).duplicate, true, "same period: same run, no second delivery");
    assert.equal(runA.run.deliveries.length, 1);
    assert.match(runA.run.deliveries[0].id, UUID);
    assert.equal(runA.run.deliveries[0].attempts.length, 1);
    const onlyA = await reports.runs(a.id);
    assert.deepEqual(onlyA.map((r: { id: string }) => r.id), [runA.run.id]);
    assert.deepEqual(onlyA[0].deliveries.map((d: { id: string }) => d.id), runA.run.deliveries.map((d: { id: string }) => d.id));
    const all = await reports.runs();
    assert.ok([runA.run.id, runB.run.id].every((id) => all.some((r: { id: string; deliveries: unknown[] }) => r.id === id && r.deliveries.length === 1)));
  });
});

describe("project timers", () => {
  const clockIn = (e: Emp) => api("/attendance/clock-in", { method: "POST", bearer: e.bearer, headers: { "x-device-id": e.device, "idempotency-key": randomUUID() } });
  async function project(code: string, member: Emp) {
    const p = await api("/projects", { method: "POST", cookie: admin, body: { code, name: `Project ${code}` } });
    assert.equal(p.status, 201, p.text);
    const t = await api(`/projects/${p.body.id}/tasks`, { method: "POST", cookie: admin, body: { title: "Work" } });
    assert.equal((await api(`/projects/${p.body.id}/members`, { method: "POST", cookie: admin, body: { employeeId: member.id } })).status, 201);
    return { id: p.body.id as string, taskId: t.body.tasks[0].id as string };
  }

  test("the start statement re-checks membership, project and task (a concurrent unassign/archive/close cannot slip in)", async () => {
    const e = await employee();
    assert.equal((await clockIn(e)).status, 200);
    const service = app.get(ProjectsService) as unknown as { startable: (employeeId: string, taskId: string) => Promise<string | null> };
    const realStartable = service.startable;
    const start = async (taskId: string, change: () => Promise<unknown>) => {
      // The pre-check passes, then the change lands before the INSERT (as from another request or instance).
      service.startable = async () => {
        service.startable = realStartable;
        await change();
        return null;
      };
      try {
        return await api("/task-time/start", { method: "POST", bearer: e.bearer, body: { taskId } });
      } finally {
        service.startable = realStartable;
      }
    };
    const entries = async () => Number((await db.execute({ sql: "SELECT count(*) AS n FROM task_time_entries WHERE employee_id = ?", args: [e.id] })).rows[0]!.n);

    const removed = await project("OPS-RM", e);
    const r1 = await start(removed.taskId, () => api(`/projects/${removed.id}/members/${e.id}`, { method: "DELETE", cookie: admin }));
    assert.equal(r1.status, 404, r1.text);

    const archived = await project("OPS-AR", e);
    const r2 = await start(archived.taskId, () => api(`/projects/${archived.id}`, { method: "PATCH", cookie: admin, body: { status: "ARCHIVED" } }));
    assert.deepEqual([r2.status, r2.body.message], [409, "This project is archived"]);

    const closed = await project("OPS-CL", e);
    const r3 = await start(closed.taskId, () => api(`/projects/${closed.id}/tasks/${closed.taskId}`, { method: "PATCH", cookie: admin, body: { status: "CLOSED" } }));
    assert.deepEqual([r3.status, r3.body.message], [409, "This task is closed"]);
    assert.equal(await entries(), 0, "no timer was started");

    // Assignments list only the caller's projects' open tasks; other projects' tasks are not loaded.
    const mine = await project("OPS-OK", e);
    const other = await employee();
    await project("OPS-OTHER", other);
    const list = (await api("/task-time/assignments", { bearer: e.bearer })).body;
    assert.deepEqual(list.map((p: { code: string; tasks: { id: string }[] }) => [p.code, p.tasks.map((t) => t.id)]), [["OPS-CL", []], ["OPS-OK", [mine.taskId]]]);
    assert.equal((await api("/task-time/start", { method: "POST", bearer: e.bearer, body: { taskId: mine.taskId } })).status, 200);
  });
});

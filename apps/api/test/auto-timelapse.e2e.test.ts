// F01 automatic daily timelapses (setting, scheduler tick with an injected clock, dedupe, retention)
// and AW-04 "last upload" on the admin-only screenshot settings. Fake encoder; synthetic frames only.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-auto-tl-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-auto-tl-videos-"));
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
const { TimelapseService } = await import("../dist/screenshots/timelapse.service.js");
const { TIMELAPSE_ENCODER } = await import("../dist/screenshots/timelapse-encoder.js");
const { addDays, DEFAULT_SCREENSHOT_SETTINGS, DEFAULT_SCREENSHOT_NOTICE_VERSION } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let service: { autoTick: (now?: number) => Promise<number>; pump: () => Promise<void> };

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; bearer?: string; device?: string };
async function api(path: string, { method = "GET", body, raw, cookie, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, text, res };
}
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Header-valid WebP (not decodable): enough for the job logic with the fake encoder. */
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

let seq = 0;
/** An employee (UTC) with a registered device and the notice acknowledged, clocked in 2 h ago, with `shots` stored screenshots, then clocked out. */
async function workedDay(shots: number) {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `auto${n}@example.com`, employeeCode: `AUTO-${n}`, fullName: `Auto ${n}`, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `auto${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID(), session: "", clockIn: Date.now() - 120 * M, shots: [] as string[] };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 180 * M)] });
  const sync = (type: string, at: number) => api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type, occurredAt: iso(at) }] } });
  assert.equal((await sync("CLOCK_IN", e.clockIn)).body.results[0].status, "ACCEPTED");
  const s = (await db.execute({ sql: "SELECT id, clock_in_at FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows[0]!;
  [e.session, e.clockIn] = [String(s.id), Date.parse(String(s.clock_in_at))];
  for (let i = 0; i < shots; i++) {
    const bytes = fakeWebp(1920, 1080, 1000 + ++seq);
    const id = randomUUID();
    const meta = { capturedAt: iso(Date.now() - (100 - i) * M), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp" };
    assert.equal((await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, sentAt: iso(Date.now()), ...meta } })).body.status, "REGISTERED");
    assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
    e.shots.push(String((await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0]!.id));
  }
  assert.equal((await sync("CLOCK_OUT", Date.now() - M)).body.results[0].status, "ACCEPTED");
  return e;
}
/** The first instant after the employee's (UTC) local day of clock-in. */
const dayEnd = (clockIn: number) => Date.parse(`${addDays(iso(clockIn).slice(0, 10), 1)}T00:00:00.000Z`);
const jobsOf = async (sessionId: string) =>
  (await db.execute({ sql: "SELECT id, status, automatic, requested_by, frames_total FROM timelapses WHERE attendance_session_id = ? ORDER BY created_at", args: [sessionId] })).rows;
const settings = (autoTimelapse: boolean, extra: object = {}) =>
  api("/settings/screenshots", { method: "PUT", cookie: admin, body: { ...DEFAULT_SCREENSHOT_SETTINGS, enabled: true, intervalSeconds: 60, autoTimelapse, reason: "test", ...extra } });

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  service = app.get(TimelapseService);
  const encoder = app.get(TIMELAPSE_ENCODER) as { encode: (frames: AsyncIterable<Uint8Array>, out: string) => Promise<void> };
  // Job logic only: concatenated frames stand in for the video whether or not FFmpeg is installed.
  Object.assign(service, { encoderReason: null });
  encoder.encode = async (frames, out) => {
    const parts: Uint8Array[] = [];
    for await (const f of frames) parts.push(f);
    await writeFile(out, Buffer.concat(parts));
  };
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const r = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  // Screenshots on since two days ago, so the synthetic captures (up to 100 min old) were allowed when taken.
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at)
          VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test', (SELECT id FROM users WHERE email = 'admin@example.com'), ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 2 * 86_400_000)],
  });
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
});

test("AW-04: admin screenshot settings report the last successful upload; employees cannot read it", async () => {
  const before = await api("/settings/screenshots", { cookie: admin });
  assert.equal(before.status, 200, before.text);
  assert.equal(before.body.lastUploadAt, null, "nothing stored yet");
  assert.equal(before.body.effective.autoTimelapse, false, "automatic videos are off by default");
  assert.equal((await settings(false)).status, 200);
  const e = await workedDay(2);
  const stored = (await db.execute("SELECT max(stored_at) AS at FROM screenshots")).rows[0]!.at;
  const after = await api("/settings/screenshots", { cookie: admin });
  assert.equal(after.body.lastUploadAt, stored);
  assert.ok(Date.now() - Date.parse(after.body.lastUploadAt) < 60_000);
  assert.equal((await api("/settings/screenshots", { bearer: e.bearer })).status, 403);
  const ready = await api("/ready");
  assert.ok(!ready.text.includes("lastUpload"), "the public readiness probe does not expose it");
  // Deleted (retention) afterwards: still the last upload, and never in an automatic video below.
  await db.execute({ sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ? WHERE attendance_session_id = ?", args: [iso(Date.now()), e.session] });
  assert.equal((await api("/settings/screenshots", { cookie: admin })).body.lastUploadAt, stored);
});

test("F01: off = nothing; on = one automatic job per finished session after the employee's day ends, once; deleted screenshots never", async () => {
  assert.equal((await settings(false)).status, 200);
  const e = await workedDay(3);
  const end = dayEnd(e.clockIn);
  assert.equal(await service.autoTick(end + 60 * M), 0, "setting off");
  assert.equal((await jobsOf(e.session)).length, 0);

  const on = await settings(true);
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.effective.autoTimelapse, true);
  assert.equal(on.body.history[1].autoTimelapse, false, "the previous version is kept unchanged");
  assert.equal(await service.autoTick(end - M), 0, "the employee's day has not ended");

  // One screenshot deleted under retention: never counted or read.
  // (a minute ago: a deletion at or after the video's creation would expire the video, by design)
  await db.execute({ sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ? WHERE id = ?", args: [iso(Date.now() - M), e.shots[0]] });
  assert.equal(await service.autoTick(end + 60 * M), 1);
  const [job] = await jobsOf(e.session);
  assert.equal(job!.automatic, 1);
  assert.equal(job!.frames_total, 2, "stored screenshots only");
  const adminId = String((await db.execute("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0]!.id);
  assert.equal(job!.requested_by, adminId, "attributed to the admin who turned it on");
  await service.pump();
  const view = await api(`/timelapses/${job!.id}`, { cookie: admin });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.body.status, "READY", view.text);
  assert.equal(view.body.automatic, true);
  assert.equal(view.body.framesDone, 2);
  const log = (await db.execute({ sql: "SELECT action, user_id FROM timelapse_access_log WHERE timelapse_id = ?", args: [job!.id] })).rows;
  assert.deepEqual(log.map((r) => ({ ...r })), [{ action: "CREATE", user_id: adminId }]);

  // Dedupe: later ticks (and a restart's re-check) never queue it again, even after the video expires.
  assert.equal(await service.autoTick(end + 120 * M), 0);
  await db.execute({ sql: "UPDATE timelapses SET status = 'EXPIRED' WHERE id = ?", args: [job!.id] });
  assert.equal(await service.autoTick(end + 180 * M), 0);
  assert.equal((await jobsOf(e.session)).length, 1);

  // Too few stored screenshots: skipped. Older than the look-back: skipped.
  const few = await workedDay(1);
  assert.equal(await service.autoTick(dayEnd(few.clockIn) + 60 * M), 0);
  const old = await workedDay(2);
  assert.equal(await service.autoTick(dayEnd(old.clockIn) + 4 * 86_400_000), 0, "only the last 3 days are checked");
  assert.equal(await service.autoTick(dayEnd(old.clockIn) + 60 * M), 1);
  await service.pump();
  await settings(false);
});

test("F01: a manual job already queued or ready for the session is not duplicated; the queue keeps a slot for admins", async () => {
  await settings(true);
  const e = await workedDay(2);
  const manual = await api("/timelapses", { method: "POST", cookie: admin, body: { sessionId: e.session, fps: 4 } });
  assert.equal(manual.status, 202, manual.text);
  await service.pump();
  assert.equal(await service.autoTick(dayEnd(e.clockIn) + 60 * M), 0, "a READY manual video counts");
  assert.deepEqual((await jobsOf(e.session)).map((j) => j.automatic), [0]);

  // Fill the queue to max - 1 with placeholders: nothing automatic is queued.
  const f = await workedDay(2);
  const g = await workedDay(2);
  const other = [await workedDay(0), await workedDay(0), await workedDay(0)];
  for (const o of other) {
    await db.execute({ sql: "INSERT INTO timelapses (id, employee_id, attendance_session_id, requested_by, fps, status, frames_total) VALUES (?, ?, ?, (SELECT id FROM users WHERE email = 'admin@example.com'), 8, 'QUEUED', 2)", args: [randomUUID(), o.id, o.session] });
  }
  Object.assign(service, { encoderReason: "paused for the test" }); // keep them queued
  assert.equal(await service.autoTick(dayEnd(f.clockIn) + 60 * M), 0, "encoder unavailable: nothing");
  Object.assign(service, { encoderReason: null });
  const pump = service.pump;
  Object.assign(service, { pump: async () => undefined });
  assert.equal(await service.autoTick(dayEnd(f.clockIn) + 60 * M), 0, "3 of 4 queued: the last slot stays free for admins");
  await db.execute("UPDATE timelapses SET status = 'CANCELLED', finished_at = 'x' WHERE status = 'QUEUED'");
  assert.equal(await service.autoTick(dayEnd(f.clockIn) + 60 * M), 2, "both sessions once the queue has room");
  Object.assign(service, { pump });
  await service.pump();
  for (const s of [f, g]) assert.equal((await jobsOf(s.session))[0]!.status, "READY");
  await settings(false);
});

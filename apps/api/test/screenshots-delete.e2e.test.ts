// Admin deletion of one screenshot (W33): permission, validation, storage first then the DELETED mark
// (who/when), idempotency, provider mismatch, storage failure, timelapse expiry, audit view.
// Synthetic, header-valid WebP bytes only; local storage in a temp dir; fake timelapse encoder.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-del-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-del-videos-"));
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
const { SCREENSHOT_STORAGE, StorageError } = await import("../dist/screenshots/storage.js");
const { DEFAULT_SCREENSHOT_NOTICE_VERSION } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let admin: string;
let adminId: string;
let storage: { delete: (key: string) => Promise<void> };

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
  return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, text };
}
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

let seq = 0;
async function employee() {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `del${n}@example.com`, employeeCode: `DEL-${n}`, fullName: `Delete ${n}`, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `del${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, userId: r.body.employee.userId as string, bearer: login.body.accessToken as string, device: randomUUID(), session: "" };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 3 * 60 * M)] });
  const c = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 120 * M) }] } });
  assert.equal(c.body.results[0].status, "ACCEPTED");
  e.session = String((await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows[0]!.id);
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

/** Registers (and, unless `upload` is false, uploads) a synthetic screenshot; returns the row. */
async function shot(e: Emp, minutesAgo: number, upload = true) {
  const bytes = fakeWebp(1920, 1080, 1000 + ++seq);
  const id = randomUUID();
  const meta = { capturedAt: iso(Date.now() - minutesAgo * M), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp" };
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, sentAt: iso(Date.now()), ...meta } });
  assert.equal(reg.body.status, "REGISTERED", reg.text);
  if (upload) assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  const row = (await db.execute({ sql: "SELECT id, storage_key FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0]!;
  return { id: String(row.id), key: String(row.storage_key), clientId: id, bytes };
}
const remove = (id: string, body: unknown = { reason: "Captured a private document" }, opts: Opts = { cookie: admin }) =>
  api(`/screenshots/${id}`, { method: "DELETE", body, ...opts });
const row = async (id: string) => (await db.execute({ sql: "SELECT upload_status, deleted_at, deleted_by, stored_at FROM screenshots WHERE id = ?", args: [id] })).rows[0]!;
const fileExists = (key: string) => existsSync(join(STORAGE_DIR, key));

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  storage = app.get(SCREENSHOT_STORAGE);
  const service = app.get(TimelapseService);
  const encoder = app.get(TIMELAPSE_ENCODER);
  Object.assign(service, { encoderReason: null });
  encoder.encode = async (frames: AsyncIterable<Uint8Array>, out: string) => {
    const parts: Uint8Array[] = [];
    for await (const f of frames) parts.push(f);
    await writeFile(out, Buffer.concat(parts));
  };
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', 'SUPER_ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at)
          VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test', ?, ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, adminId, iso(Date.now() - 2 * 86_400_000)],
  });
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
});

describe("DELETE /screenshots/:id (admin)", () => {
  test("admins only: signed out 401, employee 403 (even for their own screenshot); bad id 400; unknown 404", async () => {
    const e = await employee();
    const s = await shot(e, 50);
    assert.equal((await remove(s.id, { reason: "signed out" }, {})).status, 401);
    assert.equal((await remove(s.id, { reason: "my own" }, { bearer: e.bearer })).status, 403);
    assert.equal((await row(s.id)).upload_status, "STORED");
    assert.ok(fileExists(s.key));
    assert.equal((await remove("not-a-uuid")).status, 400);
    assert.equal((await remove(randomUUID())).status, 404);
  });

  test("reason is required, 3-500 characters, and no other fields are accepted", async () => {
    const e = await employee();
    const s = await shot(e, 50);
    assert.equal((await api(`/screenshots/${s.id}`, { method: "DELETE", cookie: admin })).status, 400, "no body");
    for (const body of [{}, { reason: "  a " }, { reason: "x".repeat(501) }, { reason: "valid reason", employeeId: e.id }, { reason: 42 }]) {
      const r = await remove(s.id, body);
      assert.equal(r.status, 400, `${String(JSON.stringify(body))}: ${r.text}`);
    }
    assert.equal((await row(s.id)).upload_status, "STORED");
  });

  test("deletes the file, then marks the row DELETED with who and when; content 410 afterwards; repeat is an idempotent 200", async () => {
    const e = await employee();
    const s = await shot(e, 50);
    const r = await remove(s.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.alreadyDeleted, false);
    assert.equal(r.body.screenshot.id, s.id);
    assert.equal(r.body.screenshot.uploadStatus, "DELETED");
    assert.equal(r.body.screenshot.employee.id, e.id);
    assert.ok(!JSON.stringify(r.body).includes(s.key), "no storage key in the response");
    const after = await row(s.id);
    assert.equal(after.upload_status, "DELETED");
    assert.equal(after.deleted_by, adminId);
    assert.equal(after.deleted_at, r.body.deletedAt);
    assert.ok(after.stored_at, "stored_at is kept");
    assert.ok(!fileExists(s.key), "file removed from storage");

    const content = await api(`/screenshots/${s.id}/content`, { cookie: admin });
    assert.equal(content.status, 410);
    assert.equal((await api(`/screenshots/${s.id}`, { cookie: admin })).body.uploadStatus, "DELETED", "metadata row kept");

    const again = await remove(s.id, { reason: "second click" });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyDeleted, true);
    assert.equal(again.body.deletedAt, r.body.deletedAt, "unchanged");
  });

  test("a REGISTERED screenshot (never uploaded) can be deleted; a later upload is refused (410), never stored", async () => {
    const e = await employee();
    const s = await shot(e, 50, false);
    const r = await remove(s.id);
    assert.equal(r.status, 200, r.text);
    assert.equal((await row(s.id)).upload_status, "DELETED");
    const up = await api(`/screenshots/${s.clientId}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: s.bytes });
    assert.equal(up.status, 410);
    assert.ok(!fileExists(s.key));
    assert.equal((await row(s.id)).upload_status, "DELETED");
  });

  test("storage failure: 502 and the row is unchanged (still STORED, file kept)", async () => {
    const e = await employee();
    const s = await shot(e, 50);
    const real = storage.delete;
    storage.delete = async () => {
      throw new StorageError("synthetic outage");
    };
    try {
      const r = await remove(s.id);
      assert.equal(r.status, 502, r.text);
    } finally {
      storage.delete = real;
    }
    const after = await row(s.id);
    assert.equal(after.upload_status, "STORED");
    assert.equal(after.deleted_at, null);
    assert.equal(after.deleted_by, null);
    assert.ok(fileExists(s.key));
  });

  test("stored with another provider: 409, nothing changed", async () => {
    const e = await employee();
    const s = await shot(e, 50);
    const src = (await db.execute({ sql: "SELECT * FROM screenshots WHERE id = ?", args: [s.id] })).rows[0]!;
    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at,
              width, height, mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1920, 1080, 'image/webp', 100, ?, 'MICROSOFT_GRAPH', ?, 'STORED', ?)`,
      args: [id, e.id, src.device_id, src.attendance_session_id, randomUUID(), iso(Date.now() - 40 * M), iso(Date.now() - 40 * M), "a".repeat(64), `graph/${id}.webp`, iso(Date.now())],
    });
    const r = await remove(id);
    assert.equal(r.status, 409, r.text);
    assert.equal((await row(id)).upload_status, "STORED");
  });

  test("a READY timelapse containing the screenshot is expired right away (file removed)", async () => {
    const e = await employee();
    const shots = [await shot(e, 30), await shot(e, 20)];
    let job = (await api("/timelapses", { method: "POST", cookie: admin, body: { sessionId: e.session, fps: 4 } })).body;
    for (let i = 0; i < 500 && ["QUEUED", "RUNNING"].includes(job.status); i++) {
      await new Promise((res) => setTimeout(res, 20));
      job = (await api(`/timelapses/${job.id}`, { cookie: admin })).body;
    }
    assert.equal(job.status, "READY");
    assert.ok(fileExists(`timelapses/${e.id}/${job.id}.mp4`), "video in file storage");
    assert.equal((await remove(shots[0]!.id)).status, 200);
    // Checked in the table (not through the timelapse API, which also sweeps): the delete itself expired it.
    const t = (await db.execute({ sql: "SELECT status FROM timelapses WHERE id = ?", args: [job.id] })).rows[0]!;
    assert.equal(t.status, "EXPIRED");
    assert.ok(!fileExists(`timelapses/${e.id}/${job.id}.mp4`));
    assert.equal((await api(`/timelapses/${job.id}/content`, { cookie: admin })).status, 410);
  });

  test("the unified audit view lists the deletion (actor, target, resource) with the stored reason", async () => {
    const e = await employee();
    const s = await shot(e, 50);
    assert.equal((await remove(s.id)).status, 200);
    const today = iso(Date.now()).slice(0, 10);
    const r = await api(`/audit?from=${today}&to=${today}&source=SCREENSHOT_DELETION&pageSize=200`, { cookie: admin });
    assert.equal(r.status, 200, r.text);
    const ev = r.body.items.find((x: { resource: { id: string } }) => x.resource.id === s.id);
    assert.ok(ev, "deletion listed");
    assert.equal(ev.action, "SCREENSHOT_DELETED");
    assert.equal(ev.actor.id, adminId);
    assert.equal(ev.target.userId, e.userId);
    assert.equal(ev.reason, "Captured a private document");
    assert.equal((await db.execute({ sql: "SELECT deleted_reason FROM screenshots WHERE id = ?", args: [s.id] })).rows[0]!.deleted_reason, "Captured a private document");
    assert.deepEqual(Object.keys(ev.details).sort(), ["capturedAt", "employeeId", "screenshotId"]);
    assert.ok(!JSON.stringify(ev).includes(s.key));
    // Scheduled retention (deleted_by NULL) is listed too, never as a person's deletion: no actor, its own action.
    const other = await shot(e, 40);
    await db.execute({ sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ? WHERE id = ?", args: [iso(Date.now()), other.id] });
    const again = await api(`/audit?from=${today}&to=${today}&source=SCREENSHOT_DELETION&pageSize=200`, { cookie: admin });
    const purged = again.body.items.filter((x: { resource: { id: string } }) => x.resource.id === other.id);
    assert.deepEqual(purged.map((x: { action: string; actor: unknown; reason: unknown; target: { userId: string }; details: { by: string } }) => [x.action, x.actor, x.reason, x.target.userId, x.details.by]),
      [["SCREENSHOT_DELETED_BY_RETENTION", null, null, e.userId, "SCHEDULED_RETENTION"]]);
    assert.equal(again.body.items.find((x: { resource: { id: string } }) => x.resource.id === s.id).action, "SCREENSHOT_DELETED", "the person's deletion is unchanged");
  });
});

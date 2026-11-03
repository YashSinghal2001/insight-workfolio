// Screenshot timelapses: authorization, eligibility, ordering, bad frames, limits, duplicate jobs,
// cancellation and cleanup, retention interaction — with a fake encoder (job logic) — and, when
// FFmpeg with libx264 is installed, a real encode of synthetic WebP frames (never real screenshots).
import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-timelapse-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-timelapse-videos-"));
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
const { TIMELAPSE_ENCODER, ffmpegArgs, ffmpegEncoder } = await import("../dist/screenshots/timelapse-encoder.js");
const { DEFAULT_SCREENSHOT_NOTICE_VERSION, TIMELAPSE_LIMITS } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
type Db = {
  execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }>;
  batch: (q: { sql: string; args: unknown[] }[], mode: string) => Promise<unknown>;
};
type Encoder = { probe: () => Promise<string | null>; encode: (frames: AsyncIterable<Uint8Array>, out: string, o: { signal: AbortSignal; fps: number }) => Promise<void> };

let app: INestApplication;
let base: string;
let db: Db;
let admin: string;
let service: { sweep: (now?: number) => Promise<void> };
let encoder: Encoder;
let realEncode: Encoder["encode"];
let ffmpegMissing: string | null;

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; bearer?: string; device?: string };
async function api(path: string, { method = "GET", body, raw, cookie, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const json = (res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : undefined;
  return { status: res.status, body: json, text, bytes, res };
}
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const today = () => iso(Date.now()).slice(0, 10);

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

/** Synthetic solid-colour WebP files (cwebp -q 80): 16:10, portrait and very wide. */
const REAL = {
  red: { w: 320, h: 200, rgb: [220, 30, 30], b64: "UklGRsgAAABXRUJQVlA4ILwAAABwEQCdASpAAcgAPm02mUmkIyKhICgAgA2JaW7hd2Ee3AAAE9gHvtk5D32ygZeLk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych76wAAP7/sXh//+xZy2BKD//+5wP+5wP+5wP4q3OcLkHWhQAAAAAAAAAAAA==" },
  green: { w: 100, h: 160, rgb: [30, 200, 40], b64: "UklGRmwAAABXRUJQVlA4IGAAAABQBwCdASpkAKAAPm02mUmkIyKhIIgAgA2JaW7hd1lwH4AAAeIIPbTmIKjntiLxBUc9sReIKjntiLxBUc9sReIKjneAAO3//zYEDND6YP//rK/mV/Mr/e7dOQpbigAAAAA=" },
  blue: { w: 240, h: 60, rgb: [30, 40, 220], b64: "UklGRmQAAABXRUJQVlA4IFgAAABwBgCdASrwADwAPm02mUmkIyKhIIgAgA2JaW7hdJlwAAE9tiLxBUc9sReIKjntiLxBUc9sReIKjntiLYAA/v7xL///cHH/YOP+wcfvW//XwBTxIAAAAAAA" },
};

let seq = 0;
/** An employee with a registered device, the notice acknowledged, clocked in two hours ago. */
async function employee() {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `tl${n}@example.com`, employeeCode: `TL-${n}`, fullName: `Timelapse ${n}`, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `tl${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID(), session: "" };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 3 * 60 * M)] });
  const c = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 120 * M) }] } });
  assert.equal(c.body.results[0].status, "ACCEPTED");
  e.session = String((await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows[0]!.id);
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

/** Registers and uploads through the real API; returns the server id. */
async function stored(e: Emp, minutesAgo: number, bytes: Uint8Array, width: number, height: number) {
  const id = randomUUID();
  const meta = { capturedAt: iso(Date.now() - minutesAgo * M), width, height, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp" };
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, sentAt: iso(Date.now()), ...meta } });
  assert.equal(reg.body.status, "REGISTERED", reg.text);
  assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  return (await db.execute({ sql: "SELECT id, storage_key FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0] as { id: string; storage_key: string };
}
const fake = (minutesAgo: number, e: Emp) => {
  const bytes = fakeWebp(1920, 1080, 1000 + (++seq % 500));
  return stored(e, minutesAgo, bytes, 1920, 1080).then((r) => ({ ...r, bytes }));
};

const create = (body: object, cookie = admin) => api("/timelapses", { method: "POST", cookie, body: { fps: 4, ...body } });
async function settle(id: string) {
  for (let i = 0; i < 1000; i++) {
    const r = await api(`/timelapses/${id}`, { cookie: admin });
    if (!["QUEUED", "RUNNING"].includes(r.body.status)) return r.body;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("timelapse did not finish");
}
/** Where a finished video is kept: the file storage (LocalDevStorage here), not the encoding folder. */
const storedVideo = (job: { id: string; employeeId: string }) => join(STORAGE_DIR, "timelapses", job.employeeId, `${job.id}.mp4`);
const leftovers = () => readdirSync(VIDEO_DIR).filter((f) => f.endsWith(".part"));

/** Writes the frames it receives, concatenated, as the "video": order and content are checkable. */
const concatEncoder: Encoder["encode"] = async (frames, out) => {
  const parts: Uint8Array[] = [];
  for await (const f of frames) parts.push(f);
  await writeFile(out, Buffer.concat(parts));
};
/** Writes a partial file, then waits until released or cancelled. */
function blockingEncoder() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const encode: Encoder["encode"] = async (frames, out, o) => {
    for await (const f of frames) void f;
    writeFileSync(out, "partial");
    await new Promise<void>((resolve, reject) => {
      void gate.then(resolve);
      if (o.signal.aborted) reject(new Error("aborted"));
      o.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  return { encode, release };
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  service = app.get(TimelapseService);
  encoder = app.get(TIMELAPSE_ENCODER);
  realEncode = encoder.encode;
  ffmpegMissing = await encoder.probe();
  // The job logic below runs with fake encoders whether or not FFmpeg is installed.
  Object.assign(service, { encoderReason: null });
  encoder.encode = concatEncoder;
  const adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const r = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
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

describe("timelapse (fake encoder: job logic, not real video)", () => {
  test("admins only; signed out 401; invalid and unknown ids; employee id cannot be supplied", async () => {
    const e = await employee();
    const q = `/timelapses?employeeId=${e.id}&from=${today()}&to=${today()}&tz=UTC`;
    assert.equal((await api(q)).status, 401);
    for (const [path, method] of [[q, "GET"], ["/timelapses", "POST"], [`/timelapses/${randomUUID()}`, "GET"], [`/timelapses/${randomUUID()}/content`, "GET"], [`/timelapses/${randomUUID()}/cancel`, "POST"], [`/timelapses/${randomUUID()}`, "DELETE"]] as const) {
      const r = await api(path, { method, bearer: e.bearer, body: method === "POST" ? { sessionId: e.session } : undefined });
      assert.equal(r.status, 403, `employee ${method} ${path}`);
    }
    assert.equal((await api("/timelapses/not-a-uuid", { cookie: admin })).status, 400);
    assert.equal((await api("/timelapses/not-a-uuid/content", { cookie: admin })).status, 400);
    assert.equal((await api(`/timelapses/${randomUUID()}`, { cookie: admin })).status, 404);
    assert.equal((await api(`/timelapses/${randomUUID()}/content`, { cookie: admin })).status, 404);
    assert.equal((await create({ sessionId: randomUUID() })).status, 404, "unknown session");
    assert.equal((await create({ sessionId: e.session, employeeId: randomUUID() })).status, 400, "no employee id in the request");
    for (const fps of [0, 31, 2.5]) assert.equal((await create({ sessionId: e.session, fps })).status, 400, `fps ${fps}`);
    assert.equal((await api(`/timelapses?from=${today()}&to=${today()}`, { cookie: admin })).status, 400, "employee required");
  });

  test("empty and single-screenshot sessions are refused with a clear reason", async () => {
    const e = await employee();
    const none = await create({ sessionId: e.session });
    assert.equal(none.status, 422);
    assert.match(none.body.message, /0 stored screenshot\(s\); at least 2/);
    await fake(50, e);
    assert.equal((await create({ sessionId: e.session })).status, 422);
  });

  test("frames in verified capture order (not upload order); other employees' screenshots never included; no paths exposed", async () => {
    const [e, other] = [await employee(), await employee()];
    const late = await fake(10, e);
    const early = await fake(90, e);
    const middle = await fake(50, e);
    await fake(70, other);
    const r = await create({ sessionId: e.session });
    assert.equal(r.status, 202, r.text);
    assert.equal(r.body.employeeId, e.id);
    assert.equal(r.body.framesTotal, 3);
    const job = await settle(r.body.id);
    assert.equal(job.status, "READY", job.error);
    assert.deepEqual([job.framesDone, job.framesSkipped, job.durationSeconds, job.width, job.height], [3, 0, 0.75, 1280, 720]);
    assert.ok(job.firstCapturedAt < job.lastCapturedAt);
    const video = await api(`/timelapses/${job.id}/content`, { cookie: admin });
    assert.equal(video.status, 200);
    assert.deepEqual(Buffer.from(video.bytes), Buffer.concat([early.bytes, middle.bytes, late.bytes]), "oldest capture first");
    assert.equal(video.res.headers.get("content-type"), "video/mp4");
    assert.equal(video.res.headers.get("cache-control"), "no-store, private, max-age=0");
    assert.equal(video.res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.match(video.res.headers.get("content-disposition")!, /^inline; filename="timelapse-/);
    assert.equal(video.res.headers.get("repr-digest"), `sha-256=:${createHash("sha256").update(video.bytes).digest("base64")}:`);
    assert.equal(job.sha256, sha(video.bytes));
    assert.equal(statSync(VIDEO_DIR).mode & 0o777, 0o700, "video directory owner-only");
    assert.equal(statSync(storedVideo(job)).mode & 0o777, 0o600, "stored video owner-only");
    assert.deepEqual(readdirSync(VIDEO_DIR), [], "nothing left in the encoding folder");
    const dl = await api(`/timelapses/${job.id}/content?download=true`, { cookie: admin });
    assert.match(dl.res.headers.get("content-disposition")!, /^attachment;/);
    const log = await db.execute({ sql: "SELECT action FROM timelapse_access_log WHERE timelapse_id = ? ORDER BY rowid", args: [job.id] });
    assert.deepEqual(log.rows.map((x) => x.action), ["CREATE", "VIEW", "DOWNLOAD"]);
    const list = await api(`/timelapses?employeeId=${e.id}&from=${today()}&to=${today()}&tz=UTC`, { cookie: admin });
    assert.equal(list.status, 200);
    assert.deepEqual([list.body.sessions.length, list.body.sessions[0].stored, list.body.sessions[0].latestJob.id], [1, 3, job.id]);
    assert.ok(!JSON.stringify([list.body, job]).includes(VIDEO_DIR) && !JSON.stringify(job).includes(STORAGE_DIR), "no paths");
  });

  test("missing, corrupt and deleted screenshots are left out; too few readable fails cleanly", async () => {
    const e = await employee();
    const shots = [await fake(100, e), await fake(80, e), await fake(60, e), await fake(40, e)];
    rmSync(join(STORAGE_DIR, shots[0]!.storage_key)); // missing from storage
    writeFileSync(join(STORAGE_DIR, shots[1]!.storage_key), Buffer.alloc(shots[1]!.bytes.length, 7)); // corrupt, same size
    await db.execute({ sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ? WHERE id = ?", args: [iso(Date.now() - M), shots[2]!.id] });
    const r = await create({ sessionId: e.session });
    assert.equal(r.body.framesTotal, 3, "deleted screenshots are not eligible");
    const job = await settle(r.body.id);
    assert.equal(job.status, "FAILED");
    assert.match(job.error, /Only 1 screenshot\(s\) could be read from storage \(2 unreadable\)/);
    assert.equal(job.framesSkipped, 2);
    assert.deepEqual(leftovers(), [], "partial file removed");
    assert.equal((await api(`/timelapses/${job.id}/content`, { cookie: admin })).status, 409);

    const extra = await fake(20, e);
    const retry = await create({ sessionId: e.session });
    assert.notEqual(retry.body.id, job.id, "retry is a new job");
    const ok = await settle(retry.body.id);
    assert.deepEqual([ok.status, ok.framesDone, ok.framesSkipped], ["READY", 2, 2]);
    const video = await api(`/timelapses/${ok.id}/content`, { cookie: admin });
    assert.deepEqual(Buffer.from(video.bytes), Buffer.concat([shots[3]!.bytes, extra.bytes]));
  });

  test("one job per session at a time; queue bounded; cancel removes the partial file", async () => {
    const block = blockingEncoder();
    encoder.encode = block.encode;
    try {
      const sessions: Emp[] = [];
      for (let i = 0; i < 6; i++) {
        const e = await employee();
        await fake(30, e);
        await fake(20, e);
        sessions.push(e);
      }
      const [a, b] = await Promise.all([create({ sessionId: sessions[0]!.session }), create({ sessionId: sessions[0]!.session })]);
      assert.equal(a.body.id, b.body.id, "concurrent requests share one job");
      for (let i = 1; i < 5; i++) assert.equal((await create({ sessionId: sessions[i]!.session })).status, 202);
      const full = await create({ sessionId: sessions[5]!.session });
      assert.equal(full.status, 429, `queue holds ${TIMELAPSE_LIMITS.maxQueued}`);

      for (let i = 0; i < 100 && !existsSync(join(VIDEO_DIR, `${a.body.id}.mp4.part`)); i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal((await api(`/timelapses/${a.body.id}`, { cookie: admin })).body.status, "RUNNING");
      const cancelled = await api(`/timelapses/${a.body.id}/cancel`, { method: "POST", cookie: admin });
      assert.equal(cancelled.body.status, "CANCELLED");
      assert.equal(cancelled.body.error, null);
      assert.ok(!existsSync(join(VIDEO_DIR, `${a.body.id}.mp4.part`)), "partial file deleted on cancel");
      assert.equal((await api(`/timelapses/${a.body.id}/cancel`, { method: "POST", cookie: admin })).status, 409, "already finished");

      // Cancelling a queued job, and deleting one, never leave it to run.
      const queued = (await create({ sessionId: sessions[5]!.session })).body.id;
      assert.equal((await api(`/timelapses/${queued}/cancel`, { method: "POST", cookie: admin })).body.status, "CANCELLED");
      const ids = await Promise.all([1, 2, 3, 4].map(async (i) => (await create({ sessionId: sessions[i]!.session })).body.id));
      for (const id of ids) assert.equal((await api(`/timelapses/${id}`, { method: "DELETE", cookie: admin })).status, 204);
      for (const id of ids) assert.equal((await settle(id)).status, "CANCELLED");
    } finally {
      block.release();
      encoder.encode = concatEncoder;
    }
    assert.deepEqual(leftovers(), []);
  });

  test("output size limit fails the job and removes the file", async () => {
    encoder.encode = async (frames, out) => {
      for await (const f of frames) void f;
      writeFileSync(out, "");
      truncateSync(out, TIMELAPSE_LIMITS.maxOutputBytes); // sparse: no real disk use
    };
    try {
      const e = await employee();
      await fake(30, e);
      await fake(20, e);
      const job = await settle((await create({ sessionId: e.session })).body.id);
      assert.equal(job.status, "FAILED");
      assert.match(job.error, /larger than 150 MB/);
      assert.deepEqual(readdirSync(VIDEO_DIR).filter((f) => f.startsWith(job.id)), []);
    } finally {
      encoder.encode = concatEncoder;
    }
  });

  test("large sessions need confirmation; over the frame limit is refused", async () => {
    const e = await employee();
    const device = (await db.execute({ sql: "SELECT device_id FROM attendance_sessions WHERE id = ?", args: [e.session] })).rows[0]!.device_id;
    const insert = (n: number, from: number) => db.batch(Array.from({ length: n }, (_, i) => ({
      sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height,
              mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1920, 1080, 'image/webp', 100, ?, 'LOCAL_DEV', ?, 'STORED', ?)`,
      args: [randomUUID(), e.id, device, e.session, randomUUID(), iso(Date.now() - 100 * M + (from + i) * 1000), iso(Date.now()), "0".repeat(64), `x/${randomUUID()}`, iso(Date.now())],
    })), "write");
    await insert(TIMELAPSE_LIMITS.confirmAboveFrames + 1, 0);
    const unconfirmed = await create({ sessionId: e.session });
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.body.message, /confirm/);
    await insert(TIMELAPSE_LIMITS.maxFrames - TIMELAPSE_LIMITS.confirmAboveFrames, 1000);
    const tooMany = await create({ sessionId: e.session, confirm: true });
    assert.equal(tooMany.status, 422);
    assert.match(tooMany.body.message, /the limit is 2000/);
  });

  test("retention: a deleted source screenshot or the time limit removes the video; orphans are swept", async () => {
    const e = await employee();
    const shots = [await fake(30, e), await fake(20, e)];
    const job = await settle((await create({ sessionId: e.session })).body.id);
    assert.equal(job.status, "READY");
    await db.execute({ sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ? WHERE id = ?", args: [iso(Date.now()), shots[0]!.id] });
    const gone = await api(`/timelapses/${job.id}/content`, { cookie: admin });
    assert.equal(gone.status, 410);
    assert.match(gone.body.message, /deleted \(by an administrator or under the retention policy\)/);
    assert.ok(!existsSync(storedVideo(job)));

    const f = await employee();
    await fake(30, f);
    await fake(20, f);
    const ttl = await settle((await create({ sessionId: f.session })).body.id);
    writeFileSync(join(VIDEO_DIR, "orphan.mp4.part"), "x");
    writeFileSync(join(VIDEO_DIR, "not-ours.txt"), "x");
    await service.sweep(Date.now() + 23 * 3_600_000);
    assert.equal((await api(`/timelapses/${ttl.id}`, { cookie: admin })).body.status, "READY", "kept until the time limit");
    assert.ok(!existsSync(join(VIDEO_DIR, "orphan.mp4.part")), "orphan removed");
    assert.ok(existsSync(join(VIDEO_DIR, "not-ours.txt")), "files the service did not create are never swept");
    rmSync(join(VIDEO_DIR, "not-ours.txt"));
    await service.sweep(Date.now() + 25 * 3_600_000);
    const expired = await api(`/timelapses/${ttl.id}`, { cookie: admin });
    assert.deepEqual([expired.body.status, expired.body.error], ["EXPIRED", "Expired after 24 h"]);
    assert.equal((await api(`/timelapses/${ttl.id}/content`, { cookie: admin })).status, 410);

    const g = await employee();
    await fake(30, g);
    await fake(20, g);
    const del = await settle((await create({ sessionId: g.session })).body.id);
    assert.equal((await api(`/timelapses/${del.id}`, { method: "DELETE", cookie: admin })).status, 204);
    assert.equal((await api(`/timelapses/${del.id}`, { cookie: admin })).body.status, "DELETED");
    assert.ok(!existsSync(storedVideo(del)));
    assert.equal((await api(`/timelapses/${del.id}`, { method: "DELETE", cookie: admin })).status, 204, "idempotent");

    // Retry after deletion, then "Create again": only the newest video of a session stays on disk.
    const first = await settle((await create({ sessionId: g.session })).body.id);
    const second = await settle((await create({ sessionId: g.session })).body.id);
    assert.deepEqual([first.status, second.status], ["READY", "READY"]);
    const replaced = (await api(`/timelapses/${first.id}`, { cookie: admin })).body;
    assert.deepEqual([replaced.status, replaced.error], ["EXPIRED", "Replaced by a newer video of the same session"]);
    assert.ok(!existsSync(storedVideo(first)));
    assert.ok(existsSync(storedVideo(second)));
  });

  test("restart: a job left encoding is marked failed and its partial file removed", async () => {
    const e = await employee();
    const id = randomUUID();
    const userId = (await db.execute("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0]!.id;
    await db.execute({ sql: "INSERT INTO timelapses (id, employee_id, attendance_session_id, requested_by, fps, status, frames_total) VALUES (?, ?, ?, ?, 4, 'RUNNING', 2)", args: [id, e.id, e.session, userId] });
    writeFileSync(join(VIDEO_DIR, `${id}.mp4.part`), "partial");
    await (service as unknown as { onModuleInit: () => Promise<void> }).onModuleInit(); // what a restart runs
    Object.assign(service, { encoderReason: null });
    const job = (await api(`/timelapses/${id}`, { cookie: admin })).body;
    assert.deepEqual([job.status, job.error], ["FAILED", "Interrupted because the server restarted. Create it again."]);
    assert.ok(!existsSync(join(VIDEO_DIR, `${id}.mp4.part`)));
  });

  test("encoder unavailable: creation refused with the reason", async () => {
    const e = await employee();
    await fake(30, e);
    await fake(20, e);
    Object.assign(service, { encoderReason: "FFmpeg is not installed on the API server (or FFMPEG_PATH is wrong)" });
    try {
      const r = await create({ sessionId: e.session });
      assert.equal(r.status, 503);
      assert.match(r.body.message, /FFmpeg is not installed/);
      const list = await api(`/timelapses?employeeId=${e.id}&from=${today()}&to=${today()}`, { cookie: admin });
      assert.deepEqual(list.body.encoder, { available: false, reason: "FFmpeg is not installed on the API server (or FFMPEG_PATH is wrong)" });
    } finally {
      Object.assign(service, { encoderReason: null });
    }
  });

  test("encoder arguments: fixed size, aspect ratio kept (fit + letterbox), frame rate, size cap", () => {
    const args = ffmpegArgs({ fps: 8, maxBytes: 1000 }, "/x/out.mp4");
    assert.ok(args.includes(`scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`));
    assert.deepEqual([args[args.indexOf("-framerate") + 1], args[args.indexOf("-r") + 1], args[args.indexOf("-fs") + 1], args[args.indexOf("-c:v") + 1]], ["8", "8", "1000", "libx264"]);
  });
});

describe("timelapse (real FFmpeg encode of synthetic frames)", () => {
  test("H.264 MP4: exact frame count and duration, capture order, aspect ratio kept", async (t) => {
    if (ffmpegMissing) return t.skip(ffmpegMissing);
    encoder.encode = realEncode;
    try {
      const e = await employee();
      // Uploaded out of capture order: blue (newest), red (oldest), green.
      for (const [name, ago] of [["blue", 10], ["red", 60], ["green", 30]] as const) {
        const f = REAL[name];
        await stored(e, ago, Buffer.from(f.b64, "base64"), f.w, f.h);
      }
      const r = await create({ sessionId: e.session, fps: 2 });
      const job = await settle(r.body.id);
      assert.equal(job.status, "READY", job.error);
      const video = await api(`/timelapses/${job.id}/content?download=true`, { cookie: admin });
      const file = join(VIDEO_DIR, "check.mp4");
      writeFileSync(file, video.bytes);
      try {
        const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames,pix_fmt:format=duration", "-of", "json", file], { encoding: "utf8" }));
        const s = probe.streams[0];
        assert.deepEqual([s.codec_name, s.width, s.height, s.nb_read_frames, s.pix_fmt], ["h264", 1280, 720, "3", "yuv420p"]);
        assert.equal(Number(probe.format.duration), 1.5, "3 frames at 2 fps");
        // One pixel per frame at the centre and near the left edge.
        const pixels = (x: number) => [...execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=2:2:${x}:359,scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])];
        const centre = pixels(639);
        const dominant = (i: number) => [0, 1, 2].reduce((a, c) => (centre[i * 3 + c]! > centre[i * 3 + a]! ? c : a), 0);
        assert.deepEqual([0, 1, 2].map(dominant), [0, 1, 2], "red, green, blue: capture order");
        const left = pixels(200);
        assert.ok(left[0]! > 150, "16:10 frame fills the width");
        assert.ok(Math.max(...left.slice(3, 6)) < 30, "portrait frame is pillarboxed (black), not stretched");
      } finally {
        rmSync(file, { force: true });
      }
    } finally {
      encoder.encode = concatEncoder;
    }
  });

  test("real encoder: timeout and cancellation kill FFmpeg", async (t) => {
    if (ffmpegMissing) return t.skip(ffmpegMissing);
    const real = ffmpegEncoder("ffmpeg");
    const out = join(VIDEO_DIR, "stuck.mp4.part");
    const never = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) };
    await assert.rejects(real.encode(never as AsyncIterable<Uint8Array>, out, { fps: 2, maxBytes: 1e6, timeoutMs: 300, signal: new AbortController().signal }), /took longer than/);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(real.encode(never as AsyncIterable<Uint8Array>, out, { fps: 2, maxBytes: 1e6, timeoutMs: 60_000, signal: ac.signal }));
    rmSync(out, { force: true });
    assert.equal(await ffmpegEncoder("/nonexistent/ffmpeg").probe(), "FFmpeg is not installed on the API server (or FFMPEG_PATH is wrong)");
  });
});

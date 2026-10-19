// Day 8: admin gallery, authorization and audit of metadata and image endpoints, secure delivery,
// cloud checksum validation, retention runs, and upload reliability (restart, interruption, credentials).
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-gallery-test-"));
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
const { SCREENSHOT_STORAGE, StorageError, quickXorHash } = await import("../dist/screenshots/storage.js");
const { DEFAULT_SCREENSHOT_NOTICE_VERSION, DEFAULT_SCREENSHOT_SETTINGS } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const D = 86_400_000;
const M = 60_000;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let admin: string;
let adminId: string;

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; bearer?: string; device?: string };
async function api(path: string, { method = "GET", body, raw, cookie, bearer, device }: Opts = {}, root = base) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${root}/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const json = (res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : undefined;
  return { status: res.status, body: json, text, bytes, res };
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
async function employee(root = base, cookie = admin) {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie, body: { email: `gal${n}@example.com`, employeeCode: `GAL-${n}`, fullName: `Gallery ${n}`, timezone: "UTC" } }, root);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } }, root);
  const login = await api("/auth/login", { method: "POST", body: { email: `gal${n}@example.com`, password: PASSWORD, client: "desktop" } }, root);
  const e = { id: r.body.employee.id as string, email: `gal${n}@example.com`, bearer: login.body.accessToken as string, device: randomUUID(), root };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } }, root);
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

/** Clocked in two hours ago with the screenshot notice acknowledged before that. */
async function ready() {
  const e = await employee();
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 3 * 60 * M)] });
  const r = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 120 * M) }] } });
  assert.equal(r.body.results[0].status, "ACCEPTED");
  return e;
}

function shot(at: number, payload = 2000) {
  const bytes = fakeWebp(1920, 1080, payload);
  return { id: randomUUID(), bytes, meta: { capturedAt: iso(at), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp" } };
}
type Shot = ReturnType<typeof shot>;
const register = (e: Emp, s: Shot) => api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id: s.id, sentAt: iso(Date.now()), ...s.meta } }, e.root);
const upload = (e: Emp, s: Shot) => api(`/screenshots/${s.id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: s.bytes }, e.root);
/** Registers and uploads; returns the server id. */
async function stored(e: Emp, at: number, database = db) {
  const s = shot(at, 2000 + (++seq % 500));
  assert.equal((await register(e, s)).body.status, "REGISTERED");
  assert.equal((await upload(e, s)).status, 200);
  return (await database.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [s.id] })).rows[0]!.id as string;
}
const settings = (patch: object, root = base, cookie = admin) =>
  api("/settings/screenshots", { method: "PUT", cookie, body: { ...DEFAULT_SCREENSHOT_SETTINGS, enabled: true, intervalSeconds: 60, reason: "test", ...patch } }, root);
const today = () => iso(Date.now()).slice(0, 10);
async function backdatedPolicy(database: Db) {
  await database.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at)
          VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test: backdated', (SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1), ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 2 * D)],
  });
}
async function boot() {
  const a = await NestFactory.create(AppModule, { logger: false });
  configureApp(a);
  await a.listen(0);
  return a;
}

before(async () => {
  app = await boot();
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const r = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await backdatedPolicy(db);
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe("gallery", () => {
  test("admin-only; filters by employee and date range; paginated newest first; real counts", async () => {
    const [a, b] = [await ready(), await ready()];
    const ids: string[] = [];
    for (let k = 0; k < 5; k++) ids.push(await stored(a, Date.now() - (100 - k * 10) * M));
    await stored(b, Date.now() - 50 * M);
    const pendingShot = shot(Date.now() - 30 * M);
    await register(a, pendingShot); // registered, never uploaded

    const q = (extra: string) => `/screenshots/gallery?from=${today()}&to=${today()}&tz=UTC${extra}`;
    assert.equal((await api(q(""), { bearer: a.bearer })).status, 403, "employees cannot open the gallery");
    assert.equal((await api(q("").replace("gallery", "overview"), { bearer: a.bearer })).status, 403);
    assert.equal((await api(q(""))).status, 401, "signed out");

    const all = await api(q("&pageSize=60"), { cookie: admin });
    assert.equal(all.status, 200, all.text);
    assert.ok(all.body.total >= 7);
    const mine = await api(q(`&employeeId=${a.id}&pageSize=2`), { cookie: admin });
    assert.equal(mine.body.total, 6, "five stored + one awaiting upload");
    assert.deepEqual(mine.body.items.map((i: { employee: { id: string } }) => i.employee.id), [a.id, a.id]);
    assert.equal(mine.body.items[0].uploadStatus, "REGISTERED", "newest first");
    const page2 = await api(q(`&employeeId=${a.id}&pageSize=2&page=2`), { cookie: admin });
    assert.deepEqual(mine.body.items[1].id, ids[4]);
    assert.deepEqual(page2.body.items.map((i: { id: string }) => i.id), [ids[3], ids[2]], "second page continues without overlap");
    assert.equal(page2.body.items[0].employee.fullName.startsWith("Gallery"), true);
    assert.ok(!("storageKey" in page2.body.items[0]) && !JSON.stringify(page2.body).includes(STORAGE_DIR), "no storage keys or paths");

    const yesterday = iso(Date.now() - D).slice(0, 10);
    assert.equal((await api(`/screenshots/gallery?from=${yesterday}&to=${yesterday}&employeeId=${a.id}`, { cookie: admin })).body.total, 0, "date filter");
    for (const bad of ["from=2026-10-13&to=2026-10-12", "from=2026-08-01&to=2026-10-01", `from=${today()}&to=${today()}&tz=Mars/Base`, `from=${today()}&to=${today()}&pageSize=500`]) {
      assert.equal((await api(`/screenshots/gallery?${bad}`, { cookie: admin })).status, 400, bad);
    }

    const ov = await api(`/screenshots/overview?from=${today()}&to=${today()}&employeeId=${a.id}`, { cookie: admin });
    assert.deepEqual([ov.body.total, ov.body.stored, ov.body.awaitingUpload, ov.body.stalled, ov.body.deleted], [6, 5, 1, 0, 0]);
    assert.ok(ov.body.latestCapturedAt && ov.body.latestStoredAt);
    assert.deepEqual([ov.body.retention.approved, ov.body.retention.deletionMode], [false, "LOCAL_DEV"]);
  });
});

describe("screenshot authorization and delivery", () => {
  test("metadata and image: admin and owner only; every access audited; safe headers; self-view policy", async () => {
    const [a, b] = [await ready(), await ready()];
    const id = await stored(a, Date.now() - 60 * M);

    // Metadata endpoint.
    const asOwner = await api(`/screenshots/${id}`, { bearer: a.bearer });
    assert.equal(asOwner.status, 200);
    assert.equal(asOwner.body.accessLog, undefined, "the access log is for admins");
    assert.equal((await api(`/screenshots/${id}`, { bearer: b.bearer })).status, 404, "no cross-employee access");
    assert.equal((await api(`/screenshots/${randomUUID()}`, { cookie: admin })).status, 404);
    assert.equal((await api(`/screenshots/not-a-uuid`, { cookie: admin })).status, 400);

    // Binary endpoint.
    assert.equal((await api(`/screenshots/${id}/content`)).status, 401, "unauthenticated");
    assert.equal((await api(`/screenshots/${id}/content`, { bearer: b.bearer })).status, 404, "other employee");
    assert.equal((await api(`/screenshots/${id}/content?variant=original`, { cookie: admin })).status, 400);
    const full = await api(`/screenshots/${id}/content`, { cookie: admin });
    assert.equal(full.status, 200);
    const h = (k: string) => full.res.headers.get(k);
    assert.deepEqual(
      [h("content-type"), h("cache-control"), h("pragma"), h("x-content-type-options"), h("content-security-policy"), h("cross-origin-resource-policy"), h("content-length")],
      ["image/webp", "no-store, private, max-age=0", "no-cache", "nosniff", "default-src 'none'; sandbox", "same-site", String(full.bytes.length)],
    );
    assert.equal(h("content-disposition"), `inline; filename="screenshot-${id}.webp"`);
    assert.equal((await api(`/screenshots/${id}/content?variant=thumbnail`, { cookie: admin })).status, 200);
    assert.equal((await api(`/screenshots/${id}/content`, { bearer: a.bearer })).status, 200, "owner (self-view allowed by default)");

    const detail = await api(`/screenshots/${id}`, { cookie: admin });
    assert.deepEqual(
      detail.body.accessLog.map((l: { action: string; viewer: { id: string } }) => [l.action, l.viewer.id === adminId]).sort(),
      [["THUMBNAIL", true], ["VIEW", false], ["VIEW", true]],
      "viewer, action and time recorded for each successful access; refused attempts are not",
    );
    assert.ok(detail.body.accessLog.every((l: { accessedAt: string }) => !Number.isNaN(Date.parse(l.accessedAt))));

    // Self-view switched off: the employee loses list, metadata and image access; admins keep it.
    await settings({ employeeSelfView: false });
    assert.equal((await api(`/screenshots/${id}/content`, { bearer: a.bearer })).status, 403);
    assert.equal((await api(`/screenshots/${id}`, { bearer: a.bearer })).status, 403);
    assert.equal((await api("/screenshots", { bearer: a.bearer })).status, 403);
    assert.equal((await api("/screenshots/me", { bearer: a.bearer })).body.employeeSelfView, false);
    assert.equal((await api(`/screenshots/${id}/content`, { cookie: admin })).status, 200);
    await settings({});
  });

  test("a stored file that fails validation is not delivered, and errors reveal no paths", async () => {
    const a = await ready();
    const id = await stored(a, Date.now() - 70 * M);
    const key = (await db.execute({ sql: "SELECT storage_key FROM screenshots WHERE id = ?", args: [id] })).rows[0]!.storage_key as string;
    writeFileSync(join(STORAGE_DIR, key), "<html><script>alert(1)</script></html>");
    const r = await api(`/screenshots/${id}/content`, { cookie: admin });
    assert.equal(r.status, 502);
    assert.equal(r.res.headers.get("content-type")?.startsWith("application/json"), true, "never served as an image or HTML");
    assert.ok(!r.text.includes(STORAGE_DIR) && !r.text.includes(key), r.text);
    rmSync(join(STORAGE_DIR, key));
    const missing = await api(`/screenshots/${id}/content`, { cookie: admin });
    assert.equal(missing.status, 502);
    assert.ok(!missing.text.includes(key));
  });
});

describe("cloud confirmation and reliability", () => {
  test("upload is STORED only if the provider's content hash matches; credential failures are retryable", async () => {
    const a = await ready();
    const storage = app.get(SCREENSHOT_STORAGE);
    const stat = storage.stat.bind(storage);
    const s = shot(Date.now() - 80 * M);
    await register(a, s);
    storage.stat = async (key: string) => ({ ...(await stat(key))!, quickXorHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    assert.equal((await upload(a, s)).status, 502, "provider hash differs: not complete");
    const status = async () => (await db.execute({ sql: "SELECT upload_status FROM screenshots WHERE idempotency_key = ?", args: [s.id] })).rows[0]!.upload_status;
    assert.equal(await status(), "REGISTERED");
    storage.stat = stat;

    const put = storage.put.bind(storage);
    storage.put = async () => {
      throw new StorageError("Microsoft identity platform token request failed (HTTP 401)");
    };
    const denied = await upload(a, s);
    assert.equal(denied.status, 502);
    assert.doesNotMatch(denied.text, /401|token|identity/, "credential details stay on the server");
    storage.put = put;
    assert.equal((await upload(a, s)).status, 200, "retry succeeds once credentials work");
    assert.equal(await status(), "STORED");

    // Two concurrent uploads of the same screenshot: both succeed, one stored file.
    const t = shot(Date.now() - 90 * M);
    await register(a, t);
    const [u1, u2] = await Promise.all([upload(a, t), upload(a, t)]);
    assert.deepEqual([u1.body.status, u2.body.status], ["STORED", "STORED"]);
  });

  test("an interrupted upload leaves the screenshot registered and a later upload completes it", async () => {
    const a = await ready();
    const s = shot(Date.now() - 100 * M);
    await register(a, s);
    const url = new URL(`${base}/api/v1/screenshots/${s.id}/content`);
    await new Promise<void>((resolve) => {
      const req = request(url, {
        method: "PUT",
        headers: { "content-type": "image/webp", "content-length": String(s.bytes.length), authorization: `Bearer ${a.bearer}`, "x-device-id": a.device, origin: ORIGIN },
      });
      req.on("error", () => resolve());
      req.on("response", (res) => (res.resume(), resolve()));
      req.write(s.bytes.subarray(0, 500));
      setTimeout(() => req.destroy(), 100); // connection drops mid-body
    });
    const row = async () => (await db.execute({ sql: "SELECT upload_status FROM screenshots WHERE idempotency_key = ?", args: [s.id] })).rows[0]!.upload_status;
    assert.equal(await row(), "REGISTERED");
    assert.equal((await upload(a, s)).status, 200);
    assert.equal(await row(), "STORED");
  });

});

describe("retention runs", () => {
  test("dry run, gated, run log with deletion mode; failures retried; expired unuploaded screenshots are never reported stored", async () => {
    const a = await ready();
    const s = shot(Date.now() - 30 * M);
    await register(a, s);
    await upload(a, s);
    const base = (await db.execute({ sql: "SELECT device_id, attendance_session_id FROM screenshots WHERE idempotency_key = ?", args: [s.id] })).rows[0]!;
    const seedOld = async (status: "STORED" | "REGISTERED", clientId = randomUUID()) => {
      const id = randomUUID();
      const key = `${a.id}/2026-01/${id}.webp`;
      if (status === "STORED") await app.get(SCREENSHOT_STORAGE).put(key, s.bytes);
      await db.execute({
        sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height,
                mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1920, 1080, 'image/webp', ?, ?, 'LOCAL_DEV', ?, ?, ?)`,
        args: [id, a.id, base.device_id, base.attendance_session_id, clientId, iso(Date.now() - 40 * D), iso(Date.now() - 40 * D), s.bytes.length, s.meta.checksum, key, status, status === "STORED" ? iso(Date.now() - 40 * D) : null],
      });
      return { id, key, clientId };
    };
    const [old1, old2] = [await seedOld("STORED"), await seedOld("STORED")];
    const unuploaded = await seedOld("REGISTERED");

    const preview = await api("/screenshots/retention", { cookie: admin });
    assert.ok(preview.body.eligible >= 3);
    assert.equal((await api("/screenshots/retention/run", { method: "POST", cookie: admin, body: { confirm: true } })).status, 409, "approval gate");
    assert.equal(preview.body.runs.length, 0, "nothing ran");

    await settings({ retentionApproved: true });
    const storage = app.get(SCREENSHOT_STORAGE);
    const del = storage.delete.bind(storage);
    storage.delete = async (key: string) => {
      if (key === old2.key) throw new StorageError("Microsoft Graph delete failed (HTTP 503)");
      return del(key);
    };
    const run1 = await api("/screenshots/retention/run", { method: "POST", cookie: admin, body: { confirm: true } });
    assert.equal(run1.status, 200, run1.text);
    assert.equal(run1.body.failed, 1);
    const st = async (id: string) => (await db.execute({ sql: "SELECT upload_status, deleted_by FROM screenshots WHERE id = ?", args: [id] })).rows[0]!;
    assert.deepEqual([(await st(old1.id)).upload_status, (await st(old2.id)).upload_status, (await st(unuploaded.id)).upload_status], ["DELETED", "STORED", "DELETED"]);
    assert.equal((await st(old1.id)).deleted_by, adminId);
    const [r1] = run1.body.runs;
    assert.deepEqual([r1.deleted, r1.failed, r1.deletionMode, r1.triggeredBy.id], [2, 1, "LOCAL_DEV", adminId]);

    storage.delete = del;
    const run2 = await api("/screenshots/retention/run", { method: "POST", cookie: admin, body: { confirm: true } });
    assert.deepEqual([run2.body.failed, run2.body.runs[0].deleted, (await st(old2.id)).upload_status], [0, 1, "DELETED"], "retried next run");
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM screenshots WHERE id IN (?, ?, ?)", args: [old1.id, old2.id, unuploaded.id] })).rows[0]!.n, 3, "metadata rows kept");

    // The desktop still holds the never-uploaded one: it must learn it was not stored.
    assert.equal((await api(`/screenshots/${unuploaded.clientId}/content`, { method: "PUT", bearer: a.bearer, device: a.device, raw: s.bytes })).status, 410);
    const re = await api("/screenshots/register", { method: "POST", bearer: a.bearer, device: a.device, body: { id: unuploaded.clientId, sentAt: iso(Date.now()), ...s.meta } });
    assert.deepEqual([re.body.status, re.body.reason], ["REJECTED", "Deleted under the screenshot retention policy"]);
    await settings({});
  });

  test("QuickXorHash matches hand-computed values (the hash SharePoint reports)", () => {
    const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
    const zero = Array(20).fill(0);
    assert.equal(quickXorHash(new Uint8Array()), b64(zero));
    const one = [...zero];
    one[0] = 1;
    one[12] = 1; // length 1, little-endian, XORed into the last 8 bytes
    assert.equal(quickXorHash(new Uint8Array([1])), b64(one));
    // Byte 145 lands at bit 155 (145 × 11 mod 160) and wraps around the 160-bit ring.
    const data = new Uint8Array(146);
    data[145] = 0xff;
    const wrap = [...zero];
    wrap[19] = 0xf8; // bits 155..159
    wrap[0] = 0x07; // bits 0..2
    wrap[12] = 146;
    assert.equal(quickXorHash(data), b64(wrap));
  });
});

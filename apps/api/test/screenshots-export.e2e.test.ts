// W3-TIMELINE: bulk screenshot export (Super Admin only, access-logged, audited, capped, streamed STORE zip) and the
// gallery idle marker (captured inside an IDLE activity interval) with its `idle=true` filter.
// Synthetic, header-valid WebP bytes only; local storage in a temp dir.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-export-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-export-videos-"));
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
const { SCREENSHOT_STORAGE, StorageError } = await import("../dist/screenshots/storage.js");
const { DEFAULT_SCREENSHOT_NOTICE_VERSION, SCREENSHOT_EXPORT_LIMITS } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let superAdmin: string;
let superAdminId: string;
let plainAdmin: string;

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; bearer?: string; device?: string };
async function call(path: string, { method = "GET", body, raw, cookie, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  return fetch(`${base}/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
}
async function api(path: string, opts: Opts = {}) {
  const res = await call(path, opts);
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

async function login(email: string, client?: "desktop") {
  const res = await call("/auth/login", { method: "POST", body: { email, password: PASSWORD, ...(client && { client }) } });
  return client ? ((await res.json()) as { accessToken: string }).accessToken : res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let seq = 0;
async function employee() {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: superAdmin, body: { email: `exp${n}@example.com`, employeeCode: `EXP-${n}`, fullName: `Export ${n}`, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const e = { code: `EXP-${n}`, id: r.body.employee.id as string, userId: r.body.employee.userId as string, bearer: await login(`exp${n}@example.com`, "desktop"), device: randomUUID(), session: "", deviceRow: "" };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 3 * 60 * M)] });
  const c = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 120 * M) }] } });
  assert.equal(c.body.results[0].status, "ACCEPTED");
  e.session = String((await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows[0]!.id);
  e.deviceRow = String((await db.execute({ sql: "SELECT id FROM devices WHERE employee_id = ?", args: [e.id] })).rows[0]!.id);
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

async function shot(e: Emp, minutesAgo: number, upload = true) {
  const bytes = fakeWebp(1920, 1080, 1000 + ++seq);
  const id = randomUUID();
  const capturedAt = iso(Date.now() - minutesAgo * M);
  const meta = { capturedAt, width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp" };
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, sentAt: iso(Date.now()), ...meta } });
  assert.equal(reg.body.status, "REGISTERED", reg.text);
  if (upload) assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  const row = (await db.execute({ sql: "SELECT id, storage_key, captured_at FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0]!;
  return { id: String(row.id), key: String(row.storage_key), capturedAt: String(row.captured_at), bytes };
}

/** Synthetic activity interval stored directly (the sync path is covered by activity tests). */
async function interval(e: Emp, kind: "ACTIVE" | "IDLE", fromMinAgo: number, toMinAgo: number) {
  const [s, en] = [iso(Date.now() - fromMinAgo * M), iso(Date.now() - toMinAgo * M)];
  await db.execute({
    sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_name, started_at, ended_at, active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DESKTOP_MACOS', ?, ?, ?)`,
    args: [randomUUID(), e.id, e.deviceRow, e.session, kind, kind === "ACTIVE" ? "Editor" : null, s, en, kind === "ACTIVE" ? (fromMinAgo - toMinAgo) * 60 : 0, kind === "IDLE" ? (fromMinAgo - toMinAgo) * 60 : 0, s, iso(Date.now()), randomUUID()],
  });
}

/** Entries of a STORE zip via its central directory. */
function unzip(zip: Buffer) {
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  let p = zip.readUInt32LE(eocd + 16);
  return Array.from({ length: zip.readUInt16LE(eocd + 10) }, () => {
    const [size, nameLen, local] = [zip.readUInt32LE(p + 20), zip.readUInt16LE(p + 28), zip.readUInt32LE(p + 42)];
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString();
    p += 46 + nameLen;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    return { name, data: zip.subarray(start, start + size) };
  });
}

const exportZip = (ids: string[], opts: Opts = { cookie: superAdmin }) => call("/screenshots/export", { method: "POST", body: { ids }, ...opts });
const accessRows = async (id: string) => (await db.execute({ sql: "SELECT user_id, action FROM screenshot_access_log WHERE screenshot_id = ?", args: [id] })).rows;
const exportAudits = async () => (await db.execute("SELECT actor_user_id, metadata FROM account_audit WHERE action = 'SCREENSHOTS_EXPORTED' ORDER BY created_at, id")).rows;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  superAdminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'super@example.com', 'ADMIN', 'SUPER_ADMIN', ?)", args: [superAdminId, await hashPassword(PASSWORD)] });
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  superAdmin = await login("super@example.com");
  plainAdmin = await login("admin@example.com");
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at)
          VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test', ?, ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, superAdminId, iso(Date.now() - 2 * 86_400_000)],
  });
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
});

describe("POST /screenshots/export", () => {
  test("Super Admin only: signed out 401; plain admin, team head and employee 403 (nothing logged); validation 400", async () => {
    const e = await employee();
    const head = await employee();
    const s = await shot(e, 50);
    const team = await api("/teams", { method: "POST", cookie: superAdmin, body: { name: "Export team", headUserId: head.userId } });
    assert.equal((await api(`/teams/${team.body.id}/members`, { method: "PUT", cookie: superAdmin, body: { employeeIds: [e.id] } })).status, 200);
    assert.equal((await exportZip([s.id], {})).status, 401);
    assert.equal((await exportZip([s.id], { cookie: plainAdmin })).status, 403);
    assert.equal((await exportZip([s.id], { bearer: head.bearer })).status, 403);
    assert.equal((await exportZip([s.id], { bearer: e.bearer })).status, 403, "not even their own");
    assert.equal((await accessRows(s.id)).length, 0);
    for (const body of [{}, { ids: [] }, { ids: ["nope"] }, { ids: [s.id, s.id] }, { ids: [s.id], from: "2026-11-01" }]) {
      assert.equal((await call("/screenshots/export", { method: "POST", cookie: superAdmin, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await exportZip(Array.from({ length: SCREENSHOT_EXPORT_LIMITS.maxItems + 1 }, () => randomUUID()))).status, 400, "count cap");
    assert.equal((await exportZip([s.id, randomUUID()])).status, 404, "an unknown id fails the whole export");
    assert.equal((await accessRows(s.id)).length, 0);
    assert.equal((await exportAudits()).length, 0);
  });

  test("streams a valid zip: names carry no paths or storage keys, bytes intact; one access-log row per file and one audit row", async () => {
    const a = await employee();
    const b = await employee();
    const shots = [await shot(a, 40), await shot(a, 30), await shot(b, 20)];
    const res = await exportZip(shots.map((s) => s.id).reverse());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="screenshots-\d{4}-\d{2}-\d{2}\.zip"$/);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    // Chronological (whatever the request order), flat names: employee code, UTC capture time, id.
    const owners = [a, a, b];
    assert.equal(files.length, 3);
    for (const [i, s] of shots.entries()) {
      const f = files[i]!;
      assert.equal(f.name, `screenshot-${owners[i]!.code}-${s.capturedAt.replace(/[:.]/g, "-")}-${s.id}.webp`);
      assert.ok(!f.name.includes("/") && !f.name.includes(s.key), "no directories or storage keys");
      assert.deepEqual(f.data, Buffer.from(s.bytes));
      assert.deepEqual((await accessRows(s.id)).map((r) => [r.user_id, r.action]), [[superAdminId, "VIEW"]]);
    }
    const audits = await exportAudits();
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actor_user_id, superAdminId);
    assert.deepEqual(JSON.parse(String(audits[0]!.metadata)), {
      count: 3,
      bytes: shots.reduce((n, s) => n + s.bytes.length, 0),
      employees: 2,
      screenshotIds: shots.map((s) => s.id).join(","),
      screenshotIdsOmitted: 0,
    });
  });

  test("refuses screenshots not stored (409) and selections over the size cap (413) before logging anything", async () => {
    const e = await employee();
    const stored = await shot(e, 40);
    const pending = await shot(e, 30, false);
    const before = (await exportAudits()).length;
    assert.equal((await exportZip([stored.id, pending.id])).status, 409);
    const max = SCREENSHOT_EXPORT_LIMITS.maxBytes;
    (SCREENSHOT_EXPORT_LIMITS as { maxBytes: number }).maxBytes = stored.bytes.length - 1;
    try {
      assert.equal((await exportZip([stored.id])).status, 413);
    } finally {
      (SCREENSHOT_EXPORT_LIMITS as { maxBytes: number }).maxBytes = max;
    }
    assert.equal((await accessRows(stored.id)).length, 0);
    assert.equal((await exportAudits()).length, before);
  });
});

describe("export failures are never a valid-looking archive", () => {
  test("storage fails on the first file: 502 JSON; on a later file: the connection is aborted (body read fails)", async () => {
    const e = await employee();
    const shots = [await shot(e, 40), await shot(e, 30), await shot(e, 20)];
    const storage = app.get(SCREENSHOT_STORAGE) as { get: (key: string) => Promise<Uint8Array> };
    const real = storage.get.bind(storage);
    const failOn = async (key: string) => {
      storage.get = async (k: string) => {
        if (k === key) throw new StorageError("synthetic outage");
        return real(k);
      };
    };
    try {
      await failOn(shots[0]!.key);
      const first = await exportZip(shots.map((s) => s.id));
      assert.equal(first.status, 502);
      assert.match(await first.text(), /storage is unavailable/i);
      await failOn(shots[1]!.key);
      const later = await exportZip(shots.map((s) => s.id));
      assert.equal(later.status, 200, "headers were already sent");
      await assert.rejects(later.arrayBuffer(), "the body must not complete");
    } finally {
      storage.get = real;
    }
    assert.equal((await exportZip(shots.map((s) => s.id))).status, 200, "recovers");
  });

  test("audit row lists at most 40 ids and counts the rest", async () => {
    const e = await employee();
    const shots = [];
    for (let i = 0; i < 42; i++) shots.push(await shot(e, 100 - i * 2));
    const res = await exportZip(shots.map((s) => s.id));
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    const meta = JSON.parse(String((await exportAudits()).at(-1)!.metadata));
    assert.equal(meta.count, 42);
    assert.equal(meta.screenshotIds.split(",").length, 40);
    assert.equal(meta.screenshotIdsOmitted, 2);
    for (const s of shots) assert.equal((await accessRows(s.id)).length, 1, "every file is in the access log");
  });
});

describe("gallery idle marker", () => {
  test("idle = captured inside an IDLE interval; `idle=true` filters (gallery and overview); no activity data = not idle", async () => {
    const e = await employee();
    await interval(e, "ACTIVE", 60, 45);
    await interval(e, "IDLE", 45, 25);
    const active = await shot(e, 50);
    const idle = await shot(e, 35);
    const edge = await shot(e, 25); // the IDLE interval ends exactly here: not idle
    const unknown = await shot(e, 10); // no activity data
    const q = `from=${iso(Date.now() - 70 * M).slice(0, 10)}&to=${iso(Date.now()).slice(0, 10)}&tz=UTC&employeeId=${e.id}`; // any time of day
    const g = await api(`/screenshots/gallery?${q}`, { cookie: plainAdmin });
    assert.equal(g.status, 200, g.text);
    const byId = new Map(g.body.items.map((i: { id: string; idle: boolean }) => [i.id, i.idle]));
    assert.deepEqual([active, idle, edge, unknown].map((s) => byId.get(s.id)), [false, true, false, false]);
    const only = await api(`/screenshots/gallery?${q}&idle=true`, { cookie: plainAdmin });
    assert.deepEqual(only.body.items.map((i: { id: string }) => i.id), [idle.id]);
    assert.equal(only.body.total, 1);
    assert.equal((await api(`/screenshots/overview?${q}&idle=true`, { cookie: plainAdmin })).body.total, 1);
    assert.equal((await api(`/screenshots/gallery?${q}&idle=maybe`, { cookie: plainAdmin })).status, 400);
    assert.equal((await api(`/screenshots/${idle.id}`, { cookie: plainAdmin })).body.idle, true, "detail carries it too");
  });
});

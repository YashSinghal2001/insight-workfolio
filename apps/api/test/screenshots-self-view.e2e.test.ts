// F08 employee screenshot access (in-process API, local storage, header-valid fake WebP files; no
// real screenshots). Employees use the existing routes: GET /screenshots (list), GET /screenshots/:id
// (detail) and GET /screenshots/:id/content. Identity comes from the session; self-view is the
// organization switch; every image request is logged.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-selfview-"));
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
const { DEFAULT_SCREENSHOT_NOTICE_VERSION, DEFAULT_SCREENSHOT_SETTINGS } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let admin: string;
let adminId: string;

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; bearer?: string; device?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, raw, cookie, bearer, device, headers: extra = {} }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...extra };
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

const MASKS = [
  { x: 0, y: 0, w: 2500, h: 1000, label: "Menu bar clock" },
  { x: 7000, y: 9000, w: 3000, h: 1000, label: "Chat notifications" },
];
const RECTS = MASKS.map(({ x, y, w, h }) => ({ x, y, w, h }));

let seq = 0;
async function employee() {
  const n = ++seq;
  const email = `self${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: `SELF-${n}`, fullName: `Self ${n}`, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, userId: login.body.user?.id as string | undefined, bearer: login.body.accessToken as string, device: randomUUID() };
  e.userId = String((await db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [e.id] })).rows[0]!.user_id);
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 5 * 60 * M)] });
  const c = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 180 * M) }] } });
  assert.equal(c.body.results[0].status, "ACCEPTED");
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

/** Registers and uploads one screenshot; returns the server id and bytes. */
async function stored(e: Emp, minutesAgo: number, masks: object[] = []) {
  const bytes = fakeWebp(1920, 1080, 1000 + (++seq % 700));
  const id = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, sentAt: iso(Date.now()), capturedAt: iso(Date.now() - minutesAgo * M), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp", masks } });
  assert.equal(reg.body.status, "REGISTERED", reg.text);
  assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  return { id: String((await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0]!.id), bytes };
}
const selfView = (on: boolean) =>
  db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, employee_self_view, reason, changed_by) VALUES (1, ?, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, ?, 'test: self-view', ?)`,
    args: [JSON.stringify(MASKS), DEFAULT_SCREENSHOT_NOTICE_VERSION, on ? 1 : 0, adminId],
  });
const logRows = async (screenshotId: string) =>
  (await db.execute({ sql: "SELECT user_id, action FROM screenshot_access_log WHERE screenshot_id = ? ORDER BY rowid", args: [screenshotId] })).rows.map((r) => `${r.user_id}:${r.action}`);

let a: Emp;
let b: Emp;
let aShots: { id: string; bytes: Uint8Array }[];
let bShot: { id: string; bytes: Uint8Array };

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
  // Masks (and self-view) in force since two days ago, so every capture below was taken under them.
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, ?, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test', ?, ?)`,
    args: [JSON.stringify(MASKS), DEFAULT_SCREENSHOT_NOTICE_VERSION, adminId, iso(Date.now() - 2 * 86_400_000)],
  });
  [a, b] = [await employee(), await employee()];
  aShots = [await stored(a, 100, RECTS), await stored(a, 80, RECTS), await stored(a, 60, RECTS)];
  bShot = await stored(b, 90, RECTS);
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe("employee screenshot self-view (in-process API)", () => {
  test("identity comes from the session: each employee lists only their own; other employees' ids are refused", async () => {
    const mine = await api("/screenshots", { bearer: a.bearer });
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual(mine.body.items.map((i: { id: string }) => i.id), [...aShots].reverse().map((s) => s.id), "newest first, only A's");
    assert.ok(mine.body.items.every((i: { employeeId: string }) => i.employeeId === a.id));
    assert.deepEqual((await api("/screenshots", { bearer: b.bearer })).body.items.map((i: { id: string }) => i.id), [bShot.id]);

    assert.equal((await api(`/screenshots?employeeId=${b.id}`, { bearer: a.bearer })).status, 404, "another employee's id");
    assert.equal((await api(`/screenshots?employeeId=${randomUUID()}`, { bearer: a.bearer })).status, 404, "unknown id");
    assert.equal((await api("/screenshots?employeeId=not-a-uuid", { bearer: a.bearer })).status, 400);
    assert.equal((await api(`/screenshots?employeeId=${a.id}`, { bearer: a.bearer })).body.total, 3, "own id is allowed");
    // Look-alike parameters and headers are ignored: still the caller's own list.
    for (const q of [`employee_id=${b.id}`, `userId=${b.userId}`, `employee=${b.id}`]) {
      const r = await api(`/screenshots?${q}`, { bearer: a.bearer });
      assert.deepEqual([r.status, r.body.total, r.body.items[0].employeeId], [200, 3, a.id], q);
    }
    const spoof = await api("/screenshots", { bearer: a.bearer, headers: { "x-employee-id": b.id, "x-user-id": b.userId! } });
    assert.equal(spoof.body.items[0].employeeId, a.id, "identity headers are ignored");
    assert.equal((await api("/screenshots")).status, 401, "signed out");
  });

  test("another employee's screenshot is not found by id; employees cannot use admin gallery or timelapses", async () => {
    for (const path of [`/screenshots/${bShot.id}`, `/screenshots/${bShot.id}/content`, `/screenshots/${bShot.id}/content?variant=thumbnail`, `/screenshots/${randomUUID()}`, `/screenshots/${randomUUID()}/content`]) {
      assert.equal((await api(path, { bearer: a.bearer })).status, 404, path);
    }
    assert.equal((await api("/screenshots/not-a-uuid/content", { bearer: a.bearer })).status, 400);
    assert.deepEqual(await logRows(bShot.id), [], "refused requests are not logged as views");
    const today = iso(Date.now()).slice(0, 10);
    assert.equal((await api(`/screenshots/gallery?from=${today}&to=${today}`, { bearer: a.bearer })).status, 403);
    const session = (await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ?", args: [a.id] })).rows[0]!.id;
    assert.equal((await api("/timelapses", { method: "POST", bearer: a.bearer, body: { sessionId: session } })).status, 403, "even for their own session");
    assert.equal((await api(`/screenshots/${aShots[0]!.id}/content`, { method: "PUT", bearer: a.bearer, device: a.device, raw: aShots[0]!.bytes })).status, 404, "a stored screenshot cannot be replaced (server id is not an upload id)");
    assert.equal((await api(`/screenshots/${aShots[0]!.id}`, { method: "DELETE", bearer: a.bearer, body: { reason: "my own screenshot" } })).status, 403, "deleting is admin-only, even for their own screenshot");
  });

  test("own screenshots: exact bytes, no-store headers, mask labels from the policy at capture; no storage internals; views logged", async () => {
    const s = aShots[0]!;
    const detail = await api(`/screenshots/${s.id}`, { bearer: a.bearer });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.maskCount, 2);
    assert.deepEqual(detail.body.masks, MASKS, "labels of the masks blacked out in this image");
    assert.equal(detail.body.accessLog, undefined, "employees do not see the access log");
    const json = JSON.stringify(detail.body);
    for (const leak of ["storage_key", "storageKey", "checksum", STORAGE_DIR, ".webp", "user_id"]) assert.ok(!json.includes(leak), leak);

    const full = await api(`/screenshots/${s.id}/content`, { bearer: a.bearer });
    const thumb = await api(`/screenshots/${s.id}/content?variant=thumbnail`, { bearer: a.bearer });
    assert.deepEqual(Buffer.from(full.bytes), Buffer.from(s.bytes));
    assert.deepEqual(Buffer.from(thumb.bytes), Buffer.from(s.bytes));
    assert.equal(full.res.headers.get("cache-control"), "no-store, private, max-age=0");
    assert.equal(full.res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.deepEqual(await logRows(s.id), [`${a.userId}:VIEW`, `${a.userId}:VIEW`], "each image request logged with the employee's account, as what was served (the full image)");
    await api(`/screenshots?pageSize=1`, { bearer: a.bearer });
    await api(`/screenshots/${s.id}`, { bearer: a.bearer });
    assert.equal((await logRows(s.id)).length, 2, "metadata requests are not image views");
    const adminView = await api(`/screenshots/${s.id}`, { cookie: admin });
    assert.deepEqual(adminView.body.accessLog.map((l: { viewer: { id: string }; action: string }) => `${l.viewer.id}:${l.action}`).sort(), [`${a.userId}:VIEW`, `${a.userId}:VIEW`], "admins see the employee's own views");
    assert.deepEqual(adminView.body.masks, MASKS);
  });

  test("deleted (retention) screenshots stay listed as deleted but the image is gone and not logged", async () => {
    const s = aShots[1]!;
    await db.execute({ sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ? WHERE id = ?", args: [iso(Date.now()), s.id] });
    const item = (await api("/screenshots", { bearer: a.bearer })).body.items.find((i: { id: string }) => i.id === s.id);
    assert.equal(item.uploadStatus, "DELETED");
    for (const v of ["", "?variant=thumbnail"]) assert.equal((await api(`/screenshots/${s.id}/content${v}`, { bearer: a.bearer })).status, 410, v);
    assert.deepEqual(await logRows(s.id), []);
  });

  test("self-view off: every employee route refuses with 403, even for their own screenshots; admins unaffected", async () => {
    await selfView(false);
    try {
      const s = aShots[2]!;
      for (const path of ["/screenshots", `/screenshots?employeeId=${a.id}`, `/screenshots/${s.id}`, `/screenshots/${s.id}/content`, `/screenshots/${s.id}/content?variant=thumbnail`]) {
        const r = await api(path, { bearer: a.bearer });
        assert.equal(r.status, 403, path);
        assert.match(r.body.message, /does not allow employees to view screenshots/);
      }
      assert.equal((await api(`/screenshots/${bShot.id}`, { bearer: a.bearer })).status, 404, "others' ids stay indistinguishable from missing");
      assert.deepEqual(await logRows(s.id), [], "nothing served, nothing logged");
      assert.equal((await api("/screenshots/me", { bearer: a.bearer })).body.employeeSelfView, false, "the desktop learns it is off");
      assert.equal((await api(`/screenshots/${s.id}/content`, { cookie: admin })).status, 200, "admins still can");
    } finally {
      await selfView(true);
    }
    assert.equal((await api(`/screenshots/${aShots[2]!.id}/content`, { bearer: a.bearer })).status, 200, "on again: allowed");
  });
});

describe("settings round trip used by the desktop", () => {
  test("PUT with employeeSelfView false is honored by the employee routes", async () => {
    const put = await api("/settings/screenshots", { method: "PUT", cookie: admin, body: { ...DEFAULT_SCREENSHOT_SETTINGS, enabled: true, intervalSeconds: 60, maskRegions: MASKS, employeeSelfView: false, reason: "test" } });
    assert.equal(put.status, 200, put.text);
    assert.equal((await api("/screenshots", { bearer: b.bearer })).status, 403);
    await api("/settings/screenshots", { method: "PUT", cookie: admin, body: { ...DEFAULT_SCREENSHOT_SETTINGS, enabled: true, intervalSeconds: 60, maskRegions: MASKS, employeeSelfView: true, reason: "test" } });
    assert.equal((await api("/screenshots", { bearer: b.bearer })).status, 200);
  });
});

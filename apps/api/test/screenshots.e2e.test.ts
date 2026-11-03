// Day 7: screenshot policy, consent, metadata registration, brokered upload, access control and retention.
// Own app instance (own in-memory database and storage directory): settings are global.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-screenshots-test-"));
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
const { ScreenshotsService, webpSize } = await import("../dist/screenshots/screenshots.service.js");
const { SCREENSHOT_STORAGE, StorageError } = await import("../dist/screenshots/storage.js");
const { DEFAULT_NOTICE_VERSION, DEFAULT_SCREENSHOT_NOTICE_VERSION, DEFAULT_SCREENSHOT_SETTINGS } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const D = 86_400_000;
const M = 60_000;

let app: INestApplication;
let base: string;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let db: Db;
let admin: string;

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; type?: string; cookie?: string; bearer?: string; device?: string };
async function api(path: string, { method = "GET", body, raw, type, cookie, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = type ?? "image/webp";
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

/** A structurally valid WebP container (VP8L header with the given size); the API never decodes pixels. */
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
  for (let i = 25; i < b.length; i++) b[i] = (i * 31) & 0xff;
  return b;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let seq = 0;
async function employee() {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `shot${n}@example.com`, employeeCode: `SHOT-${n}`, fullName: `Shot ${n}`, timezone: "Asia/Kolkata" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `shot${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;
const consentAt = (employeeId: string, version: string, at: number) =>
  db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), employeeId, version, iso(at)] });
async function attendance(e: Emp, events: [string, number][]) {
  const r = await api("/attendance/sync", {
    method: "POST", bearer: e.bearer, device: e.device,
    body: { sentAt: iso(Date.now()), events: events.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) },
  });
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
}
const settings = (patch: object) =>
  api("/settings/screenshots", { method: "PUT", cookie: admin, body: { ...DEFAULT_SCREENSHOT_SETTINGS, reason: "test", ...patch } });

function shot(at: number, { width = 1920, height = 1080, payload = 2000 } = {}) {
  const bytes = fakeWebp(width, height, payload);
  return { id: randomUUID(), bytes, meta: { capturedAt: iso(at), width, height, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp" } };
}
type Shot = ReturnType<typeof shot>;
const register = (e: Emp, s: Shot, device = e.device) =>
  api("/screenshots/register", { method: "POST", bearer: e.bearer, device, body: { id: s.id, sentAt: iso(Date.now()), ...s.meta } });
const upload = (e: Emp, s: Shot, raw = s.bytes, type?: string) =>
  api(`/screenshots/${s.id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw, type });

/** Employee clocked in an hour ago, screenshot notice acknowledged two hours ago. */
async function ready() {
  const e = await employee();
  await consentAt(e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, Date.now() - 2 * 60 * M);
  await attendance(e, [["CLOCK_IN", Date.now() - 60 * M]]);
  return e;
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const r = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe("screenshot policy and consent", () => {
  test("off by default; admin-only, validated settings with history; the storage adapter is reported", async () => {
    const e = await employee();
    const status = await api("/screenshots/me", { bearer: e.bearer });
    assert.equal(status.status, 200);
    assert.equal(status.body.policy.enabled, false, "screenshots are off until an admin turns them on");
    assert.equal(status.body.notice.version, DEFAULT_SCREENSHOT_NOTICE_VERSION);
    assert.match(status.body.notice.points.join(" "), /sensitive information/, "the notice warns that screenshots may contain sensitive data");
    assert.equal(status.body.storageProvider, "LOCAL_DEV");

    assert.equal((await api("/settings/screenshots", { bearer: e.bearer })).status, 403);
    assert.equal((await api("/settings/screenshots", { method: "PUT", bearer: e.bearer, body: { ...DEFAULT_SCREENSHOT_SETTINGS, reason: "x" } })).status, 403);
    for (const [patch, field] of [
      [{ intervalSeconds: 5 }, "intervalSeconds"], [{ webpQuality: 99 }, "webpQuality"], [{ captureScope: "ALL_DISPLAYS" }, "captureScope"],
      [{ retentionDays: 3 }, "retentionDays"], [{ noticeVersion: "missing" }, "noticeVersion"], [{ blurRadius: 8 }, "body"],
    ] as const) {
      const r = await settings(patch);
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.ok(r.text.includes(field), `${field}: ${r.text}`);
    }
    // Policies apply from their effective time; captures in later tests are backdated, so the
    // first "on" period starts two days ago (inserted directly: the table is append-only).
    await db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
              retention_approved, notice_version, reason, changed_by, effective_at)
            VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test: backdated', (SELECT id FROM users WHERE email = 'admin@example.com'), ?)`,
      args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 2 * D)],
    });
    const r = await settings({ enabled: true, intervalSeconds: 60 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.effective.enabled, r.body.effective.intervalSeconds, r.body.history.length], [true, 60, 2]);
    assert.equal((await api("/screenshots/me", { bearer: e.bearer })).body.policy.intervalSeconds, 60);
  });

  test("capture is accepted only while enabled, after the screenshot notice, inside clocked-in non-break time", async () => {
    await settings({ enabled: true, intervalSeconds: 60 });
    const e = await employee();
    const now = Date.now();
    // Activity consent alone is not screenshot consent.
    await consentAt(e.id, DEFAULT_NOTICE_VERSION, now - 3 * 60 * M);
    await attendance(e, [["CLOCK_IN", now - 60 * M], ["BREAK_START", now - 30 * M], ["BREAK_END", now - 20 * M]]);
    const before = await register(e, shot(now - 50 * M));
    assert.deepEqual([before.body.status, before.body.reason], ["REJECTED", `Captured before the required screenshot notice (${DEFAULT_SCREENSHOT_NOTICE_VERSION}) was acknowledged`]);
    assert.equal((await api("/screenshots/consent", { method: "POST", bearer: e.bearer, body: { noticeVersion: DEFAULT_NOTICE_VERSION } })).status, 400, "the activity notice is not the screenshot notice");
    const ack = await api("/screenshots/consent", { method: "POST", bearer: e.bearer, body: { noticeVersion: DEFAULT_SCREENSHOT_NOTICE_VERSION } });
    assert.ok(ack.body.consent.acknowledgedAt);
    const later = await register(e, shot(now - 50 * M));
    assert.equal(later.body.status, "REJECTED", "a capture from before the acknowledgement stays rejected");

    const e2 = await ready();
    const t = Date.now();
    await attendance(e2, [["BREAK_START", t - 30 * M], ["BREAK_END", t - 20 * M]]);
    assert.equal((await register(e2, shot(t - 70 * M))).body.reason, "Captured outside clocked-in time (before clock-in, during a break or after clock-out)", "before clock-in");
    assert.equal((await register(e2, shot(t - 25 * M))).body.status, "REJECTED", "during the break");
    const ok = shot(t - 40 * M);
    const first = await register(e2, ok);
    assert.equal(first.body.status, "REGISTERED", first.text);
    assert.equal((await register(e2, ok)).body.status, "REGISTERED", "duplicate registration is idempotent");
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM screenshots WHERE idempotency_key = ?", args: [ok.id] })).rows[0]!.n, 1);
    assert.match((await register(e2, shot(t - 40 * M + 10_000))).body.reason, /Too soon after another screenshot \(the interval in force is 60 s\)/);
    assert.match((await register(e2, shot(t - 15 * M, { width: 3000, height: 1000 }))).body.reason, /maximum resolution/);
    assert.equal((await register(e2, shot(t + 10 * M))).body.reason, "Captured in the future");

    await attendance(e2, [["CLOCK_OUT", t - 5 * M]]);
    assert.equal((await register(e2, shot(t - 2 * M))).body.status, "REJECTED", "after clock-out");
    assert.equal((await register(e2, shot(t - 10 * M))).body.status, "REGISTERED", "before clock-out, after the break");

    const e3 = await ready();
    await settings({ enabled: false, intervalSeconds: 60 });
    assert.equal((await register(e3, shot(Date.now() + 1_000))).body.reason, "Screenshots were turned off by the organization at that time");
    const off = await register(e3, shot(Date.now() - 8 * M));
    assert.equal(off.body.status, "REGISTERED", "captured while enabled: judged by the policy at capture time, not now");
    await settings({ enabled: true, intervalSeconds: 60 });
  });

  test("a new screenshot notice version must be acknowledged before captures after the change", async () => {
    await settings({ enabled: true, intervalSeconds: 60 });
    const e = await ready();
    const beforeChange = Date.now() - 3 * M;
    await api("/settings/monitoring/notices", { method: "POST", cookie: admin, body: { version: "shots-v2", title: "Screenshots v2", points: ["Updated wording."], draft: true } });
    await settings({ enabled: true, intervalSeconds: 60, noticeVersion: "shots-v2" });
    const status = await api("/screenshots/me", { bearer: e.bearer });
    assert.deepEqual([status.body.notice.version, status.body.consent.acknowledgedAt], ["shots-v2", null], "employee must re-acknowledge");
    assert.equal((await register(e, shot(beforeChange))).body.status, "REGISTERED", "offline capture from before the change: the v1 acknowledgement applied then");
    const after = await register(e, shot(Date.now()));
    assert.match(after.body.reason, /shots-v2/);
    await api("/screenshots/consent", { method: "POST", bearer: e.bearer, body: { noticeVersion: "shots-v2" } });
    assert.equal((await register(e, shot(Date.now() + 2_000))).body.status, "REGISTERED");
    const history = await api("/activity/consents", { bearer: e.bearer });
    assert.deepEqual(history.body.items.map((c: { noticeVersion: string }) => c.noticeVersion), ["shots-v2", DEFAULT_SCREENSHOT_NOTICE_VERSION]);
    await settings({ enabled: true, intervalSeconds: 60 });
  });
});

describe("screenshot upload", () => {
  test("bytes are verified against the registration; STORED only after storage confirmed; storage failure is retryable", async () => {
    await settings({ enabled: true, intervalSeconds: 60 });
    const e = await ready();
    const s = shot(Date.now() - 30 * M);
    assert.equal((await upload(e, s)).status, 404, "register first");
    assert.equal((await register(e, s)).body.status, "REGISTERED");

    assert.equal((await upload(e, s, s.bytes, "image/png")).status, 415, "only image/webp bodies");
    assert.equal((await upload(e, s, s.bytes.subarray(0, s.bytes.length - 2))).status, 400, "size must match");
    const garbage = new Uint8Array(s.bytes.length).fill(7);
    assert.equal((await upload(e, s, garbage)).status, 415, "must be a WebP");
    assert.equal((await upload(e, s, fakeWebp(1280, 720, 2000 + (s.bytes.length - fakeWebp(1280, 720).length)))).status, 400, "dimensions must match");
    const tampered = s.bytes.slice();
    tampered[100] ^= 0xff;
    assert.equal((await upload(e, s, tampered)).status, 422, "checksum must match");
    assert.equal((await upload(e, s, new Uint8Array(11 * 1024 * 1024))).status, 413, "size cap");

    // Storage outage: 502, nothing marked stored, the client retries later.
    const storage = app.get(SCREENSHOT_STORAGE);
    const put = storage.put.bind(storage);
    storage.put = async () => {
      throw new StorageError("Microsoft Graph upload failed (HTTP 503)");
    };
    const failed = await upload(e, s);
    assert.equal(failed.status, 502);
    assert.doesNotMatch(failed.text, /HTTP 503/, "provider details are not echoed to the client");
    const row = async () => (await db.execute({ sql: "SELECT upload_status, storage_key, stored_at FROM screenshots WHERE idempotency_key = ?", args: [s.id] })).rows[0]!;
    assert.equal((await row()).upload_status, "REGISTERED");
    // Storage accepts the request but does not have the file afterwards: still not complete.
    storage.put = async (key: string) => ({ itemId: key, size: 1 });
    assert.equal((await upload(e, s)).status, 502, "unconfirmed upload is not complete");
    storage.put = put;

    const stored = await upload(e, s);
    assert.equal(stored.status, 200, stored.text);
    assert.equal(stored.body.status, "STORED");
    const r = await row();
    assert.equal(r.upload_status, "STORED");
    const file = join(STORAGE_DIR, String(r.storage_key));
    assert.equal(sha(readFileSync(file)), s.meta.checksum, "the stored file is byte-identical");
    assert.match(String(r.storage_key), new RegExp(`^screenshots/unassigned/${e.id}/\\d{4}-\\d{2}/[0-9a-f-]{36}\\.webp$`), "server-generated key, no names; no team = unassigned folder");
    assert.equal((await upload(e, s)).body.status, "STORED", "re-upload is a no-op");
    assert.equal((await register(e, s)).body.status, "STORED", "re-register reports STORED");
    assert.equal((await api("/screenshots/me", { bearer: e.bearer })).body.lastStoredAt, stored.body.storedAt);
  });

  test("team folders: files of each team are kept apart (earliest membership), team members stay in scope rules of the API", async () => {
    await settings({ enabled: true, intervalSeconds: 60 });
    const adminId = String((await db.execute("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0]!.id);
    const team = async (name: string) => {
      const id = randomUUID();
      await db.execute({ sql: "INSERT INTO teams (id, name, created_by) VALUES (?, ?, ?)", args: [id, name, adminId] });
      return id;
    };
    const addMember = (teamId: string, employeeId: string, at: string) =>
      db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by, added_at) VALUES (?, ?, ?, ?)", args: [teamId, employeeId, adminId, at] });
    const [t1, t2, t3] = [await team(`Folder A ${randomUUID()}`), await team(`Folder B ${randomUUID()}`), await team(`Folder C ${randomUUID()}`)];
    const [a, b] = [await ready(), await ready()];
    await addMember(t1, a.id, "2026-01-01T00:00:00.000Z");
    await addMember(t3, b.id, "2026-01-02T00:00:00.000Z");
    await addMember(t2, b.id, "2026-01-01T00:00:00.000Z"); // b's earliest team is t2
    const keyOf = async (e: Emp) => {
      const s = shot(Date.now() - 30 * M);
      assert.equal((await register(e, s)).body.status, "REGISTERED");
      assert.equal((await upload(e, s)).body.status, "STORED");
      return String((await db.execute({ sql: "SELECT storage_key FROM screenshots WHERE idempotency_key = ?", args: [s.id] })).rows[0]!.storage_key);
    };
    const [ka, kb] = [await keyOf(a), await keyOf(b)];
    assert.ok(ka.startsWith(`screenshots/teams/${t1}/${a.id}/`), ka);
    assert.ok(kb.startsWith(`screenshots/teams/${t2}/${b.id}/`), kb);
    assert.ok(existsSync(join(STORAGE_DIR, ka)) && existsSync(join(STORAGE_DIR, kb)), "files are in their team folders");
    const teams = await db.execute({ sql: "SELECT count(*) AS n FROM team_members WHERE employee_id IN (?, ?)", args: [a.id, b.id] });
    assert.equal(Number(teams.rows[0]!.n), 3, "memberships untouched");
  });

  test("device ownership, other employees' registrations and rate limits", async () => {
    await settings({ enabled: true, intervalSeconds: 60 });
    const [a, b] = [await ready(), await ready()];
    const s = shot(Date.now() - 30 * M);
    assert.equal((await register(a, s, randomUUID())).status, 403, "unregistered installation");
    assert.equal((await register(a, s)).body.status, "REGISTERED");
    assert.equal((await upload(b, s)).status, 404, "another employee cannot upload into this registration");
    assert.equal((await register(b, s)).body.status, "REGISTERED", "the same client id under another employee is that employee's own registration");

    const limiter = app.get(ScreenshotsService).limiter;
    for (let i = 0; i < 120; i++) limiter.hit(a.id);
    const limited = await register(a, shot(Date.now() - 10 * M));
    assert.equal(limited.status, 429);
    limiter.reset(a.id);

    const { rows } = await db.execute({ sql: "SELECT id FROM devices WHERE employee_id = ?", args: [a.id] });
    await api(`/devices/${rows[0]!.id}/revoke`, { method: "POST", cookie: admin });
    assert.equal((await register(a, shot(Date.now() - 5 * M))).status, 401, "revoked device: its session is revoked with it (API-08)");
  });
});

describe("screenshot access and retention", () => {
  test("images only via the API to the owner or admins, never cached, every view logged", async () => {
    await settings({ enabled: true, intervalSeconds: 60 });
    const [a, b] = [await ready(), await ready()];
    const s = shot(Date.now() - 30 * M);
    await register(a, s);
    const pending = (await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [s.id] })).rows[0]!.id as string;
    assert.equal((await api(`/screenshots/${pending}/content`, { cookie: admin })).status, 409, "not stored yet");
    await upload(a, s);

    const own = await api(`/screenshots/${pending}/content`, { bearer: a.bearer });
    assert.equal(own.status, 200);
    assert.equal(own.res.headers.get("content-type"), "image/webp");
    assert.match(own.res.headers.get("cache-control") ?? "", /^no-store/);
    assert.equal(sha(own.bytes), s.meta.checksum);
    assert.equal((await api(`/screenshots/${pending}/content`, { bearer: b.bearer })).status, 404, "other employees cannot see it");
    assert.equal((await api(`/screenshots/${pending}/content`, { cookie: admin })).status, 200);
    const log = await db.execute({ sql: "SELECT count(*) AS n FROM screenshot_access_log WHERE screenshot_id = ?", args: [pending] });
    assert.equal(log.rows[0]!.n, 2);

    const list = await api(`/screenshots?employeeId=${a.id}`, { cookie: admin });
    assert.equal(list.body.total, 1);
    assert.deepEqual(Object.keys(list.body.items[0]).sort(), ["blurred", "capturedAt", "employeeId", "fileSizeBytes", "height", "id", "maskCount", "storageProvider", "storedAt", "uploadStatus", "width"], "metadata only: no links, keys or checksums");
    assert.equal((await api(`/screenshots?employeeId=${a.id}`, { bearer: b.bearer })).status, 404);
    assert.equal((await api("/screenshots", { bearer: a.bearer })).body.total, 1, "own list");
    const columns = (await db.execute("SELECT name, type FROM pragma_table_info('screenshots')")).rows;
    assert.ok(columns.every((c) => c.type !== "BLOB"), "no image data in the database");
  });

  test("retention: dry run, refused until approved, deletes from storage and keeps the metadata as DELETED", async () => {
    await settings({ enabled: true, intervalSeconds: 60 });
    const e = await ready();
    const s = shot(Date.now() - 20 * M);
    await register(e, s);
    await upload(e, s);
    // An old stored screenshot (seeded: older than any upload the API would accept).
    const old = (await db.execute({ sql: "SELECT * FROM screenshots WHERE idempotency_key = ?", args: [s.id] })).rows[0]!;
    const oldId = randomUUID();
    const oldKey = `${e.id}/2026-01/${oldId}.webp`;
    await app.get(SCREENSHOT_STORAGE).put(oldKey, s.bytes);
    await db.execute({
      sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height,
              mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1920, 1080, 'image/webp', ?, ?, 'LOCAL_DEV', ?, 'STORED', ?)`,
      args: [oldId, e.id, old.device_id, old.attendance_session_id, randomUUID(), iso(Date.now() - 40 * D), iso(Date.now() - 40 * D), s.bytes.length, s.meta.checksum, oldKey, iso(Date.now() - 40 * D)],
    });

    assert.equal((await api("/screenshots/retention", { bearer: e.bearer })).status, 403);
    const preview = await api("/screenshots/retention", { cookie: admin });
    assert.deepEqual([preview.body.retentionDays, preview.body.approved, preview.body.eligible], [30, false, 1]);
    assert.equal((await api("/screenshots/retention/run", { method: "POST", cookie: admin, body: {} })).status, 400, "explicit confirmation");
    assert.equal((await api("/screenshots/retention/run", { method: "POST", cookie: admin, body: { confirm: true } })).status, 409, "not approved");
    assert.ok(existsSync(join(STORAGE_DIR, oldKey)), "nothing deleted");

    await settings({ enabled: true, intervalSeconds: 60, retentionApproved: true });
    const run = await api("/screenshots/retention/run", { method: "POST", cookie: admin, body: { confirm: true } });
    assert.equal(run.status, 200, run.text);
    assert.deepEqual([run.body.eligible, run.body.failed], [0, 0]);
    assert.ok(!existsSync(join(STORAGE_DIR, oldKey)), "file deleted from storage");
    const row = (await db.execute({ sql: "SELECT upload_status, deleted_at, deleted_by FROM screenshots WHERE id = ?", args: [oldId] })).rows[0]!;
    assert.equal(row.upload_status, "DELETED");
    assert.ok(row.deleted_at && row.deleted_by, "who and when are kept");
    assert.equal((await api(`/screenshots/${oldId}/content`, { cookie: admin })).status, 410);
    assert.equal((await db.execute({ sql: "SELECT upload_status FROM screenshots WHERE idempotency_key = ?", args: [s.id] })).rows[0]!.upload_status, "STORED", "recent screenshots kept");
    await settings({ enabled: true, intervalSeconds: 60 });
  });

  test("WebP header parsing (integrity check before storage)", () => {
    assert.deepEqual(webpSize(fakeWebp(1920, 1080)), { width: 1920, height: 1080 });
    const truncated = fakeWebp(10, 10).subarray(0, 40);
    assert.equal(webpSize(truncated), null, "RIFF size must match the file length");
    assert.equal(webpSize(new TextEncoder().encode("RIFF....WEBPVP8 not really an image at all")), null);
  });
});

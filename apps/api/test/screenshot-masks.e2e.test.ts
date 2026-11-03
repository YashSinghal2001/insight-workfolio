// F02 screenshot privacy masks (API side). The masking itself happens on the device before
// encoding (Rust tests in apps/desktop/src-tauri/src/screenshot.rs); here: configuration,
// validation, history, enforcement at registration, fail-closed handling of unreadable stored
// masks, and that every read path (full, thumbnail, owner self-view, timelapse) serves exactly the
// uploaded (masked) bytes with no route to anything else. Images are header-valid fakes, never real screenshots.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-masks-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-masks-videos-"));
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
const { DEFAULT_SCREENSHOT_NOTICE_VERSION, DEFAULT_SCREENSHOT_SETTINGS } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
const D = 86_400_000;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let admin: string;

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
/** Employee with a device, the screenshot notice acknowledged, clocked in two hours ago. */
async function employee() {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `mask${n}@example.com`, employeeCode: `MSK-${n}`, fullName: `Mask ${n}`, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `mask${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 3 * 60 * M)] });
  const c = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 120 * M) }] } });
  assert.equal(c.body.results[0].status, "ACCEPTED");
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

const MASKS = [
  { x: 0, y: 0, w: 2500, h: 1000, label: "Menu bar clock" },
  { x: 7000, y: 9000, w: 3000, h: 1000, label: "Chat notifications" },
];
const RECTS = MASKS.map(({ x, y, w, h }) => ({ x, y, w, h }));

const settings = (patch: object, cookie = admin) =>
  api("/settings/screenshots", { method: "PUT", cookie, body: { ...DEFAULT_SCREENSHOT_SETTINGS, enabled: true, intervalSeconds: 60, reason: "test", ...patch } });

/** Registers (and by default uploads) one fake screenshot; returns the client id, bytes and the register answer. */
async function capture(e: Emp, at: number, masks: object[] | undefined, doUpload = true) {
  const bytes = fakeWebp(1920, 1080, 1000 + (++seq % 700));
  const id = randomUUID();
  const body = { id, sentAt: iso(Date.now()), capturedAt: iso(at), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp", ...(masks ? { masks } : {}) };
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body });
  if (doUpload && reg.body?.status === "REGISTERED") assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  const row = (await db.execute({ sql: "SELECT id, mask_count FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0];
  return { id, bytes, reg, serverId: row?.id as string | undefined, maskCount: row?.mask_count };
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  const adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const r = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  // A policy without masks from two days ago: screenshots captured before a mask change are judged by it.
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test: backdated', ?, ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, adminId, iso(Date.now() - 2 * D)],
  });
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
});

describe("screenshot privacy masks", () => {
  test("configuration: admins only, validated, kept in the append-only history with who and why; employees see the masks", async () => {
    const e = await employee();
    assert.equal((await api("/settings/screenshots", { method: "PUT", body: { ...DEFAULT_SCREENSHOT_SETTINGS, maskRegions: MASKS, reason: "x" } })).status, 401, "signed out");
    const put = (body: object) => api("/settings/screenshots", { method: "PUT", bearer: e.bearer, body });
    assert.equal((await put({ ...DEFAULT_SCREENSHOT_SETTINGS, maskRegions: MASKS, reason: "x" })).status, 403, "employees cannot change masks");

    const before = (await api("/settings/screenshots", { cookie: admin })).body.history.length;
    for (const bad of [
      [{ ...MASKS[0], x: 9000 }], // x + w beyond the right edge
      [{ ...MASKS[0], w: 0 }],
      [{ ...MASKS[0], y: -1 }],
      [{ ...MASKS[0], x: 1.5 }],
      [{ x: 0, y: 0, w: 10, h: 10 }], // no label
      [{ ...MASKS[0], label: "" }],
      [{ ...MASKS[0], color: "black" }], // unknown field
      Array.from({ length: 21 }, () => MASKS[0]),
      "not a list",
    ]) {
      assert.equal((await settings({ maskRegions: bad })).status, 400, JSON.stringify(bad).slice(0, 80));
    }
    assert.equal((await api("/settings/screenshots", { cookie: admin })).body.history.length, before, "invalid masks are never stored");

    const ok = await settings({ maskRegions: MASKS, reason: "Hide clock and chat corner" });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.body.effective.maskRegions, MASKS);
    assert.deepEqual([ok.body.effective.reason, ok.body.effective.changedBy.email], ["Hide clock and chat corner", "admin@example.com"]);
    assert.deepEqual(ok.body.history[1].maskRegions, [], "the previous version is kept unchanged");
    const me = await api("/screenshots/me", { bearer: e.bearer });
    assert.deepEqual(me.body.policy.maskRegions, MASKS, "the desktop agent receives the masks with their labels");
  });

  test("registration: the masks in force must have been applied exactly; earlier captures are judged by the earlier policy", async () => {
    await settings({ maskRegions: MASKS });
    const [e1, e2, e3, e4, e5] = [await employee(), await employee(), await employee(), await employee(), await employee()];
    const now = Date.now() + 1000;

    const old = await capture(e1, now, undefined);
    assert.equal(old.reg.body.status, "REJECTED", "an agent that sends no masks (older version) is refused");
    assert.match(old.reg.body.reason, /without the privacy masks in force at that time \(2 required\)/);
    assert.equal(old.serverId, undefined, "nothing recorded");

    for (const [e, wrong] of [[e2, [RECTS[0]]], [e3, [RECTS[1], RECTS[0]]], [e4, [{ ...RECTS[0], w: 2499 }, RECTS[1]]]] as const) {
      const r = await capture(e, now, wrong as object[]);
      assert.equal(r.reg.body.status, "REJECTED", JSON.stringify(wrong));
    }
    const labelled = await capture(e5, now, MASKS);
    assert.equal(labelled.reg.status, 400, "agents report rectangles only");

    const good = await capture(e5, now, RECTS);
    assert.equal(good.reg.body.status, "REGISTERED", good.reg.text);
    assert.equal(good.maskCount, 2);

    // Captured before the masks were configured (offline, uploaded now): the policy then had none.
    const earlier = await capture(e1, Date.now() - 10 * M, []);
    assert.equal(earlier.reg.body.status, "REGISTERED", earlier.reg.text);
    assert.equal(earlier.maskCount, 0);
    const earlierWithMasks = await capture(e2, Date.now() - 10 * M, RECTS);
    assert.equal(earlierWithMasks.reg.body.status, "REJECTED", "masks are checked against the capture time, both ways");

    const list = await api(`/screenshots/gallery?from=${today()}&to=${today()}&tz=UTC&employeeId=${e5.id}`, { cookie: admin });
    assert.deepEqual(list.body.items.map((i: { maskCount: number }) => i.maskCount), [2], "the gallery shows how many masks were applied");
    assert.equal((await api(`/screenshots/${good.serverId}`, { cookie: admin })).body.maskCount, 2);
    assert.equal((await api(`/screenshots?from=${today()}&to=${today()}`, { bearer: e5.bearer })).body.items[0].maskCount, 2, "and the employee's own list");

    await settings({ maskRegions: [] });
    const later = await capture(e3, Date.now() + 1000, []);
    assert.equal(later.reg.body.status, "REGISTERED", "removing the masks returns to unmasked capture");
  });

  test("every read path serves exactly the uploaded masked bytes; no original variant; other employees refused", async () => {
    // Masks in force since an hour ago, so two frames one capture interval apart can lie in the past.
    await db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
              retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, ?, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test: masks backdated', (SELECT id FROM users WHERE role = 'ADMIN'), ?)`,
      args: [JSON.stringify(MASKS), DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 60 * M)],
    });
    const [e, other] = [await employee(), await employee()];
    const shots = [await capture(e, Date.now() - 40 * M, RECTS), await capture(e, Date.now() - 30 * M, RECTS)];
    for (const s of shots) assert.ok(s.serverId, s.reg.text);

    for (const s of shots) {
      const full = await api(`/screenshots/${s.serverId}/content`, { cookie: admin });
      const thumb = await api(`/screenshots/${s.serverId}/content?variant=thumbnail`, { cookie: admin });
      const own = await api(`/screenshots/${s.serverId}/content`, { bearer: e.bearer });
      for (const [name, r] of [["full", full], ["thumbnail", thumb], ["owner", own]] as const) {
        assert.equal(r.status, 200, name);
        assert.deepEqual(Buffer.from(r.bytes), Buffer.from(s.bytes), `${name}: the stored (masked) bytes`);
      }
      for (const v of ["original", "raw", "unmasked", "source"]) assert.equal((await api(`/screenshots/${s.serverId}/content?variant=${v}`, { cookie: admin })).status, 400, v);
      assert.equal((await api(`/screenshots/${s.serverId}/content?unmasked=true`, { cookie: admin })).status, 400, "no extra query switches");
      assert.equal((await api(`/screenshots/${s.serverId}/content`, { bearer: other.bearer })).status, 404, "another employee cannot read it");
    }

    // Timelapse frames come from the same stored bytes (encoder replaced by concatenation: job logic, not real video).
    const service = app.get(TimelapseService);
    const encoder = app.get(TIMELAPSE_ENCODER);
    const real = encoder.encode;
    Object.assign(service, { encoderReason: null });
    encoder.encode = async (frames: AsyncIterable<Uint8Array>, out: string) => {
      const parts: Uint8Array[] = [];
      for await (const f of frames) parts.push(f);
      await writeFile(out, Buffer.concat(parts));
    };
    try {
      const session = (await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows[0]!.id;
      const job = await api("/timelapses", { method: "POST", cookie: admin, body: { sessionId: session, fps: 2 } });
      assert.equal(job.status, 202, job.text);
      let status = job.body;
      for (let i = 0; i < 200 && ["QUEUED", "RUNNING"].includes(status.status); i++) {
        await new Promise((r) => setTimeout(r, 20));
        status = (await api(`/timelapses/${job.body.id}`, { cookie: admin })).body;
      }
      assert.equal(status.status, "READY", status.error);
      const video = await api(`/timelapses/${job.body.id}/content`, { cookie: admin });
      assert.deepEqual(Buffer.from(video.bytes), Buffer.concat(shots.map((s) => s.bytes)), "timelapse frames = the masked uploads, in capture order");
    } finally {
      encoder.encode = real;
    }
  });

  test("unreadable stored masks fail closed: screenshots off for the agent and refused at registration", async () => {
    const e = await employee();
    // Valid JSON array (passes the database CHECK) but not valid masks.
    await db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
              retention_approved, notice_version, reason, changed_by) VALUES (1, ?, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test: damaged', (SELECT id FROM users WHERE role = 'ADMIN'))`,
      args: [JSON.stringify([{ x: -5, y: 0, w: 10, h: 10, label: "bad" }]), DEFAULT_SCREENSHOT_NOTICE_VERSION],
    });
    const me = await api("/screenshots/me", { bearer: e.bearer });
    assert.deepEqual([me.body.policy.enabled, me.body.policy.maskRegions], [false, []], "the agent stops capturing");
    assert.equal((await api("/settings/screenshots", { cookie: admin })).body.effective.enabled, false, "admins see it as off");
    const r = await capture(e, Date.now() + 1000, []);
    assert.equal(r.reg.body.status, "REJECTED");
    assert.match(r.reg.body.reason, /turned off/);
    const fixed = await settings({ maskRegions: MASKS, reason: "Repair masks" });
    assert.equal(fixed.status, 200);
    assert.equal((await api("/screenshots/me", { bearer: e.bearer })).body.policy.enabled, true, "a new valid version restores capture");
  });
});

// F02 whole-image screenshot blur (API side): organisation policy and per-employee overrides,
// enforced at registration against the capture time. The blur itself happens on the device before
// encoding (desktop agent); images here are header-valid fakes, never real screenshots.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-blur-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-blur-videos-"));
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
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `blur${n}@example.com`, employeeCode: `BLR-${n}`, fullName: `Blur ${n}`, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `blur${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 3 * 60 * M)] });
  const c = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 120 * M) }] } });
  assert.equal(c.body.results[0].status, "ACCEPTED");
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

const settings = (patch: object, cookie = admin) =>
  api("/settings/screenshots", { method: "PUT", cookie, body: { ...DEFAULT_SCREENSHOT_SETTINGS, enabled: true, intervalSeconds: 60, reason: "test", ...patch } });
const override = (employeeId: string, blur: boolean | null, opts: Opts = { cookie: admin }, reason = "client data on screen") =>
  api(`/settings/screenshots/blur-overrides/${employeeId}`, { method: "PUT", ...opts, body: { blur, reason } });
const MISMATCH = "Blur setting does not match the policy in force";

/** Registers (and uploads) one fake screenshot; `blurred` undefined = an older agent that does not send it. */
async function capture(e: Emp, at: number, blurred: boolean | undefined) {
  const bytes = fakeWebp(1920, 1080, 1000 + (++seq % 700));
  const id = randomUUID();
  const body = { id, sentAt: iso(Date.now()), capturedAt: iso(at), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp", ...(blurred === undefined ? {} : { blurred }) };
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body });
  if (reg.body?.status === "REGISTERED") assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  const row = (await db.execute({ sql: "SELECT id, blurred FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0];
  return { reg, serverId: row?.id as string | undefined, blurred: row?.blurred };
}
const accepted = (r: Awaited<ReturnType<typeof capture>>, msg: string) => assert.equal(r.reg.body?.status, "REGISTERED", `${msg}: ${r.reg.text}`);
function rejected(r: Awaited<ReturnType<typeof capture>>, msg: string) {
  assert.deepEqual([r.reg.body?.status, r.reg.body?.reason, r.serverId], ["REJECTED", MISMATCH, undefined], `${msg}: ${r.reg.text}`);
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
  // Screenshots on without blur since two days ago: captures before any change below are judged by it.
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

describe("screenshot blur (whole image, on the device)", () => {
  test("admins only: employees get 403 on the policy and override routes; settings history and audit record blur", async () => {
    const e = await employee();
    assert.equal((await settings({ blur: true }, "")).status, 401);
    assert.equal((await api("/settings/screenshots", { method: "PUT", bearer: e.bearer, body: { ...DEFAULT_SCREENSHOT_SETTINGS, blur: true, reason: "x" } })).status, 403);
    assert.equal((await api(`/settings/screenshots/blur-overrides?employeeId=${e.id}`, { bearer: e.bearer })).status, 403);
    assert.equal((await override(e.id, false, { bearer: e.bearer })).status, 403, "an employee cannot unblur themselves");
    assert.equal((await override(e.id, false, {})).status, 401);

    const on = await settings({ blur: true, reason: "Blur for the pilot" });
    assert.equal(on.status, 200, on.text);
    assert.deepEqual([on.body.effective.blur, on.body.history[1].blur], [true, false], "new version; the previous one is kept");
    assert.equal((await api("/screenshots/me", { bearer: e.bearer })).body.policy.blur, true, "the agent is told to blur");
    assert.equal((await settings({ blur: "yes" })).status, 400);
    const older = { ...DEFAULT_SCREENSHOT_SETTINGS, enabled: true, intervalSeconds: 60, reason: "older dashboard" } as Record<string, unknown>;
    delete older.blur;
    assert.equal((await api("/settings/screenshots", { method: "PUT", cookie: admin, body: older })).body.effective.blur, false, "a payload without blur means off");

    assert.equal((await override(e.id, true)).status, 200);
    assert.equal((await override(randomUUID(), true)).status, 404, "unknown employee");
    assert.equal((await override(e.id, true, { cookie: admin }, "x")).status, 400, "reason required (3-500)");
    assert.equal((await api(`/settings/screenshots/blur-overrides/${e.id}`, { method: "PUT", cookie: admin, body: { reason: "no value" } })).status, 400);
    assert.equal((await api("/settings/screenshots/blur-overrides", { cookie: admin })).status, 400, "employeeId required");

    const day = today();
    const audit = await api(`/audit?from=${day}&to=${day}&source=SETTINGS&action=SCREENSHOT_BLUR_OVERRIDE_CHANGED`, { cookie: admin });
    assert.equal(audit.status, 200, audit.text);
    const ev = audit.body.items.find((i: { resource: { id: string } }) => i.resource.id === e.id);
    assert.deepEqual([ev.actor.email, ev.reason, ev.details, ev.resource.type], ["admin@example.com", "client data on screen", { employeeId: e.id, blur: true }, "EMPLOYEE"]);
    assert.match(ev.target.email, /^blur\d+@example\.com$/, "the employee is the target");
    const policy = (await api(`/audit?from=${day}&to=${day}&source=SETTINGS&action=SCREENSHOT_POLICY_CHANGED`, { cookie: admin })).body.items;
    assert.ok(policy.some((i: { details: { blur: boolean }; reason: string }) => i.details.blur === true && i.reason === "Blur for the pilot"), "policy changes carry the blur flag");
    await settings({ blur: false });
  });

  test("organisation blur: unblurred registration rejected, blurred accepted and shown as blurred; old agents count as unblurred", async () => {
    await settings({ blur: true });
    const [e1, e2, e3] = [await employee(), await employee(), await employee()];
    const now = Date.now() + 1000;
    rejected(await capture(e1, now, false), "blur on, image not blurred");
    rejected(await capture(e2, now, undefined), "an older agent (no blurred field) is treated as unblurred");
    const good = await capture(e3, now, true);
    accepted(good, "blurred");
    assert.equal(good.blurred, 1, "stored on the row");

    const list = await api(`/screenshots/gallery?from=${today()}&to=${today()}&tz=UTC&employeeId=${e3.id}`, { cookie: admin });
    assert.deepEqual(list.body.items.map((i: { blurred: boolean }) => i.blurred), [true], "gallery");
    assert.equal((await api(`/screenshots/${good.serverId}`, { cookie: admin })).body.blurred, true, "detail");
    assert.equal((await api(`/screenshots?from=${today()}&to=${today()}`, { bearer: e3.bearer })).body.items[0].blurred, true, "the employee's own list");

    // Captured offline before blur was turned on: judged by the policy then (no blur), both ways.
    accepted(await capture(e1, Date.now() - 10 * M, false), "earlier capture without blur");
    rejected(await capture(e2, Date.now() - 10 * M, true), "earlier capture blurred although blur was off then");

    await settings({ blur: false });
    const later = await capture(e2, Date.now() + 1000, undefined);
    accepted(later, "blur off again: older agents work");
    assert.equal(later.blurred, 0);
    rejected(await capture(e1, Date.now() + 1000, true), "blurred while the policy says no blur");
  });

  test("per-employee override beats the organisation setting, applies from when it was set (not retroactively), and can be cleared", async () => {
    await settings({ blur: false });
    const [e, other] = [await employee(), await employee()];
    const set = await override(e.id, true, { cookie: admin }, "Handles client data");
    assert.equal(set.status, 200, set.text);
    assert.deepEqual([set.body.organisationBlur, set.body.override, set.body.effective, set.body.history.length], [false, true, true, 1]);
    assert.deepEqual([(await api("/screenshots/me", { bearer: e.bearer })).body.policy.blur, (await api("/screenshots/me", { bearer: other.bearer })).body.policy.blur], [true, false], "only this person");

    rejected(await capture(e, Date.now() + 1000, false), "override on");
    accepted(await capture(e, Date.now() - 10 * M, false), "captured before the override was set: organisation setting then (off)");
    rejected(await capture(e, Date.now() - 5 * M, true), "and blurred then is a mismatch");
    accepted(await capture(other, Date.now() + 1000, false), "other employees follow the organisation");

    // Organisation on, this person never blurred.
    await settings({ blur: true });
    await override(e.id, false, { cookie: admin }, "Exempt: works on public data");
    assert.equal((await api("/screenshots/me", { bearer: e.bearer })).body.policy.blur, false);
    const e2 = await employee();
    await override(e2.id, false, { cookie: admin }, "Exempt as well");
    accepted(await capture(e2, Date.now() + 1000, false), "override off beats organisation on");
    rejected(await capture(other, Date.now() + 40 * 1000, false), "organisation on for others");

    // Cleared: the organisation setting applies again.
    const cleared = await override(e2.id, null, { cookie: admin }, "Back to organisation setting");
    assert.deepEqual([cleared.body.override, cleared.body.effective, cleared.body.history.map((h: { blur: boolean | null }) => h.blur)], [null, true, [null, false]]);
    assert.equal((await api("/screenshots/me", { bearer: e2.bearer })).body.policy.blur, true);
    const listed = await api(`/settings/screenshots/blur-overrides?employeeId=${e2.id}`, { cookie: admin });
    assert.deepEqual([listed.body.history[0].reason, listed.body.history[0].changedBy.email], ["Back to organisation setting", "admin@example.com"]);
    await settings({ blur: false });
  });
});

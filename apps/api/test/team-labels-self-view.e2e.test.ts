// F05 per-team application labels and F08 per-person screenshot self-view (in-process API, in-memory DB,
// local screenshot storage with header-valid fake WebP files; synthetic data only).
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-teamlabels-"));
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
const { DEFAULT_NOTICE_VERSION, DEFAULT_SCREENSHOT_NOTICE_VERSION } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let admin: string;
let adminId: string;

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

const active = (app: string, start: number, end: number) => ({ id: randomUUID(), kind: "ACTIVE", applicationIdentifier: `com.example.${app}`, applicationName: app, startedAt: iso(start), endedAt: iso(end) });

let seq = 0;
/** Employee (UTC) clocked in 2 h ago with Slack 60 min and Code 30 min of ACTIVE time, and one stored screenshot. */
async function employee(code: string) {
  const email = `${code.toLowerCase()}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: code, fullName: `Person ${code}`, timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, userId: r.body.employee.userId as string, bearer: login.body.accessToken as string, device: randomUUID(), shot: "" };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  for (const v of new Set([DEFAULT_NOTICE_VERSION, DEFAULT_SCREENSHOT_NOTICE_VERSION])) {
    await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, v, iso(Date.now() - 300 * M)] });
  }
  const t = Date.now() - 120 * M;
  const c = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(t) }] } });
  assert.equal(c.body.results[0].status, "ACCEPTED", c.text);
  const up = await api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals: [active("Slack", t, t + 60 * M), active("Code", t + 60 * M, t + 90 * M)] } });
  assert.ok(up.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), up.text);

  const bytes = fakeWebp(1920, 1080, 1000 + ++seq);
  const key = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id: key, sentAt: iso(Date.now()), capturedAt: iso(Date.now() - 30 * M), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp", masks: [] } });
  assert.equal(reg.body.status, "REGISTERED", reg.text);
  assert.equal((await api(`/screenshots/${key}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  e.shot = String((await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [key] })).rows[0]!.id);
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

let a: Emp; // in Alpha
let b: Emp; // in no team
let c: Emp; // in Alpha and Beta

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  admin = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, '[]', 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test', ?, ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, adminId, iso(Date.now() - 2 * 86_400_000)],
  });
  [a, b, c] = [await employee("A-1"), await employee("B-1"), await employee("C-1")];
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

const range = () => `from=${iso(Date.now() - 180 * M).slice(0, 10)}&to=${iso(Date.now()).slice(0, 10)}`;

describe("F05 per-team labels", () => {
  let alpha: string;
  let beta: string;
  const productive = async (e: Emp) => {
    const s = (await api(`/activity/summary?employeeId=${e.id}&${range()}`, { cookie: admin })).body;
    assert.equal(s.productiveShare, s.productiveMs / s.clockedInMs);
    return Math.round(s.productiveMs / M);
  };
  const overview = async () => {
    const r = (await api(`/activity/overview?${range()}&pageSize=100`, { cookie: admin })).body;
    return Object.fromEntries(r.items.map((i: { employee: { id: string }; productiveMs: number }) => [i.employee.id, Math.round(i.productiveMs / M)]));
  };
  const teams = async () => {
    const r = (await api(`/teams/productivity?${range()}`, { cookie: admin })).body;
    return Object.fromEntries(r.items.map((i: { team: { name: string }; productiveMs: number }) => [i.team.name, Math.round(i.productiveMs / M)]));
  };

  test("admins set and remove team labels; validation; employees cannot", async () => {
    await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "NAME", value: "Slack", category: "NEUTRAL" } });
    await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "NAME", value: "Code", category: "PRODUCTIVE" } });
    alpha = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Alpha" } })).body.id;
    beta = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Beta" } })).body.id;
    await api(`/teams/${alpha}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [a.id, c.id] } });
    await api(`/teams/${beta}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [c.id] } });

    assert.deepEqual((await api(`/teams/${alpha}/labels`, { cookie: admin })).body, []);
    const set = await api(`/teams/${alpha}/labels`, { method: "PUT", cookie: admin, body: { matchKind: "NAME", value: "Notes", category: "NEUTRAL" } });
    assert.equal(set.status, 200, set.text);
    const replaced = await api(`/teams/${alpha}/labels`, { method: "PUT", cookie: admin, body: { matchKind: "NAME", value: "NOTES", category: "UNPRODUCTIVE" } });
    assert.deepEqual(replaced.body.map((l: { value: string; category: string }) => [l.value, l.category]), [["NOTES", "UNPRODUCTIVE"]], "same app (any case) replaces");
    const notes = replaced.body[0].id;
    assert.equal((await api(`/teams/${alpha}/labels/${notes}`, { method: "DELETE", cookie: admin })).body.length, 0);
    assert.equal((await api(`/teams/${alpha}/labels/${notes}`, { method: "DELETE", cookie: admin })).status, 404, "already ended");
    assert.equal((await api(`/teams/${beta}/labels/${set.body[0].id}`, { method: "DELETE", cookie: admin })).status, 404, "another team's label");
    const rows = await db.execute({ sql: "SELECT category, ended_by FROM team_application_category_rules WHERE team_id = ? ORDER BY rowid", args: [alpha] });
    assert.deepEqual(rows.rows.map((r) => [r.category, r.ended_by]), [["NEUTRAL", adminId], ["UNPRODUCTIVE", adminId]], "history kept, never deleted");

    for (const bad of [{ matchKind: "NAME", value: "X", category: "UNCLASSIFIED" }, { matchKind: "PATH", value: "X", category: "PRODUCTIVE" }, { matchKind: "NAME", value: "", category: "PRODUCTIVE" }, { matchKind: "NAME", value: "X", category: "PRODUCTIVE", extra: 1 }]) {
      assert.equal((await api(`/teams/${alpha}/labels`, { method: "PUT", cookie: admin, body: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await api(`/teams/${randomUUID()}/labels`, { cookie: admin })).status, 404);
    assert.equal((await api(`/teams/${randomUUID()}/labels`, { method: "PUT", cookie: admin, body: { matchKind: "NAME", value: "X", category: "PRODUCTIVE" } })).status, 404);
    for (const [method, path, body] of [["GET", `/teams/${alpha}/labels`], ["PUT", `/teams/${alpha}/labels`, { matchKind: "NAME", value: "Slack", category: "PRODUCTIVE" }], ["DELETE", `/teams/${alpha}/labels/${notes}`]] as const) {
      assert.equal((await api(path, { method, body, bearer: a.bearer })).status, 403, `${method} ${path}`);
    }
  });

  test("a team label changes its members' productiveShare and the team aggregate; non-members unaffected", async () => {
    // Organisation: Code productive (30 min), Slack neutral (60 min).
    assert.deepEqual([await productive(a), await productive(b), await productive(c)], [30, 30, 30]);
    assert.deepEqual(await teams(), { Alpha: 60, Beta: 30 });

    await api(`/teams/${alpha}/labels`, { method: "PUT", cookie: admin, body: { matchKind: "IDENTIFIER", value: "com.example.Slack", category: "PRODUCTIVE" } });
    assert.deepEqual([await productive(a), await productive(b), await productive(c)], [90, 30, 90], "C is in Beta too, which has no Slack label");
    assert.deepEqual(await overview(), { [a.id]: 90, [b.id]: 30, [c.id]: 90 });
    assert.deepEqual(await teams(), { Alpha: 180, Beta: 90 });
    const summary = (await api(`/activity/summary?${range()}`, { bearer: a.bearer })).body;
    assert.equal(summary.applications.find((x: { applicationName: string }) => x.applicationName === "Slack").category, "PRODUCTIVE", "the employee's own view uses the team label");
    const timeline = (await api(`/activity/timeline?${range()}&pageSize=100`, { bearer: a.bearer })).body;
    assert.equal(timeline.items.find((x: { applicationName: string }) => x.applicationName === "Slack").category, "PRODUCTIVE");
    assert.equal((await api(`/activity/summary?${range()}`, { bearer: b.bearer })).body.applications.find((x: { applicationName: string }) => x.applicationName === "Slack").category, "NEUTRAL");
  });

  test("multi-team rule: teams that agree apply, teams that disagree fall back to the organisation; inactive teams ignored", async () => {
    await api(`/teams/${beta}/labels`, { method: "PUT", cookie: admin, body: { matchKind: "NAME", value: "slack", category: "PRODUCTIVE" } });
    assert.equal(await productive(c), 90, "agree");
    const lbl = await api(`/teams/${beta}/labels`, { method: "PUT", cookie: admin, body: { matchKind: "NAME", value: "Slack", category: "UNPRODUCTIVE" } });
    assert.equal(await productive(c), 30, "disagree: organisation label (neutral)");
    assert.equal(await productive(a), 90, "A is only in Alpha");
    assert.deepEqual(await teams(), { Alpha: 120, Beta: 30 });

    await api(`/teams/${beta}`, { method: "PATCH", cookie: admin, body: { active: false } });
    assert.equal(await productive(c), 90, "Beta inactive: only Alpha's label counts");
    await api(`/teams/${beta}`, { method: "PATCH", cookie: admin, body: { active: true } });
    await api(`/teams/${beta}/labels/${lbl.body[0].id}`, { method: "DELETE", cookie: admin });
    const alphaLabel = (await api(`/teams/${alpha}/labels`, { cookie: admin })).body[0].id;
    await api(`/teams/${alpha}/labels/${alphaLabel}`, { method: "DELETE", cookie: admin });
    assert.deepEqual([await productive(a), await productive(b), await productive(c)], [30, 30, 30], "labels removed: organisation again");
  });
});

describe("F08 per-person screenshot self-view", () => {
  const tracking = (e: Emp, screenshotSelfView?: boolean | null, who: { cookie?: string; bearer?: string } = { cookie: admin }) =>
    api(`/settings/employees/${e.id}/tracking`, { method: "PUT", ...who, body: { expectedStart: null, workdays: null, idleThresholdSeconds: null, reason: "privacy test", ...(screenshotSelfView === undefined ? {} : { screenshotSelfView }) } });
  const own = async (e: Emp) => [
    (await api("/screenshots", { bearer: e.bearer })).status,
    (await api(`/screenshots/${e.shot}`, { bearer: e.bearer })).status,
    (await api(`/screenshots/${e.shot}/content`, { bearer: e.bearer })).status,
  ];
  const orgSelfView = (on: boolean) =>
    db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
              retention_approved, notice_version, employee_self_view, reason, changed_by) VALUES (1, '[]', 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, ?, 'test: self-view', ?)`,
      args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, on ? 1 : 0, adminId],
    });

  test("deny: the employee gets 403 on their own list, detail and content although the organisation allows; others, admins and heads unaffected", async () => {
    assert.deepEqual(await own(a), [200, 200, 200], "organisation allows by default");
    const set = await tracking(a, false);
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.override.screenshotSelfView, false);
    assert.deepEqual([set.body.organisation.screenshotSelfView, set.body.effective.screenshotSelfView], [true, false]);
    assert.deepEqual(await own(a), [403, 403, 403]);
    assert.equal((await api("/screenshots/me", { bearer: a.bearer })).body.employeeSelfView, false, "the employee's status says so (the /my page hides images)");
    assert.deepEqual(await own(b), [200, 200, 200], "another employee keeps the organisation setting");

    const content = await api(`/screenshots/${a.shot}/content`, { cookie: admin });
    assert.equal(content.status, 200, "admins unaffected");
    assert.equal((await api(`/screenshots?employeeId=${a.id}`, { cookie: admin })).body.total, 1);
    const team = await api("/teams", { method: "POST", cookie: admin, body: { name: "Heads", headUserId: b.userId } });
    await api(`/teams/${team.body.id}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [a.id] } });
    assert.equal((await api(`/screenshots/${a.shot}/content`, { bearer: b.bearer })).status, 200, "the team head still sees the member's screenshot");
    await api(`/teams/${team.body.id}`, { method: "PATCH", cookie: admin, body: { active: false } });

    assert.equal((await tracking(a, undefined)).body.override.screenshotSelfView, false, "omitted: carries over");
    assert.equal((await tracking(a, null)).body.override.screenshotSelfView, null);
    assert.deepEqual(await own(a), [200, 200, 200], "inherit again");
  });

  test("allow works when the organisation denies; inherit follows it", async () => {
    await orgSelfView(false);
    assert.deepEqual(await own(c), [403, 403, 403]);
    const set = await tracking(c, true);
    assert.deepEqual([set.body.organisation.screenshotSelfView, set.body.effective.screenshotSelfView], [false, true]);
    assert.deepEqual(await own(c), [200, 200, 200]);
    assert.equal((await api("/screenshots/me", { bearer: c.bearer })).body.employeeSelfView, true);
    assert.deepEqual(await own(a), [403, 403, 403], "no override: organisation (off)");
    await tracking(c, null);
    assert.deepEqual(await own(c), [403, 403, 403]);
    await orgSelfView(true);
  });

  test("employees cannot read or set the override (their own or anyone's)", async () => {
    for (const target of [a, b]) {
      assert.equal((await tracking(target, true, { bearer: a.bearer })).status, 403);
      assert.equal((await api(`/settings/employees/${target.id}/tracking`, { bearer: a.bearer })).status, 403);
    }
    assert.equal((await tracking(a, "yes" as unknown as boolean)).status, 400);
  });
});

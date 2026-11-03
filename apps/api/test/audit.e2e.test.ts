// P1 central audit (in-process API, in-memory DB, local screenshot storage with fake WebP bytes).
// Events are seeded by real API actions (role change, website policy, project, screenshot view,
// monitoring settings) plus a few account_audit rows inserted directly. GET /audit is read-only.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-audit-"));
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
const { DEFAULT_SCREENSHOT_NOTICE_VERSION, DEFAULT_WEBSITE_NOTICE_VERSION, DEFAULT_MONITORING_SETTINGS } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "audit password 1";
const M = 60_000;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
type Ev = { id: string; source: string; at: string; action: string; actor: { id: string; email: string } | null; target: { userId: string; email: string } | null; resource: { type: string; id: string | null } | null; reason: string | null; details: Record<string, unknown> };

let app: INestApplication;
let base: string;
let db: Db;

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
  const json = (res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : undefined;
  return { status: res.status, body: json, text, res };
}
const iso = (ms: number) => new Date(ms).toISOString();
const day = (offset = 0) => iso(Date.now() + offset * 86_400_000).slice(0, 10);
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

async function loginCookie(email: string) {
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, email);
  return r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function adminUser(title: "SUPER_ADMIN" | "ADMIN", email: string) {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, 'ADMIN', ?, ?)", args: [id, email, title, await hashPassword(PASSWORD)] });
  return { id, email, cookie: await loginCookie(email) };
}
let seq = 0;
/** An employee created through the API, signed in on the desktop app with a registered device and an open session. */
async function employee(cookie: string) {
  const n = ++seq;
  const email = `aud${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie, body: { email, employeeCode: `AUD-${n}`, fullName: `Audit ${n}`, timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const id = String(r.body.employee.id);
  const userId = String((await db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [id] })).rows[0]!.user_id);
  const e = { id, userId, email, bearer: String(login.body.accessToken), device: randomUUID(), cookie: await loginCookie(email) };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  return e;
}

let superAdmin: Awaited<ReturnType<typeof adminUser>>;
let admin: Awaited<ReturnType<typeof adminUser>>;
let emp: Awaited<ReturnType<typeof employee>>;
let promoted: Awaited<ReturnType<typeof employee>>;
let shotId: string;
let projectId: string;
const accountRows = { evening: randomUUID(), midnight: randomUUID(), old: randomUUID() };
const audit = (query: Record<string, string | number>, cookie = admin.cookie) =>
  api(`/audit?${new URLSearchParams({ from: day(-1), to: day(1), ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) })}`, { cookie });
const items = async (query: Record<string, string | number>) => {
  const r = await audit({ pageSize: 200, ...query });
  assert.equal(r.status, 200, r.text);
  return r.body.items as Ev[];
};

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  superAdmin = await adminUser("SUPER_ADMIN", "ceo@example.com");
  admin = await adminUser("ADMIN", "it@example.com");
  [emp, promoted] = [await employee(admin.cookie), await employee(admin.cookie)];

  // ROLE: a real promotion.
  assert.equal((await api(`/roles/users/${promoted.userId}`, { method: "PATCH", cookie: superAdmin.cookie, body: { platformRole: "ADMIN", reason: "Joined IT (audit test)" } })).status, 200);
  // SETTINGS: website and monitoring policy versions through the API.
  assert.equal((await api("/websites/policy", { method: "PUT", cookie: admin.cookie, body: { enabled: true, retentionDays: 30, noticeVersion: DEFAULT_WEBSITE_NOTICE_VERSION, reason: "pilot (audit test)" } })).status, 200);
  assert.equal((await api("/settings/monitoring", { method: "PUT", cookie: admin.cookie, body: { ...DEFAULT_MONITORING_SETTINGS, sampleSeconds: 20, reason: "slower sampling (audit test)" } })).status, 200);
  // WEBSITE: a category rule.
  assert.ok((await api("/websites/categories", { method: "POST", cookie: admin.cookie, body: { domain: "docs.example.com", match: "EXACT", category: "PRODUCTIVE" } })).status < 300);
  // PROJECT: create and assign the employee.
  const p = await api("/projects", { method: "POST", cookie: admin.cookie, body: { code: "AUDIT", name: "Audit project" } });
  assert.equal(p.status, 201, p.text);
  projectId = String(p.body.id);
  assert.ok((await api(`/projects/${projectId}/members`, { method: "POST", cookie: admin.cookie, body: { employeeId: emp.id } })).status < 300);

  // SCREENSHOT_ACCESS: a policy (direct insert, effective two days ago), one stored capture, one admin view.
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, '[]', 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'audit test', ?, ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, admin.id, iso(Date.now() - 2 * 86_400_000)],
  });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), emp.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 300 * M)] });
  const c = await api("/attendance/sync", { method: "POST", bearer: emp.bearer, device: emp.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 180 * M) }] } });
  assert.equal(c.body.results[0].status, "ACCEPTED", c.text);
  const bytes = fakeWebp(1920, 1080, 1234);
  const key = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: emp.bearer, device: emp.device, body: { id: key, sentAt: iso(Date.now()), capturedAt: iso(Date.now() - 60 * M), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp", masks: [] } });
  assert.equal(reg.body.status, "REGISTERED", reg.text);
  assert.equal((await api(`/screenshots/${key}/content`, { method: "PUT", bearer: emp.bearer, device: emp.device, raw: bytes })).status, 200);
  shotId = String((await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [key] })).rows[0]!.id);
  assert.equal((await api(`/screenshots/${shotId}/content`, { cookie: admin.cookie })).status, 200);

  // ACCOUNT: rows written directly, two around a New York midnight (EDT, UTC-4) and one old.
  const insert = (id: string, at: string, action: string, metadata: object) =>
    db.execute({ sql: "INSERT INTO account_audit (id, actor_user_id, target_user_id, action, resource_type, resource_id, reason, metadata, created_at) VALUES (?, ?, ?, ?, 'ACCOUNT', ?, ?, ?, ?)", args: [id, admin.id, emp.userId, action, emp.userId, "left team (test)", JSON.stringify(metadata), at] });
  await insert(accountRows.evening, "2026-03-10T03:30:00.000Z", "ACCOUNT_DISABLED", { status: "DISABLED", passwordHash: "x", refreshToken: "y" }); // 23:30 on Mar 9 in New York
  await insert(accountRows.midnight, "2026-03-10T04:00:00.000Z", "ACCOUNT_ENABLED", { status: "ACTIVE" }); // 00:00 on Mar 10 in New York
  await insert(accountRows.old, "2025-12-01T12:00:00.000Z", "ACCOUNT_UPDATED", { fields: 1 });
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe("audit", () => {
  test("admins and super admins read it; employees 403; anonymous 401", async () => {
    assert.equal((await audit({}, superAdmin.cookie)).status, 200);
    assert.equal((await audit({}, admin.cookie)).status, 200);
    assert.equal((await audit({}, emp.cookie)).status, 403);
    assert.equal((await api(`/audit?from=${day(-1)}&to=${day(1)}`, { bearer: emp.bearer })).status, 403);
    assert.equal((await api(`/audit?from=${day(-1)}&to=${day(1)}`)).status, 401);
  });

  test("each source maps to its events with actor, target, resource and safe details", async () => {
    const role = (await items({ source: "ROLE" })).find((e) => e.target?.userId === promoted.userId)!;
    assert.deepEqual([role.action, role.actor?.email, role.target?.email, role.reason, role.details], ["ROLE_CHANGED", superAdmin.email, promoted.email, "Joined IT (audit test)", { from: "EMPLOYEE", to: "ADMIN" }]);
    assert.equal(role.id.startsWith("ROLE:"), true);

    const settings = await items({ source: "SETTINGS" });
    const web = settings.find((e) => e.action === "WEBSITE_POLICY_CHANGED")!;
    assert.deepEqual([web.actor?.id, web.reason, web.details.enabled, web.details.retentionDays, web.resource?.type], [admin.id, "pilot (audit test)", true, 30, "WEBSITE_POLICY"]);
    const mon = settings.find((e) => e.action === "MONITORING_POLICY_CHANGED")!;
    assert.deepEqual([mon.details.sampleSeconds, mon.details.enabled, mon.reason], [20, true, "slower sampling (audit test)"]);
    const shotPolicy = (await items({ source: "SETTINGS", action: "SCREENSHOT_POLICY_CHANGED", from: day(-3) }))[0]!;
    assert.deepEqual([shotPolicy.details.enabled, shotPolicy.details.maskCount, shotPolicy.details.employeeSelfView], [true, 0, true]);
    const seeded = settings.filter((e) => e.action === "MONITORING_NOTICE_PUBLISHED");
    assert.ok(seeded.length > 0 && seeded.every((e) => e.actor === null), "seeded notices are system events");

    const website = (await items({ source: "WEBSITE" })).find((e) => e.action === "RULE_ADDED")!;
    assert.deepEqual([website.actor?.id, website.details.domain, website.resource?.type], [admin.id, "docs.example.com", "WEBSITE_CATEGORY_RULE"]);

    const project = await items({ source: "PROJECT" });
    assert.ok(project.some((e) => e.action === "PROJECT_CREATED" && e.resource?.id === projectId && e.actor?.id === admin.id));
    const assigned = project.find((e) => e.action === "EMPLOYEE_ASSIGNED")!;
    assert.deepEqual([assigned.target?.userId, assigned.details.employeeId], [emp.userId, emp.id]);

    const view = (await items({ source: "SCREENSHOT_ACCESS" })).find((e) => e.resource?.id === shotId)!;
    assert.deepEqual([view.action, view.actor?.id, view.target?.userId, view.details.employeeId, view.details.screenshotId], ["VIEW", admin.id, emp.userId, emp.id, shotId]);

    const acct = (await items({ source: "ACCOUNT", from: "2026-03-09", to: "2026-03-10" })).find((e) => e.id === `ACCOUNT:${accountRows.evening}`)!;
    assert.deepEqual([acct.action, acct.target?.email, acct.reason, acct.details], ["ACCOUNT_DISABLED", emp.email, "left team (test)", { status: "DISABLED" }], "secret-looking metadata keys are dropped");
  });

  test("filters: source, actor, target, action", async () => {
    assert.ok((await items({ source: "PROJECT" })).every((e) => e.source === "PROJECT"));
    const byActor = await items({ actorId: superAdmin.id });
    assert.ok(byActor.length > 0 && byActor.every((e) => e.actor?.id === superAdmin.id));
    const byTarget = await items({ targetUserId: emp.userId });
    assert.ok(byTarget.length >= 2 && byTarget.every((e) => e.target?.userId === emp.userId));
    assert.deepEqual(new Set(byTarget.map((e) => e.source)).has("SCREENSHOT_ACCESS"), true);
    const byAction = await items({ action: "role_changed" });
    assert.ok(byAction.length > 0 && byAction.every((e) => e.action === "ROLE_CHANGED"));
    assert.equal((await items({ actorId: randomUUID() })).length, 0);
    assert.equal((await audit({ source: "NOPE" })).status, 400);
    assert.equal((await audit({ actorId: "not-a-uuid" })).status, 400);
  });

  test("date range and time zone boundaries", async () => {
    const ids = async (q: Record<string, string>) => (await items({ source: "ACCOUNT", ...q })).map((e) => e.id).filter((id) => Object.values(accountRows).some((r) => id === `ACCOUNT:${r}`));
    const [evening, midnight, old] = [accountRows.evening, accountRows.midnight, accountRows.old].map((r) => `ACCOUNT:${r}`);
    assert.deepEqual(await ids({ from: "2026-03-09", to: "2026-03-09", timeZone: "America/New_York" }), [evening], "23:30 local is Mar 9; local midnight is excluded");
    assert.deepEqual(await ids({ from: "2026-03-10", to: "2026-03-10", timeZone: "America/New_York" }), [midnight]);
    assert.deepEqual(await ids({ from: "2026-03-09", to: "2026-03-09", timeZone: "UTC" }), []);
    assert.deepEqual(await ids({ from: "2026-03-10", to: "2026-03-10", timeZone: "UTC" }), [midnight, evening], "newest first");
    assert.deepEqual(await ids({ from: "2025-12-01", to: "2026-03-01" }), [old], "a long range");
    assert.equal((await items({})).some((e) => e.id === old), false, "outside the default window");
  });

  test("validation: range over 92 days, unknown zone, from after to, extra params", async () => {
    assert.equal((await audit({ from: "2026-01-01", to: "2026-04-02" })).status, 200, "92 days");
    assert.equal((await audit({ from: "2026-01-01", to: "2026-04-03" })).status, 400, "93 days");
    assert.equal((await audit({ timeZone: "Mars/Olympus" })).status, 400);
    assert.equal((await audit({ from: day(1), to: day(-1) })).status, 400);
    assert.equal((await audit({ pageSize: 201 })).status, 400);
    assert.equal((await audit({ evil: 1 })).status, 400);
  });

  test("pagination is complete, has no duplicates and is ordered newest first", async () => {
    const all = await items({});
    const total = (await audit({})).body.total as number;
    assert.equal(all.length, total);
    assert.ok(total >= 10, `enough events seeded (${total})`);
    const paged: Ev[] = [];
    for (let page = 1; page <= Math.ceil(total / 3); page++) {
      const r = await audit({ page, pageSize: 3 });
      assert.equal(r.body.total, total);
      paged.push(...r.body.items);
    }
    assert.deepEqual(paged.map((e) => e.id), all.map((e) => e.id), "pages concatenate to the full list in the same order");
    assert.equal(new Set(paged.map((e) => e.id)).size, total);
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1]!.at >= all[i]!.at, "ordered by time, newest first");
    assert.deepEqual((await audit({ page: Math.ceil(total / 3) + 1, pageSize: 3 })).body.items, []);
  });

  test("no secrets, hashes, tokens or storage paths in the response", async () => {
    const r = await api(`/audit?from=2025-12-01&to=2026-03-01&pageSize=200`, { cookie: admin.cookie });
    const r2 = await audit({ pageSize: 200 });
    const keys = (await db.execute("SELECT storage_key FROM screenshots")).rows.map((x) => String(x.storage_key));
    const hashes = (await db.execute("SELECT password_hash FROM users WHERE password_hash IS NOT NULL")).rows.map((x) => String(x.password_hash));
    for (const text of [r.text, r2.text].map((t) => t.replace(/"action":"[A-Z_]+"/g, ""))) {
      assert.doesNotMatch(text, /password|token|hash|secret|refresh|cookie|storage/i);
      assert.equal(text.includes(STORAGE_DIR), false);
      for (const s of [...keys, ...hashes, emp.bearer]) assert.equal(text.includes(s), false);
    }
  });

  test("read-only: no write routes, and account_audit rows cannot be changed in the database", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal((await api("/audit", { method, cookie: admin.cookie, body: {} })).status, 404, method);
      assert.equal((await api(`/audit/ACCOUNT:${accountRows.old}`, { method, cookie: admin.cookie, body: {} })).status, 404, method);
    }
    await assert.rejects(db.execute({ sql: "UPDATE account_audit SET action = 'ACCOUNT_CREATED' WHERE id = ?", args: [accountRows.old] }), /append_only/);
    await assert.rejects(db.execute({ sql: "DELETE FROM account_audit WHERE id = ?", args: [accountRows.old] }), /append_only/);
    await assert.rejects(db.execute("DELETE FROM role_changes"), /append_only/);
  });
});

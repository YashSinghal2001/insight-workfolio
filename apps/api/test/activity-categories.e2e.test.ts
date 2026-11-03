// Application productivity labels (F05): /activity/categories CRUD and the labelled /activity/summary.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { DEFAULT_NOTICE_VERSION, localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const TZ = "Asia/Kolkata";
const H = 3_600_000;
const M = 60_000;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let emp: { id: string; bearer: string; device: string };

async function api(path: string, { method = "GET", body, cookie, bearer, device }: { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
const iso = (ms: number) => new Date(ms).toISOString();
const active = (app: string, start: number, end: number) => ({ id: randomUUID(), kind: "ACTIVE", applicationIdentifier: `com.example.${app}`, applicationName: app, startedAt: iso(start), endedAt: iso(end) });

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  admin = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: "cat@example.com", employeeCode: "CAT-1", fullName: "Category One", timezone: TZ } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: "cat@example.com", password: PASSWORD, client: "desktop" } });
  emp = { id: r.body.employee.id, bearer: login.body.accessToken, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: emp.bearer, body: { installationId: emp.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), emp.id, DEFAULT_NOTICE_VERSION, iso(Date.now() - 24 * H)] });
  // Clocked in 2 h ago: Code 60 min, Safari 10 min, idle 20 min, Slack 5 min.
  const t = Date.now() - 2 * H;
  const clock = await api("/attendance/sync", { method: "POST", bearer: emp.bearer, device: emp.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(t) }] } });
  assert.equal(clock.body.results[0].status, "ACCEPTED", clock.text);
  const up = await api("/activity/sync", {
    method: "POST", bearer: emp.bearer, device: emp.device,
    body: {
      sentAt: iso(Date.now()), platform: "macos",
      intervals: [
        active("Code", t, t + 60 * M),
        active("Safari", t + 60 * M, t + 70 * M),
        { id: randomUUID(), kind: "IDLE", applicationIdentifier: null, applicationName: null, startedAt: iso(t + 70 * M), endedAt: iso(t + 90 * M) },
        active("Slack", t + 90 * M, t + 95 * M),
      ],
    },
  });
  assert.ok(up.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), up.text);
});
after(() => app.close());

const range = () => {
  const today = localDate(Date.now(), TZ);
  const from = localDate(Date.now() - 2 * H, TZ);
  return `from=${from}&to=${today}`;
};

test("rules: admin CRUD (end, never delete), duplicates refused case-insensitively, every change audited; employees get 403", async () => {
  assert.deepEqual((await api("/activity/categories", { cookie: admin })).body, []);
  const added = await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "IDENTIFIER", value: "com.example.Code", category: "PRODUCTIVE" } });
  assert.equal(added.status, 201, added.text);
  assert.equal((await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "IDENTIFIER", value: "COM.EXAMPLE.CODE", category: "NEUTRAL" } })).status, 409);
  assert.equal((await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "NAME", value: "X", category: "UNCLASSIFIED" } })).status, 400);
  const rules = (await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "NAME", value: "Notes", category: "NEUTRAL" } })).body;
  const notes = rules.find((r: { value: string }) => r.value === "Notes");
  const changed = await api(`/activity/categories/${notes.id}`, { method: "PATCH", cookie: admin, body: { category: "UNPRODUCTIVE" } });
  assert.equal(changed.body.find((r: { id: string }) => r.id === notes.id).category, "UNPRODUCTIVE");
  assert.equal((await api(`/activity/categories/${notes.id}`, { method: "DELETE", cookie: admin })).status, 200);
  assert.equal((await api(`/activity/categories/${notes.id}`, { method: "DELETE", cookie: admin })).status, 404, "already ended");
  assert.equal((await api(`/activity/categories/${notes.id}`, { method: "PATCH", cookie: admin, body: { category: "NEUTRAL" } })).status, 404);
  assert.equal((await api("/activity/categories/not-a-uuid", { method: "DELETE", cookie: admin })).status, 400);
  const kept = await db.execute({ sql: "SELECT ended_at, ended_by FROM application_category_rules WHERE id = ?", args: [notes.id] });
  assert.ok(kept.rows[0]!.ended_at && kept.rows[0]!.ended_by, "ended, not deleted");
  const audit = await db.execute("SELECT action FROM activity_category_audit ORDER BY created_at, rowid");
  assert.deepEqual(audit.rows.map((r) => r.action), ["RULE_ADDED", "RULE_ADDED", "RULE_CHANGED", "RULE_REMOVED"]);

  const id = added.body[0].id;
  for (const [method, path, body] of [["GET", "/activity/categories"], ["POST", "/activity/categories", { matchKind: "NAME", value: "Mine", category: "PRODUCTIVE" }], ["PATCH", `/activity/categories/${id}`, { category: "NEUTRAL" }], ["DELETE", `/activity/categories/${id}`]] as const) {
    assert.equal((await api(path, { method, body, bearer: emp.bearer })).status, 403, `${method} ${path}`);
  }
});

test("summary: labels applied at read time (retroactive), idle never productive, share of clocked-in time; existing fields unchanged", async () => {
  // Current rules here: Code (identifier) PRODUCTIVE. Add Safari by name (case-insensitive) as UNPRODUCTIVE.
  await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "NAME", value: "safari", category: "UNPRODUCTIVE" } });
  const own = await api(`/activity/summary?${range()}`, { bearer: emp.bearer });
  assert.equal(own.status, 200, own.text);
  const s = own.body;
  const cat = Object.fromEntries(s.applications.map((a: { applicationName: string; category: string }) => [a.applicationName, a.category]));
  assert.deepEqual(cat, { Code: "PRODUCTIVE", Safari: "UNPRODUCTIVE", Slack: "UNCLASSIFIED" });
  // Synced intervals get clock-skew correction (a few ms), so compare within 1 s.
  const expected = [60 * M, 0, 10 * M, 5 * M];
  [s.productiveMs, s.neutralMs, s.unproductiveMs, s.unclassifiedMs].forEach((v: number, i: number) => assert.ok(Math.abs(v - expected[i]!) < 1000, `bucket ${i}: ${v} vs ${expected[i]}`));
  assert.equal(s.productiveMs + s.neutralMs + s.unproductiveMs + s.unclassifiedMs, s.activeMs, "only active time is labelled");
  assert.ok(Math.abs(s.idleMs - 20 * M) < 1000, `idle ${s.idleMs}`);
  assert.ok(s.clockedInMs >= 2 * H - M);
  assert.equal(s.productiveShare, s.productiveMs / s.clockedInMs);
  assert.equal(s.categoriesConfigured, true);
  for (const k of ["employee", "from", "to", "activeMs", "idleMs", "clockedInMs", "unobservedMs", "applications", "days", "weeks", "lastReceivedAt", "deviceLastSeenAt", "freshness", "consent", "warnings"]) assert.ok(k in s, k);
  assert.deepEqual(Object.keys(s.applications[0]).sort(), ["activeMs", "applicationIdentifier", "applicationName", "category"]);

  const asAdmin = await api(`/activity/summary?${range()}&employeeId=${emp.id}`, { cookie: admin });
  assert.equal(asAdmin.body.productiveMs, s.productiveMs, "admin sees the same totals");

  // Ending every rule relabels the past too.
  for (const r of (await api("/activity/categories", { cookie: admin })).body) await api(`/activity/categories/${r.id}`, { method: "DELETE", cookie: admin });
  const after = (await api(`/activity/summary?${range()}`, { bearer: emp.bearer })).body;
  assert.equal(after.categoriesConfigured, false);
  assert.deepEqual([after.productiveMs, after.unclassifiedMs, after.productiveShare], [0, after.activeMs, 0]);
});

test("summary with nothing clocked in: productiveShare is null", async () => {
  const s = (await api(`/activity/summary?from=2026-01-05&to=2026-01-06&employeeId=${emp.id}`, { cookie: admin })).body;
  assert.deepEqual([s.clockedInMs, s.productiveShare, s.productiveMs], [0, null, 0]);
});

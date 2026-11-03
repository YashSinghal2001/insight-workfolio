// Web product additions: GET /leave/summary (+ /me), category on /activity/timeline, per-day label split
// on /activity/summary, and GET /activity/overview. Permissions, own scope, range caps, additive fields.
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
const { addDays, DEFAULT_NOTICE_VERSION, localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const H = 3_600_000;
const M = 60_000;

type Emp = { id: string; bearer: string; device: string };
let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let ana: Emp;
let ben: Emp;

async function api(path: string, { method = "GET", body, cookie, bearer, device }: { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
const iso = (ms: number) => new Date(ms).toISOString();
const active = (name: string, start: number, end: number) => ({ id: randomUUID(), kind: "ACTIVE", applicationIdentifier: `com.example.${name}`, applicationName: name, startedAt: iso(start), endedAt: iso(end) });
const idle = (start: number, end: number) => ({ id: randomUUID(), kind: "IDLE", applicationIdentifier: null, applicationName: null, startedAt: iso(start), endedAt: iso(end) });

async function employee(n: number, name: string, timezone: string): Promise<Emp> {
  const email = `wp${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: `WP-${n}`, fullName: name, timezone } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id, bearer: login.body.accessToken, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_NOTICE_VERSION, iso(Date.now() - 24 * H)] });
  return e;
}
async function attendance(e: Emp, events: [string, number][]) {
  const r = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: events.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) } });
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
}
async function activity(e: Emp, intervals: object[]) {
  const r = await api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals } });
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
}

const todayUtc = () => localDate(Date.now(), "UTC");
// Wide enough for every seeded zone (Kolkata may already be "tomorrow"); bounds past now are clipped.
const actRange = () => `from=${addDays(todayUtc(), -1)}&to=${addDays(todayUtc(), 1)}`;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  ana = await employee(1, "Ana Product", "UTC");
  ben = await employee(2, "Ben Product", "Asia/Kolkata");

  // Ana: clocked in 2 h ago (open). Code 60 min, Safari 10 min, idle 20 min, Slack 5 min.
  const t = Date.now() - 2 * H;
  await attendance(ana, [["CLOCK_IN", t]]);
  await activity(ana, [active("Code", t, t + 60 * M), active("Safari", t + 60 * M, t + 70 * M), idle(t + 70 * M, t + 90 * M), active("Slack", t + 90 * M, t + 95 * M)]);
  // Ben: closed shift 3 h ago → 30 min ago with a 1 h break: 1 h 30 min clocked in, 20 min Code.
  const b = Date.now() - 3 * H;
  await attendance(ben, [["CLOCK_IN", b], ["BREAK_START", b + H], ["BREAK_END", b + 2 * H], ["CLOCK_OUT", b + 150 * M]]);
  await activity(ben, [active("Code", b + 10 * M, b + 30 * M)]);
});
after(() => app.close());

// ---- Leave summary ----------------------------------------------------------------------------

test("leave summary: per-employee totals by status and portion; calendar days clipped to the range; own scope on /me", async () => {
  const D = todayUtc();
  const leave = async (e: Emp, body: object) => {
    const r = await api("/leave", { method: "POST", bearer: e.bearer, body });
    assert.equal(r.status, 201, r.text);
    return r.body.id as string;
  };
  const full = await leave(ana, { startDate: addDays(D, 10), endDate: addDays(D, 12), portion: "FULL_DAY" });
  await leave(ana, { startDate: addDays(D, 14), endDate: addDays(D, 14), portion: "FIRST_HALF" });
  const short = await leave(ana, { startDate: addDays(D, 15), endDate: addDays(D, 15), portion: "SHORT", startTime: "09:00", endTime: "10:30" });
  const benFull = await leave(ben, { startDate: addDays(D, 11), endDate: addDays(D, 11), portion: "FULL_DAY", reason: "BEN-PRIVATE" });
  await leave(ben, { startDate: addDays(D, 40), endDate: addDays(D, 40), portion: "FULL_DAY" }); // outside the range
  assert.equal((await api(`/leave/${full}/approve`, { method: "POST", cookie: admin, body: {} })).status, 200);
  assert.equal((await api(`/leave/${benFull}/reject`, { method: "POST", cookie: admin, body: {} })).status, 200);
  assert.equal((await api(`/leave/${short}/cancel`, { method: "POST", bearer: ana.bearer })).status, 200);

  const range = `from=${addDays(D, 11)}&to=${addDays(D, 20)}`;
  const s = await api(`/leave/summary?${range}`, { cookie: admin });
  assert.equal(s.status, 200, s.text);
  assert.deepEqual([s.body.from, s.body.to, s.body.total, s.body.page], [addDays(D, 11), addDays(D, 20), 2, 1]);
  assert.match(s.body.meta.dayRule, /weekends included/);
  assert.equal(s.body.meta.balancesConfigured, false);
  const row = (name: string) => s.body.items.find((r: { employee: { fullName: string } }) => r.employee.fullName === name).byStatus;
  assert.deepEqual(row("Ana Product").APPROVED, { requests: 1, fullDays: 2, halfDays: 0, shortRequests: 0, shortMinutes: 0, days: 2 }, "D+10..12 clipped to D+11..12");
  assert.deepEqual(row("Ana Product").PENDING, { requests: 1, fullDays: 0, halfDays: 1, shortRequests: 0, shortMinutes: 0, days: 0.5 });
  assert.deepEqual(row("Ana Product").CANCELLED, { requests: 1, fullDays: 0, halfDays: 0, shortRequests: 1, shortMinutes: 90, days: 0 });
  assert.deepEqual(row("Ben Product").REJECTED, { requests: 1, fullDays: 1, halfDays: 0, shortRequests: 0, shortMinutes: 0, days: 1 });
  assert.equal(row("Ben Product").PENDING.requests, 0, "D+40 is outside the range");
  assert.ok(!s.text.includes("BEN-PRIVATE"), "no reasons in the summary");

  // Search, paging, and an employeeId parameter is ignored (not a filter).
  const searched = await api(`/leave/summary?${range}&q=Ben`, { cookie: admin });
  assert.deepEqual(searched.body.items.map((r: { employee: { fullName: string } }) => r.employee.fullName), ["Ben Product"]);
  const paged = await api(`/leave/summary?${range}&pageSize=1&page=2&employeeId=${ana.id}`, { cookie: admin });
  assert.deepEqual([paged.status, paged.body.total, paged.body.items.length, paged.body.items[0].employee.fullName], [200, 2, 1, "Ben Product"]);

  // Range caps and validation.
  assert.equal((await api(`/leave/summary?from=${D}&to=${addDays(D, 365)}`, { cookie: admin })).status, 200, "366 dates");
  assert.equal((await api(`/leave/summary?from=${D}&to=${addDays(D, 366)}`, { cookie: admin })).status, 400);
  assert.equal((await api(`/leave/summary?from=${D}&to=${addDays(D, -1)}`, { cookie: admin })).status, 400);
  assert.equal((await api(`/leave/summary/me?from=${D}&to=${addDays(D, 366)}`, { bearer: ana.bearer })).status, 400);

  // Employees: 403 on the admin route; /me is their own row only, and takes no employee id.
  assert.equal((await api(`/leave/summary?${range}`, { bearer: ana.bearer })).status, 403);
  const mine = await api(`/leave/summary/me?${range}`, { bearer: ana.bearer });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.body.row.employee.id, ana.id);
  assert.deepEqual(mine.body.row.byStatus, row("Ana Product"));
  assert.equal((await api(`/leave/summary/me?${range}&employeeId=${ben.id}`, { bearer: ana.bearer })).status, 400, "no id swap");
  assert.equal((await api(`/leave/summary/me?${range}`, { bearer: ben.bearer })).body.row.employee.id, ben.id);
  assert.equal((await api(`/leave/summary/me?${range}`, { cookie: admin })).status, 403, "admin without a profile");
  assert.equal((await api(`/leave/summary?${range}`)).status, 401);
  // The existing :id route still parses ids (summary is matched first).
  assert.equal((await api("/leave/not-a-uuid", { cookie: admin })).status, 400);
});

// ---- Activity ---------------------------------------------------------------------------------

test("overview before any labels: productive figures are null; per-employee totals match each summary; isolation", async () => {
  const o = await api(`/activity/overview?${actRange()}`, { cookie: admin });
  assert.equal(o.status, 200, o.text);
  assert.equal(o.body.categoriesConfigured, false);
  assert.equal(o.body.total, 2);
  for (const r of o.body.items) assert.deepEqual([r.productiveMs, r.productiveShare], [null, null]);
  const benRow = o.body.items.find((r: { employee: { id: string } }) => r.employee.id === ben.id);
  const benSummary = (await api(`/activity/summary?${actRange()}&employeeId=${ben.id}`, { cookie: admin })).body;
  assert.equal(benRow.clockedInMs, 90 * M, "sessions minus breaks (closed shift)");
  assert.equal(benRow.clockedInMs, benSummary.clockedInMs);
  assert.deepEqual([benRow.activeMs, benRow.idleMs, benRow.unobservedMs], [benSummary.activeMs, benSummary.idleMs, benSummary.unobservedMs]);
  assert.ok(benRow.lastReceivedAt);
  assert.deepEqual(Object.keys(benRow).sort(), ["activeMs", "clockedInMs", "employee", "idleMs", "lastReceivedAt", "productiveMs", "productiveShare", "unobservedMs"]);

  // Employees: 403. Signed out: 401. Over 31 days: 400.
  assert.equal((await api(`/activity/overview?${actRange()}`, { bearer: ana.bearer })).status, 403);
  assert.equal((await api(`/activity/overview?${actRange()}`)).status, 401);
  assert.equal((await api(`/activity/overview?from=2026-01-01&to=2026-02-01`, { cookie: admin })).status, 400);
  // Existing isolation is unchanged: Ana cannot read Ben's timeline or summary.
  assert.equal((await api(`/activity/timeline?${actRange()}&employeeId=${ben.id}`, { bearer: ana.bearer })).status, 404);
  assert.equal((await api(`/activity/summary?${actRange()}&employeeId=${ben.id}`, { bearer: ana.bearer })).status, 404);
});

test("labels: timeline category per item (identifier, then name; idle null), per-day split adds up, overview productive share", async () => {
  await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "IDENTIFIER", value: "com.example.Code", category: "PRODUCTIVE" } });
  await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "NAME", value: "slack", category: "UNPRODUCTIVE" } });

  const t = await api(`/activity/timeline?${actRange()}`, { bearer: ana.bearer });
  assert.equal(t.status, 200, t.text);
  const cats = t.body.items.map((i: { kind: string; applicationName: string | null; category: string | null }) => [i.kind === "IDLE" ? "idle" : i.applicationName, i.category]);
  assert.deepEqual(cats, [["Code", "PRODUCTIVE"], ["Safari", "UNCLASSIFIED"], ["idle", null], ["Slack", "UNPRODUCTIVE"]]);
  assert.deepEqual(Object.keys(t.body.items[0]).sort(), ["applicationIdentifier", "applicationName", "category", "endedAt", "id", "kind", "startedAt"]);
  assert.deepEqual(Object.keys(t.body).sort(), ["items", "page", "pageSize", "total"]);

  const s = (await api(`/activity/summary?${actRange()}`, { bearer: ana.bearer })).body;
  assert.equal(s.days.length, 3);
  const sum = (k: string) => s.days.reduce((n: number, d: Record<string, number>) => n + d[k]!, 0);
  for (const k of ["productiveMs", "neutralMs", "unproductiveMs", "unclassifiedMs"]) assert.ok(Math.abs(sum(k) - s[k]) <= 2, `${k}: days ${sum(k)} vs range ${s[k]}`);
  assert.ok(Math.abs(s.productiveMs - 60 * M) < 1000 && Math.abs(s.unproductiveMs - 5 * M) < 1000 && Math.abs(s.unclassifiedMs - 10 * M) < 1000);
  for (const d of s.days) {
    for (const k of ["date", "activeMs", "idleMs", "clockedInMs", "unobservedMs"]) assert.ok(k in d, `existing day field ${k}`);
    assert.equal(d.productiveShare, d.clockedInMs > 0 ? d.productiveMs / d.clockedInMs : null);
    assert.ok(Math.abs(d.productiveMs + d.neutralMs + d.unproductiveMs + d.unclassifiedMs - d.activeMs) <= 2, "only active time is split");
  }
  assert.equal(s.days.at(-1).productiveShare, null, "tomorrow: nothing clocked in");
  assert.deepEqual(Object.keys(s.weeks[0]).sort(), ["activeMs", "clockedInMs", "idleMs", "unobservedMs", "weekStart"], "weeks unchanged");

  const o = (await api(`/activity/overview?${actRange()}`, { cookie: admin })).body;
  assert.equal(o.categoriesConfigured, true);
  const anaRow = o.items.find((r: { employee: { id: string } }) => r.employee.id === ana.id);
  assert.ok(Math.abs(anaRow.productiveMs - s.productiveMs) <= 2);
  assert.ok(Math.abs(anaRow.activeMs - s.activeMs) <= 2 && Math.abs(anaRow.idleMs - s.idleMs) <= 2);
  assert.ok(Math.abs(anaRow.clockedInMs - s.clockedInMs) < 5000, "open shift runs to now");
  assert.equal(anaRow.productiveShare, anaRow.productiveMs / anaRow.clockedInMs);
  const benRow = o.items.find((r: { employee: { id: string } }) => r.employee.id === ben.id);
  assert.ok(Math.abs(benRow.productiveMs - 20 * M) < 1000);
  const searched = (await api(`/activity/overview?${actRange()}&q=WP-2&employeeId=${ana.id}`, { cookie: admin })).body;
  assert.deepEqual(searched.items.map((r: { employee: { id: string } }) => r.employee.id), [ben.id], "search by code; employeeId ignored");
});

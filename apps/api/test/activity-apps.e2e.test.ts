// GET /activity/apps, /activity/apps/history and /activity/risk-users (W3-APPS). In-process API, in-memory DB, synthetic people.
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

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;

type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let app: INestApplication;
let base: string;
let db: Db;
let adminId: string;
let admin: string, headCookie: string, empCookie: string;
type Person = { id: string; user: string; device: string; email: string };
let H: Person, A: Person, B: Person, C: Person;
let alpha: string, beta: string;

async function api(path: string, cookie = admin, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, cookie };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api/v1${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
async function login(email: string) {
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200, email);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function person(code: string, timezone = "UTC"): Promise<Person> {
  const [user, id, device] = [randomUUID(), randomUUID(), randomUUID()];
  const email = `${code.toLowerCase()}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'EMPLOYEE', ?)", args: [user, email, await hashPassword(PASSWORD)] });
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, ?, '2023-01-01T00:00:00.000Z')", args: [id, user, code, `Person ${code}`, timezone] });
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_identifier, device_name, platform) VALUES (?, ?, ?, 'Mac', 'macos')", args: [device, id, device] });
  return { id, user, device, email };
}
/** A closed shift; returns its id. */
async function shift(p: Person, at: string, out: string) {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')", args: [id, p.id, p.device, at, out] });
  return id;
}
/** An interval inside its own shift. `app` null = idle. Identifiers are lowercase `com.<name>`. */
async function use(p: Person, app: string | null, start: string, minutes: number) {
  const end = new Date(Date.parse(start) + minutes * M).toISOString();
  const session = await shift(p, start, end);
  await db.execute({
    sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name, started_at, ended_at,
            active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DESKTOP_MACOS', ?, ?, ?)`,
    args: [randomUUID(), p.id, p.device, session, app ? "ACTIVE" : "IDLE", app ? `com.${app.toLowerCase()}` : null, app, start, end, app ? minutes * 60 : 0, app ? 0 : minutes * 60, start, end, randomUUID()],
  });
}
async function alert(p: Person, kind: string, date: string) {
  const rule = randomUUID();
  const settings = kind === "NOT_CLOCKED_IN_BY" ? [null, "10:00"] : kind === "IDLE_SHARE_ABOVE" ? [50, null] : kind === "NO_ACTIVITY_FOR" ? [30, null] : [null, null];
  await db.execute({ sql: "INSERT INTO alert_rules (id, name, kind, threshold, at_time, created_by) VALUES (?, ?, ?, ?, ?, ?)", args: [rule, `Rule ${kind}`, kind, ...settings, adminId] });
  await db.execute({ sql: "INSERT INTO alerts (id, rule_id, employee_id, date, detail) VALUES (?, ?, ?, ?, 'Synthetic detail')", args: [randomUUID(), rule, p.id, date] });
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  admin = await login("admin@example.com");
  H = await person("APP-H");
  A = await person("APP-A");
  B = await person("APP-B", "Asia/Kolkata");
  C = await person("APP-C");
  alpha = (await api("/teams", admin, { method: "POST", body: { name: "Alpha", headUserId: H.user } })).body.id;
  beta = (await api("/teams", admin, { method: "POST", body: { name: "Beta" } })).body.id;
  assert.equal((await api(`/teams/${alpha}/members`, admin, { method: "PUT", body: { employeeIds: [H.id, A.id] } })).status, 200);
  assert.equal((await api(`/teams/${beta}/members`, admin, { method: "PUT", body: { employeeIds: [B.id] } })).status, 200);
  headCookie = await login(H.email);
  empCookie = await login(A.email);

  // Apps (May 2026): A Code 60 + 30 min, Slack 30 min, idle 10 min; B (IST) Code 20 min on 4 May and 15 min at 01:30 IST on 5 May.
  await use(A, "Code", "2026-05-04T09:00:00.000Z", 60);
  await use(A, "Slack", "2026-05-04T10:00:00.000Z", 30);
  await use(A, null, "2026-05-04T10:30:00.000Z", 10);
  await use(A, "Code", "2026-05-05T09:00:00.000Z", 30);
  await use(B, "Code", "2026-05-04T05:00:00.000Z", 20);
  await use(B, "Code", "2026-05-04T20:00:00.000Z", 15);
  assert.equal((await api("/activity/categories", admin, { method: "POST", body: { matchKind: "IDENTIFIER", value: "com.code", category: "PRODUCTIVE" } })).status, 201);

  // Risk (2–8 Mar 2026): Mon–Fri 09:00 schedule; Wed 4 Mar a holiday; A on leave Thu 5 Mar; off from 1 Jun.
  await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 10, '12345', 'test', ?, '2024-01-01T00:00:00.000Z')", args: [adminId] });
  await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (0, '09:00', 10, '12345', 'test', ?, '2026-06-01T00:00:00.000Z')", args: [adminId] });
  await db.execute({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, '2026-03-04', 'Synthetic holiday', ?)", args: [randomUUID(), adminId] });
  await db.execute({
    sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, status, decided_by, decided_at) VALUES (?, ?, ?, '2026-03-05', '2026-03-05', 'FULL_DAY', 'APPROVED', ?, '2023-01-01T00:00:00.000Z')",
    args: [randomUUID(), A.id, A.user, adminId],
  });
  // A: 8 h on Mon, Tue, Fri; nothing on the holiday or the leave day → average 8 h, no shortfall (it would be 4.8 h if those days counted).
  for (const d of ["02", "03", "06"]) await shift(A, `2026-03-${d}T09:00:00.000Z`, `2026-03-${d}T17:00:00.000Z`);
  // B (IST, 03:30Z = 09:00): 8 h Mon, Thu, Fri, 2 h Tue → average 6.5 h < 7 h; one short day.
  for (const d of ["02", "05", "06"]) await shift(B, `2026-03-${d}T03:30:00.000Z`, `2026-03-${d}T11:30:00.000Z`);
  await shift(B, "2026-03-03T03:30:00.000Z", "2026-03-03T05:30:00.000Z");
  await alert(B, "LATE_CLOCK_IN", "2026-03-02");
  await alert(B, "LATE_CLOCK_IN", "2026-03-03");
  await alert(B, "NO_ACTIVITY_FOR", "2026-03-05");
  await alert(A, "IDLE_SHARE_ABOVE", "2026-03-03");
  await alert(A, "IDLE_SHARE_ABOVE", "2026-03-10"); // outside the range
});
after(() => app.close());

const APPS = "/activity/apps?from=2026-05-04&to=2026-05-05";
type AppsBody = {
  categoriesConfigured: boolean; categories: Record<string, number>;
  applications: { key: string; applicationName: string; activeMs: number; category: string; employees: number }[];
  employees: { items: { employee: { id: string }; activeMs: number; idleMs: number; categories: Record<string, number>; topApplication: string | null }[]; total: number; page: number; pageSize: number };
};

test("apps: per app (dominant label, employees), label totals and per-employee usage; no window titles", async () => {
  const r = await api(APPS);
  assert.equal(r.status, 200, r.text);
  const b = r.body as AppsBody;
  assert.equal(b.categoriesConfigured, true);
  assert.deepEqual(b.applications.map((a) => [a.key, a.applicationName, a.activeMs / M, a.category, a.employees]), [
    ["com.code", "Code", 125, "PRODUCTIVE", 2],
    ["com.slack", "Slack", 30, "UNCLASSIFIED", 1],
  ]);
  assert.deepEqual(b.categories, { PRODUCTIVE: 125 * M, NEUTRAL: 0, UNPRODUCTIVE: 0, UNCLASSIFIED: 30 * M });
  const a = b.employees.items.find((e) => e.employee.id === A.id)!;
  assert.deepEqual([a.activeMs / M, a.idleMs / M, a.categories.PRODUCTIVE / M, a.topApplication], [120, 10, 90, "Code"]);
  const c = b.employees.items.find((e) => e.employee.id === C.id)!;
  assert.deepEqual([c.activeMs, c.topApplication], [0, null], "employees without usage are listed with zeros");
  assert.ok(!/title|window/i.test(r.text));
});

test("apps: the employee section is paginated (≤ 100); app and label totals still cover everyone", async () => {
  const all = (await api(APPS)).body as AppsBody;
  const p2 = (await api(`${APPS}&page=2&pageSize=2`)).body as AppsBody;
  assert.deepEqual([p2.employees.total, p2.employees.page, p2.employees.pageSize, p2.employees.items.length], [all.employees.total, 2, 2, all.employees.total - 2]);
  assert.deepEqual(p2.employees.items.map((e) => e.employee.id), all.employees.items.slice(2, 4).map((e) => e.employee.id));
  assert.deepEqual(p2.applications, all.applications);
  assert.deepEqual(p2.categories, all.categories);
  for (const q of ["&pageSize=101", "&page=0", "&pageSize=x"]) assert.equal((await api(`${APPS}${q}`)).status, 400, q);
});

test("apps: team filter, team head scope (own team; other team 404), employee 403, validation 400", async () => {
  const ids = (b: AppsBody) => b.employees.items.map((e) => e.employee.id).sort();
  assert.deepEqual(ids((await api(`${APPS}&teamId=${beta}`)).body), [B.id]);
  assert.deepEqual(ids((await api(APPS, headCookie)).body), [A.id, H.id].sort(), "head: their team only");
  assert.deepEqual(ids((await api(`${APPS}&teamId=${alpha}`, headCookie)).body), [A.id, H.id].sort());
  assert.equal((await api(`${APPS}&teamId=${beta}`, headCookie)).status, 404);
  assert.equal((await api(`${APPS}&teamId=${randomUUID()}`)).status, 404);
  assert.equal((await api(APPS, empCookie)).status, 403);
  const ov = await api(`/activity/overview?from=2026-05-04&to=2026-05-05&teamId=${beta}`);
  assert.deepEqual(ov.body.items.map((i: { employee: { id: string } }) => i.employee.id), [B.id], "existing overview honours teamId");
  assert.equal((await api(`/activity/overview?from=2026-05-04&to=2026-05-05&teamId=${beta}`, headCookie)).status, 404);
  assert.equal((await api("/activity/apps/history?from=2026-05-04&to=2026-05-05&app=com.code", empCookie)).status, 403);
  assert.equal((await api(`/activity/apps/history?from=2026-05-04&to=2026-05-05&app=com.code&teamId=${beta}`, headCookie)).status, 404, "head: another team's history");
  assert.equal((await api(`/activity/apps/history?from=2026-05-04&to=2026-05-05&app=com.code&teamId=${alpha}`, headCookie)).status, 200);
  for (const q of ["", "?from=2026-05-05&to=2026-05-04", "?from=2026-05-01&to=2026-06-01", "?from=2026-05-01&to=2026-05-02&teamId=nope"]) assert.equal((await api(`/activity/apps${q}`)).status, 400, q);
  assert.equal((await api("/activity/apps/history?from=2026-05-04&to=2026-05-05")).status, 400, "app is required");
});

test("history: per local day (IST interval after midnight on the next day), per employee, audited per employee", async () => {
  const count = async () => Number((await db.execute("SELECT count(*) AS n FROM account_audit WHERE action = 'EMPLOYEE_ACTIVITY_SUMMARY_VIEWED'")).rows[0]!.n);
  const before = await count();
  const r = await api("/activity/apps/history?from=2026-05-04&to=2026-05-06&app=com.code");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.applicationName, "Code");
  assert.deepEqual(r.body.days.map((d: { date: string; activeMs: number }) => [d.date, d.activeMs / M]), [["2026-05-04", 80], ["2026-05-05", 45], ["2026-05-06", 0]]);
  assert.deepEqual(r.body.employees.map((e: { employee: { id: string }; activeMs: number; days: unknown[] }) => [e.employee.id, e.activeMs / M, e.days.length]), [[A.id, 90, 2], [B.id, 35, 2]]);
  assert.equal(await count(), before + 2);
  const head = await api("/activity/apps/history?from=2026-05-04&to=2026-05-06&app=com.code", headCookie);
  assert.deepEqual(head.body.employees.map((e: { employee: { id: string } }) => e.employee.id), [A.id], "head never sees another team");
  const none = await api("/activity/apps/history?from=2026-05-04&to=2026-05-04&app=com.unknown");
  assert.deepEqual([none.status, none.body.applicationName, none.body.employees.length, none.body.days[0].activeMs], [200, null, 0, 0]);
});

type Risk = { employee: { id: string }; triggers: { trigger: string; count: number }[]; total: number; lessHours: { scheduledDays: number; averageWorkedMinutes: number; thresholdMinutes: number; shortDays: number } | null };
const RISK = "/activity/risk-users?from=2026-03-02&to=2026-03-08";

test("risk users: alert rows by kind in the range, less working hours (holiday and leave excluded), severity order", async () => {
  const r = await api(RISK);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.scheduledDailyMinutes, 480);
  assert.equal(r.body.lessHoursShare, 7 / 8);
  const items = r.body.items as Risk[];
  const of = (p: Person) => items.find((i) => i.employee.id === p.id);
  assert.deepEqual(of(B)!.triggers, [{ trigger: "LESS_WORKING_HOURS", count: 1 }, { trigger: "LATE_CLOCK_IN", count: 2 }, { trigger: "NO_ACTIVITY_FOR", count: 1 }]);
  assert.deepEqual(of(B)!.lessHours, { scheduledDays: 4, shortDays: 1, averageWorkedMinutes: 390, thresholdMinutes: 420 });
  assert.deepEqual(of(A)!.triggers, [{ trigger: "IDLE_SHARE_ABOVE", count: 1 }], "no shortfall: holiday and leave days do not count; the 10 Mar alert is outside");
  assert.equal(of(A)!.lessHours, null);
  assert.deepEqual(of(C)!.triggers, [{ trigger: "LESS_WORKING_HOURS", count: 4 }], "absent on every scheduled day");
  assert.equal(items[0]!.employee.id, B.id, "most distinct triggers first");
  assert.equal(items.at(-1)!.employee.id, A.id, "fewest violations last");
  const rule = (t: string) => r.body.rules.find((x: { trigger: string }) => x.trigger === t);
  assert.deepEqual(rule("LATE_CLOCK_IN"), { trigger: "LATE_CLOCK_IN", employees: 1, count: 2 });
  assert.deepEqual(rule("NOT_CLOCKED_IN_BY"), { trigger: "NOT_CLOCKED_IN_BY", employees: 0, count: 0 });
  assert.ok(!r.text.includes("Synthetic detail"), "no alert detail text");
});

test("risk users: today (an unfinished day) never counts toward less working hours", async () => {
  // Schedule back on (Mon–Fri) for recent days; D works 8 h on each past workday of the last week and 1 h so far today.
  await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '00:00', 10, '12345', 'test', ?, '2026-10-01T00:00:00.000Z')", args: [adminId] });
  const D = await person("APP-D");
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
  for (let n = 1; n <= 6; n++) {
    const d = day(n);
    if ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) continue;
    await shift(D, `${d}T00:00:00.000Z`, `${d}T08:00:00.000Z`);
  }
  await shift(D, `${today}T00:00:00.000Z`, new Date(Math.min(now - 1000, Date.parse(`${today}T01:00:00.000Z`))).toISOString());
  const r = await api(`/activity/risk-users?from=${day(6)}&to=${today}`);
  assert.equal(r.status, 200, r.text);
  assert.equal((r.body.items as Risk[]).find((i) => i.employee.id === D.id), undefined, "8 h on every past workday; today's 1 h is ignored");
});

test("risk users: empty (no schedule, no alerts), team filter, head own/other 404, employee 403, validation 400", async () => {
  // From 2 Jun: the schedule is off from 1 Jun 00:00Z, which is still 1 Jun in IST.
  const empty = await api("/activity/risk-users?from=2026-06-02&to=2026-06-07");
  assert.deepEqual([empty.status, empty.body.items], [200, []]);
  const ids = (b: { items: Risk[] }) => b.items.map((i) => i.employee.id).sort();
  assert.deepEqual(ids((await api(`${RISK}&teamId=${beta}`)).body), [B.id]);
  assert.deepEqual(ids((await api(RISK, headCookie)).body), [A.id, H.id].sort());
  assert.equal((await api(`${RISK}&teamId=${beta}`, headCookie)).status, 404);
  assert.equal((await api(`${RISK}&teamId=${randomUUID()}`)).status, 404);
  assert.equal((await api(RISK, empCookie)).status, 403);
  for (const q of ["", "?from=2026-03-08&to=2026-03-02", "?from=2026-01-01&to=2026-04-05", "?from=2026-03-02&to=2026-03-08&teamId=x", "?from=2026-3-2&to=2026-03-08"]) {
    assert.equal((await api(`/activity/risk-users${q}`)).status, 400, q);
  }
  // 92 days spanning four calendar months is accepted.
  assert.equal((await api("/activity/risk-users?from=2026-01-15&to=2026-04-16")).status, 200);
});

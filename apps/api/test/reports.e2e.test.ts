// F12 email reports with the MOCK provider (in-process API, in-memory DB, synthetic data). The mock
// keeps messages in memory: nothing is emailed, and deliveries are recorded as MOCKED, never SENT.
// Real provider delivery is not tested (none is integrated). See reports-none.e2e.test.ts for the default.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.REPORT_MAIL_PROVIDER = "mock";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { ReportsService, MAX_ATTEMPTS } = await import("../dist/reports/reports.service.js");
const { MAIL_TRANSPORT } = await import("../dist/reports/mail.js");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "report password 1";
const M = 60_000;
const H = 60 * M;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let reports: InstanceType<typeof ReportsService>;
let mock: { outbox: { to: string; subject: string; text: string }[]; failNext: (k: "transient" | "permanent", n?: number) => void };
let admin: string;
const adminId = randomUUID();
const admin2Id = randomUUID();
const caller = { id: adminId, role: "ADMIN" };

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string };
async function api(path: string, { method = "GET", body, cookie, bearer }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
const login = async (email: string) => {
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};
const schedule = async (body: object) => {
  const r = await api("/reports/schedules", { method: "POST", cookie: admin, body: { name: "Weekly attendance", frequency: "WEEKLY", timeZone: "Asia/Kolkata", ...body } });
  assert.equal(r.status, 201, r.text);
  return r.body;
};
const addRecipient = (id: string, userId: string) => api(`/reports/schedules/${id}/recipients`, { method: "POST", cookie: admin, body: { userId } });

// ---- Synthetic people and records (direct inserts, fixed dates) ----------------------------------
let seq = 0;
async function person(name: string, timezone: string, lastSeen: string | null) {
  const n = ++seq;
  const user = randomUUID();
  const id = randomUUID();
  const device = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'EMPLOYEE', ?)", args: [user, `rp${n}@example.com`, await hashPassword(PASSWORD)] });
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, ?)", args: [id, user, `RP-${n}`, name, timezone] });
  if (lastSeen) await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at) VALUES (?, ?, 'Mac', 'macos', ?, ?)", args: [device, id, randomUUID(), lastSeen] });
  return { id, user, device, email: `rp${n}@example.com` };
}
async function shift(p: { id: string; device: string }, inAt: string, outAt: string | null, breaks: [string, string][] = []) {
  const id = randomUUID();
  // Same order as the app: open the shift, record breaks, then clock out (the schema enforces it).
  const later = breaks.length && outAt;
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, ?)", args: [id, p.id, p.device, inAt, later ? null : outAt, later || !outAt ? "OPEN" : "CLOSED"] });
  for (const [s, e] of breaks) await db.execute({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), id, s, e] });
  if (later) await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [outAt, id] });
  return id;
}
const ist = (local: string) => new Date(`${local}+05:30`).toISOString();

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  reports = app.get(ReportsService);
  mock = app.get(MAIL_TRANSPORT);
  for (const [id, email] of [[adminId, "admin@example.com"], [admin2Id, "admin2@example.com"]]) {
    await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'ADMIN', ?)", args: [id, email, await hashPassword(PASSWORD)] });
  }
  admin = await login("admin@example.com");
});
after(() => app.close());

// Fixed clock: Tue 27 Oct 2026 05:30 IST. The last complete IST week is Mon 19 – Sun 25 Oct.
const NOW = Date.parse("2026-10-27T00:00:00Z");

describe("report content (fixed dates)", () => {
  let e1: Awaited<ReturnType<typeof person>>, e2: Awaited<ReturnType<typeof person>>, e4: Awaited<ReturnType<typeof person>>;
  let weekly: { id: string };
  let text: string;

  before(async () => {
    e1 = await person("Asha Kolkata", "Asia/Kolkata", "2026-10-26T12:00:00.000Z");
    e2 = await person("Ned NewYork", "America/New_York", "2026-10-24T12:00:00.000Z");
    await person("Nora NoRecords", "UTC", null); // no records, no device
    e4 = await person("Olly OpenShift", "UTC", "2026-10-27T00:00:00.000Z");
    const s1 = await shift(e1, ist("2026-10-19T09:00"), ist("2026-10-19T17:30"), [[ist("2026-10-19T13:00"), ist("2026-10-19T13:30")]]); // 8h worked
    await shift(e1, ist("2026-10-25T23:00"), ist("2026-10-26T01:00")); // starts Sun 25: counts, 2h
    await shift(e1, ist("2026-10-26T09:00"), ist("2026-10-26T10:00")); // next week: excluded
    await shift(e1, ist("2026-10-18T22:00"), ist("2026-10-18T23:00")); // previous week: excluded
    await shift(e2, "2026-10-26T02:00:00.000Z", "2026-10-26T05:00:00.000Z"); // Sun 25 22:00 in New York: counts, 3h
    await shift(e4, "2026-10-20T09:00:00.000Z", null); // still open
    // Project time: 90 min in the week, 60 min after it; a running timer elsewhere.
    const p = (await api("/projects", { method: "POST", cookie: admin, body: { code: "APOLLO", name: "Apollo" } })).body;
    const task = (await api(`/projects/${p.id}/tasks`, { method: "POST", cookie: admin, body: { title: "Design" } })).body.tasks[0].id;
    const entry = (start: string, end: string | null, session: string, who = e1.id) =>
      db.execute({ sql: "INSERT INTO task_time_entries (id, employee_id, project_id, task_id, attendance_session_id, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", args: [randomUUID(), who, p.id, task, session, start, end, end ? "STOPPED" : null] });
    await entry(ist("2026-10-19T10:00"), ist("2026-10-19T11:30"), s1);
    const late = String((await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ? AND clock_in_at = ?", args: [e1.id, ist("2026-10-26T09:00")] })).rows[0]!.id);
    await entry(ist("2026-10-26T09:00"), ist("2026-10-26T10:00"), late);
    const open = String((await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ?", args: [e4.id] })).rows[0]!.id);
    await entry("2026-10-20T10:00:00.000Z", null, open, e4.id);
    // Data that must never appear: a leave reason and an application name.
    await db.execute({ sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, reason) VALUES (?, ?, ?, '2026-10-21', '2026-10-21', 'FULL_DAY', 'SECRET-LEAVE-REASON')", args: [randomUUID(), e1.id, e1.user] });
    await db.execute({ sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name, started_at, ended_at, active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key)
                             VALUES (?, ?, ?, ?, 'ACTIVE', 'com.secret', 'SecretBrowserApp', ?, ?, 600, 0, 'DESKTOP_MACOS', ?, ?, ?)`, args: [randomUUID(), e1.id, e1.device, s1, ist("2026-10-19T10:00"), ist("2026-10-19T10:10"), ist("2026-10-19T10:00"), ist("2026-10-19T10:10"), randomUUID()] });

    weekly = await schedule({});
    assert.equal((await addRecipient(weekly.id, adminId)).status, 201);
    const r = await reports.runNow(caller, weekly.id, NOW);
    assert.deepEqual(r.run.period, { from: "2026-10-19", to: "2026-10-25" });
    text = mock.outbox.at(-1)!.text;
  });

  test("period, time zones and attendance totals", () => {
    assert.match(mock.outbox.at(-1)!.subject, /^\[Workfolio\] Weekly attendance: 2026-10-19 to 2026-10-25$/);
    assert.match(text, /Asha Kolkata \(RP-\d+\): 2 shift\(s\), worked 10h 00m, breaks 0h 30m; task time 1h 30m/);
    assert.match(text, /Ned NewYork \(RP-\d+\): 1 shift\(s\), worked 3h 00m, breaks 0h 00m; task time 0h 00m/, "Sun 22:00 in New York counts for that Sunday");
    assert.match(text, /Nora NoRecords \(RP-\d+\): 0 shift\(s\)/);
  });

  test("project time from completed entries in the period only", () => {
    assert.match(text, /- APOLLO Apollo: 1h 30m over 1 entry/);
  });

  test("missing-record and freshness warnings", () => {
    assert.match(text, /Nora NoRecords \(RP-\d+\): no attendance recorded in this period\./);
    assert.match(text, /Nora NoRecords \(RP-\d+\): no device has connected; records may be missing\./);
    assert.match(text, /Ned NewYork \(RP-\d+\): device last connected 2026-10-24 12:00 UTC, before the period ended/);
    assert.match(text, /Olly OpenShift \(RP-\d+\): 1 day\(s\) with an open shift/);
    assert.match(text, /1 task timer\(s\) were running/);
    assert.ok(!/Asha Kolkata \(RP-\d+\): device last connected/.test(text), "a device seen after the period: no warning");
  });

  test("sensitive data is never included", () => {
    for (const secret of ["SECRET-LEAVE-REASON", "SecretBrowserApp", "com.secret", "@example.com", "score"]) assert.ok(!text.includes(secret), secret);
    assert.match(text, /contains no screenshots, application activity, leave details or website data/);
    assert.match(text, /neither measures productivity/);
  });

  test("a one-employee report contains only that employee", async () => {
    const own = await schedule({ name: "Asha weekly", employeeId: e1.id });
    assert.equal((await addRecipient(own.id, e1.user)).status, 201, "the employee may receive their own report");
    await reports.runNow(caller, own.id, NOW);
    const mine = mock.outbox.at(-1)!;
    assert.equal(mine.to, e1.email);
    assert.match(mine.text, /Asha Kolkata/);
    assert.ok(!/NewYork|NoRecords|OpenShift|running/.test(mine.text), mine.text);
    assert.match(mine.text, /APOLLO Apollo: 1h 30m/);
  });

  test("preview generates without sending; projects can be left out", async () => {
    const before = mock.outbox.length;
    const p = await api(`/reports/schedules/${weekly.id}/preview`, { cookie: admin });
    assert.equal(p.status, 200);
    assert.ok(p.body.text.includes("ATTENDANCE"));
    assert.equal(mock.outbox.length, before);
    const noProjects = await schedule({ name: "No projects", includeProjects: false });
    const text2 = (await reports.preview(noProjects.id, NOW)).text;
    assert.ok(!text2.includes("PROJECT TIME") && !text2.includes("task time"));
  });
});

describe("recipients, duplicates, retries and authorization", () => {
  test("admin-only configuration (403 employees, 401 signed out) and validation", async () => {
    const emp = await person("Eve Employee", "UTC", null);
    const empCookie = await login(emp.email);
    const s = await schedule({ name: "Auth" });
    for (const [method, path, body] of [
      ["GET", "/reports/provider"], ["GET", "/reports/schedules"], ["POST", "/reports/schedules", { name: "x", frequency: "DAILY", timeZone: "UTC" }],
      ["PATCH", `/reports/schedules/${s.id}`, { active: false }], ["POST", `/reports/schedules/${s.id}/recipients`, { userId: emp.user }],
      ["GET", `/reports/schedules/${s.id}/preview`], ["POST", `/reports/schedules/${s.id}/run`], ["GET", "/reports/runs"], ["GET", `/reports/schedules/${s.id}/eligible-recipients`],
    ] as [string, string, object?][]) {
      assert.equal((await api(path, { method, cookie: empCookie, body })).status, 403, `${method} ${path}`);
      assert.equal((await api(path, { method, body })).status, 401, `${method} ${path} signed out`);
    }
    for (const body of [{ frequency: "HOURLY" }, { timeZone: "Mars/Base" }, { to: "x@example.com" }, { employeeId: "x" }]) {
      assert.equal((await api("/reports/schedules", { method: "POST", cookie: admin, body: { name: "x", frequency: "DAILY", timeZone: "UTC", ...body } })).status, 400, JSON.stringify(body));
    }
    assert.equal((await api("/reports/schedules", { method: "POST", cookie: admin, body: { name: "x", frequency: "DAILY", timeZone: "UTC", employeeId: randomUUID() } })).status, 404);
    assert.deepEqual((await api("/reports/provider", { cookie: admin })).body, { provider: "mock", delivers: false, schedulerSeconds: 300 });
  });

  test("recipient authorization: admins for all-employee reports; the employee only for their own; never other employees or disabled users", async () => {
    const [a, b] = [await person("Ann", "UTC", null), await person("Bob", "UTC", null)];
    const all = await schedule({ name: "All" });
    assert.equal((await addRecipient(all.id, a.user)).status, 403, "an employee cannot receive everyone's report");
    assert.equal((await addRecipient(all.id, randomUUID())).status, 404);
    assert.equal((await addRecipient(all.id, adminId)).status, 201);
    assert.equal((await addRecipient(all.id, adminId)).status, 409);
    const annOnly = await schedule({ name: "Ann only", employeeId: a.id });
    assert.equal((await addRecipient(annOnly.id, b.user)).status, 403, "another employee's report");
    assert.equal((await addRecipient(annOnly.id, a.user)).status, 201);
    const eligible = (await api(`/reports/schedules/${annOnly.id}/eligible-recipients`, { cookie: admin })).body.map((u: { email: string }) => u.email);
    assert.ok(eligible.includes(a.email) && !eligible.includes(b.email));
    const disabled = randomUUID();
    await db.execute({ sql: "INSERT INTO users (id, email, role, status) VALUES (?, 'gone@example.com', 'ADMIN', 'DISABLED')", args: [disabled] });
    assert.equal((await addRecipient(all.id, disabled)).status, 403);
    assert.equal((await api(`/reports/schedules/${all.id}/recipients`, { method: "POST", cookie: admin, body: { email: "outside@example.org" } })).status, 400, "no free-form addresses");
  });

  test("authorization is checked again at send time: removed or disabled recipients are skipped", async () => {
    const s = await schedule({ name: "Recheck", frequency: "DAILY", timeZone: "UTC" });
    const extra = randomUUID();
    await db.execute({ sql: "INSERT INTO users (id, email, role) VALUES (?, 'leaver@example.com', 'ADMIN')", args: [extra] });
    await addRecipient(s.id, extra);
    await addRecipient(s.id, admin2Id);
    await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE id = ?", args: [extra] });
    const before = mock.outbox.length;
    const r = (await reports.runNow(caller, s.id, NOW)).run;
    const byEmail = Object.fromEntries(r.deliveries.map((d: { recipient: { email: string }; status: string }) => [d.recipient.email, d.status]));
    assert.deepEqual(byEmail, { "admin2@example.com": "MOCKED", "leaver@example.com": "SKIPPED" });
    assert.equal(mock.outbox.length, before + 1);
    assert.equal(r.status, "NOT_EMAILED", "mock deliveries are never reported as delivered");
  });

  test("duplicate scheduling and duplicate sends are prevented", async () => {
    const s = await schedule({ name: "Dup", frequency: "DAILY", timeZone: "UTC" });
    await addRecipient(s.id, adminId);
    const before = mock.outbox.length;
    const first = await reports.runNow(caller, s.id, NOW);
    const again = await reports.runNow(caller, s.id, NOW);
    assert.deepEqual([first.duplicate, again.duplicate, again.run.id], [false, true, first.run.id]);
    await Promise.all([reports.deliverDue(NOW), reports.deliverDue(NOW), reports.tick(NOW)]);
    assert.equal(mock.outbox.length, before + 1, "one email per recipient per period");
    const runs = (await db.execute({ sql: "SELECT count(*) AS n FROM report_runs WHERE schedule_id = ?", args: [s.id] })).rows[0]!.n;
    assert.equal(Number(runs), 1);
  });

  test("scheduler: periods that ended after the schedule was created, once each", async () => {
    const s = await schedule({ name: "Ticker", frequency: "DAILY", timeZone: "UTC" });
    await addRecipient(s.id, adminId);
    await reports.tick(NOW); // yesterday (fixed clock) ended before the schedule existed: nothing
    assert.equal((await api(`/reports/runs?scheduleId=${s.id}`, { cookie: admin })).body.length, 0);
    const tomorrow = Date.now() + 24 * H + M;
    await reports.tick(tomorrow);
    await reports.tick(tomorrow + 5 * M);
    const runs = (await api(`/reports/runs?scheduleId=${s.id}`, { cookie: admin })).body;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].triggeredBy, null);
    assert.equal(runs[0].deliveries[0].status, "MOCKED");
    await api(`/reports/schedules/${s.id}`, { method: "PATCH", cookie: admin, body: { active: false } });
    await reports.tick(tomorrow + 24 * H);
    assert.equal((await api(`/reports/runs?scheduleId=${s.id}`, { cookie: admin })).body.length, 1, "inactive schedules do not run");
  });

  test("provider failures: transient errors retry with backoff, then succeed or fail after the limit; permanent errors fail at once", async () => {
    const run = async (name: string) => {
      const s = await schedule({ name, frequency: "DAILY", timeZone: "UTC" });
      await addRecipient(s.id, adminId);
      return s.id;
    };
    const delivery = async (id: string) => (await api(`/reports/runs?scheduleId=${id}`, { cookie: admin })).body[0].deliveries[0];

    const a = await run("Retry ok");
    mock.failNext("transient", 2);
    await reports.runNow(caller, a, NOW);
    let d = await delivery(a);
    assert.deepEqual([d.status, d.attempts.length, d.nextAttemptAt], ["RETRYING", 1, new Date(NOW + 5 * M).toISOString()]);
    assert.equal(await reports.deliverDue(NOW + M), 0, "not due yet");
    await reports.deliverDue(NOW + 5 * M);
    d = await delivery(a);
    assert.deepEqual([d.status, d.nextAttemptAt], ["RETRYING", new Date(NOW + 15 * M).toISOString()], "backoff doubles");
    await reports.deliverDue(NOW + 15 * M);
    d = await delivery(a);
    assert.deepEqual([d.status, d.attempts.map((x: { outcome: string }) => x.outcome)], ["MOCKED", ["TRANSIENT_ERROR", "TRANSIENT_ERROR", "MOCKED"]]);
    assert.equal(d.attempts[0].error, "Mock provider temporarily unavailable");

    const b = await run("Retry exhausted");
    mock.failNext("transient", MAX_ATTEMPTS);
    await reports.runNow(caller, b, NOW);
    for (const t of [5, 15, 35]) await reports.deliverDue(NOW + t * M);
    d = await delivery(b);
    assert.deepEqual([d.status, d.attempts.length], ["FAILED", MAX_ATTEMPTS]);
    assert.equal((await api(`/reports/runs?scheduleId=${b}`, { cookie: admin })).body[0].status, "FAILED");

    const c = await run("Permanent");
    mock.failNext("permanent");
    await reports.runNow(caller, c, NOW);
    d = await delivery(c);
    assert.deepEqual([d.status, d.attempts.length, d.lastError], ["FAILED", 1, "Mock provider rejected the recipient"]);
    await reports.deliverDue(NOW + 60 * M);
    assert.equal((await delivery(c)).attempts.length, 1, "never retried");
  });

  test("an interrupted send is not retried (it may already have gone out)", async () => {
    const s = await schedule({ name: "Interrupted", frequency: "DAILY", timeZone: "UTC" });
    await addRecipient(s.id, adminId);
    const runId = randomUUID();
    await db.execute({ sql: "INSERT INTO report_runs (id, schedule_id, period_from, period_to) VALUES (?, ?, '2026-10-01', '2026-10-01')", args: [runId, s.id] });
    await db.execute({ sql: "INSERT INTO report_deliveries (id, run_id, user_id, email, status, attempts, claimed_until) VALUES (?, ?, ?, 'admin@example.com', 'SENDING', 1, ?)", args: [randomUUID(), runId, adminId, new Date(NOW - M).toISOString()] });
    const before = mock.outbox.length;
    await reports.deliverDue(NOW);
    const d = (await api(`/reports/runs?scheduleId=${s.id}`, { cookie: admin })).body[0].deliveries[0];
    assert.deepEqual([d.status, d.attempts[0].outcome], ["FAILED", "INTERRUPTED"]);
    assert.equal(mock.outbox.length, before);
  });

  test("run now over HTTP; the delivery record never contains the report", async () => {
    const s = await schedule({ name: "Http", frequency: "MONTHLY", timeZone: "UTC" });
    await addRecipient(s.id, adminId);
    const r = await api(`/reports/schedules/${s.id}/run`, { method: "POST", cookie: admin });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.run.deliveries[0].provider, "mock");
    assert.equal(r.body.run.deliveries[0].status, "MOCKED");
    const stored = JSON.stringify((await db.execute({ sql: "SELECT d.*, a.* FROM report_deliveries d JOIN report_delivery_attempts a ON a.delivery_id = d.id WHERE d.run_id = ?", args: [r.body.run.id] })).rows);
    assert.ok(!stored.includes("ATTENDANCE") && /[0-9a-f]{64}/.test(stored), "only a SHA-256 of the content is kept");
    assert.equal((await api(`/reports/schedules/${s.id}/run`, { method: "POST", cookie: admin })).body.duplicate, true);
  });
});

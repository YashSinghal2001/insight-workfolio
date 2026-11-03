// W24 expected work window (GET /attendance/expected) and W17 leave-day counting with per-person
// workdays (in-process API, in-memory DB, synthetic data only).
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
const { DEFAULT_LEAVE_TYPE_ID } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let adminId: string;

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}

let seq = 0;
async function employee(timezone = "UTC") {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `exp${n}@example.com`, employeeCode: `EXP-${n}`, fullName: `Expected ${n}`, timezone } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `exp${n}@example.com`, password: PASSWORD, client: "desktop" } });
  // Profiles created "now" would not exist on the March dates below for the daily view; the window does not care, but keep them realistic.
  await db.execute({ sql: "UPDATE employee_profiles SET created_at = '2025-12-01T00:00:00.000Z' WHERE id = ?", args: [r.body.employee.id] });
  return { id: r.body.employee.id as string, bearer: login.body.accessToken as string };
}
const override = (id: string, start: string | null, days: string | null, effectiveAt = "2026-02-01T00:00:00.000Z") =>
  db.execute({
    sql: "INSERT INTO employee_tracking_overrides (id, employee_id, expected_start, workdays, idle_threshold_seconds, reason, changed_by, effective_at) VALUES (?, ?, ?, ?, NULL, 'test override', ?, ?)",
    args: [randomUUID(), id, start, days, adminId, effectiveAt],
  });

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const login = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = login.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  // Organisation schedule since 2026-01-01: 09:30 + 10 min grace, Monday–Friday; disabled during June 2026.
  for (const [enabled, at] of [[1, "2026-01-01"], [0, "2026-06-01"], [1, "2026-07-01"]] as const) {
    await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (?, '09:30', 10, '12345', 'org', ?, ?)", args: [enabled, adminId, `${at}T00:00:00.000Z`] });
  }
  // 2026-03-04 (Wednesday) is a holiday.
  await db.execute({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, '2026-03-04', 'Test holiday', ?)", args: [randomUUID(), adminId] });
});
after(() => app.close());

test("W24: own expected window uses the person's override, skips the holiday and non-workdays; others only for allowed readers", async () => {
  const [me, other] = [await employee("Asia/Kolkata"), await employee("Asia/Kolkata")];
  await override(me.id, "10:30", "123456"); // Monday–Saturday from 10:30 IST

  // 2026-03-02 is a Monday. 10:30 IST = 05:00Z (late after 05:10Z); 09:30 IST = 04:00Z.
  const own = await api("/attendance/expected?from=2026-03-02&to=2026-03-08", { bearer: me.bearer });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.employeeId, me.id);
  assert.equal(own.body.timezone, "Asia/Kolkata");
  assert.deepEqual(own.body.days.map((d: { date: string }) => d.date), ["2026-03-02", "2026-03-03", "2026-03-05", "2026-03-06", "2026-03-07"], "no holiday (Wed), Saturday included, no Sunday");
  assert.deepEqual(own.body.days[0], { date: "2026-03-02", startAt: "2026-03-02T05:00:00.000Z", dueAt: "2026-03-02T05:10:00.000Z" });

  // Admin reads any employee; the organisation schedule applies to one without an override.
  const theirs = await api(`/attendance/expected?from=2026-03-02&to=2026-03-08&employeeId=${other.id}`, { cookie: admin });
  assert.equal(theirs.status, 200, theirs.text);
  assert.deepEqual(theirs.body.days.map((d: { date: string }) => d.date), ["2026-03-02", "2026-03-03", "2026-03-05", "2026-03-06"]);
  assert.equal(theirs.body.days[0].startAt, "2026-03-02T04:00:00.000Z");
  assert.deepEqual((await api(`/attendance/expected?from=2026-03-02&to=2026-03-08&employeeId=${me.id}`, { cookie: admin })).body, own.body);

  // An employee cannot read someone else's schedule (404, as the attendance history).
  assert.equal((await api(`/attendance/expected?from=2026-03-02&to=2026-03-08&employeeId=${other.id}`, { bearer: me.bearer })).status, 404);
  assert.equal((await api(`/attendance/expected?from=2026-03-02&to=2026-03-08&employeeId=${me.id}`, { bearer: me.bearer })).status, 200);
  assert.equal((await api("/attendance/expected?from=2026-03-02&to=2026-03-08")).status, 401);
  assert.equal((await api("/attendance/expected?from=2026-03-08&to=2026-03-02", { bearer: me.bearer })).status, 400);
  assert.equal((await api("/attendance/expected?from=2026-01-01&to=2026-12-31", { bearer: me.bearer })).status, 400, "range limit");

  // A disabled schedule draws no window (and an override alone never enables it).
  assert.deepEqual((await api("/attendance/expected?from=2026-06-02&to=2026-06-07", { bearer: me.bearer })).body.days, []);
  // Admin without an employee profile and no employeeId: 403 (same rule as the history).
  assert.equal((await api("/attendance/expected?from=2026-03-02&to=2026-03-08", { cookie: admin })).status, 403);
});

test("W17: leave days are charged on the employee's own workdays (override), else the organisation's", async () => {
  const [monSat, monThu, org] = [await employee(), await employee(), await employee()];
  await override(monSat.id, null, "123456");
  await override(monThu.id, null, "1234");
  // Approved full-day leave Monday 2026-03-02 … Sunday 2026-03-08 (Wednesday is a holiday).
  for (const p of [monSat, monThu, org]) {
    const user = String((await db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [p.id] })).rows[0]!.user_id);
    await db.execute({
      sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, status, decided_by, decided_at) VALUES (?, ?, ?, '2026-03-02', '2026-03-08', 'FULL_DAY', 'APPROVED', ?, '2026-03-01T00:00:00.000Z')",
      args: [randomUUID(), p.id, user, adminId],
    });
  }
  const approved = async (p: { bearer: string }) => {
    const r = await api("/leave/balances/me?month=2026-03", { bearer: p.bearer });
    assert.equal(r.status, 200, r.text);
    return (r.body.row.balances as { leaveType: { id: string }; approvedDays: number }[]).find((b) => b.leaveType.id === DEFAULT_LEAVE_TYPE_ID)!.approvedDays;
  };
  assert.equal(await approved(monSat), 5, "Mon, Tue, Thu, Fri and Saturday");
  assert.equal(await approved(monThu), 3, "Mon, Tue, Thu: no Friday");
  assert.equal(await approved(org), 4, "organisation Mon–Fri minus the holiday");
  const all = await api("/leave/balances?month=2026-03&pageSize=100", { cookie: admin });
  assert.equal(all.status, 200, all.text);
  const row = (all.body.items as { employee: { id: string }; balances: { leaveType: { id: string }; approvedDays: number }[] }[]).find((r) => r.employee.id === monThu.id)!;
  assert.equal(row.balances.find((b) => b.leaveType.id === DEFAULT_LEAVE_TYPE_ID)!.approvedDays, 3, "admin view agrees");

  // Approval limits use the same rule: a Thu–Fri request costs a Mon–Thu person 1 day, others 2.
  const t = await api("/leave/types", { method: "POST", cookie: admin, body: { name: "One day", paid: true, yearlyAllowanceDays: 1, shortHoursPerMonth: null } });
  assert.equal(t.status, 201, t.text);
  const pending = async (p: { id: string }) => {
    const id = randomUUID();
    const user = String((await db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [p.id] })).rows[0]!.user_id);
    await db.execute({
      sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, leave_type_id) VALUES (?, ?, ?, '2026-03-12', '2026-03-13', 'FULL_DAY', ?)",
      args: [id, p.id, user, t.body.id],
    });
    return id;
  };
  const ok = await api(`/leave/${await pending(monThu)}/approve`, { method: "POST", cookie: admin, body: {} });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await api(`/leave/${await pending(org)}/approve`, { method: "POST", cookie: admin, body: {} })).status, 409);
});

// F06 alert rules (in-app): CRUD and permissions, the evaluator with an injected clock (one alert per
// rule, employee and day), and no alerts on a holiday or approved leave (in-process API, in-memory DB).
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
const { AlertsService } = await import("../dist/alerts/alerts.service.js");
const { hashPassword } = await import("../dist/auth/crypto.js");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let alerts: { evaluate: (now: number) => Promise<number> };
let admin: string;
let adminId: string;
let worker: string;

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}

/** An employee in UTC who existed long before the test dates, with one device. */
async function employee(code: string) {
  const user = randomUUID();
  const id = randomUUID();
  const device = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role) VALUES (?, ?, 'EMPLOYEE')", args: [user, `${code.toLowerCase()}@example.com`] });
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, 'UTC', '2025-01-01T00:00:00.000Z')", args: [id, user, code, `Name ${code}`] });
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, id, randomUUID()] });
  return { id, user, device };
}

async function session(e: { id: string; device: string }, clockIn: string, clockOut: string | null = null) {
  const id = randomUUID();
  await db.execute({
    sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, e.id, e.device, clockIn, clockOut, clockOut ? "CLOSED" : "OPEN"],
  });
  return id;
}

async function interval(e: { id: string; device: string }, sessionId: string, kind: "ACTIVE" | "IDLE", from: string, to: string) {
  const secs = (Date.parse(to) - Date.parse(from)) / 1000;
  await db.execute({
    sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name, started_at, ended_at,
            active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DESKTOP_MACOS', ?, ?, ?)`,
    args: [randomUUID(), e.id, e.device, sessionId, kind, kind === "ACTIVE" ? "com.secret" : null, kind === "ACTIVE" ? "SecretPlannedApp" : null, from, to,
      kind === "ACTIVE" ? secs : 0, kind === "IDLE" ? secs : 0, from, to, randomUUID()],
  });
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  alerts = app.get(AlertsService);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  admin = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email: "w@example.com", employeeCode: "W-1", fullName: "Worker", timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  worker = (await api("/auth/login", { method: "POST", body: { email: "w@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken;
  // Not an employee yet on the test dates, so the evaluator ignores this account.
  await db.execute({ sql: "UPDATE employee_profiles SET created_at = '2030-01-01T00:00:00.000Z' WHERE id = ?", args: [e.body.employee.id] });
});
after(() => app.close());

test("rule CRUD: validated per kind; admins only", async () => {
  for (const bad of [
    { kind: "NOT_CLOCKED_IN_BY", name: "No time" },
    { kind: "NOT_CLOCKED_IN_BY", name: "Bad time", atTime: "24:00" },
    { kind: "IDLE_SHARE_ABOVE", name: "Too high", threshold: 100 },
    { kind: "NO_ACTIVITY_FOR", name: "Too short", threshold: 4 },
    { kind: "LATE_CLOCK_IN", name: "Extra", threshold: 5 },
    { kind: "UNKNOWN", name: "X" },
    { kind: "LATE_CLOCK_IN", name: " " },
  ]) {
    assert.equal((await api("/alerts/rules", { method: "POST", cookie: admin, body: bad })).status, 400, JSON.stringify(bad));
  }
  const r = await api("/alerts/rules", { method: "POST", cookie: admin, body: { kind: "NO_ACTIVITY_FOR", name: " Quiet ", threshold: 45 } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual({ name: r.body.name, kind: r.body.kind, threshold: r.body.threshold, atTime: r.body.atTime, active: r.body.active, by: r.body.createdBy.id }, { name: "Quiet", kind: "NO_ACTIVITY_FOR", threshold: 45, atTime: null, active: true, by: adminId });
  assert.equal((await api(`/alerts/rules/${r.body.id}`, { method: "PATCH", cookie: admin, body: { threshold: 3 } })).status, 400);
  assert.equal((await api(`/alerts/rules/${r.body.id}`, { method: "PATCH", cookie: admin, body: { atTime: "10:00" } })).status, 400, "not a parameter of this kind");
  assert.equal((await api(`/alerts/rules/${r.body.id}`, { method: "PATCH", cookie: admin, body: {} })).status, 400);
  const p = await api(`/alerts/rules/${r.body.id}`, { method: "PATCH", cookie: admin, body: { name: "Very quiet", threshold: 90, active: false } });
  assert.equal(p.status, 200, p.text);
  assert.deepEqual([p.body.name, p.body.threshold, p.body.active], ["Very quiet", 90, false]);
  assert.equal((await api("/alerts/rules", { cookie: admin })).body.length, 1);

  const routes: [string, string, unknown?][] = [["/alerts", "GET"], ["/alerts/rules", "GET"], ["/alerts/rules", "POST", { kind: "LATE_CLOCK_IN", name: "Mine" }],
    [`/alerts/rules/${r.body.id}`, "PATCH", { name: "Mine" }], [`/alerts/rules/${r.body.id}`, "DELETE"], [`/alerts/${randomUUID()}/acknowledge`, "POST"]];
  for (const [path, method, body] of routes) {
    assert.equal((await api(path, { method, body, bearer: worker })).status, 403, `${method} ${path}`);
    assert.equal((await api(path, { method, body })).status, 401, `${method} ${path} signed out`);
  }
  assert.equal((await api(`/alerts/rules/${r.body.id}`, { method: "DELETE", cookie: admin })).status, 204);
  assert.equal((await api(`/alerts/rules/${r.body.id}`, { method: "DELETE", cookie: admin })).status, 404);
  assert.equal((await api("/alerts/rules/not-a-uuid", { method: "DELETE", cookie: admin })).status, 400);
});

test("evaluator: one alert per rule, employee and day; none on approved leave or a holiday; acknowledge once", async () => {
  // Every day a workday, 09:00 with no grace, in force well before the test dates.
  await db.execute({
    sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 0, '1234567', 'test', ?, '2025-06-01T00:00:00.000Z')",
    args: [adminId],
  });
  const late = await employee("LATE-1");
  const absent = await employee("ABS-1");
  const onLeave = await employee("LEAVE-1");
  // LATE-1: yesterday (2026-03-02) 30 min active, 60 min idle (67% idle); today late at 09:30, then silent after 11:00.
  const y1 = await session(late, "2026-03-02T08:00:00.000Z", "2026-03-02T10:00:00.000Z");
  await interval(late, y1, "ACTIVE", "2026-03-02T08:00:00.000Z", "2026-03-02T08:30:00.000Z");
  await interval(late, y1, "IDLE", "2026-03-02T08:30:00.000Z", "2026-03-02T09:30:00.000Z");
  const t1 = await session(late, "2026-03-03T09:30:00.000Z");
  await interval(late, t1, "ACTIVE", "2026-03-03T09:30:00.000Z", "2026-03-03T11:00:00.000Z");
  // LEAVE-1 does exactly the same, but has approved leave for both days: never alerted.
  const y3 = await session(onLeave, "2026-03-02T08:00:00.000Z", "2026-03-02T10:00:00.000Z");
  await interval(onLeave, y3, "ACTIVE", "2026-03-02T08:00:00.000Z", "2026-03-02T08:30:00.000Z");
  await interval(onLeave, y3, "IDLE", "2026-03-02T08:30:00.000Z", "2026-03-02T09:30:00.000Z");
  const t3 = await session(onLeave, "2026-03-03T09:30:00.000Z");
  await interval(onLeave, t3, "ACTIVE", "2026-03-03T09:30:00.000Z", "2026-03-03T11:00:00.000Z");
  await db.execute({
    sql: `INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, status, decided_by, decided_at)
          VALUES (?, ?, ?, '2026-03-02', '2026-03-03', 'FULL_DAY', 'APPROVED', ?, '2026-03-01T00:00:00.000Z')`,
    args: [randomUUID(), onLeave.id, onLeave.user, adminId],
  });
  // ABS-1 never clocks in; pending (not approved) leave does not count.
  await db.execute({ sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion) VALUES (?, ?, ?, '2026-03-03', '2026-03-03', 'FULL_DAY')", args: [randomUUID(), absent.id, absent.user] });

  const rule = async (body: object) => (await api("/alerts/rules", { method: "POST", cookie: admin, body })).body.id as string;
  const rLate = await rule({ kind: "LATE_CLOCK_IN", name: "Late" });
  const rBy = await rule({ kind: "NOT_CLOCKED_IN_BY", name: "Not in by 10", atTime: "10:00" });
  const rIdle = await rule({ kind: "IDLE_SHARE_ABOVE", name: "Idle > 50%", threshold: 50 });
  const rQuiet = await rule({ kind: "NO_ACTIVITY_FOR", name: "Quiet 30", threshold: 30 });
  const rOff = await rule({ kind: "LATE_CLOCK_IN", name: "Inactive" });
  await api(`/alerts/rules/${rOff}`, { method: "PATCH", cookie: admin, body: { active: false } });

  assert.equal(await alerts.evaluate(Date.parse("2026-03-03T09:59:00Z")), 2, "before 10:00 and before 30 quiet minutes: late (today) and idle (yesterday) only");
  assert.equal(await alerts.evaluate(Date.parse("2026-03-03T12:00:00Z")), 2, "then: not clocked in by 10:00, and 60 quiet minutes");
  assert.equal(await alerts.evaluate(Date.parse("2026-03-03T12:05:00Z")), 0, "a later tick adds nothing");
  assert.equal(await alerts.evaluate(Date.parse("2026-03-03T23:59:00Z")), 0);

  const list = (await api("/alerts?status=all", { cookie: admin })).body as { id: string; rule: { id: string }; employee: { id: string }; date: string; detail: string }[];
  const key = (a: (typeof list)[number]) => `${a.rule.id}|${a.employee.id}|${a.date}`;
  assert.deepEqual(list.map(key).sort(), [`${rLate}|${late.id}|2026-03-03`, `${rBy}|${absent.id}|2026-03-03`, `${rIdle}|${late.id}|2026-03-02`, `${rQuiet}|${late.id}|2026-03-03`].sort());
  assert.ok(!list.some((a) => a.employee.id === onLeave.id), "approved leave: no alerts");
  assert.ok(!list.some((a) => a.rule.id === rOff), "inactive rule: no alerts");
  assert.match(list.find((a) => a.rule.id === rLate)!.detail, /09:30, 30 min after/);
  assert.match(list.find((a) => a.rule.id === rIdle)!.detail, /Idle 67% of 90 min/);
  assert.ok(!JSON.stringify(list).includes("Secret"), "no application names in alerts");

  // 2026-03-05 is a holiday: nobody is alerted that day; the next workday alerts again.
  await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = '2026-03-03T17:00:00.000Z', status = 'CLOSED' WHERE id IN (?, ?)", args: [t1, t3] });
  assert.equal((await api("/holidays", { method: "POST", cookie: admin, body: { date: "2026-03-05", name: "Test Day" } })).status, 201);
  assert.equal(await alerts.evaluate(Date.parse("2026-03-05T12:00:00Z")), 0, "holiday");
  assert.equal(await alerts.evaluate(Date.parse("2026-03-06T12:00:00Z")), 3, "next day: all three not clocked in by 10:00");

  // Acknowledge once; open / acknowledged filters.
  const open = (await api("/alerts", { cookie: admin })).body as { id: string }[];
  assert.equal(open.length, 7);
  assert.equal((await api(`/alerts/${open[0]!.id}/acknowledge`, { method: "POST", cookie: admin })).status, 204);
  assert.equal((await api(`/alerts/${open[0]!.id}/acknowledge`, { method: "POST", cookie: admin })).status, 409);
  assert.equal((await api(`/alerts/${randomUUID()}/acknowledge`, { method: "POST", cookie: admin })).status, 404);
  const acked = (await api("/alerts?status=acknowledged", { cookie: admin })).body;
  assert.deepEqual([acked.length, acked[0].acknowledgedBy.id], [1, adminId]);
  assert.equal((await api("/alerts", { cookie: admin })).body.length, 6);
  assert.equal((await api("/alerts?status=bogus", { cookie: admin })).status, 400);

  // Deleting a rule removes its alerts.
  assert.equal((await api(`/alerts/rules/${rBy}`, { method: "DELETE", cookie: admin })).status, 204);
  assert.equal((await api("/alerts?status=all", { cookie: admin })).body.length, 3);
});

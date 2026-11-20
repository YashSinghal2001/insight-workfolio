// W2-PROFILE: GET /employees/:id/analytics (in-process API, in-memory DB, synthetic people).
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
const iso = (ms: number) => new Date(ms).toISOString();

interface Emp { id: string; userId: string; bearer: string; device: string }

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let adminId: string;
let head: Emp;
let member: Emp;
let outsider: Emp;
let nyc: Emp;

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, text };
}

async function employee(code: string, timezone = "UTC"): Promise<Emp> {
  const email = `${code.toLowerCase()}@example.com`;
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: code, fullName: `Person ${code}`, timezone } });
  assert.equal(e.status, 201, e.text);
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const device = randomUUID();
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, e.body.employee.id, randomUUID()] });
  return { id: e.body.employee.id, userId: e.body.employee.userId, bearer: login.body.accessToken, device };
}

const shift = (who: Emp, inAt: string, outAt: string | null) =>
  db.execute({
    sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, ?)",
    args: [randomUUID(), who.id, who.device, inAt, outAt, outAt ? "CLOSED" : "OPEN"],
  });

const audits = async (target: Emp) =>
  (await db.execute({ sql: "SELECT action, actor_user_id, metadata FROM account_audit WHERE target_user_id = ? AND action LIKE 'EMPLOYEE_%' ORDER BY rowid", args: [target.userId] })).rows;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  head = await employee("HEAD-1");
  member = await employee("MEM-1");
  outsider = await employee("OUT-1");
  nyc = await employee("NYC-1", "America/New_York");
  const alpha = await api("/teams", { method: "POST", cookie: admin, body: { name: "Alpha", headUserId: head.userId } });
  assert.equal((await api(`/teams/${alpha.body.id}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [member.id, head.id] } })).status, 200);

  // member: one closed 1 h shift 3 h ago, one correction request, one leave request today.
  const start = Date.now() - 3 * 3_600_000;
  await shift(member, iso(start), iso(start + 3_600_000));
  await db.execute({
    sql: "INSERT INTO correction_requests (id, employee_id, requested_by, type, proposed, reason) VALUES (?, ?, ?, 'MISSING_CLOCK_OUT', '{}', 'forgot to clock out')",
    args: [randomUUID(), member.id, member.userId],
  });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await api("/leave", { method: "POST", bearer: member.bearer, body: { startDate: today, endDate: today, portion: "FULL_DAY" } })).status, 201);

  // New York: 09:00 local on both sides of the 1 Nov 2026 DST change (EDT → EST).
  await shift(nyc, "2026-10-30T13:00:00.000Z", "2026-10-30T21:00:00.000Z");
  await shift(nyc, "2026-11-02T14:00:00.000Z", "2026-11-02T22:00:00.000Z");
});
after(() => app.close());

test("admin: default range (last 14 days), KPIs, log, corrections, leave, activity sections; audit row written", async () => {
  const before = (await audits(member)).length;
  const r = await api(`/employees/${member.id}/analytics`, { cookie: admin });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.employee.id, member.id);
  assert.deepEqual(r.body.teams, ["Alpha"]);
  assert.equal(r.body.days.length, 14);
  assert.equal(r.body.kpis.workedMinutes, 60);
  assert.equal(r.body.kpis.daysWorked, 1);
  assert.equal(r.body.clockLog.length, 1);
  assert.equal(r.body.clockLog[0].workedMinutes, 60);
  assert.equal(r.body.clockLog[0].open, false);
  assert.equal(r.body.corrections.PENDING, 1);
  assert.equal(r.body.leave.PENDING.requests, 1);
  assert.ok(Array.isArray(r.body.topApps), "admins hold activity:read-all");
  assert.equal(r.body.kpis.activeMinutes, 0);
  const rows = (await audits(member)).slice(before);
  assert.deepEqual(rows.map((a) => a.action), ["EMPLOYEE_ATTENDANCE_VIEWED", "EMPLOYEE_ACTIVITY_SUMMARY_VIEWED"]);
  assert.equal(rows[0]!.actor_user_id, adminId);
  const meta = JSON.parse(String(rows[0]!.metadata));
  assert.equal(meta.view, "analytics");
  assert.equal(meta.employeeId, member.id);
  assert.equal(meta.from, r.body.from);
});

test("team head: own member 200, out-of-team 404; own record served without an audit row", async () => {
  assert.equal((await api(`/employees/${member.id}/analytics`, { bearer: head.bearer })).status, 200);
  const before = (await audits(outsider)).length;
  assert.equal((await api(`/employees/${outsider.id}/analytics`, { bearer: head.bearer })).status, 404);
  assert.equal((await audits(outsider)).length, before, "refused reads are not audited");
  const self = (await audits(head)).length;
  assert.equal((await api(`/employees/${head.id}/analytics`, { bearer: head.bearer })).status, 200);
  assert.equal((await audits(head)).length, self);
});

test("plain employee 403 (even for their own record); unknown id 404; malformed id 400", async () => {
  assert.equal((await api(`/employees/${member.id}/analytics`, { bearer: member.bearer })).status, 403);
  assert.equal((await api(`/employees/${outsider.id}/analytics`, { bearer: member.bearer })).status, 403);
  assert.equal((await api(`/employees/${randomUUID()}/analytics`, { cookie: admin })).status, 404);
  assert.equal((await api("/employees/not-a-uuid/analytics", { cookie: admin })).status, 400);
});

test("range validation: 400 for one-sided, reversed, > 92 days or malformed; 92 days accepted", async () => {
  for (const q of ["from=2026-01-01", "from=2026-02-01&to=2026-01-01", "from=2026-01-01&to=2026-04-03", "from=x&to=2026-01-01"]) {
    assert.equal((await api(`/employees/${member.id}/analytics?${q}`, { cookie: admin })).status, 400, q);
  }
  const ok = await api(`/employees/${member.id}/analytics?from=2026-01-01&to=2026-04-02`, { cookie: admin });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.days.length, 92);
});

test("empty range: zero-filled days, empty log, null typical times", async () => {
  const r = await api(`/employees/${member.id}/analytics?from=2025-01-01&to=2025-01-07`, { cookie: admin });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.days.length, 7);
  assert.ok(r.body.days.every((d: { workedMinutes: number }) => d.workedMinutes === 0));
  assert.deepEqual(r.body.clockLog, []);
  assert.equal(r.body.kpis.typicalFirstInLocal, null);
  assert.equal(r.body.corrections.PENDING, 0);
  assert.equal(r.body.leave.PENDING.requests, 0);
});

test("DST: a New York employee's shifts read 09:00 local on both sides of the change, 8 h each", async () => {
  const r = await api(`/employees/${nyc.id}/analytics?from=2026-10-30&to=2026-11-03`, { cookie: admin });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.clockLog.map((e: { date: string; startLocal: string; endLocal: string; workedMinutes: number }) => [e.date, e.startLocal, e.endLocal, e.workedMinutes]), [
    ["2026-11-02", "09:00", "17:00", 480],
    ["2026-10-30", "09:00", "17:00", 480],
  ]);
  assert.equal(r.body.kpis.typicalFirstInLocal, "09:00");
  assert.equal(r.body.kpis.workedMinutes, 960);
  assert.deepEqual(r.body.days.map((d: { date: string }) => d.date), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
});

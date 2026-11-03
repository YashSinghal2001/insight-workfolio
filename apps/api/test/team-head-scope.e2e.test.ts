// W41 remaining team-head scopes: attendance summary, org timesheets (+ export), leave list/detail/summary/
// balances, and the leave approve/reject exception for team heads (in-process API, in-memory DB, synthetic data).
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
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();

interface Emp { id: string; userId: string; bearer: string }

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let head: Emp; // heads Alpha and is also a member of it (own requests must still be refused)
let member: Emp; // in Alpha
let outsider: Emp; // in no team headed by `head`
let plain: Emp; // heads nothing

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: text && json ? JSON.parse(text) : undefined, text, headers: res.headers };
}

/** Employee with a device and one closed session today. */
async function employee(code: string): Promise<Emp> {
  const email = `${code.toLowerCase()}@example.com`;
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: code, fullName: `Person ${code}`, timezone: "UTC" } });
  assert.equal(e.status, 201, e.text);
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const id = e.body.employee.id;
  const device = randomUUID();
  const start = Date.now() - 3 * 3_600_000;
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, id, randomUUID()] });
  await db.execute({
    sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')",
    args: [randomUUID(), id, device, iso(start), iso(start + 3_600_000)],
  });
  return { id, userId: e.body.employee.userId, bearer: login.body.accessToken };
}

const ask = async (who: Emp, offset: number) => {
  const r = await api("/leave", { method: "POST", bearer: who.bearer, body: { startDate: day(offset), endDate: day(offset), portion: "FULL_DAY" } });
  assert.equal(r.status, 201, r.text);
  return r.body.id as string;
};

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  head = await employee("HEAD-1");
  member = await employee("MEM-1");
  outsider = await employee("OUT-1");
  plain = await employee("PLN-1");
  const alpha = await api("/teams", { method: "POST", cookie: admin, body: { name: "Alpha", headUserId: head.userId } });
  assert.equal((await api(`/teams/${alpha.body.id}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [member.id, head.id] } })).status, 200);
});
after(() => app.close());

const ids = (r: { body: { items: { employeeId?: string; employee?: { id: string } }[] } }) => r.body.items.map((i) => i.employeeId ?? i.employee!.id).sort();

test("/auth/me exposes teamHead", async () => {
  assert.equal((await api("/auth/me", { bearer: head.bearer })).body.teamHead, true);
  assert.equal((await api("/auth/me", { bearer: plain.bearer })).body.teamHead, false);
  assert.equal((await api("/auth/me", { cookie: admin })).body.teamHead, false);
});

test("attendance summary: admins the organisation, a head their teams, plain employees 403", async () => {
  const all = await api("/attendance/summary", { cookie: admin });
  assert.equal(all.status, 200, all.text);
  assert.equal(all.body.totalActiveEmployees, 4);
  const team = await api("/attendance/summary", { bearer: head.bearer });
  assert.equal(team.status, 200, team.text);
  assert.equal(team.body.totalActiveEmployees, 2);
  assert.ok(team.body.netWorkMsToday > 0 && team.body.netWorkMsToday < all.body.netWorkMsToday);
  assert.equal((await api("/attendance/summary", { bearer: plain.bearer })).status, 403);
  assert.equal((await api("/attendance/summary", { bearer: member.bearer })).status, 403);
});

test("daily attendance view: admins the organisation, a head only their teams' rows, plain employees 403", async () => {
  const all = await api(`/attendance/daily?date=${TODAY}&pageSize=100`, { cookie: admin });
  assert.equal(all.status, 200, all.text);
  assert.equal(all.body.total, 4);
  const team = await api(`/attendance/daily?date=${TODAY}&pageSize=100`, { bearer: head.bearer });
  assert.equal(team.status, 200, team.text);
  assert.deepEqual(ids(team), [head.id, member.id].sort());
  assert.ok(!ids(team).includes(outsider.id), "outsider absent");
  assert.equal(Object.values(team.body.summary as Record<string, number>).reduce((a, b) => a + b, 0), 2, "summary counts only the team");
  assert.equal((await api(`/attendance/daily?date=${TODAY}&q=${encodeURIComponent("Person")}`, { bearer: head.bearer })).body.total, 2, "search stays scoped");
  assert.equal((await api(`/attendance/daily?date=${TODAY}`, { bearer: plain.bearer })).status, 403);
  assert.equal((await api(`/attendance/daily?date=${TODAY}`, { bearer: member.bearer })).status, 403);
});

test("org timesheets and export: scoped to the head's teams; plain employees 403", async () => {
  const range = `from=${YESTERDAY}&to=${TODAY}`;
  assert.deepEqual(ids(await api(`/attendance/timesheets?${range}`, { bearer: head.bearer })), [head.id, member.id].sort());
  assert.equal((await api(`/attendance/timesheets?${range}`, { cookie: admin })).body.total, 4);
  assert.equal((await api(`/attendance/timesheets?${range}`, { bearer: plain.bearer })).status, 403);
  // Per-employee detail: own team 200, outside 404 (already team-scoped through attendanceTarget).
  assert.equal((await api(`/attendance/timesheet?${range}&employeeId=${member.id}`, { bearer: head.bearer })).status, 200);
  assert.equal((await api(`/attendance/timesheet?${range}&employeeId=${outsider.id}`, { bearer: head.bearer })).status, 404);
  assert.equal((await api(`/attendance/timesheet?${range}&employeeId=${member.id}`, { bearer: plain.bearer })).status, 404);

  const csv = await api(`/attendance/timesheets/export?${range}`, { bearer: head.bearer });
  assert.equal(csv.status, 200, csv.text);
  assert.equal(csv.headers.get("x-export-rows"), "2");
  assert.ok(csv.text.includes("MEM-1") && csv.text.includes("HEAD-1") && !csv.text.includes("OUT-1"));
  assert.equal((await api(`/attendance/timesheets/export?${range}&q=OUT`, { bearer: head.bearer })).headers.get("x-export-rows"), "0", "search cannot widen the scope");
  assert.equal((await api(`/attendance/timesheets/export?${range}`, { cookie: admin })).headers.get("x-export-rows"), "4");
  const xlsx = await api(`/attendance/timesheets/export?${range}&format=xlsx`, { bearer: head.bearer });
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.headers.get("x-export-rows"), "2");
  assert.equal((await api(`/attendance/timesheets/export?${range}`, { bearer: plain.bearer })).status, 403);
});

test("leave reads: a head lists, opens, summarises and sees balances of their team only", async () => {
  const mine = await ask(member, 3);
  const theirs = await ask(outsider, 3);
  const own = await ask(head, 4);
  const plains = await ask(plain, 5);

  const list = await api("/leave?status=PENDING", { bearer: head.bearer });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.items.map((r: { id: string }) => r.id).sort(), [mine, own].sort());
  assert.equal(list.body.total, 2);
  assert.deepEqual((await api("/leave?mine=true", { bearer: head.bearer })).body.items.map((r: { id: string }) => r.id), [own], "mine stays own");
  assert.equal((await api(`/leave?employeeId=${member.id}`, { bearer: head.bearer })).body.total, 1);
  assert.equal((await api(`/leave?employeeId=${outsider.id}`, { bearer: head.bearer })).status, 404);
  assert.equal((await api(`/leave/${mine}`, { bearer: head.bearer })).status, 200);
  assert.equal((await api(`/leave/${theirs}`, { bearer: head.bearer })).status, 404);

  // A plain employee still sees only their own.
  assert.deepEqual((await api("/leave", { bearer: plain.bearer })).body.items.map((r: { id: string }) => r.id), [plains]);
  assert.equal((await api(`/leave/${mine}`, { bearer: plain.bearer })).status, 404);
  assert.equal((await api(`/leave?employeeId=${member.id}`, { bearer: plain.bearer })).status, 404);
  assert.equal((await api("/leave", { cookie: admin })).body.total, 4);

  const range = `from=${TODAY}&to=${day(10)}`;
  assert.deepEqual(ids(await api(`/leave/summary?${range}`, { bearer: head.bearer })), [head.id, member.id].sort());
  assert.equal((await api(`/leave/summary?${range}`, { cookie: admin })).body.total, 4);
  assert.equal((await api(`/leave/summary?${range}`, { bearer: plain.bearer })).status, 403);
  const balances = await api("/leave/balances", { bearer: head.bearer });
  assert.equal(balances.status, 200, balances.text);
  assert.deepEqual(ids(balances), [head.id, member.id].sort());
  assert.equal((await api("/leave/balances", { cookie: admin })).body.total, 4);
  assert.equal((await api("/leave/balances", { bearer: plain.bearer })).status, 403);
});

test("leave decisions: a head approves/rejects their members only, never their own; plain employees 403", async () => {
  const a = await ask(member, 6);
  const b = await ask(member, 7);
  const out = await ask(outsider, 6);
  const own = await ask(head, 7);
  const decide = (id: string, action: string, bearer: string) => api(`/leave/${id}/${action}`, { method: "POST", bearer, body: { note: "ok" } });

  const approved = await decide(a, "approve", head.bearer);
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.status, "APPROVED");
  assert.equal(approved.body.decidedBy.id, head.userId);
  assert.equal((await decide(b, "reject", head.bearer)).body.status, "REJECTED");
  assert.equal((await decide(out, "approve", head.bearer)).status, 404, "outside the team");
  assert.equal((await decide(out, "reject", head.bearer)).status, 404);
  assert.equal((await decide(own, "approve", head.bearer)).status, 403, "own request, even as a member of the team");
  assert.equal((await decide(own, "reject", head.bearer)).status, 403);
  assert.equal((await decide(out, "approve", plain.bearer)).status, 403, "plain employee");
  assert.equal((await decide(out, "approve", member.bearer)).status, 403, "member of a team");
  const stillPending = await db.execute({ sql: "SELECT status FROM leave_requests WHERE id IN (?, ?)", args: [out, own] });
  assert.deepEqual(stillPending.rows.map((r) => r.status), ["PENDING", "PENDING"]);
  // Admins unchanged.
  assert.equal((await api(`/leave/${out}/approve`, { method: "POST", cookie: admin, body: {} })).status, 200);
  assert.equal((await api(`/leave/${own}/approve`, { method: "POST", cookie: admin, body: {} })).status, 200);
});

test("removing the head ends the exception at once", async () => {
  const c = await ask(member, 8);
  const teams = await api("/teams", { cookie: admin });
  await api(`/teams/${teams.body[0].id}`, { method: "PATCH", cookie: admin, body: { headUserId: null } });
  assert.equal((await api(`/leave/${c}/approve`, { method: "POST", bearer: head.bearer, body: {} })).status, 403);
  assert.equal((await api("/attendance/summary", { bearer: head.bearer })).status, 403);
  assert.equal((await api("/auth/me", { bearer: head.bearer })).body.teamHead, false);
});

// W40 teams, W41 team head scope, F08/F09 team-scoped screenshots and timelapses, F05 per-team
// productivity (in-process API, in-memory DB, synthetic data).
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
const iso = (ms: number) => new Date(ms).toISOString();

interface Emp { id: string; userId: string; bearer: string; session: string; shot: string; timelapse: string }

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let adminId: string;
let head: Emp; // heads team Alpha (not a member of it)
let member: Emp; // in Alpha
let outsider: Emp; // in no team headed by `head`

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

/** Employee with a device, a closed session, one REGISTERED screenshot (no file) and one FAILED timelapse. */
async function employee(code: string): Promise<Emp> {
  const email = `${code.toLowerCase()}@example.com`;
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: code, fullName: `Person ${code}`, timezone: "UTC" } });
  assert.equal(e.status, 201, e.text);
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const id = e.body.employee.id;
  const [device, session, shot, timelapse] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const start = Date.now() - 3 * 3_600_000;
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, id, randomUUID()] });
  await db.execute({
    sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')",
    args: [session, id, device, iso(start), iso(start + 3_600_000)],
  });
  await db.execute({
    sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height,
            mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 100, 100, 'image/webp', 100, ?, 'MICROSOFT_GRAPH', ?, 'REGISTERED')`,
    args: [shot, id, device, session, randomUUID(), iso(start + 60_000), iso(start + 60_000), "a".repeat(64), `k/${shot}`],
  });
  await db.execute({
    sql: "INSERT INTO timelapses (id, employee_id, attendance_session_id, requested_by, fps, status, frames_total, error) VALUES (?, ?, ?, ?, 4, 'FAILED', 1, 'test')",
    args: [timelapse, id, session, adminId],
  });
  return { id, userId: e.body.employee.userId, bearer: login.body.accessToken, session, shot, timelapse };
}

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
});
after(() => app.close());

let alpha: string;

test("without teams nothing changes: employees see only their own records, admins everything", async () => {
  assert.equal((await api("/employees", { bearer: head.bearer })).status, 403);
  assert.equal((await api(`/employees/${member.id}`, { bearer: head.bearer })).status, 404);
  assert.equal((await api(`/attendance/history?employeeId=${member.id}`, { bearer: head.bearer })).status, 404);
  assert.equal((await api("/employees?pageSize=100", { cookie: admin })).body.total, 3);
});

test("admins create, rename, set head and members, deactivate; validation; employees cannot manage teams", async () => {
  const created = await api("/teams", { method: "POST", cookie: admin, body: { name: " Alpha ", headUserId: head.userId } });
  assert.equal(created.status, 201, created.text);
  alpha = created.body.id;
  assert.equal(created.body.name, "Alpha");
  assert.deepEqual(created.body.head, { id: head.userId, email: "head-1@example.com", fullName: "Person HEAD-1" });
  assert.equal((await api("/teams", { method: "POST", cookie: admin, body: { name: "alpha" } })).status, 409);
  for (const bad of [{ name: "" }, { name: "X", extra: 1 }, { name: "X", headUserId: "nope" }]) {
    assert.equal((await api("/teams", { method: "POST", cookie: admin, body: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api("/teams", { method: "POST", cookie: admin, body: { name: "Ghost", headUserId: randomUUID() } })).status, 400, "head must exist");

  const beta = await api("/teams", { method: "POST", cookie: admin, body: { name: "Beta" } });
  assert.equal(beta.body.head, null);
  const members = await api(`/teams/${alpha}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [member.id] } });
  assert.equal(members.status, 200, members.text);
  assert.deepEqual(members.body.members.map((m: { id: string }) => m.id), [member.id]);
  // Several teams per employee; replacing the list removes the others.
  assert.equal((await api(`/teams/${beta.body.id}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [member.id, outsider.id] } })).body.members.length, 2);
  assert.equal((await api(`/teams/${beta.body.id}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [outsider.id] } })).body.members.length, 1);
  assert.equal((await api(`/teams/${beta.body.id}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [randomUUID()] } })).status, 400);
  assert.equal((await api(`/teams/${randomUUID()}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [] } })).status, 404);

  const renamed = await api(`/teams/${beta.body.id}`, { method: "PATCH", cookie: admin, body: { name: "Beta EU" } });
  assert.equal(renamed.body.name, "Beta EU");
  assert.equal((await api(`/teams/${beta.body.id}`, { method: "PATCH", cookie: admin, body: { name: "Alpha" } })).status, 409);
  assert.equal((await api(`/teams/${beta.body.id}`, { method: "PATCH", cookie: admin, body: {} })).status, 400);
  assert.equal((await api(`/teams/${randomUUID()}`, { method: "PATCH", cookie: admin, body: { active: false } })).status, 404);
  const list = await api("/teams", { cookie: admin });
  assert.deepEqual(list.body.map((t: { name: string }) => t.name), ["Alpha", "Beta EU"]);

  for (const who of [head, member]) {
    for (const [path, method, body] of [["/teams", "GET"], ["/teams", "POST", { name: "Mine" }], [`/teams/${alpha}`, "PATCH", { name: "Mine" }], [`/teams/${alpha}/members`, "PUT", { employeeIds: [] }]] as const) {
      assert.equal((await api(path, { method, body, bearer: who.bearer })).status, 403, `${method} ${path}`);
    }
  }
});

test("a team head sees and acts on only their team's members; everything else is 404 (or 403 for org-wide routes)", async () => {
  const h = { bearer: head.bearer };
  const ids = (r: { body: { items: { id?: string; employeeId?: string; employee?: { id: string } }[] } }) => r.body.items.map((i) => i.id ?? i.employeeId ?? i.employee!.id);
  const range = `from=${YESTERDAY}&to=${TODAY}&tz=UTC`;

  // Employees
  assert.deepEqual(ids(await api("/employees", h)), [member.id]);
  assert.equal((await api(`/employees/${member.id}`, h)).status, 200);
  assert.equal((await api(`/employees/${member.id}/devices`, h)).status, 200);
  assert.equal((await api(`/employees/${outsider.id}`, h)).status, 404);
  assert.equal((await api(`/employees/${outsider.id}/devices`, h)).status, 404);
  assert.equal((await api(`/employees/${head.id}`, h)).status, 200, "own record still readable");

  // Screenshots (F08)
  const gallery = await api(`/screenshots/gallery?${range}`, h);
  assert.equal(gallery.status, 200, gallery.text);
  assert.deepEqual(gallery.body.items.map((i: { id: string }) => i.id), [member.shot]);
  assert.equal((await api(`/screenshots/gallery?${range}&employeeId=${outsider.id}`, h)).body.total, 0);
  assert.equal((await api(`/screenshots/overview?${range}`, h)).body.total, 1);
  assert.equal((await api(`/screenshots/overview?${range}`, { cookie: admin })).body.total, 3);
  assert.equal((await api(`/screenshots?employeeId=${member.id}`, h)).status, 200);
  assert.equal((await api(`/screenshots?employeeId=${outsider.id}`, h)).status, 404);
  assert.equal((await api(`/screenshots/${member.shot}`, h)).status, 200);
  assert.equal((await api(`/screenshots/${outsider.shot}`, h)).status, 404);
  assert.equal((await api(`/screenshots/${member.shot}/content`, h)).status, 409, "past the scope check: not stored yet");
  assert.equal((await api(`/screenshots/${outsider.shot}/content`, h)).status, 404);

  // Timelapses (F09)
  assert.equal((await api(`/timelapses?${range}&employeeId=${member.id}`, h)).status, 200);
  assert.equal((await api(`/timelapses?${range}&employeeId=${outsider.id}`, h)).status, 404);
  assert.equal((await api(`/timelapses/${member.timelapse}`, h)).status, 200);
  assert.equal((await api(`/timelapses/${outsider.timelapse}`, h)).status, 404);
  assert.equal((await api(`/timelapses/${outsider.timelapse}/content`, h)).status, 404);
  assert.equal((await api(`/timelapses/${outsider.timelapse}/cancel`, { ...h, method: "POST" })).status, 404);
  assert.equal((await api(`/timelapses/${outsider.timelapse}`, { ...h, method: "DELETE" })).status, 404);
  assert.equal((await api("/timelapses", { ...h, method: "POST", body: { sessionId: outsider.session } })).status, 404);

  // Attendance
  assert.equal((await api(`/attendance/history?employeeId=${member.id}`, h)).status, 200);
  assert.equal((await api(`/attendance/history?employeeId=${outsider.id}`, h)).status, 404);
  assert.equal((await api(`/attendance/timesheet?employeeId=${member.id}&from=${YESTERDAY}&to=${TODAY}`, h)).status, 200);
  assert.equal((await api(`/attendance/timesheet?employeeId=${outsider.id}&from=${YESTERDAY}&to=${TODAY}`, h)).status, 404);
  assert.deepEqual(ids(await api("/attendance/overview", h)), [member.id]);

  // Activity
  assert.equal((await api(`/activity/summary?employeeId=${member.id}&from=${YESTERDAY}&to=${TODAY}`, h)).status, 200);
  assert.equal((await api(`/activity/summary?employeeId=${outsider.id}&from=${YESTERDAY}&to=${TODAY}`, h)).status, 404);
  assert.equal((await api(`/activity/timeline?employeeId=${outsider.id}&from=${YESTERDAY}&to=${TODAY}`, h)).status, 404);
  assert.deepEqual(ids(await api(`/activity/overview?from=${YESTERDAY}&to=${TODAY}`, h)), [member.id]);

  // Org-wide or admin routes not marked team-scoped stay admin-only.
  // (attendance summary, org timesheets and the daily attendance view are team-scoped since W41: team-head-scope.e2e.test.ts)
  for (const path of ["/settings/screenshots", "/screenshots/retention"]) {
    assert.equal((await api(path, h)).status, 403, path);
  }
  // A plain member gets none of it.
  assert.equal((await api(`/screenshots/gallery?${range}`, { bearer: member.bearer })).status, 403);
  assert.equal((await api(`/timelapses/${member.timelapse}`, { bearer: member.bearer })).status, 403);
  assert.equal((await api(`/employees/${outsider.id}`, { bearer: member.bearer })).status, 404);
});

test("F05 per team: admins get every active team, a head only theirs, members nothing", async () => {
  const q = `/teams/productivity?from=${YESTERDAY}&to=${TODAY}`;
  const all = await api(q, { cookie: admin });
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(all.body.items.map((t: { team: { name: string }; memberCount: number }) => [t.team.name, t.memberCount]), [["Alpha", 1], ["Beta EU", 1]]);
  assert.equal(all.body.categoriesConfigured, false);
  assert.equal(all.body.items[0].productiveShare, null);
  assert.ok(all.body.items[0].clockedInMs > 0, "member's session counted");
  assert.deepEqual((await api(q, { bearer: head.bearer })).body.items.map((t: { team: { id: string } }) => t.team.id), [alpha]);
  assert.equal((await api(q, { bearer: member.bearer })).status, 403);
  assert.equal((await api(`/teams/productivity?from=${TODAY}&to=${YESTERDAY}`, { cookie: admin })).status, 400);
});

test("deactivating the team or removing the head ends the head's access at once", async () => {
  assert.equal((await api(`/teams/${alpha}`, { method: "PATCH", cookie: admin, body: { active: false } })).status, 200);
  assert.equal((await api(`/screenshots/gallery?from=${YESTERDAY}&to=${TODAY}`, { bearer: head.bearer })).status, 403);
  assert.equal((await api(`/employees/${member.id}`, { bearer: head.bearer })).status, 404);
  assert.equal((await api(`/teams/${alpha}`, { method: "PATCH", cookie: admin, body: { active: true } })).status, 200);
  assert.equal((await api(`/employees/${member.id}`, { bearer: head.bearer })).status, 200);
  assert.equal((await api(`/teams/${alpha}`, { method: "PATCH", cookie: admin, body: { headUserId: null } })).status, 200);
  assert.equal((await api(`/employees/${member.id}`, { bearer: head.bearer })).status, 404);
  assert.equal((await api("/employees", { bearer: head.bearer })).status, 403);
});

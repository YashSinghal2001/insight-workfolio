// ?teamId= on attendance reads, and overview freshness (W1-ATT-DATA). In-process API, in-memory DB, synthetic people.
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
const MONTH = TODAY.slice(0, 7);
const WEEK_AGO = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();

interface Emp { id: string; userId: string; bearer: string; device: string }

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let head: Emp, member: Emp, outsider: Emp, plain: Emp;
let alpha: string, beta: string;

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: text && json ? JSON.parse(text) : undefined, text };
}

/** Employee (UTC) with a device and one closed session two days ago. */
async function employee(code: string): Promise<Emp> {
  const email = `${code.toLowerCase()}@example.com`;
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: code, fullName: `Person ${code}`, timezone: "UTC" } });
  assert.equal(e.status, 201, e.text);
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const id = e.body.employee.id;
  const device = randomUUID();
  const start = Date.now() - 2 * 86_400_000;
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, id, randomUUID()] });
  await db.execute({
    sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')",
    args: [randomUUID(), id, device, iso(start), iso(start + 3_600_000)],
  });
  return { id, userId: e.body.employee.userId, bearer: login.body.accessToken, device };
}

const ROUTES = [
  `/attendance/overview?pageSize=100`,
  `/attendance/daily?date=${TODAY}&pageSize=100`,
  `/attendance/summary?date=${TODAY}`,
  `/attendance/timesheets?from=${WEEK_AGO}&to=${TODAY}&pageSize=100`,
  `/attendance/timesheets/export?from=${WEEK_AGO}&to=${TODAY}`,
  `/attendance/monthly?month=${MONTH}&pageSize=100`,
  `/attendance/monthly/export?month=${MONTH}`,
  `/attendance/late?from=${TODAY}&to=${TODAY}`,
];
/** Employee ids a route's response lists (null for the summary, which only counts). */
function ids(route: string, r: { body?: { items?: { employeeId?: string; employee?: { id: string } }[] }; text: string }): string[] | null {
  if (route.includes("summary") || route.includes("/late") || route.includes("export")) return null; // checked separately
  return r.body!.items!.map((i) => i.employeeId ?? i.employee!.id).sort();
}

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
  alpha = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Alpha", headUserId: head.userId } })).body.id;
  beta = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Beta" } })).body.id;
  assert.equal((await api(`/teams/${alpha}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [member.id, head.id] } })).status, 200);
  assert.equal((await api(`/teams/${beta}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [outsider.id] } })).status, 200);
});
after(() => app.close());

test("admin: any team narrows every route to its active members; without teamId nothing changes", async () => {
  for (const route of ROUTES) {
    const all = await api(route, { cookie: admin });
    const a = await api(`${route}&teamId=${alpha}`, { cookie: admin });
    const b = await api(`${route}&teamId=${beta}`, { cookie: admin });
    for (const r of [all, a, b]) assert.equal(r.status, 200, `${route}: ${r.text}`);
    const listed = ids(route, a);
    if (listed) {
      assert.deepEqual(listed, [head.id, member.id].sort(), route);
      assert.deepEqual(ids(route, b), [outsider.id], route);
      assert.equal(ids(route, all)!.length, 4, `${route} unfiltered`);
    }
    if (route.includes("export")) {
      assert.match(a.text, /MEM-1/, route);
      assert.doesNotMatch(a.text, /OUT-1|PLN-1/, route);
      assert.match(all.text, /OUT-1/, route);
    }
    if (route.includes("summary")) {
      assert.equal(all.body.totalActiveEmployees, 4);
      assert.equal(a.body.totalActiveEmployees, 2);
      assert.equal(b.body.totalActiveEmployees, 1);
    }
  }
});

test("unknown team → 404 for admins; a head's own team ok; another team → 404; plain employee → 403; bad id → 400", async () => {
  const unknown = randomUUID();
  for (const route of ROUTES) {
    assert.equal((await api(`${route}&teamId=${unknown}`, { cookie: admin })).status, 404, route);
    const own = await api(`${route}&teamId=${alpha}`, { bearer: head.bearer });
    assert.equal(own.status, 200, `${route}: ${own.text}`);
    const listed = ids(route, own);
    if (listed) assert.deepEqual(listed, [head.id, member.id].sort(), route);
    assert.equal((await api(`${route}&teamId=${beta}`, { bearer: head.bearer })).status, 404, route);
    assert.equal((await api(`${route}&teamId=${alpha}`, { bearer: plain.bearer })).status, 403, route);
    assert.equal((await api(route, { bearer: plain.bearer })).status, 403, route);
    assert.equal((await api(`${route}&teamId=not-a-uuid`, { cookie: admin })).status, 400, route);
  }
});

test("a deactivated team is unknown to its head and filters to nobody for admins", async () => {
  const gamma = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Gamma", headUserId: head.userId } })).body.id;
  await api(`/teams/${gamma}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [plain.id] } });
  await db.execute({ sql: "UPDATE teams SET active = 0 WHERE id = ?", args: [gamma] });
  assert.equal((await api(`/attendance/monthly?month=${MONTH}&teamId=${gamma}`, { bearer: head.bearer })).status, 404);
  const r = await api(`/attendance/monthly?month=${MONTH}&teamId=${gamma}`, { cookie: admin });
  assert.deepEqual([r.status, r.body.total], [200, 0]);
});

test("overview freshness: clocked in but the device silent for 6 h is not online (regression); a fresh device is", async () => {
  const now = Date.now();
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [randomUUID(), member.id, member.device, iso(now - 7 * 3_600_000)] });
  await db.execute({ sql: "UPDATE devices SET last_seen_at = ? WHERE id = ?", args: [iso(now - 6 * 3_600_000), member.device] });
  // A second, older registered device must not hide the most recent contact.
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at) VALUES (?, ?, 'Old', 'macos', ?, ?)", args: [randomUUID(), member.id, randomUUID(), iso(now - 30 * 86_400_000)] });
  const row = async () => (await api(`/attendance/overview?teamId=${alpha}`, { cookie: admin })).body.items.find((i: { employeeId: string }) => i.employeeId === member.id);
  let r = await row();
  assert.equal(r.state, "CLOCKED_IN", "attendance state is unchanged");
  assert.equal(r.online, false);
  assert.equal(r.lastSeenAt, iso(now - 6 * 3_600_000));
  assert.equal(r.deviceLastSeenAt, r.lastSeenAt);
  await db.execute({ sql: "UPDATE devices SET last_seen_at = ? WHERE id = ?", args: [iso(now - 60_000), member.device] });
  r = await row();
  assert.equal(r.online, true);
  await db.execute({ sql: "UPDATE devices SET last_seen_at = ? WHERE id = ?", args: [iso(now - 5 * 60_000 - 5_000), member.device] });
  assert.equal((await row()).online, false, "just past the 5-minute window");
  const never = (await api(`/attendance/overview?teamId=${beta}`, { cookie: admin })).body.items[0];
  assert.deepEqual([never.lastSeenAt, never.online], [null, false]);
});

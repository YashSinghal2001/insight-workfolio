// W36 leave types and balances, W35 short-leave quota (in-process API, in-memory DB, synthetic data).
// Balances are computed per type and calendar year; approval past the limit is refused (409).
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
const { addDays, localDate, DEFAULT_LEAVE_TYPE_ID } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;

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
async function employee() {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `bal${n}@example.com`, employeeCode: `BAL-${n}`, fullName: `Balance ${n}`, timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `bal${n}@example.com`, password: PASSWORD, client: "desktop" } });
  return { id: r.body.employee.id as string, bearer: login.body.accessToken as string };
}
const createType = async (body: object) => {
  const r = await api("/leave/types", { method: "POST", cookie: admin, body: { paid: true, yearlyAllowanceDays: null, shortHoursPerMonth: null, ...body } });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: string; name: string };
};
const ask = async (who: { bearer: string }, body: object) => {
  const r = await api("/leave", { method: "POST", ...who, body });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: string; leaveType: { id: string; name: string; paid: boolean } };
};
const approve = (id: string) => api(`/leave/${id}/approve`, { method: "POST", cookie: admin, body: {} });
const full = (start: string, end = start, leaveTypeId?: string) => ({ startDate: start, endDate: end, portion: "FULL_DAY", ...(leaveTypeId ? { leaveTypeId } : {}) });
const short = (date: string, startTime: string, endTime: string, leaveTypeId: string) => ({ startDate: date, endDate: date, portion: "SHORT", startTime, endTime, leaveTypeId });
// Dates well inside the request window, all in one calendar year and month.
const today = localDate(Date.now(), "UTC");
const month = today.slice(0, 7);
const day = (n: number) => `${month}-${String(n).padStart(2, "0")}`;
type Balance = { leaveType: { id: string }; allowanceDays: number | null; approvedDays: number; pendingDays: number; remainingDays: number | null; shortHoursPerMonth: number | null; shortApprovedHours: number; shortPendingHours: number; shortRemainingHours: number | null };
const mine = async (who: { bearer: string }) => {
  const r = await api(`/leave/balances/me?month=${month}`, who);
  assert.equal(r.status, 200, r.text);
  return r.body as { month: string; row: { employee: { id: string }; balances: Balance[] }; dayRule: string };
};

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const login = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = login.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
after(() => app.close());

test("admins manage types (validated, unique names, deactivate not delete); employees see active types only and cannot manage", async () => {
  const e = await employee();
  const t = await createType({ name: "Sick", paid: true, yearlyAllowanceDays: 10 });
  assert.equal((await api("/leave/types", { method: "POST", cookie: admin, body: { name: "sick", paid: false, yearlyAllowanceDays: null, shortHoursPerMonth: null } })).status, 409, "unique name, any case");
  assert.equal((await api("/leave/types", { method: "POST", cookie: admin, body: { name: "X", paid: true, yearlyAllowanceDays: -1, shortHoursPerMonth: null } })).status, 400);
  assert.equal((await api("/leave/types", { method: "POST", bearer: e.bearer, body: { name: "Mine", paid: true, yearlyAllowanceDays: 99, shortHoursPerMonth: null } })).status, 403);
  assert.equal((await api(`/leave/types/${t.id}`, { method: "PATCH", bearer: e.bearer, body: { yearlyAllowanceDays: 99 } })).status, 403);
  const changed = await api(`/leave/types/${t.id}`, { method: "PATCH", cookie: admin, body: { yearlyAllowanceDays: 12, active: false } });
  assert.equal(changed.status, 200, changed.text);
  assert.deepEqual({ ...changed.body, id: undefined }, { id: undefined, name: "Sick", paid: true, yearlyAllowanceDays: 12, shortHoursPerMonth: null, active: false });
  assert.equal((await api(`/leave/types/${DEFAULT_LEAVE_TYPE_ID}`, { method: "PATCH", cookie: admin, body: { active: false } })).status, 400, "the default type stays active");
  assert.equal((await api(`/leave/types/${randomUUID()}`, { method: "PATCH", cookie: admin, body: { paid: false } })).status, 404);

  const adminList = (await api("/leave/types", { cookie: admin })).body as { id: string; active: boolean }[];
  assert.ok(adminList.some((x) => x.id === t.id && !x.active));
  const empList = (await api("/leave/types", { bearer: e.bearer })).body as { id: string; name: string }[];
  assert.ok(empList.some((x) => x.id === DEFAULT_LEAVE_TYPE_ID && x.name === "General"));
  assert.ok(!empList.some((x) => x.id === t.id), "inactive types are hidden from employees");
  const r = await api("/leave", { method: "POST", bearer: e.bearer, body: full(addDays(today, 5), addDays(today, 5), t.id) });
  assert.equal(r.status, 400, "inactive types cannot be requested");
  assert.equal((await api("/leave", { method: "POST", bearer: e.bearer, body: full(addDays(today, 5), addDays(today, 5), randomUUID()) })).status, 400);
});

test("a request with no type uses General (unpaid, no limit), so older clients and existing requests keep working", async () => {
  const e = await employee();
  const r = await ask(e, full(day(1), day(28)));
  assert.deepEqual(r.leaveType, { id: DEFAULT_LEAVE_TYPE_ID, name: "General", paid: false });
  assert.equal((await approve(r.id)).status, 200, "no allowance: never refused");
  const general = (await mine(e)).row.balances.find((b) => b.leaveType.id === DEFAULT_LEAVE_TYPE_ID)!;
  assert.equal(general.approvedDays, 28);
  assert.equal(general.remainingDays, null);
});

test("approval past the yearly allowance is refused with a clear message; rejected and cancelled leave never uses balance", async () => {
  const e = await employee();
  const t = await createType({ name: `Annual ${randomUUID().slice(0, 6)}`, yearlyAllowanceDays: 2.5 });
  const a = await ask(e, full(day(1), day(2), t.id));
  const b = await ask(e, { startDate: day(3), endDate: day(3), portion: "FIRST_HALF", leaveTypeId: t.id });
  const c = await ask(e, full(day(4), day(4), t.id));
  let bal = (await mine(e)).row.balances.find((x) => x.leaveType.id === t.id)!;
  assert.deepEqual([bal.allowanceDays, bal.approvedDays, bal.pendingDays, bal.remainingDays], [2.5, 0, 3.5, 2.5], "pending is shown, not deducted");
  assert.equal((await approve(a.id)).status, 200);
  assert.equal((await approve(b.id)).status, 200);
  const refused = await approve(c.id);
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, new RegExp(`exceed the ${t.name} balance for ${month.slice(0, 4)}: 0 of 2.5 days remain and this request uses 1`));
  assert.equal((await api(`/leave/${c.id}`, { cookie: admin })).body.status, "PENDING", "a refused approval changes nothing");
  assert.equal((await api(`/leave/${c.id}/reject`, { method: "POST", cookie: admin, body: {} })).status, 200, "rejecting is always possible");
  bal = (await mine(e)).row.balances.find((x) => x.leaveType.id === t.id)!;
  assert.deepEqual([bal.approvedDays, bal.pendingDays, bal.remainingDays], [2.5, 0, 0]);

  // Raising the allowance makes room again.
  await api(`/leave/types/${t.id}`, { method: "PATCH", cookie: admin, body: { yearlyAllowanceDays: 3.5 } });
  const d = await ask(e, full(day(5), day(5), t.id));
  assert.equal((await approve(d.id)).status, 200);
});

test("concurrent approvals cannot both fit the last day", async () => {
  const e = await employee();
  const t = await createType({ name: `Race ${randomUUID().slice(0, 6)}`, yearlyAllowanceDays: 1 });
  const [a, b] = [await ask(e, full(day(6), day(6), t.id)), await ask(e, full(day(7), day(7), t.id))];
  const results = (await Promise.all([approve(a.id), approve(b.id)])).map((r) => r.status).sort();
  assert.deepEqual(results, [200, 409]);
});

test("short leave counts against the monthly hours quota (W35), not days", async () => {
  const e = await employee();
  const t = await createType({ name: `Short ${randomUUID().slice(0, 6)}`, yearlyAllowanceDays: 0, shortHoursPerMonth: 2 });
  const a = await ask(e, short(day(8), "09:00", "10:30", t.id));
  const b = await ask(e, short(day(9), "09:00", "10:00", t.id));
  const c = await ask(e, short(day(10), "09:00", "09:30", t.id));
  assert.equal((await approve(a.id)).status, 200, "short leave uses no days, even with a 0-day allowance");
  const refused = await approve(b.id);
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, new RegExp(`short-leave limit for ${month}: 0.5 of 2 hours remain and this request uses 1`));
  assert.equal((await approve(c.id)).status, 200, "exactly the remaining half hour fits");
  const bal = (await mine(e)).row.balances.find((x) => x.leaveType.id === t.id)!;
  assert.deepEqual([bal.approvedDays, bal.shortHoursPerMonth, bal.shortApprovedHours, bal.shortPendingHours, bal.shortRemainingHours], [0, 2, 2, 1, 0]);
});

test("isolation: employees see only their own balances; admins see everyone's", async () => {
  const [e1, e2] = [await employee(), await employee()];
  const me = await mine(e1);
  assert.equal(me.row.employee.id, e1.id);
  assert.equal((await api(`/leave/balances/me?employeeId=${e2.id}`, { bearer: e1.bearer })).status, 400, "no employeeId accepted");
  assert.equal((await api("/leave/balances", { bearer: e1.bearer })).status, 403);
  assert.equal((await api("/leave/balances/me?month=2026-13", { bearer: e1.bearer })).status, 400);
  assert.equal((await api("/leave/balances/me", { cookie: admin })).status, 403, "admin without a profile");
  const all = await api(`/leave/balances?month=${month}&q=Balance&pageSize=100`, { cookie: admin });
  assert.equal(all.status, 200, all.text);
  const ids = (all.body.items as { employee: { id: string } }[]).map((r) => r.employee.id);
  assert.ok(ids.includes(e1.id) && ids.includes(e2.id));
  assert.equal(all.body.month, month);
});

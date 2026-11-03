// W38 holiday calendar, W18 absence respecting holidays, W39 holiday CSV import
// (in-process API, in-memory DB, synthetic data).
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
const { localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let adminId: string;
let worker: { id: string; bearer: string };

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  admin = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email: "hol@example.com", employeeCode: "HOL-1", fullName: "Holiday Worker", timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  worker = { id: e.body.employee.id, bearer: (await api("/auth/login", { method: "POST", body: { email: "hol@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken };
  await db.execute({ sql: "UPDATE employee_profiles SET created_at = '2025-01-01T00:00:00.000Z' WHERE id = ?", args: [worker.id] });
});
after(() => app.close());

test("admins add, list and remove holidays; one per date; employees cannot manage them", async () => {
  const add = await api("/holidays", { method: "POST", cookie: admin, body: { date: "2026-08-15", name: " Independence Day " } });
  assert.equal(add.status, 201, add.text);
  assert.equal(add.body.name, "Independence Day");
  assert.equal(add.body.createdBy.id, adminId);
  assert.equal((await api("/holidays", { method: "POST", cookie: admin, body: { date: "2026-08-15", name: "Again" } })).status, 409);
  for (const bad of [{ date: "2026-02-30", name: "X" }, { date: "2026-08-16", name: "" }, { date: "2026-08-16", name: "X", extra: 1 }]) {
    assert.equal((await api("/holidays", { method: "POST", cookie: admin, body: bad })).status, 400, JSON.stringify(bad));
  }
  for (const [path, method, body] of [["/holidays", "GET"], ["/holidays", "POST", { date: "2026-08-17", name: "Mine" }], ["/holidays/import", "POST", { csv: "2026-08-17,Mine" }], [`/holidays/${add.body.id}`, "DELETE"]] as const) {
    assert.equal((await api(path, { method, body, bearer: worker.bearer })).status, 403, `${method} ${path}`);
  }
  const list = await api("/holidays?year=2026", { cookie: admin });
  assert.deepEqual(list.body.map((h: { date: string }) => h.date), ["2026-08-15"]);
  assert.deepEqual((await api("/holidays?year=2027", { cookie: admin })).body, []);
  assert.equal((await api(`/holidays/${add.body.id}`, { method: "DELETE", cookie: admin })).status, 204);
  assert.equal((await api(`/holidays/${add.body.id}`, { method: "DELETE", cookie: admin })).status, 404);
});

test("CSV import (W39): all or nothing; dates already present are skipped", async () => {
  await api("/holidays", { method: "POST", cookie: admin, body: { date: "2026-12-25", name: "Christmas" } });
  const bad = await api("/holidays/import", { method: "POST", cookie: admin, body: { csv: "date,name\n2026-12-31,New Year's Eve\nnot-a-date,X\n" } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /Line 3/);
  assert.equal((await api("/holidays?year=2026", { cookie: admin })).body.length, 1, "nothing imported on error");
  const ok = await api("/holidays/import", { method: "POST", cookie: admin, body: { csv: 'date,name\n2026-12-25,Christmas Day\n2026-12-31,"New Year\'s Eve, office"\n2027-01-01,New Year\n' } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body, { created: 2, skipped: ["2026-12-25"] });
  const all = (await api("/holidays", { cookie: admin })).body as { date: string; name: string }[];
  assert.deepEqual(all.map((h) => [h.date, h.name]), [["2026-12-25", "Christmas"], ["2026-12-31", "New Year's Eve, office"], ["2027-01-01", "New Year"]]);
});

test("the daily view (W18) labels a holiday HOLIDAY, never ABSENT; other workdays are still ABSENT", async () => {
  await db.execute({
    sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 0, '1234567', 'test', ?, '2025-06-01T00:00:00.000Z')",
    args: [adminId],
  });
  await api("/holidays", { method: "POST", cookie: admin, body: { date: "2026-03-02", name: "Spring Day" } });
  const daily = async (date: string) => (await api(`/attendance/daily?date=${date}&pageSize=100`, { cookie: admin })).body;
  const h = await daily("2026-03-02");
  const row = h.items.find((r: { employee: { id: string } }) => r.employee.id === worker.id);
  assert.equal(row.status, "HOLIDAY");
  assert.deepEqual(row.holiday, { name: "Spring Day" });
  assert.equal(h.summary.ABSENT, 0);
  assert.equal(h.meta.holidaysConfigured, true);
  const w = await daily("2026-03-03");
  assert.equal(w.items.find((r: { employee: { id: string } }) => r.employee.id === worker.id).status, "ABSENT");
  assert.equal(w.items[0].holiday, null);
});

test("leave days skip holidays: a range over a holiday uses one day less of the balance", async () => {
  const month = localDate(Date.now(), "UTC").slice(0, 7);
  const d = (n: number) => `${month}-${String(n).padStart(2, "0")}`;
  await api("/holidays", { method: "POST", cookie: admin, body: { date: d(11), name: "Mid-month" } });
  const t = await api("/leave/types", { method: "POST", cookie: admin, body: { name: "Annual", paid: true, yearlyAllowanceDays: 1, shortHoursPerMonth: null } });
  const r = await api("/leave", { method: "POST", bearer: worker.bearer, body: { startDate: d(10), endDate: d(11), portion: "FULL_DAY", leaveTypeId: t.body.id } });
  assert.equal(r.status, 201, r.text);
  assert.equal((await api(`/leave/${r.body.id}/approve`, { method: "POST", cookie: admin, body: {} })).status, 200, "2 calendar days, 1 is a holiday (every day is a workday here)");
  const bal = (await api(`/leave/balances/me?month=${month}`, { bearer: worker.bearer })).body.row.balances.find((b: { leaveType: { id: string } }) => b.leaveType.id === t.body.id);
  assert.equal(bal.approvedDays, 1);
  assert.equal(bal.remainingDays, 0);
});

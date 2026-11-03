// Work schedule (W17/W18): GET/PUT /settings/schedule and GET /attendance/daily. Synthetic data only.
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
const { addDays, localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const H = 3_600_000;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let adminId: string;
let employeeBearer: string;

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

type Person = { id: string; user: string; device: string };
async function person(name: string, timezone: string, { employment = "ACTIVE", account = "ACTIVE", created = "2025-12-01T00:00:00.000Z" } = {}): Promise<Person> {
  const [user, id, device] = [randomUUID(), randomUUID(), randomUUID()];
  await db.execute({ sql: "INSERT INTO users (id, email, role, status) VALUES (?, ?, 'EMPLOYEE', ?)", args: [user, `${name}@example.com`, account] });
  await db.execute({
    sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, employment_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [id, user, `SCH-${name.toUpperCase()}`, `Sched ${name}`, timezone, employment, created],
  });
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_identifier, device_name, platform) VALUES (?, ?, ?, 'Mac', 'macos')", args: [device, id, device] });
  return { id, user, device };
}
const clockIn = (p: Person, at: string) =>
  db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), p.id, p.device, at, new Date(Date.parse(at) + H).toISOString()] });
const leave = (p: Person, start: string, end: string, portion = "FULL_DAY", status = "APPROVED") =>
  db.execute({
    sql: `INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, status, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [randomUUID(), p.id, p.user, start, end, portion, status, status === "PENDING" ? null : adminId, status === "PENDING" ? null : "2026-02-01T00:00:00.000Z"],
  });
const policy = (enabled: number, effectiveAt: string, start = "09:30", grace = 10, days = "12345") =>
  db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (?, ?, ?, ?, 'test policy', ?, ?)", args: [enabled, start, grace, days, adminId, effectiveAt] });

type Row = { employee: { id: string; fullName: string }; status: string; lateMinutes: number | null; firstClockInAt: string | null; firstClockInLocal: string | null; leave: { portion: string } | null; scheduled: boolean | null; dueAt: string | null };
const daily = async (date: string, extra = "") => {
  const r = await api(`/attendance/daily?date=${date}&pageSize=100${extra}`, { cookie: admin });
  assert.equal(r.status, 200, r.text);
  return r.body as { items: Row[]; total: number; summary: Record<string, number>; meta: { holidaysConfigured: boolean; perPersonOverrides: boolean } };
};
const statusOf = (items: Row[], p: Person) => items.find((i) => i.employee.id === p.id);

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
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email: "worker@example.com", employeeCode: "SCH-WORKER", fullName: "Worker", timezone: "Asia/Kolkata" } });
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  employeeBearer = (await api("/auth/login", { method: "POST", body: { email: "worker@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken;
});
after(() => app.close());

test("admin only: employees get 403 on the schedule and the daily view; bad input is 400", async () => {
  for (const [path, method, body] of [["/settings/schedule", "GET"], ["/settings/schedule", "PUT", { enabled: true, expectedStart: "09:00", graceMinutes: 0, workdays: "1", reason: "mine" }], ["/attendance/daily?date=2026-03-02", "GET"]] as const) {
    assert.equal((await api(path, { method, body, bearer: employeeBearer })).status, 403, `${method} ${path}`);
  }
  assert.equal((await api("/attendance/daily", { cookie: admin })).status, 400, "date required");
  assert.equal((await api("/attendance/daily?date=2026-02-30", { cookie: admin })).status, 400);
  for (const bad of [{ expectedStart: "25:00" }, { graceMinutes: 300 }, { workdays: "1189" }, { reason: "" }]) {
    const r = await api("/settings/schedule", { method: "PUT", cookie: admin, body: { enabled: true, expectedStart: "09:00", graceMinutes: 0, workdays: "12345", reason: "pilot", ...bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test("disabled by default: nobody is absent without an enabled policy; holidays are reported as not configured", async () => {
  const s = await api("/settings/schedule", { cookie: admin });
  assert.deepEqual(s.body, { current: { enabled: false, expectedStart: "09:00", graceMinutes: 15, workdays: "12345", seq: null, changedBy: null, reason: null, effectiveAt: null }, history: [] });
  const p = await person("nopolicy", "Asia/Kolkata");
  const d = await daily("2026-03-02");
  assert.equal(statusOf(d.items, p)!.status, "NO_POLICY");
  assert.equal(d.summary.ABSENT, 0);
  assert.equal(d.meta.holidaysConfigured, false);
  assert.equal(d.meta.perPersonOverrides, true);
});

test("PUT appends versions (reason kept); a change applies from the next local day; future workdays are not yet due", async () => {
  const p = await person("future", "Asia/Kolkata");
  const put = await api("/settings/schedule", { method: "PUT", cookie: admin, body: { enabled: true, expectedStart: "09:00", graceMinutes: 5, workdays: "7654321", reason: "pilot schedule" } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.current.workdays, "1234567", "normalized");
  assert.equal(put.body.current.changedBy.email, "admin@example.com");
  assert.equal(put.body.history.length, 1);
  const todayUtc = localDate(Date.now(), "UTC");
  const future = addDays(todayUtc, 2); // after now in every time zone
  assert.equal(statusOf((await daily(future)).items, p)!.status, "NOT_YET_DUE");
  assert.equal(statusOf((await daily(addDays(todayUtc, -2))).items, p)!.status, "NO_POLICY", "the past is never relabelled");
  const off = await api("/settings/schedule", { method: "PUT", cookie: admin, body: { enabled: false, expectedStart: "09:00", graceMinutes: 5, workdays: "12345", reason: "pause pilot" } });
  assert.deepEqual(off.body.history.map((h: { enabled: boolean; reason: string }) => [h.enabled, h.reason]), [[false, "pause pilot"], [true, "pilot schedule"]]);
  assert.equal(statusOf((await daily(future)).items, p)!.status, "NO_POLICY", "disabled again");
});

test("present, late, absent, on leave, not scheduled, time zone boundary, and who is listed", async () => {
  // Enabled from 2026-01-01: 09:30 + 10 min grace, Monday–Friday. Disabled again from 2026-03-05.
  await policy(1, "2026-01-01T00:00:00.000Z");
  await policy(0, "2026-03-05T00:00:00.000Z");
  const DAY = "2026-03-02"; // Monday. 09:30 Asia/Kolkata = 04:00Z (due 04:10Z); 09:30 UTC = 09:30Z.
  const present = await person("present", "Asia/Kolkata");
  const late = await person("late", "Asia/Kolkata");
  const absent = await person("absent", "Asia/Kolkata");
  const onLeave = await person("onleave", "Asia/Kolkata");
  const halfDay = await person("halfday", "Asia/Kolkata");
  const pending = await person("pending", "Asia/Kolkata");
  const utc = await person("utc", "UTC");
  const kolkataNight = await person("night", "Asia/Kolkata");
  const utcNight = await person("utcnight", "UTC");
  const terminated = await person("terminated", "Asia/Kolkata", { employment: "TERMINATED" });
  const disabled = await person("disabled", "Asia/Kolkata", { account: "DISABLED" });
  const newcomer = await person("newcomer", "Asia/Kolkata", { created: "2026-03-10T00:00:00.000Z" });
  await clockIn(present, "2026-03-02T04:10:00.000Z"); // exactly at the end of the grace period
  await clockIn(late, "2026-03-02T04:20:00.000Z"); // 09:50 local
  await clockIn(late, "2026-03-02T09:00:00.000Z"); // a later shift does not change the first clock-in
  await leave(onLeave, "2026-03-01", "2026-03-03");
  await leave(halfDay, DAY, DAY, "FIRST_HALF");
  await clockIn(halfDay, "2026-03-02T08:00:00.000Z");
  await leave(pending, DAY, DAY, "FULL_DAY", "PENDING");
  await clockIn(utc, "2026-03-02T09:35:00.000Z");
  // 2026-03-01T20:00Z is 01:30 on 2 March in Kolkata but still 1 March in UTC.
  await clockIn(kolkataNight, "2026-03-01T20:00:00.000Z");
  await clockIn(utcNight, "2026-03-01T20:00:00.000Z");
  await clockIn(terminated, "2026-03-02T04:00:00.000Z");

  const d = await daily(DAY);
  const row = (p: Person) => statusOf(d.items, p)!;
  assert.deepEqual([row(present).status, row(present).lateMinutes, row(present).firstClockInLocal], ["PRESENT", null, "2026-03-02T09:40"]);
  assert.equal(row(present).dueAt, "2026-03-02T04:10:00.000Z");
  assert.deepEqual([row(late).status, row(late).lateMinutes, row(late).firstClockInAt], ["LATE", 20, "2026-03-02T04:20:00.000Z"]);
  assert.deepEqual([row(absent).status, row(absent).firstClockInAt, row(absent).scheduled], ["ABSENT", null, true]);
  assert.deepEqual([row(onLeave).status, row(onLeave).leave!.portion], ["ON_LEAVE", "FULL_DAY"]);
  assert.deepEqual([row(halfDay).status, row(halfDay).leave!.portion, row(halfDay).firstClockInAt], ["ON_LEAVE", "FIRST_HALF", "2026-03-02T08:00:00.000Z"]);
  assert.equal(row(pending).status, "ABSENT", "only approved leave counts");
  assert.deepEqual([row(utc).status, row(utc).firstClockInLocal], ["PRESENT", "2026-03-02T09:35"]);
  assert.deepEqual([row(kolkataNight).status, row(kolkataNight).firstClockInLocal], ["PRESENT", "2026-03-02T01:30"]);
  assert.equal(row(utcNight).status, "ABSENT", "the clock-in belongs to 1 March in UTC");
  for (const p of [terminated, disabled, newcomer]) assert.equal(statusOf(d.items, p), undefined, "not listed");
  assert.equal(d.total, d.items.length);
  assert.equal(Object.values(d.summary).reduce((a, b) => a + b, 0), d.total, "summary covers everyone");
  assert.ok(d.summary.ABSENT >= 3 && d.summary.LATE === 1 && d.summary.ON_LEAVE === 2);

  // Sunday 1 March: not a workday (the night clock-ins fall on it in UTC only).
  const sunday = await daily("2026-03-01");
  assert.deepEqual([statusOf(sunday.items, utcNight)!.status, statusOf(sunday.items, utcNight)!.scheduled], ["NOT_SCHEDULED", false]);
  assert.equal(statusOf(sunday.items, onLeave)!.status, "NOT_SCHEDULED");
  // From 5 March the policy is disabled: no clock-in is NO_POLICY, never ABSENT.
  const friday = await daily("2026-03-06");
  assert.equal(statusOf(friday.items, absent)!.status, "NO_POLICY");
  assert.equal(friday.summary.ABSENT, 0);
  assert.equal(statusOf(await daily("2026-03-12").then((x) => x.items), newcomer)!.status, "NO_POLICY", "listed once employed");

  // Search and pages; summary still counts every match.
  const searched = await api(`/attendance/daily?date=${DAY}&q=night&pageSize=1&page=2`, { cookie: admin });
  assert.equal(searched.body.total, 2);
  assert.equal(searched.body.items.length, 1);
  assert.equal(searched.body.summary.PRESENT + searched.body.summary.ABSENT, 2);
});

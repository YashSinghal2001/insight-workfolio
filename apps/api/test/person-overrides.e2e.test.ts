// Per-person overrides (W17 start/workdays, W21 idle threshold) and idle-excluded apps (W22):
// GET/PUT /settings/employees/:id/tracking, the daily attendance view, and the desktop policy in
// GET /activity/me. Synthetic data only.
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
const { addDays, localDate, DEFAULT_MONITORING_SETTINGS } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const H = 3_600_000;

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
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

type Person = { id: string; device: string };
async function person(name: string): Promise<Person> {
  const [user, id, device] = [randomUUID(), randomUUID(), randomUUID()];
  await db.execute({ sql: "INSERT INTO users (id, email, role) VALUES (?, ?, 'EMPLOYEE')", args: [user, `${name}@example.com`] });
  await db.execute({
    sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, 'Asia/Kolkata', '2025-12-01T00:00:00.000Z')",
    args: [id, user, `OVR-${name.toUpperCase()}`, `Override ${name}`],
  });
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_identifier, device_name, platform) VALUES (?, ?, ?, 'Mac', 'macos')", args: [device, id, device] });
  return { id, device };
}
const clockIn = (p: Person, at: string) =>
  db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), p.id, p.device, at, new Date(Date.parse(at) + H).toISOString()] });
/** A past override version (the API records new ones at now, effective from the next local day). */
const override = (p: Person, effectiveAt: string, start: string | null, days: string | null, idle: number | null = null) =>
  db.execute({
    sql: "INSERT INTO employee_tracking_overrides (id, employee_id, expected_start, workdays, idle_threshold_seconds, reason, changed_by, effective_at) VALUES (?, ?, ?, ?, ?, 'test override', ?, ?)",
    args: [randomUUID(), p.id, start, days, idle, adminId, effectiveAt],
  });
const daily = async (date: string) => {
  const r = await api(`/attendance/daily?date=${date}&pageSize=100`, { cookie: admin });
  assert.equal(r.status, 200, r.text);
  return (id: string) => (r.body.items as { employee: { id: string }; status: string; lateMinutes: number | null }[]).find((i) => i.employee.id === id)!;
};
const tracking = (id: string, body?: object) => api(`/settings/employees/${id}/tracking`, body ? { method: "PUT", cookie: admin, body } : { cookie: admin });
const NONE = { expectedStart: null, workdays: null, idleThresholdSeconds: null };

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
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email: "worker@example.com", employeeCode: "OVR-WORKER", fullName: "Worker", timezone: "Asia/Kolkata" } });
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  worker = { id: e.body.employee.id, bearer: (await api("/auth/login", { method: "POST", body: { email: "worker@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken };
  // Organisation schedule in force since 2026-01-01: 09:30 + 10 min grace, Monday–Friday.
  await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:30', 10, '12345', 'org', ?, '2026-01-01T00:00:00.000Z')", args: [adminId] });
});
after(() => app.close());

test("admin only: employees cannot read or set overrides (their own included); bad input 400; unknown employee 404", async () => {
  const valid = { ...NONE, idleThresholdSeconds: 3600, reason: "mine" };
  assert.equal((await api(`/settings/employees/${worker.id}/tracking`, { bearer: worker.bearer })).status, 403);
  assert.equal((await api(`/settings/employees/${worker.id}/tracking`, { method: "PUT", bearer: worker.bearer, body: valid })).status, 403);
  assert.equal((await api("/settings/monitoring", { method: "PUT", bearer: worker.bearer, body: { ...DEFAULT_MONITORING_SETTINGS, idleExcludedApps: ["x"], reason: "mine" } })).status, 403);
  for (const bad of [{ expectedStart: "9:30" }, { workdays: "118" }, { idleThresholdSeconds: 5 }, { reason: "" }, { graceMinutes: 0 }]) {
    assert.equal((await tracking(worker.id, { ...valid, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await tracking(randomUUID(), valid)).status, 404);
  assert.equal((await tracking("not-a-uuid")).status, 400);
  assert.equal((await tracking(worker.id)).body.history.length, 0, "nothing was recorded");
});

test("override precedence: the person's start/workdays apply, else the organisation schedule; cleared = inherit again", async () => {
  // 2026-03-02 is a Monday. 09:30 IST = 04:00Z (due 04:10Z); 10:30 IST = 05:00Z (due 05:10Z).
  const [org, later, weekend, cleared] = [await person("org"), await person("later"), await person("weekend"), await person("cleared")];
  for (const p of [org, later, weekend, cleared]) await clockIn(p, "2026-03-02T04:45:00.000Z"); // 10:15 IST
  await override(later, "2026-02-01T00:00:00.000Z", "10:30", null);
  await override(weekend, "2026-02-01T00:00:00.000Z", null, "67");
  await override(cleared, "2026-02-01T00:00:00.000Z", "10:30", null);
  await override(cleared, "2026-02-15T00:00:00.000Z", null, null); // cleared before the day

  const day = await daily("2026-03-02");
  assert.deepEqual([day(org.id).status, day(org.id).lateMinutes], ["LATE", 45], "organisation 09:30 applies");
  assert.equal(day(later.id).status, "PRESENT", "10:30 override: 10:15 is on time");
  assert.equal(day(weekend.id).status, "NOT_SCHEDULED", "workday override");
  assert.deepEqual([day(cleared.id).status, day(cleared.id).lateMinutes], ["LATE", 45], "cleared override inherits");

  // An override applies from the start of the employee's local day, never relabelling an earlier day.
  const before = await person("before");
  await clockIn(before, "2026-03-02T04:45:00.000Z");
  await override(before, "2026-03-02T12:00:00.000Z", "10:30", null);
  assert.equal((await daily("2026-03-02"))(before.id).status, "LATE");
});

test("late flag uses an override recorded through the API (from the next local day); GET shows organisation, override and effective", async () => {
  const p = await person("api");
  const put = await tracking(p.id, { expectedStart: "11:00", workdays: "7654321", idleThresholdSeconds: null, reason: "late shift" });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.body.override, { expectedStart: "11:00", workdays: "1234567", idleThresholdSeconds: null, screenshotSelfView: null });
  assert.deepEqual(put.body.organisation.schedule, { enabled: true, expectedStart: "09:30", graceMinutes: 10, workdays: "12345" });
  assert.deepEqual(put.body.effective.schedule, { enabled: true, expectedStart: "11:00", graceMinutes: 10, workdays: "1234567" });
  assert.equal(put.body.history[0].changedBy.email, "admin@example.com");
  assert.equal(put.body.history[0].reason, "late shift");

  // Tomorrow (UTC+2 days: after now in every zone): a 10:45 IST clock-in is on time under 11:00.
  const future = addDays(localDate(Date.now(), "UTC"), 2);
  await clockIn(p, `${future}T05:15:00.000Z`); // 10:45 IST
  assert.equal((await daily(future))(p.id).status, "PRESENT");
  const q = await person("apicontrol");
  await clockIn(q, `${future}T05:15:00.000Z`);
  const status = (await daily(future))(q.id).status;
  assert.ok(status === "LATE" || status === "NOT_SCHEDULED", `organisation schedule for the control (${status})`);
});

test("desktop policy: GET /activity/me returns the effective idle threshold and the organisation's excluded apps", async () => {
  const me = async () => (await api("/activity/me", { bearer: worker.bearer })).body.policy;
  assert.deepEqual(await me(), { enabled: true, sampleSeconds: 15, idleThresholdSeconds: 300, idleExcludedApps: [] });

  const set = await api("/settings/monitoring", { method: "PUT", cookie: admin, body: { ...DEFAULT_MONITORING_SETTINGS, idleExcludedApps: ["us.zoom.xos", " Zoom.exe ", "US.ZOOM.XOS"], reason: "calls" } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.body.effective.idleExcludedApps, ["us.zoom.xos", "Zoom.exe"]);
  assert.equal((await tracking(worker.id, { ...NONE, idleThresholdSeconds: 900, reason: "long reads" })).status, 200);
  assert.deepEqual(await me(), { enabled: true, sampleSeconds: 15, idleThresholdSeconds: 900, idleExcludedApps: ["us.zoom.xos", "Zoom.exe"] });

  // An older client that omits the list keeps it; the organisation threshold change does not beat the override.
  const keep = await api("/settings/monitoring", { method: "PUT", cookie: admin, body: { ...DEFAULT_MONITORING_SETTINGS, idleThresholdSeconds: 600, idleExcludedApps: undefined, reason: "older client" } });
  assert.deepEqual(keep.body.effective.idleExcludedApps, ["us.zoom.xos", "Zoom.exe"]);
  assert.equal((await me()).idleThresholdSeconds, 900);
  const view = await tracking(worker.id);
  assert.deepEqual([view.body.organisation.idleThresholdSeconds, view.body.effective.idleThresholdSeconds], [600, 900]);

  // Cleared: the organisation value applies again; other employees never see the override.
  assert.equal((await tracking(worker.id, { ...NONE, reason: "back to normal" })).status, 200);
  assert.equal((await me()).idleThresholdSeconds, 600);
  assert.equal((await tracking(worker.id)).body.history.length, 2, "history kept");
  assert.equal((await api("/settings/monitoring", { method: "PUT", cookie: admin, body: { ...DEFAULT_MONITORING_SETTINGS, idleExcludedApps: [""], reason: "bad" } })).status, 400);
});

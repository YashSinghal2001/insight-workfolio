// Attendance notification rules (docs/notifications.md §9): rules CRUD and RBAC, recipient validation, the
// producers (clock-in/out incl. offline sync, late, absence, missing clock-out, productivity alert), dedupe,
// IMMEDIATE / DAILY_DIGEST / OFF, digests once per local day across DST, team scoping and send-time re-checks.
// In-process API, in-memory DB, MOCK mail transport only (nothing leaves the process), example.com accounts.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.INVITATION_MAIL_PROVIDER = "mock";
process.env.MAIL_SENDER = "it@example.com";
process.env.DASHBOARD_URL = "https://workfolio.example.com";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { AuthService } = await import("../dist/auth/auth.service.js");
const { INVITATION_TRANSPORT } = await import("../dist/employees/invitations.js");
const { MailError } = await import("../dist/reports/mail.js");
const { NotificationsService, NOTIFICATION_RETRY } = await import("../dist/notifications/notifications.service.js");
const { NotificationRulesService } = await import("../dist/notifications/notification-rules.service.js");
const { EmailService } = await import("../dist/notifications/email.service.js");
const { AttendanceService } = await import("../dist/attendance/attendance.service.js");
const { AlertsService } = await import("../dist/alerts/alerts.service.js");
const { renderAttendance } = await import("../dist/notifications/templates.js");
const { ATTENDANCE_NOTIFICATION_TYPES } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "rules password 1";
let app: INestApplication;
let base: string;
type Rows = { rows: Record<string, unknown>[] };
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<Rows> };
type Sent = { to: string; subject: string; text: string; html?: string };
let mock: { outbox: Sent[]; delivers: boolean; send: (m: Sent) => Promise<{ messageId: string }> };
let svc: InstanceType<typeof NotificationsService>;
let rules: InstanceType<typeof NotificationRulesService>;
let attendance: InstanceType<typeof AttendanceService>;

async function api(path: string, { method = "GET", body, cookie }: { method?: string; body?: unknown; cookie?: string } = {}) {
  const h: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
async function signIn(email: string) {
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `${email}: ${r.text}`);
  return r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
let n = 0;
type Person = { id: string; email: string; profile: string; device: string; code: string; name: string };
/** A synthetic account with a profile (employee since 2025) and a device. */
async function person(kind: "SUPER_ADMIN" | "ADMIN" | "EMPLOYEE", timezone = "UTC"): Promise<Person> {
  const id = randomUUID();
  const profile = randomUUID();
  const device = randomUUID();
  const code = `RULE-${++n}`;
  const email = `rule${n}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, ?, ?, ?)", args: [id, email, kind === "EMPLOYEE" ? "EMPLOYEE" : "ADMIN", kind === "EMPLOYEE" ? null : kind, await hashPassword(PASSWORD)] });
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, ?, '2025-01-01T00:00:00.000Z')", args: [profile, id, code, `Person <${n}>`, timezone] });
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, profile, randomUUID()] });
  return { id, email, profile, device, code, name: `Person <${n}>` };
}
async function team(head: Person | null, members: Person[]) {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO teams (id, name, head_user_id, created_by) VALUES (?, ?, ?, ?)", args: [id, `Team ${id.slice(0, 8)}`, head?.id ?? null, admin.id] });
  for (const m of members) await db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [id, m.profile, admin.id] });
  return id;
}
/** Creates a rule through the API with its recipients. */
async function rule(body: Record<string, unknown>, recipients: Person[]) {
  const r = await api("/notifications/rules", { method: "POST", cookie: adminCookie, body });
  assert.equal(r.status, 201, r.text);
  const p = await api(`/notifications/rules/${r.body.id}/recipients`, { method: "PUT", cookie: adminCookie, body: { userIds: recipients.map((x) => x.id) } });
  assert.equal(p.status, 200, p.text);
  return r.body.id as string;
}
const events = async (type: string, employee: Person) =>
  (await db.execute({ sql: "SELECT id, dedupe_key, local_date, occurred_at FROM notification_events WHERE type = ? AND employee_id = ? ORDER BY created_at, id", args: [type, employee.profile] })).rows;
const deliveries = async (eventId: string) =>
  (await db.execute({ sql: "SELECT d.recipient_role, u.email, d.status, d.last_error FROM notification_deliveries d JOIN users u ON u.id = d.recipient_user_id WHERE d.event_id = ? ORDER BY u.email", args: [eventId] })).rows.map((r) => `${r.recipient_role}:${r.email}:${r.status}`);
const digestEvents = async (ruleId: string) => (await db.execute({ sql: "SELECT id, local_date FROM notification_events WHERE dedupe_key LIKE ? ORDER BY local_date", args: [`digest:${ruleId}:%`] })).rows;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Clock-in/out notifications are recorded after the request, outside the employee lock: wait for them. */
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100 && !(await check()); i++) await pause(10);
  assert.ok(await check(), "timed out waiting for the notification");
}
/** Counts write batches and INSERT/UPDATE/DELETE statements sent to the database while `fn` runs. */
async function writesDuring(fn: () => Promise<unknown>) {
  const raw = db as unknown as { batch: (s: unknown[], mode?: string) => Promise<unknown>; execute: (q: unknown) => Promise<unknown> };
  const [batch, execute] = [raw.batch, raw.execute];
  let writes = 0;
  raw.batch = (st, mode) => { if (mode === "write") writes++; return batch.call(raw, st, mode); };
  raw.execute = (q) => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(typeof q === "string" ? q : (q as { sql: string }).sql)) writes++; return execute.call(raw, q); };
  try {
    await fn();
  } finally {
    Object.assign(raw, { batch, execute });
  }
  return writes;
}
const sentTo = (from: number) => mock.outbox.slice(from).map((m) => m.to).sort();

let admin: Person;
let adminCookie: string;
let superAdmin: Person;
let employeeCookie: string;
let headA: Person;
let headCookie: string;
let a1: Person;
let b1: Person;
let teamA: string;
let teamB: string;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  mock = app.get(INVITATION_TRANSPORT);
  svc = app.get(NotificationsService);
  rules = app.get(NotificationRulesService);
  attendance = app.get(AttendanceService);
  NOTIFICATION_RETRY.backoffMs = [0, 0, 0];
  const auth = app.get(AuthService);
  auth.loginByIp.hit = () => true;
  admin = await person("ADMIN");
  superAdmin = await person("SUPER_ADMIN");
  adminCookie = await signIn(admin.email);
  headA = await person("EMPLOYEE");
  a1 = await person("EMPLOYEE");
  b1 = await person("EMPLOYEE");
  employeeCookie = await signIn(a1.email);
  teamA = await team(headA, [a1]);
  teamB = await team(null, [b1]);
  headCookie = await signIn(headA.email);
  // Work schedule: Mon-Fri, 09:00 + 15 min grace, in force since 2025 (each employee's own zone).
  await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 15, '12345', 'test schedule', ?, '2025-01-01T00:00:00.000Z')", args: [admin.id] });
});
after(() => app?.close());

describe("mock transport only", () => {
  test("the notification transport is the in-process mock: it never delivers to a real inbox", async () => {
    const status = await app.get(EmailService).status();
    assert.equal(status.provider, "mock");
    assert.equal(status.delivers, false);
    assert.ok(Array.isArray(mock.outbox));
  });
});

describe("rules API", () => {
  test("GET lists every type as an OFF default (18:00, default zone), idempotently; admin only", async () => {
    const r = await api("/notifications/rules", { cookie: adminCookie });
    assert.equal(r.status, 200, r.text);
    const org = r.body.filter((x: { teamId: string | null }) => x.teamId === null);
    assert.deepEqual(org.map((x: { type: string }) => x.type).sort(), [...ATTENDANCE_NOTIFICATION_TYPES].sort());
    for (const x of org) assert.deepEqual([x.mode, x.digestLocalTime, x.timezone, x.recipients.length], ["OFF", "18:00", "Asia/Kolkata", 0]);
    assert.equal((await api("/notifications/rules", { cookie: adminCookie })).body.length, r.body.length, "a second GET adds nothing");
    assert.equal((await api("/notifications/rules", { cookie: employeeCookie })).status, 403);
    assert.equal((await api("/notifications/rules", { cookie: headCookie })).status, 403, "a team head cannot manage rules");
    assert.equal((await api("/notifications/rules", { method: "POST", cookie: headCookie, body: { type: "ABSENCE", teamId: teamA } })).status, 403);
    assert.equal((await api("/notifications/rules")).status, 401);
  });

  test("POST / PATCH: validation 400, unknown team 404, duplicate (type, team) 409, unknown rule 404; audited", async () => {
    for (const bad of [{ type: "UNKNOWN" }, { type: "ABSENCE", mode: "SOMETIMES" }, { type: "ABSENCE", digestLocalTime: "24:00" }, { type: "ABSENCE", timezone: "Mars/Base" }, { type: "ABSENCE", teamId: "x" }, { type: "ABSENCE", extra: 1 }]) {
      assert.equal((await api("/notifications/rules", { method: "POST", cookie: adminCookie, body: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await api("/notifications/rules", { method: "POST", cookie: adminCookie, body: { type: "ABSENCE", teamId: randomUUID() } })).status, 404);
    assert.equal((await api("/notifications/rules", { method: "POST", cookie: adminCookie, body: { type: "ABSENCE" } })).status, 409, "the org-wide default exists");
    const t = await team(null, []);
    const c = await api("/notifications/rules", { method: "POST", cookie: adminCookie, body: { type: "ABSENCE", teamId: t, mode: "DAILY_DIGEST", digestLocalTime: "17:30", timezone: "America/New_York" } });
    assert.equal(c.status, 201, c.text);
    assert.deepEqual([c.body.mode, c.body.digestLocalTime, c.body.timezone, c.body.teamId, c.body.changedBy], ["DAILY_DIGEST", "17:30", "America/New_York", t, admin.id]);
    assert.equal((await api("/notifications/rules", { method: "POST", cookie: adminCookie, body: { type: "ABSENCE", teamId: t } })).status, 409);
    assert.equal((await api(`/notifications/rules/${c.body.id}`, { method: "PATCH", cookie: adminCookie, body: {} })).status, 400);
    assert.equal((await api(`/notifications/rules/${c.body.id}`, { method: "PATCH", cookie: adminCookie, body: { teamId: null } })).status, 400, "team never changes");
    assert.equal((await api(`/notifications/rules/${randomUUID()}`, { method: "PATCH", cookie: adminCookie, body: { mode: "OFF" } })).status, 404);
    assert.equal((await api(`/notifications/rules/${c.body.id}`, { method: "PATCH", cookie: employeeCookie, body: { mode: "OFF" } })).status, 403);
    const p = await api(`/notifications/rules/${c.body.id}`, { method: "PATCH", cookie: adminCookie, body: { mode: "OFF", digestLocalTime: "00:00" } });
    assert.equal(p.status, 200, p.text);
    assert.deepEqual([p.body.mode, p.body.digestLocalTime, p.body.timezone], ["OFF", "00:00", "America/New_York"]);
    const audit = (await db.execute({ sql: "SELECT action FROM account_audit WHERE json_extract(metadata, '$.ruleId') = ? ORDER BY created_at, rowid", args: [c.body.id] })).rows.map((r) => r.action);
    assert.deepEqual(audit, ["NOTIFICATION_RULE_CREATED", "NOTIFICATION_RULE_UPDATED"]);
  });

  test("recipients: admins anywhere, a team head only on their team's rule; disabled, unknown, other team → 400; append-only and audited", async () => {
    const id = await rule({ type: "MISSING_CLOCK_OUT", teamId: teamA }, [admin, headA]);
    const got = (await api("/notifications/rules", { cookie: adminCookie })).body.find((x: { id: string }) => x.id === id);
    assert.deepEqual(got.recipients.map((x: { email: string }) => x.email).sort(), [admin.email, headA.email].sort());
    assert.ok(got.recipients.every((x: { fullName: string | null }) => typeof x.fullName === "string"));
    const orgWide = (await api("/notifications/rules", { cookie: adminCookie })).body.find((x: { type: string; teamId: null }) => x.type === "MISSING_CLOCK_OUT" && x.teamId === null);
    const teamBRule = await rule({ type: "MISSING_CLOCK_OUT", teamId: teamB }, []);
    const disabled = await person("ADMIN");
    await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE id = ?", args: [disabled.id] });
    for (const [ruleId, users] of [[orgWide.id, [headA.id]], [teamBRule, [headA.id]], [id, [disabled.id]], [id, [randomUUID()]], [id, [a1.id]]] as [string, string[]][]) {
      assert.equal((await api(`/notifications/rules/${ruleId}/recipients`, { method: "PUT", cookie: adminCookie, body: { userIds: users } })).status, 400);
    }
    assert.equal((await api(`/notifications/rules/${id}/recipients`, { method: "PUT", cookie: adminCookie, body: { userIds: [admin.id, admin.id] } })).status, 400, "duplicates");
    assert.equal((await api(`/notifications/rules/${id}/recipients`, { method: "PUT", cookie: adminCookie, body: { userIds: "x" } })).status, 400);
    assert.equal((await api(`/notifications/rules/${randomUUID()}/recipients`, { method: "PUT", cookie: adminCookie, body: { userIds: [] } })).status, 404);
    assert.equal((await api(`/notifications/rules/${id}/recipients`, { method: "PUT", cookie: headCookie, body: { userIds: [] } })).status, 403);
    const r = await api(`/notifications/rules/${id}/recipients`, { method: "PUT", cookie: adminCookie, body: { userIds: [superAdmin.id, headA.id] } });
    assert.deepEqual(r.body.recipients.map((x: { email: string }) => x.email).sort(), [superAdmin.email, headA.email].sort());
    const rows = (await db.execute({ sql: "SELECT user_id, removed_at FROM notification_rule_recipients WHERE rule_id = ?", args: [id] })).rows;
    assert.equal(rows.length, 3, "the removed admin's row is ended, not deleted");
    assert.equal(rows.find((x) => x.user_id === admin.id)!.removed_at !== null, true);
    const audit = (await db.execute({ sql: "SELECT action, target_user_id FROM account_audit WHERE json_extract(metadata, '$.ruleId') = ? AND action LIKE 'NOTIFICATION_RECIPIENT_%'", args: [id] })).rows.map((x) => `${x.action}:${x.target_user_id}`);
    assert.deepEqual(audit.sort(), [`NOTIFICATION_RECIPIENT_ADDED:${admin.id}`, `NOTIFICATION_RECIPIENT_ADDED:${headA.id}`, `NOTIFICATION_RECIPIENT_ADDED:${superAdmin.id}`, `NOTIFICATION_RECIPIENT_REMOVED:${admin.id}`].sort());
    await api(`/notifications/rules/${id}/recipients`, { method: "PUT", cookie: adminCookie, body: { userIds: [] } });
  });
});

describe("clock-in / clock-out", () => {
  test("OFF (default): a clock-in records nothing", async () => {
    const e = await person("EMPLOYEE");
    await attendance.act({ employeeId: e.profile, deviceId: e.device }, "CLOCK_IN", randomUUID());
    await pause(100);
    assert.equal((await events("ATTENDANCE_CLOCK_IN", e)).length, 0);
    await attendance.act({ employeeId: e.profile, deviceId: e.device }, "CLOCK_OUT", randomUUID());
  });

  test("IMMEDIATE team rule: online and offline-synced events, one per attendance event (replays dedupe); team head of that team and admins only", async () => {
    const e = await person("EMPLOYEE");
    const other = await person("EMPLOYEE");
    const t = await team(headA, [e]);
    await db.execute({ sql: "UPDATE teams SET head_user_id = ? WHERE id = ?", args: [headA.id, t] });
    await rule({ type: "ATTENDANCE_CLOCK_IN", teamId: t, mode: "IMMEDIATE" }, [admin, headA, superAdmin]);
    await rule({ type: "ATTENDANCE_CLOCK_OUT", teamId: t, mode: "IMMEDIATE" }, [admin]);
    const key = randomUUID();
    await attendance.act({ employeeId: e.profile, deviceId: e.device }, "CLOCK_IN", key);
    await assert.rejects(attendance.act({ employeeId: e.profile, deviceId: e.device }, "CLOCK_IN", randomUUID()), "a second clock-in is rejected: no event");
    await until(async () => (await events("ATTENDANCE_CLOCK_IN", e)).length > 0);
    await pause(50);
    assert.equal((await events("ATTENDANCE_CLOCK_IN", e)).length, 1);
    const [ev] = await events("ATTENDANCE_CLOCK_IN", e);
    assert.ok(ev);
    const attendanceId = (await db.execute({ sql: "SELECT id FROM attendance_events WHERE idempotency_key = ?", args: [key] })).rows[0]!.id;
    assert.equal(ev!.dedupe_key, `ATTENDANCE_CLOCK_IN:${attendanceId}`);
    assert.deepEqual(await deliveries(String(ev!.id)), [`IT:${admin.email}:PENDING`, `EMPLOYEE:${headA.email}:PENDING`, `SUPER_ADMIN:${superAdmin.email}:PENDING`].sort((x, y) => x.split(":")[1]!.localeCompare(y.split(":")[1]!)));
    // Offline sync: a clock-out queued on the device, then the same upload again (replay).
    const sentAt = new Date().toISOString();
    const upload = { sentAt, events: [{ id: randomUUID(), type: "CLOCK_OUT", occurredAt: sentAt }] };
    await attendance.sync({ employeeId: e.profile, deviceId: e.device }, upload);
    await attendance.sync({ employeeId: e.profile, deviceId: e.device }, upload);
    await until(async () => (await events("ATTENDANCE_CLOCK_OUT", e)).length > 0);
    await pause(50);
    assert.equal((await events("ATTENDANCE_CLOCK_OUT", e)).length, 1, "replayed upload: still one event");
    // Another team's employee: no rule covers them.
    await attendance.act({ employeeId: other.profile, deviceId: other.device }, "CLOCK_IN", randomUUID());
    await pause(100);
    assert.equal((await events("ATTENDANCE_CLOCK_IN", other)).length, 0);
    const from = mock.outbox.length;
    await svc.deliver();
    assert.deepEqual(sentTo(from), [admin.email, admin.email, headA.email, superAdmin.email].sort());
    const m = mock.outbox.slice(from).find((x) => x.to === headA.email)!;
    assert.match(m.subject, /^Clock-in: Person <\d+> \(RULE-\d+\)$/);
    assert.ok(m.html!.includes("Person &#60;") && !m.html!.includes(`${e.name}`), "names are HTML-escaped");
    assert.match(m.text, new RegExp(`Employee code: ${e.code}`));
    assert.match(m.text, /Local time: \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    for (const leak of ["screenshot", "window", "leave", other.code]) assert.ok(!m.text.toLowerCase().includes(leak.toLowerCase()), leak);
  });
});

describe("late arrival, absence, productivity alert, missing clock-out", () => {
  // Wednesday 2026-11-18 (a workday); Thursday 2026-11-19 is a holiday; Saturday 2026-11-21 is not a workday.
  const WED_10 = Date.parse("2026-11-18T10:00:00.000Z");
  test("LATE_ARRIVAL and ABSENCE (timer, injected clock): once per employee and day; never on leave, a holiday, a non-workday or before due", async () => {
    const late = await person("EMPLOYEE");
    const absent = await person("EMPLOYEE");
    const onLeave = await person("EMPLOYEE");
    const onTime = await person("EMPLOYEE");
    const t = await team(null, [late, absent, onLeave, onTime]);
    const lateRule = await rule({ type: "LATE_ARRIVAL", teamId: t, mode: "IMMEDIATE" }, [admin]);
    await rule({ type: "ABSENCE", teamId: t, mode: "IMMEDIATE" }, [admin]);
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, '2026-11-18T09:40:00.000Z', 'OPEN')", args: [randomUUID(), late.profile, late.device] });
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, '2026-11-18T09:10:00.000Z', 'OPEN')", args: [randomUUID(), onTime.profile, onTime.device] });
    await db.execute({ sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, status, decided_by, decided_at) VALUES (?, ?, ?, '2026-11-18', '2026-11-21', 'FULL_DAY', 'APPROVED', ?, '2026-11-01T00:00:00.000Z')", args: [randomUUID(), onLeave.profile, onLeave.id, admin.id] });
    await db.execute({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, '2026-11-19', 'Test holiday', ?)", args: [randomUUID(), admin.id] });

    await rules.tick(Date.parse("2026-11-18T09:14:00.000Z"));
    assert.equal((await events("ABSENCE", absent)).length, 0, "not yet due (09:15)");
    await rules.tick(WED_10);
    await rules.tick(WED_10 + 60_000);
    assert.equal(await writesDuring(() => rules.tick(WED_10 + 120_000)), 0, "a later tick finds everything recorded: no writes");
    const [l] = await events("LATE_ARRIVAL", late);
    assert.deepEqual([l?.dedupe_key, l?.local_date, l?.occurred_at], [`LATE_ARRIVAL:${late.profile}:2026-11-18`, "2026-11-18", "2026-11-18T09:40:00.000Z"]);
    assert.equal((await events("LATE_ARRIVAL", late)).length, 1, "repeated ticks: once");
    assert.equal((await events("ABSENCE", absent)).length, 1);
    assert.equal((await events("ABSENCE", absent))[0]!.dedupe_key, `ABSENCE:${absent.profile}:2026-11-18`);
    for (const p of [onLeave, onTime]) assert.equal((await events("ABSENCE", p)).length + (await events("LATE_ARRIVAL", p)).length, 0);
    await rules.tick(Date.parse("2026-11-19T12:00:00.000Z"));
    await rules.tick(Date.parse("2026-11-21T12:00:00.000Z"));
    assert.equal((await events("ABSENCE", absent)).length, 1, "holiday and Saturday: no absence");
    // Switched OFF: nothing more (Friday).
    await api(`/notifications/rules/${lateRule}`, { method: "PATCH", cookie: adminCookie, body: { mode: "OFF" } });
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, '2026-11-20T10:00:00.000Z', 'OPEN')", args: [randomUUID(), absent.profile, absent.device] });
    await rules.tick(Date.parse("2026-11-20T11:00:00.000Z"));
    assert.equal((await events("LATE_ARRIVAL", absent)).length, 0);
  });

  test("PRODUCTIVITY_ALERT: one event per created alert; MISSING_CLOCK_OUT producer: once per employee and local date", async () => {
    const e = await person("EMPLOYEE", "Asia/Kolkata");
    const t = await team(null, [e]);
    await rule({ type: "PRODUCTIVITY_ALERT", teamId: t, mode: "IMMEDIATE" }, [admin]);
    await rule({ type: "MISSING_CLOCK_OUT", teamId: t, mode: "IMMEDIATE" }, [admin]);
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, '2026-11-18T05:00:00.000Z', 'OPEN')", args: [randomUUID(), e.profile, e.device] });
    await db.execute({ sql: "INSERT INTO alert_rules (id, name, kind, created_by) VALUES (?, 'Late', 'LATE_CLOCK_IN', ?)", args: [randomUUID(), admin.id] });
    const now = Date.parse("2026-11-18T06:00:00.000Z"); // 11:30 in Kolkata: clocked in 10:30, after 09:15
    await app.get(AlertsService).evaluate(now);
    await app.get(AlertsService).evaluate(now + 60_000);
    const alerts = await events("PRODUCTIVITY_ALERT", e);
    assert.equal(alerts.length, 1);
    assert.match(String(alerts[0]!.dedupe_key), new RegExp(`^PRODUCTIVITY_ALERT:[0-9a-f-]{36}:${e.profile}:2026-11-18$`));
    assert.equal(await rules.recordMissingClockOut({ employeeId: e.profile, clockInAt: "2026-11-18T05:00:00.000Z" }, now) !== null, true);
    assert.equal(await rules.recordMissingClockOut({ employeeId: e.profile, clockInAt: "2026-11-18T05:00:00.000Z" }, now + 1), null, "duplicate");
    const [m] = await events("MISSING_CLOCK_OUT", e);
    assert.deepEqual([m?.dedupe_key, m?.local_date], [`MISSING_CLOCK_OUT:${e.profile}:2026-11-18`, "2026-11-18"]);
    assert.equal(await rules.recordMissingClockOut({ employeeId: randomUUID(), clockInAt: "2026-11-18T05:00:00.000Z" }, now), null, "unknown employee");
    const from = mock.outbox.length;
    await svc.deliver();
    const mail = mock.outbox.slice(from).find((x) => x.subject.startsWith("Missing clock-out"))!;
    assert.match(mail.text, /Local time: 2026-11-18 10:30 Asia\/Kolkata/);
    const alertMail = mock.outbox.slice(from).find((x) => x.subject.startsWith("Productivity alert"))!;
    assert.ok(!/min after|expected start/.test(alertMail.text), "no alert detail in the email");
  });
});

describe("missing clock-out from the anomaly detector", () => {
  test("the timer records one event per employee and local date, team-scoped, only with a rule that is not OFF; later ticks write nothing", async () => {
    const x = await person("EMPLOYEE");
    const y = await person("EMPLOYEE");
    const gone = await person("EMPLOYEE");
    const t = await team(null, [x, gone]);
    const now = Date.parse("2026-11-18T10:00:00.000Z");
    for (const p of [x, y, gone]) await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, '2026-11-16T09:00:00.000Z', 'OPEN')", args: [randomUUID(), p.profile, p.device] });
    await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE id = ?", args: [gone.id] });
    const id = await rule({ type: "MISSING_CLOCK_OUT", teamId: t, mode: "OFF" }, [admin]);
    await rules.tick(now);
    assert.equal((await events("MISSING_CLOCK_OUT", x)).length, 0, "rule OFF: nothing");
    await api(`/notifications/rules/${id}`, { method: "PATCH", cookie: adminCookie, body: { mode: "IMMEDIATE" } });
    await rules.tick(now);
    const [ev] = await events("MISSING_CLOCK_OUT", x);
    assert.equal(ev?.dedupe_key, `MISSING_CLOCK_OUT:${x.profile}:2026-11-16`);
    assert.deepEqual(await deliveries(String(ev!.id)), [`IT:${admin.email}:PENDING`]);
    assert.equal((await events("MISSING_CLOCK_OUT", y)).length, 0, "not in the rule's team");
    assert.equal((await events("MISSING_CLOCK_OUT", gone)).length, 0, "disabled account");
    assert.equal(await writesDuring(() => rules.tick(now + 60_000)), 0);
    assert.equal((await events("MISSING_CLOCK_OUT", x)).length, 1);
    await api(`/notifications/rules/${id}`, { method: "PATCH", cookie: adminCookie, body: { mode: "OFF" } });
    await svc.deliver();
  });
});

describe("daily digest", () => {
  test("one email per recipient per rule per local date at digest time; empty day nothing; repeated ticks never resend", async () => {
    const e1 = await person("EMPLOYEE");
    const e2 = await person("EMPLOYEE");
    const outsider = await person("EMPLOYEE");
    const e3 = await person("EMPLOYEE");
    const head = await person("EMPLOYEE");
    const t = await team(head, [e1, e2, e3]);
    const id = await rule({ type: "MISSING_CLOCK_OUT", teamId: t, mode: "DAILY_DIGEST", digestLocalTime: "18:00", timezone: "UTC" }, [admin, head]);
    await rule({ type: "MISSING_CLOCK_OUT", teamId: await team(null, [outsider]), mode: "IMMEDIATE" }, [superAdmin]);
    await rules.recordMissingClockOut({ employeeId: e1.profile, clockInAt: "2026-06-10T08:00:00.000Z" }, Date.parse("2026-06-10T12:00:00.000Z"));
    await rules.recordMissingClockOut({ employeeId: e2.profile, clockInAt: "2026-06-10T09:00:00.000Z" }, Date.parse("2026-06-10T13:00:00.000Z"));
    await rules.recordMissingClockOut({ employeeId: outsider.profile, clockInAt: "2026-06-10T09:00:00.000Z" }, Date.parse("2026-06-10T13:00:00.000Z"));
    assert.deepEqual(await deliveries(String((await events("MISSING_CLOCK_OUT", e1))[0]!.id)), [], "digest rule: no immediate delivery");
    await rules.digests(Date.parse("2026-06-10T17:59:00.000Z"));
    assert.equal((await digestEvents(id)).length, 0, "before digest time");
    await rules.digests(Date.parse("2026-06-10T18:00:00.000Z"));
    // Events recorded after the digest time are not in today's digest: they go into the next day's.
    await rules.recordMissingClockOut({ employeeId: e3.profile, clockInAt: "2026-06-10T19:00:00.000Z" }, Date.parse("2026-06-10T20:00:00.000Z"));
    await rules.recordMissingClockOut({ employeeId: e1.profile, clockInAt: "2026-06-11T00:30:00.000Z" }, Date.parse("2026-06-11T01:00:00.000Z"));
    for (const at of ["2026-06-10T18:01:00.000Z", "2026-06-10T23:59:00.000Z"]) await rules.digests(Date.parse(at));
    const days = await digestEvents(id);
    assert.deepEqual(days.map((d) => d.local_date), ["2026-06-10"]);
    const from = mock.outbox.length;
    await svc.deliver();
    await svc.deliver();
    const digest = mock.outbox.slice(from).filter((m) => m.subject.includes("daily digest"));
    assert.deepEqual(digest.map((m) => m.to).sort(), [admin.email, head.email].sort());
    for (const m of digest) {
      assert.match(m.subject, /^Missing clock-out: daily digest for 2026-06-10 \(2\)$/);
      assert.ok(m.text.includes(e1.code) && m.text.includes(e2.code) && !m.text.includes(outsider.code) && !m.text.includes(e3.code), "only this team's events up to the digest time");
    }
    // Next day: the late 10 June event and the 11 June one.
    assert.equal(await writesDuring(() => rules.digests(Date.parse("2026-06-10T23:00:00.000Z"))), 0, "digest already recorded: no writes");
    await rules.digests(Date.parse("2026-06-11T18:00:00.000Z"));
    const next = mock.outbox.length;
    await svc.deliver();
    const day2 = mock.outbox.slice(next).find((m) => m.to === admin.email)!;
    assert.match(day2.subject, /daily digest for 2026-06-11 \(2\)$/);
    assert.ok(day2.text.includes(e3.code) && day2.text.includes("2026-06-10 19:00 UTC") && day2.text.includes(e1.code) && !day2.text.includes(e2.code));
    // Empty day: nothing.
    await rules.digests(Date.parse("2026-06-12T19:00:00.000Z"));
    assert.deepEqual((await digestEvents(id)).map((d) => d.local_date), ["2026-06-10", "2026-06-11"]);
  });

  test("a team head's digest lists only that team's members, never another team's events", async () => {
    const member = await person("EMPLOYEE");
    const nonMember = await person("EMPLOYEE");
    const head = await person("EMPLOYEE");
    const t = await team(head, [member]);
    await rule({ type: "MISSING_CLOCK_OUT", teamId: t, mode: "DAILY_DIGEST", digestLocalTime: "18:00", timezone: "UTC" }, [head]);
    await rule({ type: "MISSING_CLOCK_OUT", teamId: await team(null, [nonMember]), mode: "DAILY_DIGEST", digestLocalTime: "18:00", timezone: "UTC" }, [admin]);
    for (const p of [member, nonMember]) await rules.recordMissingClockOut({ employeeId: p.profile, clockInAt: "2026-08-03T08:00:00.000Z" }, Date.parse("2026-08-03T12:00:00.000Z"));
    await rules.digests(Date.parse("2026-08-03T18:00:00.000Z"));
    const from = mock.outbox.length;
    await svc.deliver();
    const mails = mock.outbox.slice(from).filter((m) => m.to === head.email);
    assert.equal(mails.length, 1);
    assert.ok(mails[0]!.text.includes(member.code) && !mails[0]!.text.includes(nonMember.code));
  });

  test("DST (America/New_York): spring-forward gap fires once after the gap; fall-back repeated hour fires once", async () => {
    const e = await person("EMPLOYEE", "America/New_York");
    const t = await team(null, [e]);
    const id = await rule({ type: "MISSING_CLOCK_OUT", teamId: t, mode: "DAILY_DIGEST", digestLocalTime: "02:30", timezone: "America/New_York" }, [admin]);
    await rules.recordMissingClockOut({ employeeId: e.profile, clockInAt: "2026-03-08T05:30:00.000Z" }, Date.parse("2026-03-08T06:00:00.000Z")); // 00:30 EST, 8 March
    await rules.digests(Date.parse("2026-03-08T06:59:00.000Z")); // 01:59 EST
    assert.equal((await digestEvents(id)).length, 0);
    for (const at of ["2026-03-08T07:00:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-08T12:00:00.000Z"]) await rules.digests(Date.parse(at)); // 03:00 EDT onwards
    assert.deepEqual((await digestEvents(id)).map((d) => d.local_date), ["2026-03-08"]);
    // Fall back: 01:30 happens twice on 1 November.
    await db.execute({ sql: "UPDATE notification_rules SET digest_local_time = '01:30' WHERE id = ?", args: [id] });
    await rules.recordMissingClockOut({ employeeId: e.profile, clockInAt: "2026-11-01T04:10:00.000Z" }, Date.parse("2026-11-01T04:20:00.000Z")); // 00:10 EDT
    await rules.digests(Date.parse("2026-11-01T05:29:00.000Z"));
    assert.equal((await digestEvents(id)).length, 1);
    await rules.digests(Date.parse("2026-11-01T05:30:00.000Z")); // 01:30 EDT
    await rules.digests(Date.parse("2026-11-01T06:30:00.000Z")); // 01:30 EST (again)
    assert.deepEqual((await digestEvents(id)).map((d) => d.local_date), ["2026-03-08", "2026-11-01"]);
    const from = mock.outbox.length;
    await svc.deliver();
    assert.equal(mock.outbox.slice(from).filter((m) => m.to === admin.email && m.subject.includes("daily digest")).length, 2);
  });
});

describe("send-time checks and delivery states", () => {
  test("a recipient disabled, removed, or a rule switched OFF before the send: not emailed (FAILED, no mail)", async () => {
    const e = await person("EMPLOYEE");
    const r1 = await person("ADMIN");
    const r2 = await person("ADMIN");
    const r3 = await person("ADMIN");
    const t = await team(null, [e]);
    const id = await rule({ type: "MISSING_CLOCK_OUT", teamId: t, mode: "IMMEDIATE" }, [r1, r2, r3]);
    const ev = (await rules.recordMissingClockOut({ employeeId: e.profile, clockInAt: "2026-07-01T08:00:00.000Z" }, Date.parse("2026-07-01T20:00:00.000Z")))!;
    await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE id = ?", args: [r1.id] });
    await api(`/notifications/rules/${id}/recipients`, { method: "PUT", cookie: adminCookie, body: { userIds: [r3.id] } }); // r1 disabled (can no longer be named), r2 removed
    const from = mock.outbox.length;
    await svc.deliver();
    assert.deepEqual(sentTo(from), [r3.email]);
    assert.deepEqual(await deliveries(ev), [`IT:${r1.email}:FAILED`, `IT:${r2.email}:FAILED`, `IT:${r3.email}:SENT`]);
    const ev2 = (await rules.recordMissingClockOut({ employeeId: e.profile, clockInAt: "2026-07-02T08:00:00.000Z" }, Date.parse("2026-07-02T20:00:00.000Z")))!;
    await api(`/notifications/rules/${id}`, { method: "PATCH", cookie: adminCookie, body: { mode: "OFF" } });
    await svc.deliver();
    assert.deepEqual(await deliveries(ev2), [`IT:${r3.email}:FAILED`]);
    assert.equal(await rules.recordMissingClockOut({ employeeId: e.profile, clockInAt: "2026-07-03T08:00:00.000Z" }, Date.parse("2026-07-03T20:00:00.000Z")), null, "OFF: nothing recorded");
  });

  test("an employee moved out of the team before the send: the team head is not emailed", async () => {
    const e = await person("EMPLOYEE");
    const head = await person("EMPLOYEE");
    const t = await team(head, [e]);
    await rule({ type: "MISSING_CLOCK_OUT", teamId: t, mode: "IMMEDIATE" }, [head]);
    const ev = (await rules.recordMissingClockOut({ employeeId: e.profile, clockInAt: "2026-07-05T08:00:00.000Z" }, Date.parse("2026-07-05T20:00:00.000Z")))!;
    await db.execute({ sql: "DELETE FROM team_members WHERE team_id = ? AND employee_id = ?", args: [t, e.profile] });
    const from = mock.outbox.length;
    await svc.deliver();
    assert.deepEqual(sentTo(from), []);
    assert.deepEqual(await deliveries(ev), [`EMPLOYEE:${head.email}:FAILED`]);
  });

  test("transient failures retry and then send; existing retry endpoint still works on a rule delivery", async () => {
    const e = await person("EMPLOYEE");
    const r = await person("ADMIN");
    await rule({ type: "MISSING_CLOCK_OUT", teamId: await team(null, [e]), mode: "IMMEDIATE" }, [r]);
    const ev = (await rules.recordMissingClockOut({ employeeId: e.profile, clockInAt: "2026-07-06T08:00:00.000Z" }, Date.parse("2026-07-06T20:00:00.000Z")))!;
    const real = mock.send.bind(mock);
    mock.send = async (m) => { if (m.to === r.email) throw new MailError("Mock provider temporarily unavailable", false); return real(m); };
    await svc.deliver();
    assert.deepEqual(await deliveries(ev), [`IT:${r.email}:RETRYING`]);
    mock.send = async (m) => { if (m.to === r.email) throw new MailError("Mock provider rejected the recipient", true); return real(m); };
    await svc.deliver();
    assert.deepEqual(await deliveries(ev), [`IT:${r.email}:FAILED`]);
    mock.send = real;
    const d = (await db.execute({ sql: "SELECT id FROM notification_deliveries WHERE event_id = ?", args: [ev] })).rows[0]!.id;
    assert.equal((await api(`/notifications/deliveries/${d}/retry`, { method: "POST", cookie: adminCookie })).status, 204);
    await svc.deliver();
    assert.deepEqual(await deliveries(ev), [`IT:${r.email}:SENT`]);
    const overview = await api("/notifications?show=all", { cookie: adminCookie });
    assert.ok(overview.body.events.some((x: { id: string; type: string }) => x.id === ev && x.type === "MISSING_CLOCK_OUT"));
  });
});

describe("templates", () => {
  test("IMMEDIATE and digest emails: escaped HTML, plain text twin, only name, code, local time and event type", () => {
    const items = [{ fullName: `<script>"x"</script>`, employeeCode: "E-1", localTime: "2026-11-18 09:40 UTC" }];
    const one = renderAttendance({ type: "LATE_ARRIVAL", digestDate: null, items, to: "x@example.com", dashboardUrl: "https://workfolio.example.com", sender: "it@example.com" });
    assert.ok(!one.html!.includes("<script>") && one.html!.includes("&#60;script&#62;"));
    assert.match(one.text, /Employee: <script>"x"<\/script>\nEmployee code: E-1\nLocal time: 2026-11-18 09:40 UTC\nEvent: Late arrival/);
    const many = renderAttendance({ type: "ABSENCE", digestDate: "2026-11-18", items: Array.from({ length: 205 }, (_, i) => ({ fullName: `P${i}`, employeeCode: `E-${i}`, localTime: "2026-11-18 09:15 UTC" })), to: "x@example.com", dashboardUrl: "https://workfolio.example.com", sender: "it@example.com" });
    assert.match(many.subject, /Absence: daily digest for 2026-11-18 \(205\)/);
    assert.match(many.text, /5 more are in the dashboard/);
    assert.ok(!many.text.includes("P204"));
  });
});

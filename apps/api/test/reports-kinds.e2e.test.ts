// W1-REPORTS-SCHED: report kinds (worked hours / late / absent), send time, team scope. MOCK provider only:
// messages stay in memory, nothing is emailed. In-process API, in-memory DB, synthetic people, fixed dates.
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
process.env.REPORT_MAIL_PROVIDER = "mock";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { ReportsService } = await import("../dist/reports/reports.service.js");
const { MAIL_TRANSPORT, mailTransportProvider } = await import("../dist/reports/mail.js");
const { DelegatedGraphMailTransport } = await import("../dist/employees/invitations.js");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "report password 1";
const OLD = "2026-01-01T00:00:00.000Z";

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let reports: InstanceType<typeof ReportsService>;
let mock: { outbox: { to: string; subject: string; text: string }[] };
let admin: string;
const adminId = randomUUID();
const caller = { id: adminId, role: "ADMIN" };

async function api(path: string, { method = "GET", body, cookie = admin }: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
const login = async (email: string) => {
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};
const create = async (body: object) => {
  const r = await api("/reports/schedules", { method: "POST", body: { name: "Report", frequency: "DAILY", timeZone: "UTC", ...body } });
  assert.equal(r.status, 201, r.text);
  return r.body;
};

let seq = 0;
async function person(name: string, timezone: string) {
  const n = ++seq;
  const [user, id, device] = [randomUUID(), randomUUID(), randomUUID()];
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'EMPLOYEE', ?)", args: [user, `rk${n}@example.com`, await hashPassword(PASSWORD)] });
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: [id, user, `RK-${n}`, name, timezone, OLD] });
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at) VALUES (?, ?, 'Mac', 'macos', ?, ?)", args: [device, id, randomUUID(), OLD] });
  return { id, user, device, email: `rk${n}@example.com` };
}
const clockIn = (p: { id: string; device: string }, at: string) =>
  db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), p.id, p.device, at, new Date(Date.parse(at) + 3_600_000).toISOString()] });

let asha: Awaited<ReturnType<typeof person>>, ben: Awaited<ReturnType<typeof person>>, cara: Awaited<ReturnType<typeof person>>, dev: Awaited<ReturnType<typeof person>>, eli: Awaited<ReturnType<typeof person>>;
let teamId: string;
let headCookie: string, empCookie: string, headUser: string;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  reports = app.get(ReportsService);
  mock = app.get(MAIL_TRANSPORT);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  admin = await login("admin@example.com");

  // Work schedule since January: 09:00 + 10 min grace, Monday to Friday. Mon 5 Oct 2026; Tue 6 Oct is a holiday.
  await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 10, '12345', 'Office hours', ?, ?)", args: [adminId, OLD] });
  await db.execute({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, '2026-10-06', 'Founders Day', ?)", args: [randomUUID(), adminId] });
  asha = await person("Asha Kolkata", "Asia/Kolkata"); // team: 09:30 IST -> late 30 min
  ben = await person("Ben NewYork", "America/New_York"); // team: 08:55 New York -> on time
  cara = await person("Cara NewYork", "America/New_York"); // not in team: 22:00 New York on Mon 5 (Tue 6 in UTC) -> late on the 5th
  dev = await person("Dev Absent", "UTC"); // team: no clock-in -> absent
  eli = await person("Eli Leave", "UTC"); // approved leave on the 5th -> never listed
  await clockIn(asha, "2026-10-05T04:00:00.000Z");
  await clockIn(ben, "2026-10-05T12:55:00.000Z");
  await clockIn(cara, "2026-10-06T02:00:00.000Z");
  await db.execute({ sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, reason, status, decided_by, decided_at) VALUES (?, ?, ?, '2026-10-05', '2026-10-05', 'FULL_DAY', 'SECRET-LEAVE-REASON', 'APPROVED', ?, ?)", args: [randomUUID(), eli.id, eli.user, adminId, OLD] });

  const head = await person("Hana Head", "UTC");
  headUser = head.user;
  teamId = randomUUID();
  await db.execute({ sql: "INSERT INTO teams (id, name, head_user_id, created_by) VALUES (?, 'Ops', ?, ?)", args: [teamId, head.user, adminId] });
  for (const p of [asha, ben, dev]) await db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [teamId, p.id, adminId] });
  headCookie = await login(head.email);
  empCookie = await login(asha.email);
});
after(() => app.close());

// The day after Mon 5 Oct: the last complete UTC day is the 5th; two days after: the 6th (holiday).
const ON_6TH = Date.parse("2026-10-06T12:00:00Z");
const ON_7TH = Date.parse("2026-10-07T12:00:00Z");

describe("configuration", () => {
  test("create and update each kind; send time and team scope are returned", async () => {
    for (const kind of ["WORKED_HOURS", "LATE", "ABSENT"]) {
      const s = await create({ name: `K ${kind}`, kind, sendAtLocalTime: "09:30", teamId });
      assert.deepEqual([s.kind, s.sendAtLocalTime, s.team, s.employee], [kind, "09:30", { id: teamId, name: "Ops" }, null]);
    }
    const plain = await create({ name: "Defaults" });
    assert.deepEqual([plain.kind, plain.sendAtLocalTime, plain.team], ["WORKED_HOURS", null, null], "existing behaviour by default");
    const u = await api(`/reports/schedules/${plain.id}`, { method: "PATCH", body: { kind: "ABSENT", sendAtLocalTime: "18:00", timeZone: "Asia/Kolkata", teamId } });
    assert.equal(u.status, 200, u.text);
    assert.deepEqual([u.body.kind, u.body.sendAtLocalTime, u.body.timeZone, u.body.team.id], ["ABSENT", "18:00", "Asia/Kolkata", teamId]);
    const back = await api(`/reports/schedules/${plain.id}`, { method: "PATCH", body: { teamId: null, employeeId: asha.id, sendAtLocalTime: null } });
    assert.equal(back.status, 200, back.text);
    assert.deepEqual([back.body.team, back.body.employee.id, back.body.sendAtLocalTime], [null, asha.id, null]);
  });

  test("validation: team and employee together 400, bad time 400, unknown kind 400, unknown team/employee 404", async () => {
    const post = (body: object) => api("/reports/schedules", { method: "POST", body: { name: "x", frequency: "DAILY", timeZone: "UTC", ...body } });
    assert.equal((await post({ teamId, employeeId: asha.id })).status, 400);
    for (const sendAtLocalTime of ["24:00", "9:30", "09:60", "noon", ""]) assert.equal((await post({ sendAtLocalTime })).status, 400, sendAtLocalTime);
    assert.equal((await post({ kind: "IDLE" })).status, 400);
    assert.equal((await post({ teamId: "not-a-uuid" })).status, 400);
    assert.equal((await post({ teamId: randomUUID() })).status, 404);
    assert.equal((await post({ employeeId: randomUUID() })).status, 404);
    const s = await create({ name: "Team only", teamId });
    assert.equal((await api(`/reports/schedules/${s.id}`, { method: "PATCH", body: { employeeId: asha.id } })).status, 400, "merged scope would hold both");
    assert.equal((await api(`/reports/schedules/${s.id}`, { method: "PATCH", body: { teamId: randomUUID() } })).status, 404);
    assert.equal((await api(`/reports/schedules/${s.id}`, { method: "PATCH", body: { sendAtLocalTime: "7:00" } })).status, 400);
  });

  test("RBAC: employees and team heads get 403 on every report route", async () => {
    const s = await create({ name: "Rbac", teamId });
    for (const cookie of [empCookie, headCookie]) {
      for (const [method, path, body] of [
        ["GET", "/reports/schedules"], ["POST", "/reports/schedules", { name: "x", frequency: "DAILY", timeZone: "UTC", teamId }],
        ["PATCH", `/reports/schedules/${s.id}`, { kind: "LATE" }], ["POST", `/reports/schedules/${s.id}/run`], ["GET", `/reports/schedules/${s.id}/preview`], ["GET", "/reports/provider"],
      ] as [string, string, object?][]) {
        assert.equal((await api(path, { method, body, cookie })).status, 403, `${method} ${path}`);
      }
    }
  });

  test("recipients: the team's head may receive a team report, not an organisation one", async () => {
    const team = await create({ name: "Head team", teamId });
    const org = await create({ name: "Head org" });
    const emails = async (id: string) => (await api(`/reports/schedules/${id}/eligible-recipients`)).body.map((u: { id: string }) => u.id);
    assert.ok((await emails(team.id)).includes(headUser));
    assert.ok(!(await emails(org.id)).includes(headUser));
    assert.equal((await api(`/reports/schedules/${org.id}/recipients`, { method: "POST", body: { userId: headUser } })).status, 403);
    assert.equal((await api(`/reports/schedules/${team.id}/recipients`, { method: "POST", body: { userId: headUser } })).status, 201);
  });
});

describe("content (Mon 5 Oct 2026)", () => {
  const text = async (body: object, now = ON_6TH) => (await reports.preview((await create(body)).id, now)).text as string;

  test("LATE, organisation: each employee's own local date; on-time, absent and leave not listed", async () => {
    const t = await text({ name: "Late org", kind: "LATE" });
    assert.match(t, /late clock-in report for 2026-10-05/);
    assert.match(t, /^- 2026-10-05 Asha Kolkata \(RK-\d+\): clocked in 09:30, 30 min after the expected start$/m);
    assert.match(t, /^- 2026-10-05 Cara NewYork \(RK-\d+\): clocked in 22:00, /m, "22:00 New York counts for the 5th");
    for (const name of ["Ben NewYork", "Dev Absent", "Eli Leave"]) assert.ok(!t.includes(name), name);
    assert.match(t, /Scope: Organisation\./);
  });

  test("ABSENT, organisation: no clock-in on a workday; leave excluded; no leave details", async () => {
    const t = await text({ name: "Absent org", kind: "ABSENT" });
    assert.match(t, /^- 2026-10-05 Dev Absent \(RK-\d+\)$/m);
    for (const name of ["Asha", "Ben", "Cara", "Eli Leave"]) assert.ok(!t.includes(name), name);
    for (const secret of ["SECRET-LEAVE-REASON", "@example.com", "Founders"]) assert.ok(!t.includes(secret), secret);
  });

  test("holiday: nobody is absent or late", async () => {
    const t = await text({ name: "Absent holiday", kind: "ABSENT" }, ON_7TH);
    assert.match(t, /report for 2026-10-06/);
    assert.match(t, /ABSENT \(no clock-in on a scheduled workday\)\n- none/);
    assert.match(await text({ name: "Late holiday", kind: "LATE" }, ON_7TH), /LATE CLOCK-INS\n- none/);
  });

  test("team scope: only the team's members, for every kind", async () => {
    const late = await text({ name: "Late team", kind: "LATE", teamId });
    assert.ok(late.includes("Asha Kolkata") && !late.includes("Cara"), late);
    assert.match(late, /Scope: Team Ops\./);
    assert.match(await text({ name: "Absent team", kind: "ABSENT", teamId }), /Dev Absent/);
    const hours = await text({ name: "Hours team", teamId });
    for (const name of ["Asha Kolkata", "Ben NewYork", "Dev Absent"]) assert.ok(hours.includes(name), name);
    for (const name of ["Cara", "Eli", "Hana"]) assert.ok(!hours.includes(name), name);
  });

  test("one-employee scope for LATE lists only that employee", async () => {
    const t = await text({ name: "Late Cara", kind: "LATE", employeeId: cara.id });
    assert.ok(t.includes("Cara NewYork") && !t.includes("Asha"), t);
  });
});

describe("scheduling at the send time (fixed clock, mock delivery)", () => {
  const runs = async (id: string) => (await api(`/reports/runs?scheduleId=${id}`)).body as { period: { from: string }; deliveries: { status: string }[] }[];
  const scheduled = async (body: object, createdAt: string) => {
    const s = await create({ kind: "LATE", ...body });
    await db.execute({ sql: "UPDATE report_schedules SET created_at = ? WHERE id = ?", args: [createdAt, s.id] });
    assert.equal((await api(`/reports/schedules/${s.id}/recipients`, { method: "POST", body: { userId: adminId } })).status, 201);
    return s.id as string;
  };

  test("due at 07:00 the next local day, exactly one run per period, delivery MOCKED", async () => {
    const id = await scheduled({ name: "Seven", sendAtLocalTime: "07:00" }, "2026-10-05T12:00:00.000Z");
    const before = mock.outbox.length;
    await reports.tick(Date.parse("2026-10-06T06:59:00Z"));
    assert.equal((await runs(id)).length, 0, "not due before the send time");
    await reports.tick(Date.parse("2026-10-06T07:00:00Z"));
    await reports.tick(Date.parse("2026-10-06T07:05:00Z"));
    await reports.tick(Date.parse("2026-10-07T00:02:00Z"));
    let r = await runs(id);
    assert.deepEqual(r.map((x) => x.period.from), ["2026-10-05"]);
    assert.equal(r[0]!.deliveries[0]!.status, "MOCKED");
    const mail = mock.outbox.slice(before);
    assert.equal(mail.length, 1);
    assert.match(mail[0]!.text, /Asha Kolkata/);
    await reports.tick(Date.parse("2026-10-07T07:00:00Z"));
    r = await runs(id);
    assert.deepEqual(r.map((x) => x.period.from).sort(), ["2026-10-05", "2026-10-06"]);
  });

  test("send time in the schedule's zone (IST 09:00 = 03:30 UTC)", async () => {
    const id = await scheduled({ name: "Ist", sendAtLocalTime: "09:00", timeZone: "Asia/Kolkata" }, "2026-10-05T12:00:00.000Z");
    await reports.tick(Date.parse("2026-10-06T03:29:00Z"));
    assert.equal((await runs(id)).length, 0);
    await reports.tick(Date.parse("2026-10-06T03:30:00Z"));
    assert.deepEqual((await runs(id)).map((x) => x.period.from), ["2026-10-05"]);
  });

  test("a 23:59 send time is caught after midnight; no backfill before creation", async () => {
    const id = await scheduled({ name: "Late night", sendAtLocalTime: "23:59" }, "2026-10-05T00:00:00.000Z");
    await reports.tick(Date.parse("2026-10-07T00:03:00Z"));
    assert.deepEqual((await runs(id)).map((x) => x.period.from), ["2026-10-05"], "5th's report (due 6th 23:59) caught");
    const fresh = await scheduled({ name: "Fresh", sendAtLocalTime: "23:59" }, "2026-10-07T00:00:00.000Z");
    await reports.tick(Date.parse("2026-10-07T00:03:00Z"));
    assert.equal((await runs(fresh)).length, 0, "due before the schedule existed: not sent");
  });

  test("run now ignores the send time and the scheduled run does not repeat it", async () => {
    const id = await scheduled({ name: "Now", sendAtLocalTime: "07:00" }, "2026-10-05T12:00:00.000Z");
    const first = await reports.runNow(caller, id, Date.parse("2026-10-06T01:00:00Z"));
    assert.equal(first.duplicate, false);
    await reports.tick(Date.parse("2026-10-06T07:00:00Z"));
    assert.equal((await runs(id)).length, 1);
  });
});

test("transport: graph-delegated reuses the invitations' delegated Graph transport (not called here); default none", () => {
  const make = (provider: string) => mailTransportProvider.useFactory({ get: () => provider } as never, { token: async () => "unused" } as never);
  const graph = make("graph-delegated");
  assert.ok(graph instanceof DelegatedGraphMailTransport);
  assert.deepEqual([graph.name, graph.delivers], ["graph", true]);
  assert.deepEqual([make("none").name, make("none").delivers, make("mock").name], ["none", false, "mock"]);
});

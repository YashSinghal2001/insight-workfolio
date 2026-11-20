// W2-OVERVIEW: GET /overview (in-process API, in-memory DB, synthetic people). People live in a fixed-offset zone
// where it is ~21:00 now, so "today" never depends on when CI runs.
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

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { addDays, localDate, zonedToUtc } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const offset = ((21 - new Date().getUTCHours() + 36) % 24) - 12;
const TZ = offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
const D = localDate(Date.now(), TZ);
const at = (date: string, hm: string, tz = TZ) => Date.parse(zonedToUtc(`${date}T${hm}`, tz));

type Db = {
  execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }>;
  batch: (q: { sql: string; args: unknown[] }[], mode: "write") => Promise<unknown>;
};
let app: INestApplication;
let base: string;
let db: Db;
let adminId: string;
let admin: string;
let hash: string;

async function api(path: string, cookie?: string) {
  const res = await fetch(`${base}/api/v1${path}`, { headers: { origin: ORIGIN, ...(cookie && { cookie }) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
async function login(email: string) {
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function post(path: string, method: string, body: unknown) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { origin: ORIGIN, cookie: admin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  assert.ok(res.status < 300, text);
  return text ? JSON.parse(text) : undefined;
}

interface Emp { id: string; userId: string; email: string; device: string | null }
let seq = 0;
async function person(name: string, { tz = TZ, device = true } = {}): Promise<Emp> {
  const n = ++seq;
  const userId = randomUUID();
  const id = randomUUID();
  const email = `ov${n}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'EMPLOYEE', ?)", args: [userId, email, hash] });
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, ?, '2020-01-01T00:00:00.000Z')", args: [id, userId, `OV-${n}`, name, tz] });
  const dev = device ? randomUUID() : null;
  if (dev) await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at) VALUES (?, ?, 'Mac', 'macos', ?, ?)", args: [dev, id, randomUUID(), iso(Date.now())] });
  return { id, userId, email, device: dev };
}
async function shift(e: Emp, start: number, end: number | null, brk?: [number, number | null]) {
  const id = randomUUID();
  // Breaks go in while the session is open (as the state machine records them), then it is closed.
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [id, e.id, e.device, iso(start)] });
  if (brk) await db.execute({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)", args: [randomUUID(), id, iso(brk[0]), brk[1] === null ? null : iso(brk[1]), brk[1] === null ? "OPEN" : "CLOSED"] });
  if (end !== null) await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [iso(end), id] });
  return id;
}
const intervalSql = `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name, started_at, ended_at,
  active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, 0, 'DESKTOP_MACOS', ?, ?, ?)`;
const interval = (e: Emp, sessionId: string, app: string, from: number, to: number) => ({
  sql: intervalSql,
  args: [randomUUID(), e.id, e.device, sessionId, `com.${app.toLowerCase()}`, app, iso(from), iso(to), (to - from) / 1000, iso(from), iso(to), randomUUID()],
});
async function screenshot(e: Emp, sessionId: string, capturedAt: number) {
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height,
            mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 100, 100, 'image/webp', 100, ?, 'MICROSOFT_GRAPH', ?, 'STORED', ?)`,
    args: [id, e.id, e.device, sessionId, randomUUID(), iso(capturedAt), iso(capturedAt), "a".repeat(64), `k/${id}`, iso(capturedAt)],
  });
  return id;
}
const leave = (e: Emp, from: string, to: string, status: "APPROVED" | "PENDING", reason = "Synthetic private reason") =>
  db.execute({
    sql: `INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, reason, status, decided_by, decided_at)
          VALUES (?, ?, ?, ?, ?, 'FULL_DAY', ?, ?, ?, ?)`,
    args: [randomUUID(), e.id, e.userId, from, to, reason, status, status === "PENDING" ? null : adminId, status === "PENDING" ? null : iso(Date.now())],
  });
const ids = (rows: { employee: { id: string } }[]) => rows.map((r) => r.employee.id).sort();

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  hash = await hashPassword(PASSWORD);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, hash] });
  admin = await login("admin@example.com");
});
after(() => app.close());

test("empty organisation: every section present and empty; late/absent null without a schedule", async () => {
  const r = await api(`/overview?date=${D}`, admin);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.date, D);
  assert.equal(r.body.teamId, null);
  assert.deepEqual(r.body.kpis, {
    totalMembers: 0, workingNow: 0, onBreak: 0, clockedOut: 0, notStarted: 0, onLeave: 0, appNotInstalled: 0,
    late: null, absent: null, missingClockOuts: 0, screenshotsStored: 0, netWorkMs: 0, breakMs: 0,
  });
  assert.equal(r.body.workload.days.length, 7);
  assert.equal(r.body.workload.days.at(-1).date, D);
  assert.equal(r.body.workload.days[0].date, addDays(D, -6));
  assert.deepEqual(r.body.workload.thresholds, { overworkedAbove: 1.1, lessUtilisedBelow: 0.8 });
  assert.deepEqual(r.body.topApps, { totalActiveMs: 0, otherMs: 0, items: [] });
  for (const k of ["late", "absent", "missingClockOuts", "workHours", "recentScreenshots", "upcomingHolidays", "upcomingLeaves"]) assert.deepEqual(r.body[k], [], k);
  assert.deepEqual(r.body.pendingApprovals, { leave: 0, corrections: 0 });
  // No date: today in the default zone.
  const t = await api("/overview", admin);
  assert.equal(t.status, 200, t.text);
  assert.match(t.body.date, /^\d{4}-\d{2}-\d{2}$/);
});

test("validation and unknown team", async () => {
  for (const q of ["date=2026-02-30", "date=today", `teamId=nope`, "date=2026-01-01&extra=<x>"]) {
    const r = await api(`/overview?${q}`, admin);
    if (q.includes("extra")) assert.equal(r.status, 200, q); // unknown keys are dropped, as on other reads
    else assert.equal(r.status, 400, `${q}: ${r.text}`);
  }
  assert.equal((await api(`/overview?teamId=${randomUUID()}`, admin)).status, 404);
  const anon = await fetch(`${base}/api/v1/overview`, { headers: { origin: ORIGIN } });
  assert.equal(anon.status, 401);
});

describe("one organisation", () => {
  let ana: Emp, ben: Emp, cy: Emp, di: Emp, ed: Emp, fi: Emp, head: Emp;
  let alpha: string, beta: string, shotId: string, edSession: string;

  before(async () => {
    await db.execute({
      sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 15, '1234567', 'test schedule', ?, '2020-01-01T00:00:00.000Z')",
      args: [adminId],
    });
    ana = await person("Ana Present");
    ben = await person("Ben Late");
    cy = await person("Cy Absent");
    di = await person("Di Leave", { device: false });
    ed = await person("Ed Forgot");
    fi = await person("Fi Break");
    head = await person("Hal Head", { device: false });
    const a = await shift(ana, at(D, "09:00"), at(D, "17:30"), [at(D, "12:00"), at(D, "12:30")]); // 480 min
    await db.batch([interval(ana, a, "Editor", at(D, "09:00"), at(D, "11:00")), interval(ana, a, "Browser", at(D, "13:00"), at(D, "14:00"))], "write");
    shotId = await screenshot(ana, a, at(D, "10:00"));
    await shift(ben, at(D, "10:00"), at(D, "18:00")); // late, 480 min
    await shift(cy, at(addDays(D, -2), "09:00"), at(addDays(D, -2), "11:00")); // 120 min, less utilised
    await shift(cy, at(addDays(D, -1), "08:00"), at(addDays(D, -1), "20:00")); // yesterday: 720 min, over-worked
    edSession = await shift(ed, at(addDays(D, -2), "09:00"), null); // open since two days: missing clock-out
    await shift(fi, at(D, "15:00"), null, [at(D, "15:30"), null]); // late, on a break now
    await leave(di, D, addDays(D, 2), "APPROVED");
    await leave(ana, addDays(D, 20), addDays(D, 20), "APPROVED"); // beyond 14 days
    await leave(ben, addDays(D, 3), addDays(D, 3), "PENDING");
    await db.execute({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, ?, 'Synthetic holiday', ?), (?, ?, 'Too far', ?)", args: [randomUUID(), addDays(D, 10), adminId, randomUUID(), addDays(D, 40), adminId] });
    alpha = ((await post("/teams", "POST", { name: "Alpha", headUserId: head.userId })) as { id: string }).id;
    beta = ((await post("/teams", "POST", { name: "Beta" })) as { id: string }).id;
    await post(`/teams/${alpha}/members`, "PUT", { employeeIds: [ana.id, ben.id, head.id] });
    await post(`/teams/${beta}/members`, "PUT", { employeeIds: [cy.id] });
  });

  test("admin, today: KPIs, lists, workload, apps, screenshots, holidays, leave, approvals", async () => {
    const before = (await db.execute("SELECT count(*) AS n FROM screenshot_access_log")).rows[0]!.n;
    const r = await api(`/overview?date=${D}`, admin);
    assert.equal(r.status, 200, r.text);
    const b = r.body;
    assert.deepEqual(
      { ...b.kpis, netWorkMs: undefined, breakMs: undefined },
      { totalMembers: 7, workingNow: 1, onBreak: 1, clockedOut: 2, notStarted: 4, onLeave: 1, appNotInstalled: 2, late: 2, absent: 3, missingClockOuts: b.missingClockOuts.length, screenshotsStored: 1, netWorkMs: undefined, breakMs: undefined },
    );
    assert.deepEqual(ids(b.late), [ben.id, fi.id].sort());
    assert.equal(b.late.find((l: { employee: { id: string } }) => l.employee.id === ben.id).lateMinutes, 60);
    assert.deepEqual(ids(b.absent), [cy.id, ed.id, head.id].sort());
    assert.ok(b.missingClockOuts.some((m: { sessionId: string }) => m.sessionId === edSession));
    const row = (e: Emp) => b.workHours.find((w: { employee: { id: string } }) => w.employee.id === e.id);
    assert.equal(b.workHours.length, 7);
    assert.deepEqual([row(ana).workedMinutes, row(ana).firstClockInAt, row(ana).state, row(ana).online], [480, iso(at(D, "09:00")), "CLOCKED_OUT", true]);
    assert.equal(row(ben).workedMinutes, 480);
    assert.deepEqual([row(ed).state, row(ed).missingClockOut, row(ed).workedMinutes], ["CLOCKED_IN", true, 0], "open since an earlier day: nothing on this date");
    assert.equal(row(fi).state, "ON_BREAK");
    assert.ok(row(fi).workedMinutes >= 30 && row(fi).workedMinutes <= 31, `open shift counts to now minus the open break: ${row(fi).workedMinutes}`);
    assert.deepEqual([row(di).online, row(di).lastSeenAt], [false, null]);
    const day = (d: string) => b.workload.days.find((x: { date: string }) => x.date === d);
    assert.equal(b.workload.scheduledDailyMinutes, 480);
    assert.deepEqual(day(D), { date: D, overworked: 0, healthy: 2, lessUtilised: 0 }, "open shifts are not counted");
    assert.deepEqual(day(addDays(D, -1)), { date: addDays(D, -1), overworked: 1, healthy: 0, lessUtilised: 0 });
    assert.deepEqual(day(addDays(D, -2)), { date: addDays(D, -2), overworked: 0, healthy: 0, lessUtilised: 1 });
    assert.deepEqual(b.topApps, { totalActiveMs: 3 * H, otherMs: 0, items: [{ applicationName: "Editor", activeMs: 2 * H }, { applicationName: "Browser", activeMs: H }] });
    assert.deepEqual(b.recentScreenshots.map((s: { id: string }) => s.id), [shotId]);
    assert.equal(b.recentScreenshots[0].employee.fullName, "Ana Present");
    assert.equal((await db.execute("SELECT count(*) AS n FROM screenshot_access_log")).rows[0]!.n, before, "metadata only: images are logged when opened");
    assert.doesNotMatch(r.text, /k\/[0-9a-f-]{36}|storage_key|storageKey/, "no storage keys");
    assert.deepEqual(b.upcomingHolidays.map((h: { date: string; name: string }) => [h.date, h.name]), [[addDays(D, 10), "Synthetic holiday"]]);
    assert.equal(Object.keys(b.upcomingHolidays[0]).sort().join(), "date,id,name", "no creator email");
    assert.deepEqual(b.upcomingLeaves.map((l: { employee: { id: string }; startDate: string; leaveType: string }) => [l.employee.id, l.startDate, l.leaveType]), [[di.id, D, "General"]]);
    assert.doesNotMatch(r.text, /Synthetic private reason/, "leave reasons never included");
    assert.deepEqual(b.pendingApprovals, { leave: 1, corrections: 0 });
  });

  test("admin + teamId: only the team's active members, everywhere", async () => {
    const a = (await api(`/overview?date=${D}&teamId=${alpha}`, admin)).body;
    assert.equal(a.teamId, alpha);
    assert.deepEqual(ids(a.workHours), [ana.id, ben.id, head.id].sort());
    assert.equal(a.kpis.totalMembers, 3);
    assert.equal(a.kpis.appNotInstalled, 1);
    assert.deepEqual(ids(a.late), [ben.id]);
    assert.deepEqual(ids(a.absent), [head.id]);
    assert.deepEqual(a.missingClockOuts, []);
    assert.equal(a.recentScreenshots.length, 1);
    assert.equal(a.topApps.totalActiveMs, 3 * H);
    assert.deepEqual(a.upcomingLeaves, []);
    assert.deepEqual(a.pendingApprovals, { leave: 1, corrections: 0 });
    const b = (await api(`/overview?date=${D}&teamId=${beta}`, admin)).body;
    assert.deepEqual(ids(b.workHours), [cy.id]);
    assert.deepEqual(b.recentScreenshots, []);
    assert.deepEqual(b.topApps, { totalActiveMs: 0, otherMs: 0, items: [] });
    assert.deepEqual(b.pendingApprovals, { leave: 0, corrections: 0 });
    assert.equal(b.workload.days.find((x: { date: string }) => x.date === addDays(D, -1)).overworked, 1);
  });

  test("team head: own teams only; another team 404; an employee 403", async () => {
    const h = await login(head.email);
    const own = await api(`/overview?date=${D}`, h);
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(ids(own.body.workHours), [ana.id, ben.id, head.id].sort());
    assert.equal(own.body.kpis.totalMembers, 3);
    assert.notEqual(own.body.topApps, null, "team heads read their members' activity");
    assert.deepEqual(own.body.recentScreenshots.map((s: { id: string }) => s.id), [shotId]);
    assert.ok(Array.isArray(own.body.upcomingLeaves));
    assert.doesNotMatch(own.text, new RegExp(`${cy.id}|${di.id}|${ed.id}`), "nobody outside the team");
    assert.equal((await api(`/overview?date=${D}&teamId=${alpha}`, h)).status, 200);
    assert.equal((await api(`/overview?date=${D}&teamId=${beta}`, h)).status, 404);
    assert.equal((await api(`/overview?date=${D}&teamId=${randomUUID()}`, h)).status, 404);
    assert.equal((await api(`/overview?date=${D}`, await login(cy.email))).status, 403);
  });

  test("a past date: that day's hours and statuses; 'now' figures stay now", async () => {
    const y = addDays(D, -1);
    const r = (await api(`/overview?date=${y}`, admin)).body;
    assert.equal(r.date, y);
    const cyRow = r.workHours.find((w: { employee: { id: string } }) => w.employee.id === cy.id);
    assert.deepEqual([cyRow.workedMinutes, cyRow.firstClockInAt], [720, iso(at(y, "08:00"))]);
    assert.ok(ids(r.absent).includes(ana.id), "Ana did not work yesterday");
    assert.ok(!ids(r.absent).includes(cy.id));
    assert.equal(r.kpis.workingNow, 1);
    assert.equal(r.kpis.onBreak, 1);
    assert.equal(r.workload.days.at(-1).date, y);
    assert.deepEqual(r.recentScreenshots.map((s: { id: string }) => s.id), [], "captured after the date");
    assert.deepEqual(r.topApps.items, []);
  });

  test("DST: a New York shift across the spring-forward night counts elapsed time", async () => {
    const ny = await person("Nia NewYork", { tz: "America/New_York" });
    const dst = "2026-03-08";
    await shift(ny, at(dst, "00:30", "America/New_York"), at(dst, "09:30", "America/New_York")); // 9 h on the wall clock, 8 h elapsed
    const r = (await api(`/overview?date=${dst}`, admin)).body;
    const row = r.workHours.find((w: { employee: { id: string } }) => w.employee.id === ny.id);
    assert.equal(row.workedMinutes, 480);
    assert.equal(row.firstClockInAt, "2026-03-08T05:30:00.000Z");
    assert.equal(r.workload.days.find((x: { date: string }) => x.date === dst).healthy, 1);
  });

  test("100 employees: one request under a second (synthetic data)", async (t) => {
    const rows: { sql: string; args: unknown[] }[] = [];
    for (let i = 0; i < 100; i++) {
      const userId = randomUUID();
      const id = randomUUID();
      const dev = randomUUID();
      rows.push(
        { sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'EMPLOYEE', ?)", args: [userId, `load${i}@example.com`, hash] },
        { sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, ?, '2020-01-01T00:00:00.000Z')", args: [id, userId, `LOAD-${i}`, `Load ${i}`, i % 2 ? TZ : "America/New_York"] },
        { sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at) VALUES (?, ?, 'Mac', 'macos', ?, ?)", args: [dev, id, randomUUID(), iso(Date.now())] },
      );
      const e: Emp = { id, userId, email: "", device: dev };
      for (let d = 6; d >= 0; d--) { // oldest first: an open session may not precede a later one
        const date = addDays(D, -d);
        const sid = randomUUID();
        const start = at(date, "09:00");
        rows.push(
          { sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [sid, id, dev, iso(start)] },
          { sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), sid, iso(start + 3 * H), iso(start + 3.5 * H)] },
          { sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [iso(start + (6 + (i % 5)) * H), sid] },
          interval(e, sid, `App${i % 12}`, start, start + H),
          interval(e, sid, `App${(i + 5) % 12}`, start + H, start + 2 * H),
        );
      }
    }
    await db.batch(rows, "write");
    await api(`/overview?date=${D}`, admin); // warm-up
    const t0 = performance.now();
    const r = await api(`/overview?date=${D}`, admin);
    const ms = Math.round(performance.now() - t0);
    t.diagnostic(`overview with ${r.body.kpis.totalMembers} employees: ${ms} ms`);
    assert.equal(r.status, 200);
    assert.ok(r.body.kpis.totalMembers >= 100);
    assert.equal(r.body.topApps.items.length, 8);
    assert.ok(r.body.topApps.otherMs > 0);
    assert.ok(ms < 1000, `${ms} ms`);
  });
});

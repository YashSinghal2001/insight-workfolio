// F10 leave requests (in-process API, in-memory DB, synthetic data). Policy-neutral: no types,
// balances or payroll; attendance is never changed. Identity always comes from the session.
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
const { addDays, localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const H = 3_600_000;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string; // cookie; no employee profile
let lead: { cookie: string; bearer: string; id: string }; // an admin who is also an employee

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, cookie, bearer, headers: extra = {} }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

let seq = 0;
async function employee(timezone = "UTC") {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `lv${n}@example.com`, employeeCode: `LV-${n}`, fullName: `Leave ${n}`, timezone } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `lv${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID(), tz: timezone };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  return e;
}

const today = (tz = "UTC") => localDate(Date.now(), tz);
const ask = (who: { bearer?: string; cookie?: string }, body: object) => api("/leave", { method: "POST", ...who, body });
const full = (start: string, end = start, reason?: string) => ({ startDate: start, endDate: end, portion: "FULL_DAY", ...(reason === undefined ? {} : { reason }) });
const half = (date: string, portion = "FIRST_HALF") => ({ startDate: date, endDate: date, portion });
const short = (date: string, startTime: string, endTime: string) => ({ startDate: date, endDate: date, portion: "SHORT", startTime, endTime });
const decide = (id: string, action: "approve" | "reject", note?: string, cookie = admin) =>
  api(`/leave/${id}/${action}`, { method: "POST", cookie, body: note === undefined ? {} : { note } });
const cancel = (id: string, who: { bearer?: string; cookie?: string }) => api(`/leave/${id}/cancel`, { method: "POST", ...who });
const stored = async (employeeId: string) =>
  Number((await db.execute({ sql: "SELECT count(*) AS n FROM leave_requests WHERE employee_id = ?", args: [employeeId] })).rows[0]!.n);

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  for (const email of ["admin@example.com", "lead@example.com"]) {
    await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'ADMIN', ?)", args: [randomUUID(), email, await hashPassword(PASSWORD)] });
  }
  admin = cookiesOf((await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res);
  const userId = String((await db.execute("SELECT id FROM users WHERE email = 'lead@example.com'")).rows[0]!.id);
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, 'LEAD-1', 'Team Lead', 'UTC')", args: [id, userId] });
  const cookie = cookiesOf((await api("/auth/login", { method: "POST", body: { email: "lead@example.com", password: PASSWORD } })).res);
  const bearer = (await api("/auth/login", { method: "POST", body: { email: "lead@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken;
  lead = { cookie, bearer, id };
});
after(() => app.close());

describe("leave requests", () => {
  test("full-day, half-day and short leave are recorded as asked, for the signed-in employee only", async () => {
    const e = await employee();
    const d = addDays(today(), 10);
    const r1 = await ask(e, full(d, addDays(d, 2), "  Family event  "));
    assert.equal(r1.status, 201, r1.text);
    assert.equal(r1.body.employee.id, e.id);
    assert.deepEqual(
      { s: r1.body.startDate, e: r1.body.endDate, p: r1.body.portion, t: [r1.body.startTime, r1.body.endTime], reason: r1.body.reason, status: r1.body.status },
      { s: d, e: addDays(d, 2), p: "FULL_DAY", t: [null, null], reason: "Family event", status: "PENDING" },
    );
    assert.deepEqual(r1.body.history.map((h: { action: string }) => h.action), ["SUBMITTED"]);
    assert.equal(r1.body.decidedBy, null);

    const r2 = await ask(e, half(addDays(d, 5), "SECOND_HALF"));
    assert.equal(r2.status, 201, r2.text);
    assert.equal(r2.body.reason, null, "no reason is required");
    const r3 = await ask(e, { ...short(addDays(d, 6), "14:00", "15:30"), reason: "" });
    assert.equal(r3.status, 201, r3.text);
    assert.deepEqual([r3.body.startTime, r3.body.endTime, r3.body.reason], ["14:00", "15:30", null]);

    const mine = await api("/leave", { bearer: e.bearer });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.items.map((x: { id: string }) => x.id), [r3.body.id, r2.body.id, r1.body.id], "latest dates first");
    // Past dates are accepted too (e.g. reported after a sick day); whether that is allowed is policy.
    assert.equal((await ask(e, full(addDays(today(), -3)))).status, 201);
  });

  test("invalid input is refused (400) and nothing is stored", async () => {
    const e = await employee();
    const d = addDays(today(), 20);
    for (const body of [
      full(d, addDays(d, -1)), // reversed
      full("2026-02-30"), // not a date
      { ...half(d), endDate: addDays(d, 1) }, // half day over two dates
      { startDate: d, endDate: d, portion: "SHORT" }, // short without times
      short(d, "15:00", "14:00"), // end before start
      short(d, "14:00", "14:00"), // empty
      short(d, "24:00", "24:30"), // not a time
      short(d, "9:00", "10:00"), // not HH:MM
      { ...full(d), startTime: "09:00", endTime: "10:00" }, // times on a full day
      { ...full(d), portion: "UNPAID" }, // no leave types exist
      { ...full(d), type: "SICK" }, // unknown field
      { ...full(d), employeeId: randomUUID() }, // identity never comes from the body
      { ...full(d), reason: "x".repeat(501) },
      full(d, addDays(d, 366)), // 367 dates
      {}, // nothing
    ]) {
      const r = await ask(e, body);
      assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)} → ${r.text}`);
    }
    assert.equal(await stored(e.id), 0);
    const from = addDays(today(), -100);
    assert.equal((await ask(e, full(from, addDays(from, 365)))).status, 201, "366 dates is the limit");
  });

  test("the date window uses the employee's time zone (UTC+14 vs UTC-11)", async () => {
    const east = await employee("Pacific/Kiritimati");
    const west = await employee("Pacific/Pago_Pago");
    assert.ok(today(east.tz) > today(west.tz), "the two zones are on different dates");
    const limit = addDays(today(east.tz), 366);
    assert.equal((await ask(east, full(limit))).status, 201, "366 days ahead of the eastern date");
    const r = await ask(west, full(limit));
    assert.equal(r.status, 400, "beyond 366 days of the western date");
    assert.match(r.body.message, /Pacific\/Pago_Pago/);
    assert.equal((await ask(west, full(addDays(today(west.tz), 366)))).status, 201);
    assert.equal((await ask(west, full(addDays(today(west.tz), -367)))).status, 400);
  });

  test("overlapping pending or approved requests are refused (409); halves and separate short leaves are not overlaps", async () => {
    const e = await employee();
    const d = addDays(today(), 30);
    const first = await ask(e, full(d, addDays(d, 2)));
    assert.equal(first.status, 201);
    const clash = await ask(e, full(addDays(d, 2), addDays(d, 4)));
    assert.equal(clash.status, 409);
    assert.match(clash.body.message, /overlaps your pending request/);
    assert.equal((await ask(e, half(addDays(d, 1)))).status, 409, "inside a full-day request");
    assert.equal((await ask(e, short(d, "10:00", "11:00"))).status, 409);

    const h = addDays(d, 10);
    assert.equal((await ask(e, half(h, "FIRST_HALF"))).status, 201);
    assert.equal((await ask(e, half(h, "SECOND_HALF"))).status, 201, "the other half");
    assert.equal((await ask(e, half(h, "FIRST_HALF"))).status, 409, "the same half twice");
    assert.equal((await ask(e, short(h, "16:00", "17:00"))).status, 409, "a half day's hours are undefined, so any short leave that day overlaps");

    const s = addDays(d, 20);
    assert.equal((await ask(e, short(s, "10:00", "11:00"))).status, 201);
    assert.equal((await ask(e, short(s, "11:00", "12:00"))).status, 201, "back to back");
    assert.equal((await ask(e, short(s, "10:30", "11:30"))).status, 409);
    assert.equal((await ask(e, full(s))).status, 409);

    // Rejected and cancelled requests free the time again; approved ones keep it.
    assert.equal((await decide(first.body.id, "reject")).status, 200);
    const again = await ask(e, full(d));
    assert.equal(again.status, 201, again.text);
    assert.equal((await cancel(again.body.id, e)).status, 200);
    const third = await ask(e, full(d));
    assert.equal((await decide(third.body.id, "approve")).status, 200);
    assert.match((await ask(e, half(d))).body.message, /overlaps your approved request/);
    // Other employees are unaffected.
    assert.equal((await ask(await employee(), full(d))).status, 201);
  });

  test("approve, reject and cancel: decided once, with who, when and the optional note", async () => {
    const e = await employee();
    const d = addDays(today(), 50);
    const a = (await ask(e, full(d))).body;
    const ok = await decide(a.id, "approve", "  Enjoy  ");
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.status, "APPROVED");
    assert.equal(ok.body.decidedBy.email, "admin@example.com");
    assert.equal(ok.body.decisionNote, "Enjoy");
    assert.deepEqual(ok.body.history.map((h: { action: string; by: { email: string }; note: string | null }) => [h.action, h.by.email, h.note]), [
      ["SUBMITTED", "lv" + seq + "@example.com", null],
      ["APPROVED", "admin@example.com", "Enjoy"],
    ]);
    assert.ok(ok.body.history[1].at >= ok.body.history[0].at);
    for (const r of [await decide(a.id, "approve"), await decide(a.id, "reject"), await cancel(a.id, e)]) assert.equal(r.status, 409, r.text);
    assert.match((await cancel(a.id, e)).body.message, /already approved/, "approved leave cannot be cancelled here (policy decision)");

    const b = (await ask(e, full(addDays(d, 1)))).body;
    const no = await decide(b.id, "reject");
    assert.deepEqual([no.status, no.body.status, no.body.decisionNote], [200, "REJECTED", null], "the note is optional");
    assert.equal((await decide(b.id, "approve")).status, 409);

    const c = (await ask(e, full(addDays(d, 2)))).body;
    const gone = await cancel(c.id, e);
    assert.deepEqual([gone.status, gone.body.status, gone.body.decidedBy.id], [200, "CANCELLED", gone.body.requestedBy.id]);
    assert.equal((await decide(c.id, "approve")).status, 409, "a cancelled request cannot be approved");

    // Two reviewers at once: exactly one decision is recorded.
    const x = (await ask(e, full(addDays(d, 3)))).body;
    const both = await Promise.all([decide(x.id, "approve"), decide(x.id, "reject", undefined, lead.cookie)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    const final = (await api(`/leave/${x.id}`, { bearer: e.bearer })).body;
    assert.equal(final.history.length, 2);

    assert.equal((await decide(randomUUID(), "approve")).status, 404);
    assert.equal((await api("/leave/not-a-uuid", { cookie: admin })).status, 400);
    assert.equal((await decide(c.id, "approve", "x".repeat(1001))).status, 400);
    assert.equal((await api(`/leave/${c.id}/approve`, { method: "POST", cookie: admin, body: { note: "ok", status: "APPROVED" } })).status, 400, "no extra fields");
  });

  test("isolation and authorization: own requests only, admins decide server-side, never their own", async () => {
    const [a, b] = [await employee(), await employee()];
    const d = addDays(today(), 70);
    const ra = (await ask(a, full(d, d, "Private reason A"))).body;
    await ask(b, full(d));

    // Employees: no decisions, no one else's requests (404, not 403: existence is not revealed).
    assert.equal((await api(`/leave/${ra.id}/approve`, { method: "POST", body: {} })).status, 401);
    assert.equal((await api(`/leave/${ra.id}/approve`, { method: "POST", bearer: a.bearer, body: {} })).status, 403, "cannot approve own");
    assert.equal((await api(`/leave/${ra.id}/approve`, { method: "POST", bearer: b.bearer, body: {} })).status, 403);
    assert.equal((await api(`/leave/${ra.id}`, { bearer: b.bearer })).status, 404);
    assert.equal((await cancel(ra.id, b)).status, 404);
    assert.equal((await api(`/leave?employeeId=${a.id}`, { bearer: b.bearer })).status, 404);
    const listB = await api("/leave", { bearer: b.bearer, headers: { "x-employee-id": a.id, "x-user-id": a.id } });
    assert.ok(listB.body.items.length >= 1 && listB.body.items.every((r: { employee: { id: string } }) => r.employee.id === b.id), "spoofed headers ignored");
    assert.ok(!listB.text.includes("Private reason A"));
    assert.equal((await api("/leave")).status, 401);
    assert.equal((await ask({}, full(d))).status, 401);

    // Admins see everyone's (with the reason), filter by employee, cannot cancel for the employee.
    const all = await api(`/leave?employeeId=${a.id}`, { cookie: admin });
    assert.deepEqual(all.body.items.map((r: { reason: string }) => r.reason), ["Private reason A"]);
    assert.equal((await api(`/leave?status=PENDING&pageSize=100`, { cookie: admin })).body.items.every((r: { status: string }) => r.status === "PENDING"), true);
    assert.equal((await api("/leave?status=LOST", { cookie: admin })).status, 400);
    assert.equal((await cancel(ra.id, { cookie: admin })).status, 403);
    // An admin without an employee profile has no leave of their own.
    assert.equal((await ask({ cookie: admin }, full(d))).status, 403);
    // An admin who is also an employee asks like anyone else; another admin must decide.
    const own = (await ask({ bearer: lead.bearer }, full(d))).body;
    assert.equal(own.employee.id, lead.id);
    const self = await decide(own.id, "approve", undefined, lead.cookie);
    assert.equal(self.status, 403);
    assert.match(self.body.message, /your own/);
    assert.equal((await decide(own.id, "approve")).status, 200);
  });

  test("attendance is never changed by leave", async () => {
    const e = await employee();
    const yesterday = addDays(today(), -1);
    const start = Date.parse(`${yesterday}T09:00:00Z`);
    const sync = await api("/attendance/sync", {
      method: "POST", bearer: e.bearer, headers: { "x-device-id": e.device },
      body: { sentAt: new Date().toISOString(), events: [["CLOCK_IN", start], ["CLOCK_OUT", start + 4 * H]].map(([type, at]) => ({ id: randomUUID(), type, occurredAt: new Date(at as number).toISOString() })) },
    });
    assert.equal(sync.status, 200, sync.text);
    const range = `from=${addDays(yesterday, -1)}&to=${today()}`;
    const before = await Promise.all([api(`/attendance/timesheet?${range}`, { bearer: e.bearer }), api(`/attendance/history?${range}`, { bearer: e.bearer })]);
    const counts = async () => (await db.execute({ sql: "SELECT (SELECT count(*) FROM attendance_sessions WHERE employee_id = ?1) s, (SELECT count(*) FROM attendance_events WHERE employee_id = ?1) e, (SELECT employment_status FROM employee_profiles WHERE id = ?1) st", args: [e.id] })).rows[0];
    const countsBefore = await counts();

    const r = (await ask(e, full(yesterday, today()))).body;
    assert.equal((await decide(r.id, "approve")).status, 200);
    const after = await Promise.all([api(`/attendance/timesheet?${range}`, { bearer: e.bearer }), api(`/attendance/history?${range}`, { bearer: e.bearer })]);
    assert.deepEqual(after.map((x) => x.body), before.map((x) => x.body), "timesheet and shifts identical");
    assert.deepEqual(await counts(), countsBefore, "no sessions or events added; employment status untouched");
    // Clocking in on an approved leave day still works (nothing is blocked automatically).
    const clock = await api("/attendance/clock-in", { method: "POST", bearer: e.bearer, headers: { "x-device-id": e.device, "idempotency-key": randomUUID() } });
    assert.equal(clock.status, 200, clock.text);
  });
});

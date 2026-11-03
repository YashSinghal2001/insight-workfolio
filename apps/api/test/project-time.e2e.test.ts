// F11 project and task time (in-process API, in-memory DB, synthetic data). Timers use server time,
// need an open shift with no break, and never write attendance. Identity always from the session.
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
const { addDays, localDate, totalMs } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
const H = 60 * M;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let adminId: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, cookie, bearer, headers: extra = {} }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("json") && text;
  return { status: res.status, body: json ? JSON.parse(text) : undefined, text };
}
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
async function employee(timezone = "UTC") {
  const n = ++seq;
  const email = `pt${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: `PT-${n}`, fullName: `Tracker ${n}`, timezone } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken as string;
  const e = { id: r.body.employee.id as string, email, bearer, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;
const as = (e: Emp) => ({ bearer: e.bearer });
const clock = async (e: Emp, action: "clock-in" | "clock-out" | "break/start" | "break/end") => {
  const r = await api(`/attendance/${action}`, { method: "POST", bearer: e.bearer, headers: { "x-device-id": e.device, "idempotency-key": randomUUID() } });
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const sync = async (e: Emp, events: [string, number][]) => {
  const r = await api("/attendance/sync", { method: "POST", bearer: e.bearer, headers: { "x-device-id": e.device }, body: { sentAt: iso(Date.now()), events: events.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) } });
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
};
const start = (e: Emp, taskId: string) => api("/task-time/start", { method: "POST", ...as(e), body: { taskId } });
const end = (e: Emp, id: string, how: "pause" | "stop") => api(`/task-time/${id}/${how}`, { method: "POST", ...as(e) });
const current = async (e: Emp) => (await api("/task-time/current", as(e))).body;
const attendanceCounts = async (employeeId: string) =>
  (await db.execute({ sql: "SELECT (SELECT count(*) FROM attendance_sessions WHERE employee_id = ?1) s, (SELECT count(*) FROM attendance_events WHERE employee_id = ?1) e, (SELECT count(*) FROM break_sessions b JOIN attendance_sessions a ON a.id = b.attendance_session_id WHERE a.employee_id = ?1) b", args: [employeeId] })).rows[0];

async function project(code: string, tasks: string[], members: Emp[]) {
  const p = await api("/projects", { method: "POST", cookie: admin, body: { code, name: `Project ${code}` } });
  assert.equal(p.status, 201, p.text);
  for (const title of tasks) assert.equal((await api(`/projects/${p.body.id}/tasks`, { method: "POST", cookie: admin, body: { title } })).status, 201);
  for (const m of members) assert.equal((await api(`/projects/${p.body.id}/members`, { method: "POST", cookie: admin, body: { employeeId: m.id } })).status, 201);
  const full = (await api("/projects", { cookie: admin })).body.find((x: { id: string }) => x.id === p.body.id);
  return { id: p.body.id as string, tasks: full.tasks.map((t: { id: string }) => t.id) as string[] };
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
});
after(() => app.close());

describe("projects and tasks (admin)", () => {
  test("create, edit, archive and restore projects; tasks; assignments; every change in the history", async () => {
    const e = await employee();
    const created = await api("/projects", { method: "POST", cookie: admin, body: { code: " apollo-1 ", name: " Apollo ", description: "Launch" } });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual([created.body.code, created.body.name, created.body.status], ["APOLLO-1", "Apollo", "ACTIVE"]);
    const id = created.body.id;
    for (const body of [{ code: "APOLLO-1", name: "Dup" }, { code: "a", name: "x" }, { code: "OK-1", name: "" }, { code: "OK-2", name: "x", owner: "me" }]) {
      assert.equal((await api("/projects", { method: "POST", cookie: admin, body })).status, body.code === "APOLLO-1" ? 409 : 400, JSON.stringify(body));
    }
    assert.equal((await api(`/projects/${id}`, { method: "PATCH", cookie: admin, body: {} })).status, 400, "nothing to change");
    const renamed = await api(`/projects/${id}`, { method: "PATCH", cookie: admin, body: { name: "Apollo II", description: null } });
    assert.deepEqual([renamed.body.name, renamed.body.description], ["Apollo II", null]);
    const task = await api(`/projects/${id}/tasks`, { method: "POST", cookie: admin, body: { title: "Design" } });
    const taskId = task.body.tasks[0].id;
    assert.equal((await api(`/projects/${id}/tasks/${taskId}`, { method: "PATCH", cookie: admin, body: { title: "Design v2" } })).body.tasks[0].title, "Design v2");
    assert.equal((await api(`/projects/${id}/tasks/${taskId}`, { method: "PATCH", cookie: admin, body: { status: "CLOSED" } })).body.tasks[0].status, "CLOSED");
    assert.equal((await api(`/projects/${randomUUID()}/tasks/${taskId}`, { method: "PATCH", cookie: admin, body: { status: "OPEN" } })).status, 404);
    const other = (await api("/projects", { method: "POST", cookie: admin, body: { code: "OTHER-1", name: "Other" } })).body.id;
    assert.equal((await api(`/projects/${other}/tasks/${taskId}`, { method: "PATCH", cookie: admin, body: { status: "OPEN" } })).status, 404, "a task of another project");

    const assigned = await api(`/projects/${id}/members`, { method: "POST", cookie: admin, body: { employeeId: e.id } });
    assert.deepEqual(assigned.body.members.map((m: { id: string }) => m.id), [e.id]);
    assert.equal((await api(`/projects/${id}/members`, { method: "POST", cookie: admin, body: { employeeId: e.id } })).status, 409);
    assert.equal((await api(`/projects/${id}/members`, { method: "POST", cookie: admin, body: { employeeId: randomUUID() } })).status, 404);
    assert.equal((await api(`/projects/${id}/members/${e.id}`, { method: "DELETE", cookie: admin })).body.members.length, 0);
    assert.equal((await api(`/projects/${id}/members/${e.id}`, { method: "DELETE", cookie: admin })).status, 404);
    assert.equal((await api(`/projects/${id}`, { method: "PATCH", cookie: admin, body: { status: "ARCHIVED" } })).body.status, "ARCHIVED");
    assert.equal((await api(`/projects/${id}`, { method: "PATCH", cookie: admin, body: { status: "ACTIVE" } })).body.status, "ACTIVE");

    const history = (await api(`/projects/${id}/history`, { cookie: admin })).body;
    assert.deepEqual(history.map((h: { action: string }) => h.action), [
      "PROJECT_CREATED", "PROJECT_UPDATED", "TASK_CREATED", "TASK_UPDATED", "TASK_CLOSED", "EMPLOYEE_ASSIGNED", "EMPLOYEE_UNASSIGNED", "PROJECT_ARCHIVED", "PROJECT_RESTORED",
    ]);
    assert.ok(history.every((h: { by: { email: string } }) => h.by.email === "admin@example.com"));
    const rows = await db.execute({ sql: "SELECT removed_at FROM project_members WHERE project_id = ?", args: [id] });
    assert.equal(rows.rows.length, 1, "the ended assignment is kept");
  });

  test("admin routes are admin-only, server-side", async () => {
    const e = await employee();
    const { id, tasks } = await project("SEC-1", ["T"], [e]);
    for (const [method, path, body] of [
      ["GET", "/projects"], ["GET", "/projects/summary?from=2026-10-01&to=2026-10-07"], ["POST", "/projects", { code: "X-1", name: "x" }],
      ["PATCH", `/projects/${id}`, { status: "ARCHIVED" }], ["GET", `/projects/${id}/history`], ["POST", `/projects/${id}/members`, { employeeId: e.id }],
      ["DELETE", `/projects/${id}/members/${e.id}`], ["POST", `/projects/${id}/tasks`, { title: "x" }], ["PATCH", `/projects/${id}/tasks/${tasks[0]}`, { status: "CLOSED" }],
    ] as [string, string, object?][]) {
      assert.equal((await api(path, { method, bearer: e.bearer, body })).status, 403, `${method} ${path}`);
      assert.equal((await api(path, { method, body })).status, 401, `${method} ${path} signed out`);
    }
    assert.equal((await api("/projects/not-a-uuid/history", { cookie: admin })).status, 400);
    assert.equal((await api(`/projects/${randomUUID()}/history`, { cookie: admin })).status, 404);
  });
});

describe("task timers (employee)", () => {
  test("assignments: only active projects the employee is assigned to, with open tasks", async () => {
    const [a, b] = [await employee(), await employee()];
    const p1 = await project("ASG-1", ["Open", "Closed"], [a]);
    await api(`/projects/${p1.id}/tasks/${p1.tasks[1]}`, { method: "PATCH", cookie: admin, body: { status: "CLOSED" } });
    const p2 = await project("ASG-2", ["X"], [a]);
    await api(`/projects/${p2.id}`, { method: "PATCH", cookie: admin, body: { status: "ARCHIVED" } });
    await project("ASG-3", ["Y"], [b]);
    const mine = (await api("/task-time/assignments", as(a))).body;
    assert.deepEqual(mine.map((p: { code: string; tasks: { title: string }[] }) => [p.code, p.tasks.map((t) => t.title)]), [["ASG-1", ["Open"]]]);
    assert.equal(mine[0].members, undefined, "employees do not see who else is assigned");
    assert.equal((await api("/task-time/assignments", { cookie: admin })).status, 403, "an admin without an employee profile");
  });

  test("start, pause, resume and stop with server times; duplicates and concurrent requests are safe", async () => {
    const e = await employee();
    const { tasks: [t1, t2] } = await project("TMR-1", ["One", "Two"], [e]);
    assert.match((await start(e, t1!)).body.message, /Clock in/, "not clocked in");
    await clock(e, "clock-in");
    const before = Date.now();
    const s1 = await start(e, t1!);
    assert.equal(s1.status, 200, s1.text);
    assert.ok(Date.parse(s1.body.startedAt) >= before - 5 && Date.parse(s1.body.startedAt) <= Date.now(), "server time");
    assert.equal(s1.body.endedAt, null);
    assert.equal((await start(e, t1!)).body.id, s1.body.id, "starting the running task again returns it");
    const other = await start(e, t2!);
    assert.equal(other.status, 409);
    assert.match(other.body.message, /already running for TMR-1 · One/);
    // A burst of starts (double taps, retries): one running entry.
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => start(e, t1!)));
    assert.ok(burst.every((r) => r.status === 200 && r.body.id === s1.body.id));
    assert.equal((await current(e)).running.id, s1.body.id);

    const p = await end(e, s1.body.id, "pause");
    assert.deepEqual([p.status, p.body.endReason], [200, "PAUSED"]);
    assert.equal(p.body.durationMs, Date.parse(p.body.endedAt) - Date.parse(p.body.startedAt));
    assert.equal((await end(e, s1.body.id, "pause")).status, 409, "pausing twice");
    assert.equal((await end(e, s1.body.id, "stop")).status, 409, "a late stop cannot end a newer timer");
    const paused = await current(e);
    assert.deepEqual([paused.running, paused.paused.id], [null, s1.body.id]);
    const s2 = await start(e, t1!); // resume = a new entry on the same task
    assert.notEqual(s2.body.id, s1.body.id);
    const stopped = await end(e, s2.body.id, "stop");
    assert.equal(stopped.body.endReason, "STOPPED");
    assert.deepEqual([(await current(e)).running, (await current(e)).paused], [null, null]);
    // Two different tasks at the same moment: exactly one runs.
    const race = await Promise.all([start(e, t1!), start(e, t2!)]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    const running = (await db.execute({ sql: "SELECT count(*) AS n FROM task_time_entries WHERE employee_id = ? AND ended_at IS NULL", args: [e.id] })).rows[0]!.n;
    assert.equal(Number(running), 1);
  });

  test("a timer of a known length: duration = server end − server start, matching the wall clock", async () => {
    const e = await employee();
    const { tasks: [t] } = await project("LEN-1", ["Work"], [e]);
    await clock(e, "clock-in");
    const t0 = Date.now();
    const s = (await start(e, t!)).body;
    await new Promise((r) => setTimeout(r, 1500));
    const done = (await end(e, s.id, "stop")).body;
    const wall = Date.now() - t0;
    assert.equal(done.durationMs, Date.parse(done.endedAt) - Date.parse(done.startedAt));
    assert.ok(done.durationMs >= 1450 && done.durationMs <= wall, `${done.durationMs} ms of ${wall} ms`);
    const stored = (await db.execute({ sql: "SELECT started_at, ended_at FROM task_time_entries WHERE id = ?", args: [s.id] })).rows[0]!;
    assert.deepEqual([stored.started_at, stored.ended_at], [s.startedAt, done.endedAt], "what the API reported is what is stored");
    // Deleted or edited? Never: the database refuses both.
    await assert.rejects(db.execute({ sql: "UPDATE task_time_entries SET ended_at = ? WHERE id = ?", args: [new Date().toISOString(), s.id] }));
    await assert.rejects(db.execute({ sql: "DELETE FROM task_time_entries WHERE id = ?", args: [s.id] }));
  });

  test("invalid and unauthorized timer requests", async () => {
    const [a, b] = [await employee(), await employee()];
    const pa = await project("INV-1", ["A", "Closed"], [a]);
    const pb = await project("INV-2", ["B"], [b]);
    const archived = await project("INV-3", ["Z"], [a]);
    await api(`/projects/${pa.id}/tasks/${pa.tasks[1]}`, { method: "PATCH", cookie: admin, body: { status: "CLOSED" } });
    await api(`/projects/${archived.id}`, { method: "PATCH", cookie: admin, body: { status: "ARCHIVED" } });
    await clock(a, "clock-in");
    assert.equal((await start(a, pb.tasks[0]!)).status, 404, "a task of a project the employee is not assigned to");
    assert.equal((await start(a, randomUUID())).status, 404);
    assert.match((await start(a, pa.tasks[1]!)).body.message, /closed/);
    assert.match((await start(a, archived.tasks[0]!)).body.message, /archived/);
    assert.equal((await api("/task-time/start", { method: "POST", bearer: a.bearer, body: { taskId: "x" } })).status, 400);
    assert.equal((await api("/task-time/start", { method: "POST", bearer: a.bearer, body: { taskId: pa.tasks[0], employeeId: b.id } })).status, 400, "identity never from the body");
    assert.equal((await api("/task-time/start", { method: "POST", body: { taskId: pa.tasks[0] } })).status, 401);
    const mine = (await start(a, pa.tasks[0]!)).body;
    await clock(b, "clock-in");
    assert.equal((await end(b, mine.id, "stop")).status, 404, "another employee's timer");
    assert.equal((await end(a, randomUUID(), "stop")).status, 404);
    // Removal from the project: the running timer can still be stopped; no new one can start.
    await api(`/projects/${pa.id}/members/${a.id}`, { method: "DELETE", cookie: admin });
    assert.equal((await end(a, mine.id, "pause")).status, 200);
    assert.equal((await current(a)).paused, null, "no resume offered after removal");
    assert.equal((await start(a, pa.tasks[0]!)).status, 404);
  });

  test("breaks and clock-out end the timer at the recorded time; attendance itself is unchanged", async () => {
    const e = await employee();
    const { tasks: [t] } = await project("ATT-1", ["Work"], [e]);
    await clock(e, "clock-in");
    const counts0 = await attendanceCounts(e.id);
    const s1 = (await start(e, t!)).body;
    const brk = await clock(e, "break/start");
    const state = await current(e);
    assert.deepEqual([state.running, state.attendance], [null, { clockedIn: true, onBreak: true }]);
    const ended = (await api(`/task-time/entries?from=${localDate(Date.now(), "UTC")}&to=${localDate(Date.now(), "UTC")}`, as(e))).body.find((x: { id: string }) => x.id === s1.id);
    const breakRow = (await db.execute({ sql: "SELECT b.started_at FROM break_sessions b JOIN attendance_sessions s ON s.id = b.attendance_session_id WHERE s.employee_id = ?", args: [e.id] })).rows[0]!;
    assert.deepEqual([ended.endReason, ended.endedAt], ["BREAK", breakRow.started_at], "ended exactly at the recorded break start");
    assert.ok(brk, "break recorded as usual");
    assert.match((await start(e, t!)).body.message, /end any break/, "no timer during a break");
    await clock(e, "break/end");
    const s2 = (await start(e, t!)).body;
    await clock(e, "clock-out");
    const out = (await db.execute({ sql: "SELECT clock_out_at FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows[0]!.clock_out_at;
    const after = (await api(`/task-time/entries?from=${localDate(Date.now(), "UTC")}&to=${localDate(Date.now(), "UTC")}`, as(e))).body.find((x: { id: string }) => x.id === s2.id);
    assert.deepEqual([after.endReason, after.endedAt], ["CLOCK_OUT", out]);
    assert.deepEqual(await attendanceCounts(e.id), { ...counts0, e: Number(counts0!.e) + 3, b: 1 }, "only the 3 attendance actions were recorded (break start, break end, clock-out)");
    assert.equal((await current(e)).attendance.clockedIn, false);
  });

  test("a break synced later from offline that covers the timer start ends it with no time counted", async () => {
    const e = await employee();
    const { tasks: [t] } = await project("OFF-1", ["Work"], [e]);
    await sync(e, [["CLOCK_IN", Date.now() - 2 * H]]);
    const s = (await start(e, t!)).body;
    await sync(e, [["BREAK_START", Date.now() - 5 * M]]); // happened before the timer started, uploaded after
    const entry = (await api(`/task-time/entries?from=${addDays(localDate(Date.now(), "UTC"), -1)}&to=${localDate(Date.now(), "UTC")}`, as(e))).body.find((x: { id: string }) => x.id === s.id);
    assert.deepEqual([entry.endReason, entry.durationMs, entry.endedAt], ["BREAK", 0, s.startedAt], "never negative, never invented");
  });

  test("app restart and reconnection: the running timer is kept by the server and shown again", async () => {
    const e = await employee();
    const { tasks: [t] } = await project("RST-1", ["Work"], [e]);
    await clock(e, "clock-in");
    const s = (await start(e, t!)).body;
    const relogin = (await api("/auth/login", { method: "POST", body: { email: e.email, password: PASSWORD, client: "desktop" } })).body.accessToken;
    const state = (await api("/task-time/current", { bearer: relogin })).body;
    assert.equal(state.running.id, s.id);
    assert.equal(state.running.startedAt, s.startedAt, "start time unchanged by a restart");
    assert.ok(Date.parse(state.serverTime) >= Date.parse(s.startedAt), "the client shows elapsed time from the server's clock");
  });

  test("isolation: own entries only; admins may read any employee's", async () => {
    const [a, b] = [await employee(), await employee()];
    const { tasks: [t] } = await project("ISO-1", ["Work"], [a, b]);
    await clock(a, "clock-in");
    const s = (await start(a, t!)).body;
    const today = localDate(Date.now(), "UTC");
    assert.equal((await api(`/task-time/entries?from=${today}&to=${today}&employeeId=${a.id}`, as(b))).status, 404);
    const own = await api(`/task-time/entries?from=${today}&to=${today}`, { bearer: b.bearer, headers: { "x-employee-id": a.id } });
    assert.deepEqual(own.body, [], "spoofed headers ignored");
    assert.equal((await api(`/task-time/entries?from=${today}&to=${today}&employeeId=${a.id}`, { cookie: admin })).body[0].id, s.id);
    assert.equal((await api(`/task-time/entries?from=${today}&to=${addDays(today, 92)}`, as(a))).status, 400, "at most 92 days");
    assert.equal((await api(`/task-time/entries?from=${today}&to=${addDays(today, -1)}`, as(a))).status, 400);
  });
});

describe("reporting", () => {
  test("summary totals equal the underlying entries; attendance time is reported separately; running and out-of-range excluded", async () => {
    const [a, b] = [await employee("Asia/Kolkata"), await employee()];
    const p1 = await project("REP-1", ["Design", "Build"], [a, b]);
    const p2 = await project("REP-2", ["Ops"], [a]);
    // A recorded shift 3 days ago (09:00–17:00 local, no breaks) and fixed past entries in it.
    const day = addDays(localDate(Date.now(), "Asia/Kolkata"), -3);
    const shiftStart = Date.parse(`${day}T09:00:00+05:30`);
    await sync(a, [["CLOCK_IN", shiftStart], ["CLOCK_OUT", shiftStart + 8 * H]]);
    const session = String((await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ?", args: [a.id] })).rows[0]!.id);
    const put = (task: string, project: string, from: number, minutes: number) =>
      db.execute({ sql: "INSERT INTO task_time_entries (id, employee_id, project_id, task_id, attendance_session_id, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?, 'STOPPED')", args: [randomUUID(), a.id, project, task, session, iso(from), iso(from + minutes * M)] });
    await put(p1.tasks[0]!, p1.id, shiftStart, 90);
    await put(p1.tasks[1]!, p1.id, shiftStart + 2 * H, 45);
    await put(p2.tasks[0]!, p2.id, shiftStart + 4 * H, 30);
    // b: one real (short) entry today, then a running one (not counted).
    await clock(b, "clock-in");
    const bEntry = (await start(b, p1.tasks[0]!)).body;
    const bStopped = (await end(b, bEntry.id, "stop")).body;
    await start(b, p1.tasks[1]!);

    const today = localDate(Date.now(), "UTC");
    const from = addDays(day, -1);
    const s = (await api(`/projects/summary?from=${from}&to=${today}`, { cookie: admin })).body;
    const rep = s.byProject.filter((x: { project: { code: string } }) => x.project.code.startsWith("REP-"));
    const aRow = s.byEmployee.find((x: { employee: { id: string } }) => x.employee.id === a.id);
    assert.equal(aRow.taskMs, 165 * M);
    assert.equal(aRow.entries, 3);
    assert.equal(aRow.attendanceNetMs, 8 * H, "attendance worked time, from the timesheet, is a separate figure");
    const aEntries = (await api(`/task-time/entries?from=${from}&to=${today}&employeeId=${a.id}`, { cookie: admin })).body;
    assert.equal(aRow.taskMs, totalMs(aEntries));
    const bEntries = (await api(`/task-time/entries?from=${from}&to=${today}&employeeId=${b.id}`, { cookie: admin })).body;
    assert.equal(s.byEmployee.find((x: { employee: { id: string } }) => x.employee.id === b.id).taskMs, totalMs(bEntries), "running entry not counted");
    const r1 = rep.find((x: { project: { code: string } }) => x.project.code === "REP-1");
    assert.equal(r1.taskMs, 135 * M + bStopped.durationMs);
    assert.equal(r1.taskMs, r1.byTask.reduce((n: number, t: { taskMs: number }) => n + t.taskMs, 0), "tasks add up to the project");
    assert.equal(rep.find((x: { project: { code: string } }) => x.project.code === "REP-2").taskMs, 30 * M);
    assert.ok(s.running >= 1);
    // The local date decides the day (Asia/Kolkata): a range ending the day before excludes them.
    const none = (await api(`/projects/summary?from=${addDays(day, -5)}&to=${addDays(day, -1)}`, { cookie: admin })).body;
    assert.equal(none.byEmployee.find((x: { employee: { id: string } }) => x.employee.id === a.id), undefined);
    assert.ok(!JSON.stringify(s).match(/productiv|score/i), "no productivity figures");
  });
});

describe("regressions", () => {
  test("timesheet, history, CSV export (F03/F07), leave (F10) and screenshot self-view routes (F08) are unaffected by task timers", async () => {
    const e = await employee();
    const { tasks: [t] } = await project("REG-1", ["Work"], [e]);
    const yesterday = addDays(localDate(Date.now(), "UTC"), -1);
    const y0 = Date.parse(`${yesterday}T09:00:00Z`);
    await sync(e, [["CLOCK_IN", y0], ["BREAK_START", y0 + H], ["BREAK_END", y0 + 1.5 * H], ["CLOCK_OUT", y0 + 4 * H]]);
    const q = `from=${yesterday}&to=${yesterday}`;
    const snap = async () => Promise.all([`/attendance/timesheet?${q}`, `/attendance/history?${q}`, `/attendance/export?${q}`].map(async (p) => (await api(p, as(e))).text));
    const before = await snap();
    await clock(e, "clock-in");
    const s = (await start(e, t!)).body;
    await end(e, s.id, "pause");
    await start(e, t!);
    await clock(e, "break/start");
    assert.deepEqual(await snap(), before, "past timesheet, shifts and export byte-identical");
    const leave = await api("/leave", { method: "POST", ...as(e), body: { startDate: addDays(yesterday, 10), endDate: addDays(yesterday, 10), portion: "FULL_DAY" } });
    assert.equal(leave.status, 201, leave.text);
    const shots = await api("/screenshots?page=1&pageSize=12", as(e));
    assert.ok([200, 403].includes(shots.status), `self-view route still answers (403 when self-view is off): ${shots.status} ${shots.text}`);
    const csv = before[2]!;
    assert.ok(!csv.includes("REG-1"), "task data is not added to the draft export");
  });
});

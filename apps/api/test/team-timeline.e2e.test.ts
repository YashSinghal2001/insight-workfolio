// W3-TIMELINE: GET /activity/team-timeline — scope (admin, team head in/out of team, employee), team filter, each
// employee's own local day, segments, validation and audit (in-process API, in-memory DB, synthetic people).
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
const DATE = "2026-11-10"; // fixed past day: independent of the time the suite runs
const at = (hhmm: string) => `${DATE}T${hhmm}:00.000Z`;

interface Emp { id: string; userId: string; bearer: string; device: string }
let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let adminId: string;
let head: Emp; // heads Alpha (member of it too)
let member: Emp; // Alpha, Asia/Kolkata
let outsider: Emp; // Beta
let alpha: string;
let beta: string;

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, text };
}

async function employee(code: string, timezone = "UTC"): Promise<Emp> {
  const email = `${code.toLowerCase()}@example.com`;
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: code, fullName: `Person ${code}`, timezone } });
  assert.equal(e.status, 201, e.text);
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const device = randomUUID();
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, e.body.employee.id, randomUUID()] });
  return { id: e.body.employee.id, userId: e.body.employee.userId, bearer: login.body.accessToken, device };
}

async function session(e: Emp, from: string, to: string, breaks: [string, string][] = []) {
  const id = randomUUID();
  // Breaks can only be added to an open session (trigger): open, add breaks, then close.
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [id, e.id, e.device, from] });
  for (const [s, en] of breaks) await db.execute({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), id, s, en] });
  await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [to, id] });
  return id;
}

async function interval(e: Emp, sessionId: string, kind: "ACTIVE" | "IDLE", from: string, to: string, app = "Editor") {
  const secs = (Date.parse(to) - Date.parse(from)) / 1000;
  await db.execute({
    sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_name, started_at, ended_at, active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DESKTOP_MACOS', ?, ?, ?)`,
    args: [randomUUID(), e.id, e.device, sessionId, kind, kind === "ACTIVE" ? app : null, from, to, kind === "ACTIVE" ? secs : 0, kind === "IDLE" ? secs : 0, from, to, randomUUID()],
  });
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
  head = await employee("TL-HEAD");
  member = await employee("TL-MEM", "Asia/Kolkata");
  outsider = await employee("TL-OUT");
  alpha = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Alpha", headUserId: head.userId } })).body.id;
  beta = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Beta" } })).body.id;
  assert.equal((await api(`/teams/${alpha}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [member.id, head.id] } })).status, 200);
  assert.equal((await api(`/teams/${beta}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [outsider.id] } })).status, 200);
  // Outsider (UTC): 09:00-17:00 with a 12:00-13:00 break; app 09:00-11:00, idle 11:00-11:30.
  const s = await session(outsider, at("09:00"), at("17:00"), [[at("12:00"), at("13:00")]]);
  await interval(outsider, s, "ACTIVE", at("09:00"), at("11:00"));
  await interval(outsider, s, "IDLE", at("11:00"), at("11:30"));
  // Member (IST): clocked in 04:00-06:00 UTC = 09:30-11:30 local.
  await session(member, at("04:00"), at("06:00"));
});
after(() => app.close());

const tl = (q: string, auth: { cookie?: string; bearer?: string }) => api(`/activity/team-timeline?date=${DATE}${q}`, auth);
const ids = (r: { body: { items: { employee: { id: string } }[] } }) => r.body.items.map((i) => i.employee.id).sort();

test("admin: everyone, each in their own local day; segments from attendance and activity", async () => {
  const r = await tl("", { cookie: admin });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ids(r), [head.id, member.id, outsider.id].sort());
  assert.equal(r.body.date, DATE);
  const out = r.body.items.find((i: { employee: { id: string } }) => i.employee.id === outsider.id);
  assert.equal(out.dayStart, `${DATE}T00:00:00.000Z`);
  assert.deepEqual(
    out.segments.map((s: { type: string; start: string; end: string; label: string | null }) => `${s.type}|${s.start.slice(11, 16)}-${s.end.slice(11, 16)}|${s.label ?? ""}`),
    ["UNTRACKED|00:00-09:00|", "NEUTRAL|09:00-11:00|Editor · unlabelled", "IDLE|11:00-11:30|", "BREAK|12:00-13:00|", "UNTRACKED|17:00-00:00|"],
  );
  const mem = r.body.items.find((i: { employee: { id: string } }) => i.employee.id === member.id);
  assert.equal(mem.employee.timezone, "Asia/Kolkata");
  assert.equal(mem.dayStart, "2026-11-09T18:30:00.000Z", "IST midnight");
  assert.deepEqual(mem.segments.map((s: { type: string }) => s.type), ["UNTRACKED", "UNTRACKED"], "clocked in without activity data: blank between");
  assert.equal(mem.segments[0].end, at("04:00"));
  assert.ok(!JSON.stringify(r.body).includes("storage") && !JSON.stringify(r.body).includes("title"));
});

test("team filter: admin any team (unknown 404); team head only their own team (others 404, no filter = own team); employee 403", async () => {
  assert.deepEqual(ids(await tl(`&teamId=${beta}`, { cookie: admin })), [outsider.id]);
  assert.equal((await tl(`&teamId=${randomUUID()}`, { cookie: admin })).status, 404);
  const own = await tl("", { bearer: head.bearer });
  assert.equal(own.status, 200, own.text);
  assert.deepEqual(ids(own), [head.id, member.id].sort());
  assert.deepEqual(ids(await tl(`&teamId=${alpha}`, { bearer: head.bearer })), [head.id, member.id].sort());
  assert.equal((await tl(`&teamId=${beta}`, { bearer: head.bearer })).status, 404);
  assert.equal((await tl("", { bearer: outsider.bearer })).status, 403);
  assert.equal((await tl("", {})).status, 401);
});

test("validation: date required and real, team uuid, page size ≤ 100, no extra fields", async () => {
  assert.equal((await api("/activity/team-timeline", { cookie: admin })).status, 400);
  for (const q of ["&teamId=x", "&pageSize=101", "&employeeId=" + randomUUID(), "&page=0"]) assert.equal((await tl(q, { cookie: admin })).status, 400, q);
  assert.equal((await api("/activity/team-timeline?date=2026-02-30", { cookie: admin })).status, 400);
  const paged = await tl("&pageSize=1&page=2", { cookie: admin });
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.total, 3);
});

test("audit: one EMPLOYEE_ACTIVITY_TIMELINE_VIEWED row per other employee shown (the caller's own row is not audited)", async () => {
  const count = async (actor: string, target: string) =>
    Number((await db.execute({ sql: "SELECT count(*) AS n FROM account_audit WHERE action = 'EMPLOYEE_ACTIVITY_TIMELINE_VIEWED' AND actor_user_id = ? AND target_user_id = ? AND json_extract(metadata, '$.view') = 'team'", args: [actor, target] })).rows[0]!.n);
  const before = await count(adminId, outsider.userId);
  await tl(`&teamId=${beta}`, { cookie: admin });
  assert.equal(await count(adminId, outsider.userId), before + 1);
  const headBefore = [await count(head.userId, member.userId), await count(head.userId, head.userId)];
  await tl("", { bearer: head.bearer });
  assert.deepEqual([await count(head.userId, member.userId), await count(head.userId, head.userId)], [headBefore[0]! + 1, 0]);
});

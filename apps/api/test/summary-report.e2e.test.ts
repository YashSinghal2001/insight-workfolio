// GET /attendance/summary-report (W2-REPORTS). In-process API, in-memory DB, synthetic people.
import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const RANGE = "from=2026-03-01&to=2026-03-31";

interface Emp { id: string; userId: string; bearer: string; device: string }
let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let head: Emp, ist: Emp, nyc: Emp, outsider: Emp, plain: Emp;
let alpha: string, beta: string;

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  const json = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: json && buf.length ? JSON.parse(buf.toString()) : undefined, text: buf.toString(), buf, headers: res.headers };
}

async function employee(code: string, timezone = "UTC", fullName = `Person ${code}`): Promise<Emp> {
  const email = `${code.toLowerCase()}@example.com`;
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: code, fullName, timezone } });
  assert.equal(e.status, 201, e.text);
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const id = e.body.employee.id;
  const device = randomUUID();
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, id, randomUUID()] });
  return { id, userId: e.body.employee.userId, bearer: login.body.accessToken, device };
}

/** A shift (UTC); closed unless `out` is null; optional break and recorded active/idle seconds. */
async function shift(p: Emp, at: string, out: string | null, opts: { brk?: [string, string]; active?: number; idle?: number } = {}) {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [id, p.id, p.device, at] });
  if (opts.brk) await db.execute({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), id, ...opts.brk] });
  const start = Date.parse(at);
  const interval = (kind: "ACTIVE" | "IDLE", secs: number, offset: number) =>
    db.execute({
      sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name, started_at, ended_at,
              active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DESKTOP_MACOS', ?, ?, ?)`,
      args: [
        randomUUID(), p.id, p.device, id, kind, kind === "ACTIVE" ? "com.example.secretapp" : null, kind === "ACTIVE" ? "SecretPlantedApp" : null,
        new Date(start + offset).toISOString(), new Date(start + offset + secs * 1000).toISOString(),
        kind === "ACTIVE" ? secs : 0, kind === "IDLE" ? secs : 0, new Date(start + offset).toISOString(), new Date(start).toISOString(), randomUUID(),
      ],
    });
  if (opts.active) await interval("ACTIVE", opts.active, 0);
  if (opts.idle) await interval("IDLE", opts.idle, (opts.active ?? 0) * 1000);
  if (out) await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [out, id] });
}

type Row = { employee: { id: string; employeeCode: string }; workedDays: number; workedMinutes: number; breakMinutes: number; activeMinutes: number; idleMinutes: number };
const rowOf = (body: { items: Row[] }, id: string) => body.items.find((r) => r.employee.id === id)!;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  head = await employee("SR-HEAD");
  ist = await employee("SR-IST", "Asia/Kolkata", "=HYPERLINK(\"http://x\")");
  nyc = await employee("SR-NYC", "America/New_York");
  outsider = await employee("SR-OUT");
  plain = await employee("SR-PLN");
  alpha = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Alpha", headUserId: head.userId } })).body.id;
  beta = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Beta" } })).body.id;
  assert.equal((await api(`/teams/${alpha}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [head.id, ist.id, nyc.id] } })).status, 200);
  assert.equal((await api(`/teams/${beta}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [outsider.id] } })).status, 200);

  // IST: 08:55–18:30 with a 30 m 30 s break; a night shift 21:30 → 06:00; one shift on 1 Apr IST (out of March); an open shift on 2 Apr (last: an open shift blocks later ones).
  await shift(ist, "2026-03-02T03:25:00.000Z", "2026-03-02T13:00:00.000Z", { brk: ["2026-03-02T07:00:00.000Z", "2026-03-02T07:30:30.000Z"], active: 6 * 3600 + 59, idle: 1800 });
  await shift(ist, "2026-03-04T16:00:00.000Z", "2026-03-05T00:30:00.000Z", { active: 3600 });
  await shift(ist, "2026-03-31T19:00:00.000Z", "2026-03-31T21:00:00.000Z", { active: 3600 });
  await shift(ist, "2026-04-02T03:30:00.000Z", null, { active: 9999, idle: 9999 });
  // New York across the DST change (Sat 7 Mar 23:00 EST → Sun 05:00 EDT = 5 real hours) and a normal day.
  await shift(nyc, "2026-03-08T04:00:00.000Z", "2026-03-08T09:00:00.000Z", { idle: 600 });
  await shift(nyc, "2026-03-10T13:00:00.000Z", "2026-03-10T21:00:00.000Z", { active: 7 * 3600 });
  await shift(outsider, "2026-03-02T09:00:00.000Z", "2026-03-02T17:00:00.000Z");
});
after(() => app.close());

test("validation: range required, ≤ 92 days, from ≤ to; format json|xlsx; teamId uuid; pageSize ≤ 100", async () => {
  for (const q of ["", "?from=2026-03-01", "?from=2026-01-01&to=2026-04-03", "?from=2026-03-02&to=2026-03-01", `?${RANGE}&format=csv`, `?${RANGE}&teamId=nope`, `?${RANGE}&pageSize=101`, "?from=2026-02-30&to=2026-03-01"]) {
    assert.equal((await api(`/attendance/summary-report${q}`, { cookie: admin })).status, 400, q);
  }
  assert.equal((await api("/attendance/summary-report?from=2026-01-01&to=2026-04-02", { cookie: admin })).status, 200, "92 days");
});

test("admin: worked and break minutes equal the timesheet to the minute; active/idle from completed shifts; totals are column sums", async () => {
  const r = await api(`/attendance/summary-report?${RANGE}&pageSize=100`, { cookie: admin });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.total, 5);
  for (const p of [ist, nyc, outsider, head]) {
    const sheet = await api(`/attendance/timesheet?employeeId=${p.id}&${RANGE}`, { cookie: admin });
    const row = rowOf(r.body, p.id);
    assert.equal(row.workedMinutes, Math.floor(sheet.body.totals.netMs / 60_000), p.id);
    assert.equal(row.breakMinutes, Math.floor(sheet.body.totals.breakMs / 60_000), p.id);
    assert.equal(row.workedDays, sheet.body.days.length, p.id);
  }
  const i = rowOf(r.body, ist.id);
  // 08:55–18:30 = 575 m − 30.5 m break = 544 (floored total) + 510 night shift; the open shift is not counted.
  assert.deepEqual([i.workedDays, i.workedMinutes, i.breakMinutes, i.activeMinutes, i.idleMinutes], [2, 1054, 30, 420, 30]);
  const n = rowOf(r.body, nyc.id);
  assert.deepEqual([n.workedDays, n.workedMinutes, n.activeMinutes, n.idleMinutes], [2, 300 + 480, 420, 10]);
  const items = r.body.items as Row[];
  const sum = (k: keyof Omit<Row, "employee">) => items.reduce((a, x) => a + x[k], 0);
  assert.deepEqual(r.body.totals, { employees: 5, workedDays: sum("workedDays"), workedMinutes: sum("workedMinutes"), breakMinutes: sum("breakMinutes"), activeMinutes: sum("activeMinutes"), idleMinutes: sum("idleMinutes") });
  assert.doesNotMatch(r.text, /SecretPlantedApp|secretapp|@example\.com/, "no app names or emails");
  // Pagination keeps all-page totals; empty range → zeros.
  const p2 = await api(`/attendance/summary-report?${RANGE}&pageSize=2&page=2`, { cookie: admin });
  assert.deepEqual([p2.body.items.length, p2.body.total, p2.body.totals.workedMinutes], [2, 5, r.body.totals.workedMinutes]);
  // The open shift's day counts as a worked day (as /attendance/monthly) but none of its minutes or activity do.
  const april = rowOf((await api(`/attendance/summary-report?from=2026-03-01&to=2026-04-30&pageSize=100`, { cookie: admin })).body, ist.id);
  assert.deepEqual([april.workedDays, april.workedMinutes, april.activeMinutes, april.idleMinutes], [4, 1054 + 120, 480, 30]);
  const empty = await api("/attendance/summary-report?from=2025-01-01&to=2025-01-07", { cookie: admin });
  assert.equal(empty.body.totals.workedMinutes, 0);
});

test("team filter and scope: admin team / unknown 404; head own team 200, other team 404, unfiltered = own teams; employee 403", async () => {
  const a = await api(`/attendance/summary-report?${RANGE}&teamId=${alpha}`, { cookie: admin });
  assert.deepEqual((a.body.items as Row[]).map((x) => x.employee.id).sort(), [head.id, ist.id, nyc.id].sort());
  assert.equal((await api(`/attendance/summary-report?${RANGE}&teamId=${randomUUID()}`, { cookie: admin })).status, 404);
  const own = await api(`/attendance/summary-report?${RANGE}&teamId=${alpha}`, { bearer: head.bearer });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.total, 3);
  const scoped = await api(`/attendance/summary-report?${RANGE}`, { bearer: head.bearer });
  assert.deepEqual((scoped.body.items as Row[]).map((x) => x.employee.id).sort(), [head.id, ist.id, nyc.id].sort());
  assert.equal((await api(`/attendance/summary-report?${RANGE}&teamId=${beta}`, { bearer: head.bearer })).status, 404);
  assert.equal((await api(`/attendance/summary-report?${RANGE}&teamId=${beta}&format=xlsx`, { bearer: head.bearer })).status, 404);
  assert.equal((await api(`/attendance/summary-report?${RANGE}`, { bearer: plain.bearer })).status, 403);
  assert.equal((await api(`/attendance/summary-report?${RANGE}&format=xlsx`, { bearer: plain.bearer })).status, 403);
  assert.equal((await api(`/attendance/summary-report?${RANGE}`)).status, 401);
});

test("xlsx: headers, values equal the JSON, totals row, text never a formula, no ids/emails/app names", async () => {
  const json = await api(`/attendance/summary-report?${RANGE}&teamId=${alpha}`, { cookie: admin });
  const x = await api(`/attendance/summary-report?${RANGE}&teamId=${alpha}&format=xlsx`, { cookie: admin });
  assert.equal(x.status, 200, x.text);
  assert.equal(x.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(x.headers.get("content-disposition"), 'attachment; filename="summary-report_2026-03-01_2026-03-31.xlsx"');
  assert.equal(x.headers.get("cache-control"), "no-store, private, max-age=0");
  assert.equal(x.headers.get("x-export-rows"), "3");
  assert.equal(x.buf.subarray(0, 2).toString(), "PK");
  const dir = mkdtempSync(join(tmpdir(), "iw-summary-"));
  try {
    const file = join(dir, "s.xlsx");
    writeFileSync(file, x.buf);
    const all = execFileSync("unzip", ["-p", file]).toString();
    assert.match(all, /SR-IST/);
    assert.match(all, /All employees/);
    assert.match(all, /HYPERLINK/, "the name is kept as text");
    assert.doesNotMatch(all, /<f>/, "no formulas");
    assert.doesNotMatch(all, /SecretPlantedApp|secretapp|@example\.com|SR-OUT/);
    assert.doesNotMatch(all, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/, "no internal ids");
    const i = rowOf(json.body, ist.id);
    assert.match(all, new RegExp(`<v>${i.workedMinutes}</v>`), "worked minutes as a number");
    assert.match(all, new RegExp(`<v>${json.body.totals.workedMinutes}</v>`), "totals row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daily export: tab rows, minutes equal the timesheet, CSV and XLSX, scope, validation", async () => {
  const D = "date=2026-03-02";
  // /attendance/daily lists people only from the local date their profile was created.
  await db.execute("UPDATE employee_profiles SET created_at = '2023-01-01T00:00:00.000Z'");
  for (const q of ["", `?${D}`, `?${D}&tab=all`, `?date=2026-3-2&tab=worked`, `?${D}&tab=worked&format=pdf`, `?${D}&tab=worked&teamId=nope`]) {
    assert.equal((await api(`/attendance/daily/export${q}`, { cookie: admin })).status, 400, q);
  }
  const csv = await api(`/attendance/daily/export?${D}&tab=worked&teamId=${alpha}`, { cookie: admin });
  assert.equal(csv.status, 200, csv.text);
  assert.equal(csv.headers.get("content-disposition"), 'attachment; filename="daily-attendance_worked_2026-03-02.csv"');
  const lines = csv.text.replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(lines[0], "Employee code,Employee name,Time zone,Date,Status,Clock in,Clock out,Worked minutes,Late minutes");
  const sheet = await api(`/attendance/timesheet?employeeId=${ist.id}&from=2026-03-02&to=2026-03-02`, { cookie: admin });
  assert.deepEqual(lines.slice(1), [`SR-IST,"'=HYPERLINK(""http://x"")",Asia/Kolkata,2026-03-02,NO_POLICY,08:55,18:30,${Math.floor(sheet.body.totals.netMs / 60_000)},`]);
  assert.equal(csv.headers.get("x-export-rows"), "1");
  const all = await api(`/attendance/daily/export?${D}&tab=worked`, { cookie: admin });
  assert.match(all.text, /SR-OUT/);
  assert.equal((await api(`/attendance/daily/export?${D}&tab=absent`, { cookie: admin })).text.trim().split("\r\n").length, 1, "header only");
  const x = await api(`/attendance/daily/export?${D}&tab=worked&teamId=${alpha}&format=xlsx`, { cookie: admin });
  assert.equal(x.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const dir = mkdtempSync(join(tmpdir(), "iw-daily-"));
  try {
    writeFileSync(join(dir, "d.xlsx"), x.buf);
    const xml = execFileSync("unzip", ["-p", join(dir, "d.xlsx")]).toString();
    assert.match(xml, /SR-IST/);
    assert.doesNotMatch(xml, /<f>|SecretPlantedApp|@example\.com|SR-OUT/);
    assert.doesNotMatch(xml, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const own = await api(`/attendance/daily/export?${D}&tab=worked`, { bearer: head.bearer });
  assert.equal(own.status, 200);
  assert.doesNotMatch(own.text, /SR-OUT/, "a head sees only their teams");
  assert.equal((await api(`/attendance/daily/export?${D}&tab=worked&teamId=${beta}`, { bearer: head.bearer })).status, 404);
  assert.equal((await api(`/attendance/daily/export?${D}&tab=worked&teamId=${randomUUID()}`, { cookie: admin })).status, 404);
  assert.equal((await api(`/attendance/daily/export?${D}&tab=worked`, { bearer: plain.bearer })).status, 403);
});

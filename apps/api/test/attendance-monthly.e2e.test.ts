// GET /attendance/monthly and /attendance/monthly/export (W1-ATT-DATA). In-process API, in-memory DB, synthetic people.
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

type Db = {
  execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }>;
  batch: (q: { sql: string; args: unknown[] }[], mode: string) => Promise<unknown>;
};
let app: INestApplication;
let base: string;
let db: Db;
let admin: string;
let adminId: string;

async function api(path: string, { cookie = admin }: { cookie?: string } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { headers: { origin: ORIGIN, cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  const json = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: json ? JSON.parse(buf.toString()) : undefined, text: buf.toString(), buf, headers: res.headers };
}

type Person = { id: string; user: string; device: string };
async function person(code: string, timezone: string, created = "2023-01-01T00:00:00.000Z"): Promise<Person> {
  const [user, id, device] = [randomUUID(), randomUUID(), randomUUID()];
  await db.execute({ sql: "INSERT INTO users (id, email, role) VALUES (?, ?, 'EMPLOYEE')", args: [user, `${code.toLowerCase()}@example.com`] });
  await db.execute({
    sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, user, code, `Person ${code}`, timezone, created],
  });
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_identifier, device_name, platform) VALUES (?, ?, ?, 'Mac', 'macos')", args: [device, id, device] });
  return { id, user, device };
}
/** A shift (UTC instants); breaks are recorded while it is open, then it is closed unless `out` is null. */
async function shift(p: Person, at: string, out: string | null, breaks: [string, string][] = []) {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [id, p.id, p.device, at] });
  for (const [s, e] of breaks) await db.execute({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), id, s, e] });
  if (out) await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [out, id] });
}
const leave = (p: Person, start: string, end: string, portion = "FULL_DAY") =>
  db.execute({
    sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, status, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, 'APPROVED', ?, '2023-01-01T00:00:00.000Z')",
    args: [randomUUID(), p.id, p.user, start, end, portion, adminId],
  });
const policy = (enabled: number, effectiveAt: string, start = "09:00", grace = 10, days = "12345") =>
  db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (?, ?, ?, ?, 'test policy', ?, ?)", args: [enabled, start, grace, days, adminId, effectiveAt] });

type Day = { date: string; status: string; firstInLocal: string | null; lastOutLocal: string | null; workedMinutes: number; breakMinutes: number; overtimeMinutes: number; lateMinutes: number | null; dueLocal: string | null };
type Row = { employee: { id: string; employeeCode: string }; days: Day[]; totals: Record<string, number> };
async function monthly(month: string, q: string) {
  const r = await api(`/attendance/monthly?month=${month}&q=${q}&pageSize=100`);
  assert.equal(r.status, 200, r.text);
  return r.body as { month: string; items: Row[]; total: number };
}
const dayOf = (row: Row, date: string) => row.days.find((d) => d.date === date)!;

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
  // 09:00 + 10 min grace, Monday–Friday from 2024; start moves to 10:00 from 2026-04-15 12:00Z; off from 2026-06-01.
  await policy(1, "2024-01-01T00:00:00.000Z");
  await policy(1, "2026-04-15T12:00:00.000Z", "10:00");
  await policy(0, "2026-06-01T00:00:00.000Z");
  await db.execute({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, '2026-03-10', 'Synthetic holiday', ?)", args: [randomUUID(), adminId] });
});
after(() => app.close());

test("validation: month is required and YYYY-MM; pageSize ≤ 100; format csv|xlsx", async () => {
  for (const q of ["", "?month=2026-13", "?month=2026-3", "?month=2026-03-01", "?month=2026-03&pageSize=101", "?month=2026-03&teamId=nope"]) {
    assert.equal((await api(`/attendance/monthly${q}`)).status, 400, q);
  }
  assert.equal((await api("/attendance/monthly/export?month=2026-03&format=pdf")).status, 400);
  assert.equal((await api("/attendance/monthly/export?month=bad")).status, 400);
});

test("28/29/30/31-day months; leap February; days before the profile existed are not scheduled", async () => {
  const p = await person("MON-LEN", "UTC");
  const late = await person("MON-NEW", "UTC", "2026-03-16T10:00:00.000Z");
  for (const [m, n] of [["2023-02", 28], ["2024-02", 29], ["2026-04", 30], ["2026-03", 31]] as const) {
    const r = await monthly(m, "MON-LEN");
    assert.equal(r.month, m);
    assert.equal(r.items[0]!.days.length, n, m);
    assert.equal(r.items[0]!.employee.id, p.id);
  }
  const feb = (await monthly("2024-02", "MON-LEN")).items[0]!;
  assert.equal(dayOf(feb, "2024-02-29").status, "ABSENT", "29 Feb 2024 was a Thursday");
  const r = (await monthly("2026-03", "MON-NEW")).items[0]!;
  assert.equal(dayOf(r, "2026-03-13").status, "NOT_SCHEDULED", "before the profile existed");
  assert.equal(dayOf(r, "2026-03-16").status, "ABSENT");
  assert.equal(late.id, r.employee.id);
  assert.equal((await monthly("2026-02", "MON-NEW")).total, 0, "not listed before joining");
});

test("IST month: cross-midnight shift, open shift, holiday, full and half-day leave; totals equal the timesheet", async () => {
  const p = await person("MON-IST", "Asia/Kolkata");
  await shift(p, "2026-03-02T03:25:00.000Z", "2026-03-02T13:00:00.000Z", [["2026-03-02T07:00:00.000Z", "2026-03-02T07:30:30.000Z"]]); // 08:55–18:30 IST
  await shift(p, "2026-03-03T04:00:00.000Z", "2026-03-03T12:00:00.000Z"); // 09:30 IST: 30 min late
  await shift(p, "2026-03-04T16:00:00.000Z", "2026-03-05T00:30:00.000Z"); // 21:30 → 06:00 next day
  await shift(p, "2026-03-12T03:30:00.000Z", "2026-03-12T08:00:00.000Z"); // half-day leave, worked the morning
  await shift(p, "2026-03-31T03:20:00.000Z", null); // still open
  await leave(p, "2026-03-11", "2026-03-11");
  await leave(p, "2026-03-12", "2026-03-12", "SECOND_HALF");
  const row = (await monthly("2026-03", "MON-IST")).items[0]!;
  assert.deepEqual(dayOf(row, "2026-03-02"), { date: "2026-03-02", status: "PRESENT", firstInLocal: "08:55", lastOutLocal: "18:30", workedMinutes: 544, breakMinutes: 30, overtimeMinutes: 64, lateMinutes: null, dueLocal: "09:10" });
  assert.equal(dayOf(row, "2026-03-03").status, "LATE");
  assert.equal(dayOf(row, "2026-03-03").lateMinutes, 30);
  assert.deepEqual([dayOf(row, "2026-03-04").firstInLocal, dayOf(row, "2026-03-04").lastOutLocal, dayOf(row, "2026-03-04").workedMinutes], ["21:30", "06:00", 510]);
  assert.equal(dayOf(row, "2026-03-05").status, "ABSENT", "the night shift belongs to the day it started");
  assert.equal(dayOf(row, "2026-03-10").status, "HOLIDAY");
  assert.equal(dayOf(row, "2026-03-11").status, "ON_LEAVE");
  assert.equal(dayOf(row, "2026-03-12").status, "ON_LEAVE", "any approved portion, as /daily");
  assert.equal(dayOf(row, "2026-03-12").workedMinutes, 270);
  assert.equal(dayOf(row, "2026-03-31").status, "OPEN");
  assert.equal(dayOf(row, "2026-03-31").workedMinutes, 0, "open shifts are not counted, as on the timesheet");
  const sheet = await api(`/attendance/timesheet?employeeId=${p.id}&from=2026-03-01&to=2026-03-31`);
  assert.equal(sheet.status, 200, sheet.text);
  assert.equal(row.totals.workedMinutes, Math.floor(sheet.body.totals.netMs / 60_000));
  assert.equal(row.totals.overtimeMinutes, Math.floor(sheet.body.totals.overtimeMs / 60_000));
  for (const d of sheet.body.days as { date: string; netMs: number; breakMs: number; overtimeMs: number }[]) {
    const m = dayOf(row, d.date);
    assert.deepEqual([m.workedMinutes, m.breakMinutes, m.overtimeMinutes], [d.netMs, d.breakMs, d.overtimeMs].map((x) => Math.floor(x / 60_000)), d.date);
  }
  assert.deepEqual(
    { workedDays: row.totals.workedDays, presentDays: row.totals.presentDays, lateDays: row.totals.lateDays, leaveDays: row.totals.leaveDays, holidayDays: row.totals.holidayDays, absentDays: row.totals.absentDays },
    // 22 weekdays: 03-02, 03-03 (late), 03-04 (late), 03-31 (open) attended; 2 leave; 1 holiday; 15 absent.
    { workedDays: 5, presentDays: 4, lateDays: 2, leaveDays: 2, holidayDays: 1, absentDays: 15 },
  );
  // Same day statuses as /attendance/daily.
  for (const date of ["2026-03-02", "2026-03-03", "2026-03-05", "2026-03-10", "2026-03-12"]) {
    const d = await api(`/attendance/daily?date=${date}&q=MON-IST`);
    assert.equal(d.body.items[0].status, dayOf(row, date).status, date);
  }
});

test("DST month in America/New_York: local times and due times follow the wall clock", async () => {
  const p = await person("MON-NYC", "America/New_York");
  await shift(p, "2026-03-06T14:05:00.000Z", "2026-03-06T22:05:00.000Z"); // Fri 09:05 EST
  await shift(p, "2026-03-09T13:05:00.000Z", "2026-03-09T21:05:00.000Z"); // Mon 09:05 EDT (DST began Sunday 8th)
  await shift(p, "2026-03-11T13:20:00.000Z", "2026-03-11T21:00:00.000Z"); // 09:20 EDT: late 20
  const row = (await monthly("2026-03", "MON-NYC")).items[0]!;
  assert.deepEqual([dayOf(row, "2026-03-06").status, dayOf(row, "2026-03-06").firstInLocal, dayOf(row, "2026-03-06").dueLocal], ["PRESENT", "09:05", "09:10"]);
  assert.deepEqual([dayOf(row, "2026-03-09").status, dayOf(row, "2026-03-09").firstInLocal, dayOf(row, "2026-03-09").lastOutLocal], ["PRESENT", "09:05", "17:05"]);
  assert.deepEqual([dayOf(row, "2026-03-11").status, dayOf(row, "2026-03-11").lateMinutes], ["LATE", 20]);
  assert.equal(dayOf(row, "2026-03-08").status, "NOT_SCHEDULED");
});

test("schedule changed mid-month applies from the next local day; disabled schedule is NO_POLICY", async () => {
  const p = await person("MON-CHG", "UTC");
  await shift(p, "2026-04-15T09:30:00.000Z", "2026-04-15T17:00:00.000Z"); // old 09:00 start: late
  await shift(p, "2026-04-16T09:30:00.000Z", "2026-04-16T17:00:00.000Z"); // new 10:00 start: on time
  const row = (await monthly("2026-04", "MON-CHG")).items[0]!;
  assert.deepEqual([dayOf(row, "2026-04-15").status, dayOf(row, "2026-04-15").dueLocal], ["LATE", "09:10"]);
  assert.deepEqual([dayOf(row, "2026-04-16").status, dayOf(row, "2026-04-16").dueLocal], ["PRESENT", "10:10"]);
  const june = (await monthly("2026-06", "MON-CHG")).items[0]!;
  assert.ok(june.days.every((d) => d.status === "NO_POLICY"), "no enabled policy");
  assert.equal(june.totals.absentDays, 0);
});

test("export: CSV and XLSX, one row per employee, one column per day, codes, totals, no ids or emails", async () => {
  const p = await person("MON-EXP", "UTC");
  await shift(p, "2026-03-02T09:00:00.000Z", "2026-03-02T17:30:00.000Z");
  await leave(p, "2026-03-03", "2026-03-03");
  const csv = await api("/attendance/monthly/export?month=2026-03");
  assert.equal(csv.status, 200, csv.text);
  assert.match(csv.headers.get("content-type")!, /^text\/csv/);
  assert.equal(csv.headers.get("content-disposition"), 'attachment; filename="attendance-2026-03.csv"');
  assert.equal(csv.headers.get("cache-control"), "no-store, private, max-age=0");
  const lines = csv.text.replace(/^\uFEFF/, "").trim().split("\r\n").map((l) => l.split(","));
  const header = lines[0]!;
  assert.equal(header.length, 3 + 31 + 8);
  assert.deepEqual(header.slice(0, 4), ["Employee code", "Employee name", "Time zone", "2026-03-01"]);
  const mine = lines.find((l) => l[0] === "MON-EXP")!;
  assert.equal(mine[header.indexOf("2026-03-02")], "09:00–17:30");
  assert.equal(mine[header.indexOf("2026-03-03")], "LV");
  assert.equal(mine[header.indexOf("2026-03-04")], "A");
  assert.equal(mine[header.indexOf("2026-03-07")], "WO");
  assert.equal(mine[header.indexOf("2026-03-10")], "H");
  assert.equal(mine[header.indexOf("Worked minutes")], "510");
  assert.equal(Number(csv.headers.get("x-export-rows")), lines.length - 1);
  assert.doesNotMatch(csv.text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/, "no internal ids");
  assert.doesNotMatch(csv.text, /@example\.com/, "no emails");
  const xlsx = await api("/attendance/monthly/export?month=2026-03&format=xlsx");
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.headers.get("content-disposition"), 'attachment; filename="attendance-2026-03.xlsx"');
  assert.equal(xlsx.buf.subarray(0, 2).toString(), "PK");
  const dir = mkdtempSync(join(tmpdir(), "iw-monthly-"));
  try {
    const file = join(dir, "m.xlsx");
    writeFileSync(file, xlsx.buf);
    const sheets = execFileSync("unzip", ["-p", file, "xl/worksheets/sheet1.xml"]).toString();
    const all = sheets + execFileSync("unzip", ["-p", file]).toString();
    assert.match(all, /MON-EXP/);
    assert.match(all, /09:00–17:30/);
    assert.doesNotMatch(all, /<f>/, "no formulas");
    assert.doesNotMatch(all, /@example\.com/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("performance: 100 employees × 31 days in under a second", async (t) => {
  const people: Person[] = [];
  for (let i = 0; i < 100; i++) people.push(await person(`PERF-${String(i).padStart(3, "0")}`, i % 2 ? "Asia/Kolkata" : "America/New_York"));
  const stmts = people.flatMap((p) =>
    Array.from({ length: 31 }, (_, d) => {
      const at = Date.parse(`2025-01-${String(d + 1).padStart(2, "0")}T12:00:00.000Z`);
      return { sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), p.id, p.device, new Date(at).toISOString(), new Date(at + 8.5 * 3_600_000).toISOString()] };
    }),
  );
  await db.batch(stmts, "write");
  const t0 = performance.now();
  const r = await monthly("2025-01", "PERF-");
  const ms = performance.now() - t0;
  assert.equal(r.items.length, 100);
  assert.ok(r.items.every((x) => x.totals.workedDays === 31));
  t.diagnostic(`monthly 100×31: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});

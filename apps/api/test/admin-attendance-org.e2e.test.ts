// Organisation-wide timesheet export (F03) and the admin attendance summary. Synthetic employees and
// shifts only. Day figures are checked on a fixed past date (two days ago) so the test does not depend on
// the time of day it runs; "now" states use sessions opened a few minutes ago.
import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { addDays, TIMESHEET_CSV_COLUMNS } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
const XLSX_DIR = mkdtempSync(join(tmpdir(), "wf-org-xlsx-"));
const OPENPYXL = spawnSync("python3", ["-I", "-c", "import openpyxl"]).status === 0;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let adminId: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string };
async function api(path: string, { method = "GET", body, cookie, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString("utf8");
  return { status: res.status, body: (res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : undefined, text, bytes, res };
}
const iso = (ms: number) => new Date(ms).toISOString();

/** Fixed past date (UTC) for the day figures; every shift below is placed relative to it. */
const D = addDays(iso(Date.now()).slice(0, 10), -2);
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00.000Z`);

let seq = 0;
async function employee(code: string, name: string, timezone: string) {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `org${n}@example.com`, employeeCode: code, fullName: name, timezone } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `org${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;
async function events(e: Emp, evs: [string, number][]) {
  const r = await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: evs.map(([type, t]) => ({ id: randomUUID(), type, occurredAt: iso(t) })) } });
  assert.equal(r.status, 200, r.text);
  for (const x of r.body.results) assert.equal(x.status, "ACCEPTED", JSON.stringify(x));
}

let A: Emp, B: Emp, C: Emp, Dd: Emp, F: Emp, X: Emp;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const login = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = login.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  // A (UTC): a shift crossing into D (23:00 -> 01:00, 1 h inside D) and one on D with a 15-minute break.
  A = await employee("ORG-A", "Alpha =cmd", "UTC");
  await events(A, [
    ["CLOCK_IN", at(addDays(D, -1), "23:00")], ["CLOCK_OUT", at(D, "01:00")],
    ["CLOCK_IN", at(D, "10:00")], ["BREAK_START", at(D, "10:30")], ["BREAK_END", at(D, "10:45")], ["CLOCK_OUT", at(D, "12:00")],
  ]);
  // B: working now. C: on a break now. Neither worked on D.
  B = await employee("ORG-B", "Bravo", "UTC");
  await events(B, [["CLOCK_IN", Date.now() - 10 * M]]);
  C = await employee("ORG-C", "Charlie", "UTC");
  await events(C, [["CLOCK_IN", Date.now() - 20 * M], ["BREAK_START", Date.now() - 5 * M]]);
  // Dd: never clocked in.
  Dd = await employee("ORG-D", "Delta", "UTC");
  // F (India, UTC+5:30): 19:00-20:00 UTC the day before D is 00:30-01:30 on D locally.
  F = await employee("ORG-F", "Foxtrot", "Asia/Kolkata");
  await events(F, [["CLOCK_IN", at(addDays(D, -1), "19:00")], ["CLOCK_OUT", at(addDays(D, -1), "20:00")]]);
  // X: worked on D, then the account was disabled: excluded unless includeInactive.
  X = await employee("ORG-X", "Xray", "UTC");
  await events(X, [["CLOCK_IN", at(D, "09:00")], ["CLOCK_OUT", at(D, "10:00")]]);
  assert.equal((await api(`/employees/${X.id}/status`, { method: "PATCH", cookie: admin, body: { status: "DISABLED" } })).status, 200);

  // Pending items, projects and tasks (direct inserts: these tables are not under test here).
  const userOf = async (e: Emp) => String((await db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [e.id] })).rows[0]!.user_id);
  await db.execute({ sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion) VALUES (?, ?, ?, ?, ?, 'FULL_DAY')", args: [randomUUID(), Dd.id, await userOf(Dd), D, D] });
  await db.execute({ sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, status, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, 'FULL_DAY', 'CANCELLED', ?, ?)", args: [randomUUID(), Dd.id, await userOf(Dd), D, D, await userOf(Dd), iso(Date.now())] });
  await db.execute({ sql: "INSERT INTO correction_requests (id, employee_id, requested_by, type, proposed, reason) VALUES (?, ?, ?, 'MISSING_CLOCK_OUT', '{}', 'synthetic reason')", args: [randomUUID(), B.id, await userOf(B)] });
  const [p1, p2] = [randomUUID(), randomUUID()];
  await db.execute({ sql: "INSERT INTO projects (id, code, name, created_by) VALUES (?, 'ORG1', 'Synthetic one', ?)", args: [p1, adminId] });
  await db.execute({ sql: "INSERT INTO projects (id, code, name, status, created_by) VALUES (?, 'ORG2', 'Synthetic two', 'ARCHIVED', ?)", args: [p2, adminId] });
  for (const [project, status] of [[p1, "OPEN"], [p1, "OPEN"], [p1, "CLOSED"], [p2, "OPEN"]]) {
    await db.execute({ sql: "INSERT INTO project_tasks (id, project_id, title, status, created_by) VALUES (?, ?, 'Task', ?, ?)", args: [randomUUID(), project, status, adminId] });
  }

  // Screenshot rows (metadata only; no files): counted when STORED and captured inside the owner's local day D.
  const shot = async (e: Emp, capturedAt: number, status: "STORED" | "REGISTERED") => {
    const s = (await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ? ORDER BY clock_in_at LIMIT 1", args: [e.id] })).rows[0]!;
    const d = (await db.execute({ sql: "SELECT id FROM devices WHERE employee_id = ?", args: [e.id] })).rows[0]!;
    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height,
              mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 100, 100, 'image/webp', 100, ?, 'MICROSOFT_GRAPH', ?, ?, ?)`,
      args: [id, e.id, d.id, s.id, randomUUID(), iso(capturedAt), iso(capturedAt), "a".repeat(64), `k/${id}`, status, status === "STORED" ? iso(capturedAt) : null],
    });
  };
  await shot(A, at(D, "11:00"), "STORED"); // counted (any provider)
  await shot(A, at(D, "11:30"), "REGISTERED"); // not stored
  await shot(F, at(addDays(D, -1), "19:30"), "STORED"); // D 01:00 in India: counted
  await shot(F, at(D, "23:00"), "STORED"); // the day after D in India: not counted
});
after(async () => {
  await app.close();
  rmSync(XLSX_DIR, { recursive: true, force: true });
});

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        f += '"';
        i++;
      } else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\r" && s[i + 1] === "\n") {
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
      i++;
    } else f += c;
  }
  return rows;
}

describe("GET /attendance/timesheets/export (organisation)", () => {
  const range = `from=${addDays(D, -1)}&to=${D}`;

  test("admins only (employee 403, signed out 401); same 92-day cap and validation", async () => {
    assert.equal((await api(`/attendance/timesheets/export?${range}`)).status, 401);
    assert.equal((await api(`/attendance/timesheets/export?${range}`, { bearer: A.bearer })).status, 403);
    assert.equal((await api(`/attendance/timesheets/export?from=2026-01-01&to=2026-04-03`, { cookie: admin })).status, 400, "93 days");
    assert.equal((await api(`/attendance/timesheets/export?from=${D}&to=${addDays(D, -1)}`, { cookie: admin })).status, 400, "from after to");
    assert.equal((await api(`/attendance/timesheets/export?${range}&format=pdf`, { cookie: admin })).status, 400);
    assert.equal((await api(`/attendance/timesheets/export?${range}&includeInactive=yes`, { cookie: admin })).status, 400);
  });

  test("CSV: active employees' shifts with the per-employee columns, by employee code; headers; formula guard", async () => {
    const r = await api(`/attendance/timesheets/export?${range}`, { cookie: admin });
    assert.equal(r.status, 200, r.text);
    assert.match(r.res.headers.get("content-type")!, /^text\/csv/);
    assert.equal(r.res.headers.get("content-disposition"), `attachment; filename="workfolio-timesheets-draft1_all_${addDays(D, -1)}_${D}.csv"`);
    assert.equal(r.res.headers.get("cache-control"), "no-store, private, max-age=0");
    const [head, ...rows] = parseCsv(r.text);
    assert.deepEqual(head, TIMESHEET_CSV_COLUMNS.map((c) => c.header));
    assert.equal(r.res.headers.get("x-export-rows"), String(rows.length));
    // A: 2 shifts, F: 1 (local dates D), X disabled: excluded; B and C opened today: outside the range.
    assert.deepEqual(rows.map((x) => x[0]), ["ORG-A", "ORG-A", "ORG-F"]);
    assert.equal(rows[0]![1], "Alpha =cmd", "a formula character inside the text is left alone");
    assert.equal(rows[0]![2], addDays(D, -1));
    assert.equal(rows[1]![10], "105", "worked minutes = 2 h - 15 min break");
    assert.equal(rows[2]![2], D, "work date in the employee's own zone");
    assert.equal(rows[2]![3], "Asia/Kolkata");

    // Identical to each employee's own export, row for row.
    const own = parseCsv((await api(`/attendance/export?${range}&employeeId=${A.id}`, { cookie: admin })).text).slice(1);
    assert.deepEqual(rows.slice(0, 2), own);
  });

  test("formula characters at the start of a name are neutralised", async () => {
    await db.execute({ sql: "UPDATE employee_profiles SET full_name = '=HYPERLINK(1)' WHERE id = ?", args: [F.id] });
    try {
      const rows = parseCsv((await api(`/attendance/timesheets/export?${range}`, { cookie: admin })).text);
      assert.equal(rows.find((x) => x[0] === "ORG-F")![1], "'=HYPERLINK(1)");
    } finally {
      await db.execute({ sql: "UPDATE employee_profiles SET full_name = 'Foxtrot' WHERE id = ?", args: [F.id] });
    }
  });

  test("includeInactive=true adds disabled employees; q filters by name, email or code", async () => {
    const all = parseCsv((await api(`/attendance/timesheets/export?${range}&includeInactive=true`, { cookie: admin })).text).slice(1);
    assert.deepEqual(all.map((x) => x[0]), ["ORG-A", "ORG-A", "ORG-F", "ORG-X"]);
    const one = await api(`/attendance/timesheets/export?${range}&q=foxtrot`, { cookie: admin });
    assert.deepEqual(parseCsv(one.text).slice(1).map((x) => x[0]), ["ORG-F"]);
    assert.equal(one.res.headers.get("x-export-rows"), "1");
    const none = await api(`/attendance/timesheets/export?${range}&q=nobody`, { cookie: admin });
    assert.equal(parseCsv(none.text).length, 1, "header only");
    assert.equal(none.res.headers.get("x-export-rows"), "0");
  });

  test("XLSX: a Timesheet sheet with every row and a Summary row per employee", async (t) => {
    const r = await api(`/attendance/timesheets/export?${range}&format=xlsx`, { cookie: admin });
    assert.equal(r.status, 200);
    assert.equal(r.res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(r.res.headers.get("content-disposition"), `attachment; filename="workfolio-timesheets-draft1_all_${addDays(D, -1)}_${D}.xlsx"`);
    assert.equal(r.res.headers.get("x-export-rows"), "3");
    assert.equal(r.bytes.subarray(0, 2).toString(), "PK");
    if (!OPENPYXL) return t.skip("python3 openpyxl not installed: workbook contents not read");
    const file = join(XLSX_DIR, `${randomUUID()}.xlsx`);
    writeFileSync(file, r.bytes);
    const book = JSON.parse(
      execFileSync("python3", ["-I", "-c", "import json,sys,openpyxl\nwb=openpyxl.load_workbook(sys.argv[1])\nprint(json.dumps({ws.title:[[str(c.value) if c.value is not None else None for c in row] for row in ws.iter_rows()] for ws in wb.worksheets}))", file], { encoding: "utf8" }),
    );
    assert.deepEqual(Object.keys(book), ["Timesheet", "Summary"]);
    assert.deepEqual(book.Timesheet.slice(1).map((x: string[]) => x[0]), ["ORG-A", "ORG-A", "ORG-F"]);
    const summary = book.Summary as (string | null)[][];
    assert.deepEqual(summary.slice(1, 5).map((x) => x[0]), ["ORG-A", "ORG-B", "ORG-C", "ORG-D"], "every active employee, even without shifts");
    const a = summary.find((x) => x[0] === "ORG-A")!;
    assert.equal(a[3], "2", "shifts");
    const total = summary.find((x) => x[0] === "All employees")!;
    assert.equal(total[3], "3");
    assert.ok(summary.some((x) => x[0] === "Format" && x[1] === "timesheet-csv-draft-1"));
  });
});

describe("GET /attendance/summary", () => {
  test("admins only; date must be YYYY-MM-DD and nothing else is accepted", async () => {
    assert.equal((await api("/attendance/summary")).status, 401);
    assert.equal((await api("/attendance/summary", { bearer: A.bearer })).status, 403);
    assert.equal((await api("/attendance/summary?date=02-11-2026", { cookie: admin })).status, 400);
    assert.equal((await api("/attendance/summary?employeeId=x", { cookie: admin })).status, 400);
  });

  test("counts for a past date, in each employee's own time zone, clipped to the day", async () => {
    const r = await api(`/attendance/summary?date=${D}`, { cookie: admin });
    assert.equal(r.status, 200, r.text);
    const { generatedAt, netWorkMsToday, breakMsToday, ...s } = r.body;
    // Synced times carry a few milliseconds of clock-skew correction.
    assert.ok(Math.abs(netWorkMsToday - (60 + 105 + 60) * M) < 1000, String(netWorkMsToday)); // A: 1 h of the overnight shift + 1 h 45; F: 1 h
    assert.ok(Math.abs(breakMsToday - 15 * M) < 1000, String(breakMsToday));
    assert.ok(Math.abs(Date.parse(generatedAt) - Date.now()) < 60_000);
    assert.deepEqual(s, {
      date: D,
      totalActiveEmployees: 5, // A, B, C, Dd, F (X is disabled)
      currentlyWorking: 1, // B
      onBreak: 1, // C
      clockedOutToday: 2, // A, F
      notClockedInToday: 3, // B, C, Dd
      pendingLeaveCount: 1,
      pendingCorrectionCount: 1,
      activeProjectCount: 1,
      openTaskCount: 2,
      screenshotsStoredToday: 2,
    });
  });

  test("default date: each employee's today; open sessions run to now", async () => {
    const r = await api("/attendance/summary", { cookie: admin });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.date, null);
    assert.equal(r.body.currentlyWorking, 1);
    assert.equal(r.body.onBreak, 1);
    assert.equal(r.body.totalActiveEmployees, 5);
    // B and C clocked in minutes ago; whether that is "today" depends on the clock at run time only
    // within the first 20 minutes after UTC midnight, so the bounds below hold either way.
    assert.ok(r.body.notClockedInToday >= 3 && r.body.notClockedInToday <= 5);
    assert.ok(r.body.netWorkMsToday <= 26 * M && r.body.breakMsToday <= 6 * M, JSON.stringify(r.body));
  });
});

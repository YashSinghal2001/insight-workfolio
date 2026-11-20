// F07 employee self-service (in-process API, synthetic data). The desktop History tab reads three
// existing routes: /attendance/timesheet, /attendance/history and /activity/summary. Identity comes
// from the session; another employee's id is 404; nothing else in the request selects the employee.
import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
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
const { DEFAULT_NOTICE_VERSION, TIMESHEET_CSV_COLUMNS, addDays, localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const H = 3_600_000;
const M = 60_000;
const DAY = 24 * H;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, cookie, bearer, device, headers: extra = {} }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("json") && text;
  return { status: res.status, body: json ? JSON.parse(text) : undefined, text, headers: res.headers };
}
const iso = (ms: number) => new Date(ms).toISOString();
/** Uploads are corrected for clock skew (device send time vs server time), so allow a second. */
const near = (actual: number | string, expected: number, msg?: string) =>
  assert.ok(Math.abs((typeof actual === "string" ? Date.parse(actual) : actual) - expected) < 1000, `${msg ?? ""} ${actual} vs ${expected}`);

let seq = 0;
async function employee(fullName = `Self Service ${seq + 1}`) {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `ss${n}@example.com`, employeeCode: `SS-${n}`, fullName, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `ss${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_NOTICE_VERSION, iso(Date.now() - 4 * DAY)] });
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

async function attendance(e: Emp, events: [string, number][]) {
  const r = await api("/attendance/sync", {
    method: "POST", bearer: e.bearer, device: e.device,
    body: { sentAt: iso(Date.now()), events: events.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) },
  });
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
}
const active = (app: string, start: number, end: number) => ({ id: randomUUID(), kind: "ACTIVE", applicationIdentifier: `com.example.${app}`, applicationName: app, startedAt: iso(start), endedAt: iso(end) });
async function upload(e: Emp, intervals: object[]) {
  const r = await api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals } });
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
}

// Day -2 (UTC): a shift 23:00 → day -1 01:00 with a 15-minute break, and "Secret App" across midnight.
const today = localDate(Date.now(), "UTC");
const d2 = addDays(today, -2);
const d1 = addDays(today, -1);
const midnight = Date.parse(`${d1}T00:00:00Z`);
let a: Emp;
let b: Emp;
let empty: Emp;
let tricky: Emp;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  [a, b, empty] = [await employee(), await employee(), await employee()];
  tricky = await employee('=HYPERLINK("http://x","Zoë, "Zo" 日本")');
  await attendance(tricky, [["CLOCK_IN", midnight - 3 * H], ["CLOCK_OUT", midnight - 2 * H]]);
  await attendance(a, [["CLOCK_IN", midnight - H], ["BREAK_START", midnight - 40 * M], ["BREAK_END", midnight - 25 * M], ["CLOCK_OUT", midnight + H]]);
  await upload(a, [active("Secret App", midnight - 20 * M, midnight + 10 * M)]);
  // B: an open shift (no clock-out) with no activity at all.
  // P7-11: two hours ago, but never before today's UTC midnight (the checks read "today").
  await attendance(b, [["CLOCK_IN", Math.max(Date.now() - 2 * H, Date.parse(`${today}T00:00:00Z`))]]);
});
after(() => app.close());

const week = (from = d2, to = addDays(d2, 6)) => `from=${from}&to=${to}`;

describe("self-service reads", () => {
  test("employees cannot read another employee's sessions, timesheet or activity", async () => {
    for (const path of ["/attendance/history", "/attendance/timesheet", "/activity/summary"]) {
      assert.equal((await api(`${path}?${week()}&employeeId=${a.id}`, { bearer: b.bearer })).status, 404, `${path}: another employee's id is not found`);
      assert.equal((await api(`${path}?${week()}&employeeId=${randomUUID()}`, { bearer: b.bearer })).status, 404, `${path}: unknown id`);
      assert.equal((await api(`${path}?${week()}`)).status, 401, `${path}: signed out`);
      assert.equal((await api(`${path}?${week()}`, { bearer: "not-a-token" })).status, 401, `${path}: bad token`);
      // Headers never select the employee; B still sees only B.
      const spoof = await api(`${path}?${week()}`, { bearer: b.bearer, headers: { "x-employee-id": a.id, "x-user-id": a.id } });
      assert.equal(spoof.status, 200, path);
      assert.ok(!spoof.text.includes(a.id) && !spoof.text.includes("Secret App"), `${path}: no data of A`);
    }
    // Admins (no employee profile) must name the employee; they can.
    assert.equal((await api(`/activity/summary?${week()}&employeeId=${a.id}`, { cookie: admin })).body.applications[0].applicationName, "Secret App");
  });

  test("history: recorded times and breaks, filtered by the start date", async () => {
    const h = await api(`/attendance/history?${week()}&pageSize=100`, { bearer: a.bearer });
    assert.equal(h.status, 200);
    assert.equal(h.body.total, 1);
    const s = h.body.items[0];
    near(s.clockInAt, midnight - H);
    near(s.clockOutAt, midnight + H);
    assert.equal(s.breaks.length, 1);
    near(s.breaks[0].startedAt, midnight - 40 * M);
    near(s.breaks[0].endedAt, midnight - 25 * M);
    assert.equal((await api(`/attendance/history?${week(d1, d1)}`, { bearer: a.bearer })).body.total, 0, "a shift belongs to the day it started");
    assert.equal((await api(`/attendance/history?${week(addDays(d2, -7), addDays(d2, -1))}`, { bearer: a.bearer })).body.total, 0, "earlier week is empty");
  });

  test("timesheet: calculated totals count the shift once, on its start day", async () => {
    const t = await api(`/attendance/timesheet?${week()}`, { bearer: a.bearer });
    assert.equal(t.status, 200);
    near(t.body.totals.netMs, 2 * H - 15 * M);
    near(t.body.totals.breakMs, 15 * M);
    assert.deepEqual(t.body.days.map((d: { date: string }) => d.date), [d2]);
  });

  test("activity: split at local midnight; no-record time is reported, never counted as active", async () => {
    const s = await api(`/activity/summary?${week(d2, d1)}`, { bearer: a.bearer });
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.days.map((d: { date: string }) => d.date), [d2, d1]);
    near(s.body.days[0].activeMs, 20 * M, "before midnight");
    near(s.body.days[1].activeMs, 10 * M, "after midnight");
    near(s.body.activeMs, 30 * M);
    near(s.body.clockedInMs, 2 * H - 15 * M, "breaks are not clocked-in time");
    assert.equal(s.body.unobservedMs, s.body.clockedInMs - s.body.activeMs - s.body.idleMs);
    assert.deepEqual(s.body.applications.map((x: { applicationName: string }) => x.applicationName), ["Secret App"]);
  });

  test("open shift and no activity: incomplete, not counted as worked; activity is all no-record", async () => {
    const h = await api(`/attendance/history?${week(today, today)}`, { bearer: b.bearer });
    assert.equal(h.body.items[0].clockOutAt, null);
    const t = await api(`/attendance/timesheet?${week(today, today)}`, { bearer: b.bearer });
    assert.equal(t.body.totals.incompleteDays, 1);
    assert.equal(t.body.totals.netMs, 0, "open shifts are not counted until clocked out");
    const s = await api(`/activity/summary?${week(today, today)}`, { bearer: b.bearer });
    assert.equal(s.body.activeMs + s.body.idleMs, 0);
    assert.ok(s.body.unobservedMs > 0 && s.body.unobservedMs === s.body.clockedInMs);
    assert.deepEqual(s.body.applications, []);
  });

  test("empty history: every day listed with zeros, nothing invented", async () => {
    const [h, t, s] = await Promise.all(["/attendance/history", "/attendance/timesheet", "/activity/summary"].map((p) => api(`${p}?${week()}`, { bearer: empty.bearer })));
    assert.equal(h.body.total, 0);
    assert.equal(t.body.totals.netMs, 0);
    assert.deepEqual(t.body.days, []);
    assert.equal(s.body.days.length, 7);
    assert.ok(s.body.days.every((d: { activeMs: number; idleMs: number; clockedInMs: number }) => d.activeMs + d.idleMs + d.clockedInMs === 0));
    assert.deepEqual(s.body.applications, []);
  });

  test("bad ranges are refused", async () => {
    assert.equal((await api(`/activity/summary?from=${d1}&to=${d2}`, { bearer: a.bearer })).status, 400);
    assert.equal((await api(`/activity/summary?from=2026-01-01&to=2026-03-01`, { bearer: a.bearer })).status, 400, "31-day cap");
    assert.equal((await api(`/attendance/timesheet?from=nope&to=${d1}`, { bearer: a.bearer })).status, 400);
  });
});

/** Minimal RFC 4180 reader (quoted fields, doubled quotes). */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [[]];
  let f = "", q = false;
  for (let i = csv.startsWith("\uFEFF") ? 1 : 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (q && c === '"' && csv[i + 1] === '"') {
      f += '"';
      i++;
    } else if (c === '"') {
      q = !q;
    } else if (!q && (c === "," || (c === "\r" && csv[i + 1] === "\n"))) {
      rows.at(-1)!.push(f);
      f = "";
      if (c === "\r") {
        rows.push([]);
        i++;
      }
    } else {
      f += c;
    }
  }
  rows.pop();
  return rows;
}
const records = (csv: string) => {
  const [head, ...rows] = parseCsv(csv);
  return rows.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i]!])));
};

describe("timesheet CSV export (draft format)", () => {
  test("download headers, BOM, draft columns and one row per shift in the range", async () => {
    const r = await api(`/attendance/export?${week()}`, { bearer: a.bearer });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8; header=present");
    assert.equal(r.headers.get("content-disposition"), `attachment; filename="workfolio-timesheet-draft1_SS-1_${d2}_${addDays(d2, 6)}.csv"`);
    assert.match(r.headers.get("cache-control")!, /no-store/);
    assert.equal(r.headers.get("x-export-rows"), "1", "shift count for the app's message");
    assert.match(r.headers.get("access-control-expose-headers") ?? "", /x-export-rows/i, "readable cross-origin (desktop app)");
    const raw = new Uint8Array(await (await fetch(`${base}/api/v1/attendance/export?${week()}`, { headers: { origin: ORIGIN, authorization: `Bearer ${a.bearer}` } })).arrayBuffer());
    assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM (Response.text() strips it)");
    assert.ok(r.text.startsWith("Employee code,Employee name,Work date,Time zone,Clock in,Clock out,Status,Breaks,"), r.text.slice(0, 120));
    const rows = records(r.text);
    assert.equal(rows.length, 1);
    const x = rows[0]!;
    assert.equal(x["Work date"], d2, "the day the shift started");
    assert.equal(x["Time zone"], "UTC");
    assert.match(x["Clock in"]!, new RegExp(`^${d2}T23:00:0\\d\\+00:00$`));
    assert.match(x["Clock out"]!, new RegExp(`^${d1}T01:00:0\\d\\+00:00$`));
    assert.equal(x.Status, "Completed");
    assert.equal(x["Break count"], "1");
    assert.equal(x["Break minutes"], "15");
    assert.equal(x["Worked minutes"], "105");
    assert.equal(x["Active minutes"], "30", "recorded activity linked to the shift");
    assert.equal(x["No activity record minutes"], "75");
  });

  test("date range filters by start date; empty range is header only", async () => {
    assert.equal(records((await api(`/attendance/export?${week(d1, d1)}`, { bearer: a.bearer })).text).length, 0, "the shift started the day before");
    const e = await api(`/attendance/export?${week()}`, { bearer: empty.bearer });
    assert.equal(e.status, 200);
    assert.equal(parseCsv(e.text).length, 1, "header only");
  });

  test("open shift: no clock-out, worked and no-record empty; nothing assumed", async () => {
    const [x] = records((await api(`/attendance/export?${week(today, today)}`, { bearer: b.bearer })).text);
    assert.equal(x!["Clock out"], "");
    assert.equal(x!.Status, "Open: no clock-out recorded");
    assert.equal(x!["Worked minutes"], "");
    assert.equal(x!["No activity record minutes"], "");
    assert.equal(x!["Active minutes"], "0");
  });

  test("untrusted text: formula neutralised, Unicode, quotes and commas preserved", async () => {
    const r = await api(`/attendance/export?${week()}`, { bearer: tricky.bearer });
    assert.ok(r.text.includes(`,"'=HYPERLINK(""http://x"",""Zoë, ""Zo"" 日本"")",`), r.text.split("\r\n")[1]);
    assert.equal(records(r.text)[0]!["Employee name"]!.startsWith("'="), true);
  });

  test("isolation and authorization; no internal ids or other employees in the file", async () => {
    assert.equal((await api(`/attendance/export?${week()}&employeeId=${a.id}`, { bearer: b.bearer })).status, 404);
    assert.equal((await api(`/attendance/export?${week()}&employeeId=${randomUUID()}`, { bearer: b.bearer })).status, 404);
    assert.equal((await api(`/attendance/export?${week()}`)).status, 401);
    assert.equal((await api(`/attendance/export?${week()}`, { bearer: "nope" })).status, 401);
    const spoof = await api(`/attendance/export?${week()}`, { bearer: b.bearer, headers: { "x-employee-id": a.id, "x-user-id": a.id } });
    assert.ok(!spoof.text.includes("SS-1,"), "headers never select the employee");
    const own = await api(`/attendance/export?${week()}`, { bearer: a.bearer });
    const ids = (await db.execute({ sql: "SELECT s.id AS sid, p.id AS pid, p.user_id AS uid, d.id AS did FROM attendance_sessions s JOIN employee_profiles p ON p.id = s.employee_id JOIN devices d ON d.employee_id = p.id WHERE p.id = ?", args: [a.id] })).rows[0]!;
    for (const v of Object.values(ids)) assert.ok(!own.text.includes(String(v)), `internal id ${v} not exported`);
    assert.ok(!own.text.includes("Secret App"), "no application names in the timesheet");
    assert.ok(!own.text.includes(`SS-${seq}`) && !own.text.includes("Self Service 2"), "no other employee");
    assert.equal((await api(`/attendance/export?${week()}`, { cookie: admin })).status, 403, "admin without a profile must name the employee");
    assert.equal((await api(`/attendance/export?${week()}&employeeId=${a.id}`, { cookie: admin })).status, 200);
  });

  test("invalid and oversized ranges are refused", async () => {
    for (const q of [`from=${d1}&to=${d2}`, "from=2026-01-01&to=2026-04-03", "from=nope&to=2026-01-01", "from=2026-01-01", ""]) {
      assert.equal((await api(`/attendance/export?${q}`, { bearer: a.bearer })).status, 400, q);
    }
    assert.equal((await api("/attendance/export?from=2026-01-01&to=2026-04-02", { bearer: a.bearer })).status, 200, "92 days is the limit");
  });
});

// ---- XLSX ----------------------------------------------------------------------------------------
// The workbook is checked twice: its raw XML (unzip) and an independent reader (Python openpyxl,
// when installed; those checks are skipped otherwise, never passed silently).
const OPENPYXL = spawnSync("python3", ["-I", "-c", "import openpyxl"]).status === 0;
const XLSX_DIR = mkdtempSync(join(tmpdir(), "wf-xlsx-"));
const READER = `
import json, sys, datetime, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
def v(x): return x.date().isoformat() if isinstance(x, datetime.datetime) else x
out = {"sheets": wb.sheetnames}
for ws in wb.worksheets:
    out[ws.title] = {"freeze": ws.freeze_panes, "filter": ws.auto_filter.ref,
        "rows": [[v(c.value) for c in r] for r in ws.iter_rows()],
        "types": [[c.data_type for c in r] for r in ws.iter_rows()],
        "formats": [[c.number_format for c in r] for r in ws.iter_rows()]}
print(json.dumps(out))`;
async function xlsx(query: string, bearer?: string, cookie?: string) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}/api/v1/attendance/export?${query}&format=xlsx`, { headers });
  const bytes = Buffer.from(await res.arrayBuffer());
  const file = join(XLSX_DIR, `${randomUUID()}.xlsx`);
  writeFileSync(file, bytes);
  const part = (name: string) => execFileSync("unzip", ["-p", file, name], { encoding: "utf8" });
  const read = () => JSON.parse(execFileSync("python3", ["-I", "-c", READER, file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  return { res, bytes, part, read };
}
/** The CSV row as the XLSX reader sees it: numbers as numbers, blanks as null. */
const asCells = (row: Record<string, string>) =>
  TIMESHEET_CSV_COLUMNS.map((c) => (row[c.header] === "" ? null : c.type === "number" ? Number(row[c.header]) : row[c.header]!.replace(/^'/, "")));

describe("timesheet XLSX export (draft format)", () => {
  test("download headers and a real workbook: two sheets, frozen and filtered header, same columns and values as the CSV", async (t) => {
    const x = await xlsx(week(), a.bearer);
    assert.equal(x.res.status, 200);
    assert.equal(x.res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(x.res.headers.get("content-disposition"), `attachment; filename="workfolio-timesheet-draft1_SS-1_${d2}_${addDays(d2, 6)}.xlsx"`);
    assert.match(x.res.headers.get("cache-control")!, /no-store/);
    assert.equal(x.res.headers.get("x-export-rows"), "1");
    assert.equal(x.bytes.subarray(0, 2).toString(), "PK", "a ZIP container, not renamed CSV");
    assert.match(x.part("xl/workbook.xml"), /<sheet [^>]*name="Timesheet"[^>]*\/>.*<sheet [^>]*name="Summary"/);
    const sheet = x.part("xl/worksheets/sheet1.xml");
    assert.match(sheet, /<pane ySplit="1"[^>]*state="frozen"\/>/);
    assert.match(sheet, /<autoFilter ref="A1:P2"\/>/);
    if (!OPENPYXL) return t.skip("python3 openpyxl not installed: independent reader checks skipped");
    const wb = x.read();
    assert.deepEqual(wb.sheets, ["Timesheet", "Summary"]);
    assert.deepEqual([wb.Timesheet.freeze, wb.Timesheet.filter], ["A2", "A1:P2"]);
    assert.deepEqual(wb.Timesheet.rows[0], TIMESHEET_CSV_COLUMNS.map((c) => c.header));
    const csv = records((await api(`/attendance/export?${week()}`, { bearer: a.bearer })).text);
    assert.deepEqual(wb.Timesheet.rows.slice(1), csv.map(asCells), "same rows as the CSV");
    assert.deepEqual(wb.Timesheet.types[1], ["s", "s", "d", "s", "s", "s", "s", "s", "n", "n", "n", "n", "n", "n", "s", "s"], "text, a date cell, numeric minutes");
    assert.equal(wb.Timesheet.formats[1][2], "yyyy-mm-dd");
  });

  test("summary sheet: exact counts and column sums only; no overtime, paid hours or leave", async (t) => {
    if (!OPENPYXL) return t.skip("python3 openpyxl not installed");
    const s = Object.fromEntries((await xlsx(week(), a.bearer)).read().Summary.rows.slice(1).map((r: unknown[]) => [r[0], r[1]]));
    assert.equal(s.Format, "timesheet-csv-draft-1");
    assert.deepEqual([s["Work dates from"], s["Work dates to"], s["Time zone"]], [d2, addDays(d2, 6), "UTC"]);
    assert.deepEqual(
      [s["Shifts (rows)"], s["Completed shifts"], s["Open shifts"], s["Worked minutes (sum of the column)"], s["Break minutes (sum of the column)"], s["Active minutes (sum of the column)"], s["No activity record minutes (sum of the column)"]],
      [1, 1, 0, 105, 15, 30, 75],
    );
    assert.ok(!Object.keys(s).some((k) => /overtime|paid|leave|productiv/i.test(k)));
  });

  test("open shift: blank cells, never zero; empty range: header row only", async (t) => {
    if (!OPENPYXL) return t.skip("python3 openpyxl not installed");
    const open = (await xlsx(week(today, today), b.bearer)).read().Timesheet.rows[1];
    const col = (h: string) => open[TIMESHEET_CSV_COLUMNS.findIndex((c) => c.header === h)];
    assert.deepEqual([col("Clock out"), col("Worked minutes"), col("Break minutes"), col("No activity record minutes"), col("Status")], [null, null, null, null, "Open: no clock-out recorded"]);
    const none = await xlsx(week(), empty.bearer);
    assert.match(none.part("xl/worksheets/sheet1.xml"), /<autoFilter ref="A1:P1"\/>/);
    const wb = none.read();
    assert.equal(wb.Timesheet.rows.length, 1);
    assert.equal(Object.fromEntries(wb.Summary.rows.map((r: unknown[]) => [r[0], r[1]]))["Shifts (rows)"], 0);
  });

  test("formula injection: user text is a plain string cell, never a formula", async (t) => {
    const x = await xlsx(week(), tricky.bearer);
    for (const name of ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) assert.ok(!/<f[ >]/.test(x.part(name)), `${name} has no formula element`);
    assert.ok(x.part("xl/sharedStrings.xml").includes('<t>=HYPERLINK("http://x","Zoë, "Zo" 日本")</t>'), "stored as a shared string (text)");
    if (!OPENPYXL) return t.skip("python3 openpyxl not installed");
    const wb = x.read();
    assert.equal(wb.Timesheet.rows[1][1], '=HYPERLINK("http://x","Zoë, "Zo" 日本")', "shown exactly, no apostrophe needed");
    assert.equal(wb.Timesheet.types[1][1], "s");
  });

  test("same authorization, range and format validation as the CSV", async () => {
    const status = async (q: string, who: { bearer?: string; cookie?: string }) => (await xlsx(q, who.bearer, who.cookie)).res.status;
    assert.equal(await status(`${week()}&employeeId=${a.id}`, { bearer: b.bearer }), 404);
    assert.equal(await status(`${week()}&employeeId=${randomUUID()}`, { bearer: b.bearer }), 404);
    assert.equal(await status(week(), {}), 401);
    assert.equal(await status(week(), { cookie: admin }), 403, "admin without a profile must name the employee");
    assert.equal(await status(`${week()}&employeeId=${a.id}`, { cookie: admin }), 200);
    for (const q of [`from=${d1}&to=${d2}`, "from=2026-01-01&to=2026-04-03", "from=nope&to=2026-01-01"]) assert.equal(await status(q, { bearer: a.bearer }), 400, q);
    assert.equal(await status("from=2026-01-01&to=2026-04-02", { bearer: a.bearer }), 200, "92 days");
    for (const f of ["pdf", "XLSX", "xls", ""]) assert.equal((await api(`/attendance/export?${week()}&format=${f}`, { bearer: a.bearer })).status, 400, f);
    const plain = await api(`/attendance/export?${week()}`, { bearer: a.bearer });
    const csv = await api(`/attendance/export?${week()}&format=csv`, { bearer: a.bearer });
    assert.equal(csv.text, plain.text, "format=csv is the existing CSV, unchanged");
    const spoof = await xlsx(week(), b.bearer);
    assert.ok(!spoof.part("xl/sharedStrings.xml").includes("SS-1<"), "never another employee's data");
  });

  test("large export: 92 days × 3 shifts (276 rows) in both formats, quickly and in modest memory", async (t) => {
    const big = await employee("Big Range");
    const device = String((await db.execute({ sql: "SELECT id FROM devices WHERE employee_id = ?", args: [big.id] })).rows[0]!.id);
    const from = addDays(today, -95);
    for (let d = 0; d < 92; d++) {
      for (const h of [1, 9, 17]) {
        const start = Date.parse(`${addDays(from, d)}T00:00:00Z`) + h * H;
        await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), big.id, device, iso(start), iso(start + 7 * H)] });
      }
    }
    const q = `from=${from}&to=${addDays(from, 91)}`;
    const heap = process.memoryUsage().heapUsed;
    const started = Date.now();
    const csv = await api(`/attendance/export?${q}`, { bearer: big.bearer });
    const x = await xlsx(q, big.bearer);
    const ms = Date.now() - started;
    assert.equal(records(csv.text).length, 276);
    assert.ok(ms < 10_000, `${ms} ms`);
    assert.ok(x.bytes.length < 1_000_000, `${x.bytes.length} bytes`);
    assert.ok(process.memoryUsage().heapUsed - heap < 200 * 1024 * 1024, "heap growth under 200 MB");
    assert.match(x.part("xl/worksheets/sheet1.xml"), /<autoFilter ref="A1:P277"\/>/);
    if (!OPENPYXL) return t.skip("python3 openpyxl not installed");
    const wb = x.read();
    assert.equal(wb.Timesheet.rows.length, 277);
    assert.equal(Object.fromEntries(wb.Summary.rows.map((r: unknown[]) => [r[0], r[1]]))["Worked minutes (sum of the column)"], 276 * 7 * 60);
  });
});

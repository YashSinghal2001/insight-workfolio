import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPORT_CONTENT_TYPES, TIMESHEET_CSV_COLUMNS, csvCell, timesheetCsv, timesheetCsvFilename, timesheetFilename, timesheetRows, timesheetSummary, toCsv, zonedIso } from "../dist/index.js";

/** Minimal RFC 4180 reader for the checks below (quoted fields, doubled quotes, CRLF inside quotes). */
function parse(csv: string): string[][] {
  assert.ok(csv.startsWith("﻿"), "UTF-8 BOM for Excel");
  const rows: string[][] = [[]];
  let f = "", q = false;
  for (let i = 1; i < csv.length; i++) {
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

const employee = { id: "e1", fullName: "Zoë O'Brien, \"Zo\"\nLine 2", employeeCode: "=HYPERLINK(1)", timezone: "Asia/Kolkata" };
const T = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 27, h, m)).toISOString(); // 27 Oct UTC
const session = (over: object) => ({ id: "s1", clockInAt: T(3, 30), clockOutAt: T(12), status: "CLOSED", corrected: false, clockInSource: "ONLINE", breaks: [], ...over });

test("cells: quoting, doubled quotes, line breaks, Unicode, empty, numbers", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(""), "");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("one\ntwo"), '"one\ntwo"');
  assert.equal(csvCell("one\r\ntwo"), '"one\r\ntwo"');
  assert.equal(csvCell(" padded "), '" padded "');
  assert.equal(csvCell("日本語 – Zoë 🙂"), "日本語 – Zoë 🙂");
});

test("formula injection: text starting with = + - @ tab or CR is neutralised; numbers untouched", () => {
  for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "=HYPERLINK(\"http://x\",\"y\")"]) {
    const out = csvCell(bad);
    assert.ok(out.replace(/^"/, "").startsWith("'"), `${JSON.stringify(bad)} → ${out}`);
  }
  assert.equal(csvCell('=A1,"x"'), `"'=A1,""x"""`, "neutralised and quoted");
  assert.equal(csvCell(-5), "-5", "real numbers are not text");
  assert.equal(csvCell("2026-10-27T09:00:00+05:30"), "2026-10-27T09:00:00+05:30");
});

test("zonedIso: local time with its offset, DST-aware", () => {
  assert.equal(zonedIso("2026-10-27T03:30:00.000Z", "Asia/Kolkata"), "2026-10-27T09:00:00+05:30");
  assert.equal(zonedIso("2026-01-15T14:00:00.000Z", "America/New_York"), "2026-01-15T09:00:00-05:00");
  assert.equal(zonedIso("2026-07-15T13:00:00.000Z", "America/New_York"), "2026-07-15T09:00:00-04:00");
  assert.equal(zonedIso("2026-07-15T13:00:00.999Z", "UTC"), "2026-07-15T13:00:00+00:00");
});

test("columns: draft header row and a completed shift", () => {
  const rows = parse(timesheetCsv(employee, [session({ breaks: [{ id: "b1", startedAt: T(7), endedAt: T(7, 30) }] })], new Map([["s1", { activeMs: 5 * 3_600_000, idleMs: 30 * 60_000 }]])));
  assert.deepEqual(rows[0], TIMESHEET_CSV_COLUMNS.map((c) => c.header));
  assert.deepEqual(rows[0], ["Employee code", "Employee name", "Work date", "Time zone", "Clock in", "Clock out", "Status", "Breaks", "Break count", "Break minutes", "Worked minutes", "Active minutes", "Idle minutes", "No activity record minutes", "Corrected", "Clock-in source"]);
  const r = Object.fromEntries(rows[0]!.map((h, i) => [h, rows[1]![i]]));
  assert.equal(r["Employee code"], "'=HYPERLINK(1)", "untrusted text neutralised");
  assert.equal(r["Employee name"], employee.fullName, "Unicode, comma, quotes and newline survive a round trip");
  assert.equal(r["Work date"], "2026-10-27");
  assert.equal(r["Clock in"], "2026-10-27T09:00:00+05:30");
  assert.equal(r["Clock out"], "2026-10-27T17:30:00+05:30");
  assert.equal(r.Status, "Completed");
  assert.equal(r.Breaks, "2026-10-27T12:30:00+05:30/2026-10-27T13:00:00+05:30");
  assert.equal(r["Break minutes"], "30");
  assert.equal(r["Worked minutes"], String(8 * 60), "8h30 minus a 30-minute break");
  assert.equal(r["Active minutes"], "300");
  assert.equal(r["Idle minutes"], "30");
  assert.equal(r["No activity record minutes"], "150");
  assert.equal(r["Clock-in source"], "Desktop app");
  assert.equal(rows.length, 2);
});

test("open shift and missing activity: nothing assumed", () => {
  const rows = parse(timesheetCsv(employee, [session({ clockOutAt: null, status: "OPEN", breaks: [{ id: "b1", startedAt: T(7), endedAt: null }] })], new Map()));
  const r = Object.fromEntries(rows[0]!.map((h, i) => [h, rows[1]![i]]));
  assert.equal(r["Clock out"], "");
  assert.equal(r.Status, "Open: no clock-out recorded");
  assert.equal(r.Breaks, "2026-10-27T12:30:00+05:30/", "open break has no end");
  assert.equal(r["Break minutes"], "");
  assert.equal(r["Worked minutes"], "");
  assert.equal(r["No activity record minutes"], "");
  assert.equal(r["Active minutes"], "0", "no intervals recorded");
  assert.equal(r["Idle minutes"], "0");
});

test("empty export: header only; rows sorted by clock-in; filename is safe", () => {
  assert.deepEqual(parse(timesheetCsv(employee, [], new Map())).length, 1);
  const two = parse(timesheetCsv(employee, [session({ id: "late", clockInAt: T(20), clockOutAt: T(22) }), session({ id: "early" })], new Map()));
  assert.ok(two[1]![4]! < two[2]![4]!);
  assert.equal(timesheetCsvFilename("EMP-7", "2026-10-01", "2026-10-31"), "workfolio-timesheet-draft1_EMP-7_2026-10-01_2026-10-31.csv");
  assert.equal(timesheetCsvFilename('../a"b c', "2026-10-01", "2026-10-01"), "workfolio-timesheet-draft1__a_b_c_2026-10-01_2026-10-01.csv");
  assert.equal(toCsv([["a"]]), "﻿a\r\n");
});

test("one row source for CSV and XLSX: same 16 columns and values; XLSX metadata per column", () => {
  const sessions = [session({ breaks: [{ id: "b1", startedAt: T(7), endedAt: T(7, 30) }] }), session({ id: "s2", clockInAt: T(20), clockOutAt: null, status: "OPEN" })];
  const rows = timesheetRows(employee, sessions, new Map([["s1", { activeMs: 61_000, idleMs: 0 }]]));
  const csv = parse(timesheetCsv(employee, sessions, new Map([["s1", { activeMs: 61_000, idleMs: 0 }]])));
  assert.equal(TIMESHEET_CSV_COLUMNS.length, 16);
  assert.deepEqual(csv.slice(1), rows.map((r) => r.map((v) => (v === null ? "" : typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v)))), "CSV = rows (+ text neutralised)");
  assert.deepEqual(TIMESHEET_CSV_COLUMNS.filter((c) => c.type === "number").map((c) => c.header), ["Break count", "Break minutes", "Worked minutes", "Active minutes", "Idle minutes", "No activity record minutes"]);
  assert.deepEqual(TIMESHEET_CSV_COLUMNS.filter((c) => c.type === "date").map((c) => c.header), ["Work date"]);
  for (const [i, c] of TIMESHEET_CSV_COLUMNS.entries()) for (const r of rows) assert.ok(r[i] === null || (c.type === "number" ? typeof r[i] === "number" : typeof r[i] === "string"), `${c.header}: ${r[i]}`);
  assert.equal(rows[1]![TIMESHEET_CSV_COLUMNS.findIndex((c) => c.header === "Work date")], "2026-10-28", "20:00 UTC is 01:30 next day in Kolkata: belongs to the clock-in date");
});

test("summary: exact sums and counts of the rows; blanks are not zeros", () => {
  const sessions = [
    session({ breaks: [{ id: "b1", startedAt: T(7), endedAt: T(7, 30) }] }), // 8h worked, 30m break
    session({ id: "s2", clockInAt: T(13), clockOutAt: T(14, 59, 59) }), // 1h59m59s -> 119
    session({ id: "s3", clockInAt: T(20), clockOutAt: null, status: "OPEN" }),
  ];
  const rows = timesheetRows(employee, sessions, new Map([["s1", { activeMs: 90 * 60_000, idleMs: 10 * 60_000 }], ["s3", { activeMs: 5 * 60_000, idleMs: 0 }]]));
  const s = Object.fromEntries(timesheetSummary(rows).map((x) => [x.label, x.value]));
  assert.deepEqual(s, {
    "Shifts (rows)": 3,
    "Completed shifts": 2,
    "Open shifts": 1,
    "Worked minutes (sum of the column)": 480 + 119,
    "Break minutes (sum of the column)": 30,
    "Active minutes (sum of the column)": 95,
    "Idle minutes (sum of the column)": 10,
    "No activity record minutes (sum of the column)": 380 + 119,
  });
  assert.match(timesheetSummary(rows).find((x) => x.label.startsWith("Worked"))!.note, /2 of 3 rows have a value/);
  assert.ok(!timesheetSummary(rows).some((x) => /overtime|paid|leave/i.test(x.label)), "no unapproved business figures");
  assert.deepEqual(timesheetSummary([]).map((x) => x.value), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("file names and content types per format", () => {
  assert.equal(timesheetFilename("EMP-7", "2026-10-01", "2026-10-31", "xlsx"), "workfolio-timesheet-draft1_EMP-7_2026-10-01_2026-10-31.xlsx");
  assert.equal(timesheetFilename("A.B", "2026-10-01", "2026-10-31"), "workfolio-timesheet-draft1_A_B_2026-10-01_2026-10-31.csv", "one dot only: the extension");
  assert.equal(EXPORT_CONTENT_TYPES.xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimesheet, summaryReportCells, summaryReportQuerySchema, summaryReportRow, summaryReportTotals } from "../dist/index.js";

const emp = (timezone: string) => ({ id: "e1", fullName: "Synthetic One", employeeCode: "S-1", timezone });
const s = (id: string, clockInAt: string, clockOutAt: string | null, breaks: [string, string | null][] = []) => ({
  id, clockInAt, clockOutAt, breaks: breaks.map(([startedAt, endedAt]) => ({ startedAt, endedAt })),
});

test("IST range: cross-midnight shift belongs to its start day; open shift and out-of-range shift excluded; equals the timesheet", () => {
  const sessions = [
    s("a", "2026-03-02T03:30:00.000Z", "2026-03-02T12:00:30.000Z", [["2026-03-02T07:00:00.000Z", "2026-03-02T07:30:45.000Z"]]),
    s("b", "2026-03-03T16:00:00.000Z", "2026-03-04T00:30:00.000Z"), // 21:30 IST → 06:00 next day
    s("c", "2026-03-05T03:30:00.000Z", null), // open
    s("d", "2026-02-28T19:00:00.000Z", "2026-02-28T20:00:00.000Z"), // 01 Mar 00:30 IST: in range
    s("e", "2026-03-31T19:00:00.000Z", "2026-03-31T20:00:00.000Z"), // 01 Apr IST: out of range
  ];
  const activity = new Map([
    ["a", { activeMs: 7.5 * 3_600_000 + 59_000, idleMs: 30 * 60_000 }],
    ["b", { activeMs: 60 * 60_000, idleMs: 0 }],
    ["c", { activeMs: 99 * 60_000, idleMs: 99 * 60_000 }],
    ["e", { activeMs: 60 * 60_000, idleMs: 0 }],
  ]);
  const range = { from: "2026-03-01", to: "2026-03-31" };
  const r = summaryReportRow(emp("Asia/Kolkata"), sessions, activity, range);
  const sheet = buildTimesheet(sessions, { ...range, timeZone: "Asia/Kolkata" });
  assert.equal(r.workedMinutes, Math.floor(sheet.totals.netMs / 60_000));
  assert.equal(r.breakMinutes, Math.floor(sheet.totals.breakMs / 60_000));
  assert.deepEqual({ ...r, employee: undefined }, { employee: undefined, workedDays: 4, workedMinutes: 1049 /* 479.75 + 510 + 60, floored once */, breakMinutes: 30, activeMinutes: 450 + 60, idleMinutes: 30 });
});

test("DST week in America/New_York: elapsed time, not wall time", () => {
  // Sat 7 Mar 23:00 EST → Sun 8 Mar 05:00 EDT is 5 real hours.
  const r = summaryReportRow(emp("America/New_York"), [s("x", "2026-03-08T04:00:00.000Z", "2026-03-08T09:00:00.000Z")], new Map(), { from: "2026-03-07", to: "2026-03-08" });
  assert.equal(r.workedMinutes, 300);
  assert.equal(r.workedDays, 1);
});

test("empty: zeros, totals row, query validation", () => {
  const r = summaryReportRow(emp("UTC"), [], new Map(), { from: "2026-03-01", to: "2026-03-01" });
  assert.deepEqual([r.workedDays, r.workedMinutes, r.activeMinutes], [0, 0, 0]);
  assert.deepEqual(summaryReportTotals([r, { ...r, workedMinutes: 5, workedDays: 1 }]), { employees: 2, workedDays: 1, workedMinutes: 5, breakMinutes: 0, activeMinutes: 0, idleMinutes: 0 });
  const cells = summaryReportCells([{ ...r, workedMinutes: 7 }]);
  assert.deepEqual(cells, [["S-1", "Synthetic One", "UTC", 0, 7, 0, 0, 0], ["All employees", "1 employees", null, 0, 7, 0, 0, 0]]);
  const ok = (q: Record<string, string>) => summaryReportQuerySchema.safeParse(q).success;
  assert.equal(ok({ from: "2026-01-01", to: "2026-04-02" }), true, "92 days");
  assert.equal(ok({ from: "2026-01-01", to: "2026-04-03" }), false, "93 days");
  assert.equal(ok({ from: "2026-03-02", to: "2026-03-01" }), false);
  assert.equal(ok({ from: "2026-03-01", to: "2026-03-01", format: "csv" }), false);
  assert.equal(ok({ from: "2026-03-01", to: "2026-03-01", teamId: "nope" }), false);
  assert.equal(ok({ from: "2026-03-01", to: "2026-03-01", pageSize: "101" }), false);
});

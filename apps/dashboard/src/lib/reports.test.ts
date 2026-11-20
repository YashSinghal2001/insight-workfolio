import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyExportCells, dailyTabRows, type DailyAttendanceRow, type MonthlyAttendanceDay, type MonthlyAttendanceRow } from "@workfolio/shared";
import {
  dailyReportRows,
  dailyTabCounts,
  fetchAllPages,
  loadWeekGrid,
  hm,
  inOutCell,
  inOutCounts,
  missedDay,
  overtimeSummary,
  weekGrid,
  weekMonths,
} from "./reports.ts";

const emp = (id: string) => ({ id, fullName: `Person ${id}`, employeeCode: id.toUpperCase(), timezone: "Asia/Kolkata" });
const day = (date: string, over: Partial<MonthlyAttendanceDay> = {}): MonthlyAttendanceDay => ({
  date, status: "ABSENT", firstInLocal: null, lastOutLocal: null, workedMinutes: 0, breakMinutes: 0, overtimeMinutes: 0, lateMinutes: null, dueLocal: "09:10", ...over,
});
const totals = { workedDays: 0, presentDays: 0, lateDays: 0, absentDays: 0, leaveDays: 0, holidayDays: 0, workedMinutes: 0, overtimeMinutes: 0 };
const daily = (id: string, status: DailyAttendanceRow["status"], firstClockInLocal: string | null, lateMinutes: number | null = null): DailyAttendanceRow => ({
  employee: emp(id), date: "2026-03-02", scheduled: true, dueAt: null, firstClockInAt: null, firstClockInLocal, lateMinutes, leave: null, holiday: null, status,
});

test("fetchAllPages: follows total, stops on an empty page and at maxPages", async () => {
  const pages = (total: number) => (page: number) => Promise.resolve({ items: Array.from({ length: Math.max(0, Math.min(2, total - (page - 1) * 2)) }, (_, i) => (page - 1) * 2 + i), total, page, pageSize: 2 });
  assert.deepEqual(await fetchAllPages(pages(5)), [0, 1, 2, 3, 4]);
  assert.deepEqual(await fetchAllPages(pages(0)), []);
  assert.deepEqual(await fetchAllPages(pages(100), 2), [0, 1, 2, 3]);
});

test("daily: tabs, clock-out and worked minutes joined from monthly; open shift worked is unknown; export cells", () => {
  const rows = dailyReportRows(
    [daily("a", "PRESENT", "2026-03-02T08:55"), daily("b", "LATE", "2026-03-02T09:40", 30), daily("c", "ON_LEAVE", null), daily("d", "ABSENT", null), daily("e", "PRESENT", "2026-03-02T09:00")],
    [
      { employee: emp("a"), totals, days: [day("2026-03-02", { status: "PRESENT", firstInLocal: "08:55", lastOutLocal: "18:30", workedMinutes: 544 })] },
      { employee: emp("b"), totals, days: [day("2026-03-02", { status: "OPEN", firstInLocal: "09:40", workedMinutes: 0 })] },
    ],
  );
  assert.deepEqual(dailyTabCounts(rows), { worked: 3, late: 1, leave: 1, absent: 1 });
  assert.deepEqual(dailyTabRows(rows, "worked").map((r) => [r.employee.id, r.clockIn, r.clockOut, r.workedMinutes]), [["a", "08:55", "18:30", 544], ["b", "09:40", null, null], ["e", "09:00", null, null]]);
  assert.deepEqual(dailyExportCells(dailyTabRows(rows, "late")), [["B", "Person b", "Asia/Kolkata", "2026-03-02", "LATE", "09:40", null, null, 30]]);
  assert.equal(dailyReportRows([daily("a", "ABSENT", null)], null)[0]!.workedMinutes, null, "monthly failed: unknown, not zero");
});

test("in/out cells, counts, overtime", () => {
  assert.equal(inOutCell(day("d", { status: "PRESENT", firstInLocal: "09:00", lastOutLocal: "17:30" })), "09:00–17:30");
  assert.equal(inOutCell(day("d", { status: "OPEN", firstInLocal: "21:30" })), "21:30–");
  assert.deepEqual(["ABSENT", "ON_LEAVE", "HOLIDAY", "NOT_SCHEDULED", "NO_POLICY"].map((status) => inOutCell(day("d", { status: status as MonthlyAttendanceDay["status"] }))), ["A", "LV", "H", "WO", "—"]);
  const row: MonthlyAttendanceRow = {
    employee: emp("a"),
    totals: { ...totals, workedDays: 3, lateDays: 1, absentDays: 2, leaveDays: 1, overtimeMinutes: 95 },
    days: [day("1", { overtimeMinutes: 60 }), day("2", { overtimeMinutes: 35 }), day("3")],
  };
  assert.deepEqual(inOutCounts(row), { worked: 3, nonWorked: 3, late: 1 });
  assert.deepEqual(overtimeSummary(row), { days: 2, minutes: 95 });
  assert.equal(hm(95), "1h 35m");
});

test("week grid: a week across two months merges by employee; totals; red only for ABSENT; missing month is null", () => {
  assert.deepEqual(weekMonths("2026-03-30"), ["2026-03", "2026-04"]);
  assert.deepEqual(weekMonths("2026-03-02"), ["2026-03"]);
  const march: MonthlyAttendanceRow[] = [
    { employee: emp("a"), totals, days: [day("2026-03-29"), day("2026-03-30", { status: "PRESENT", firstInLocal: "09:00", lastOutLocal: "17:00", workedMinutes: 450, breakMinutes: 30 }), day("2026-03-31")] },
  ];
  const april: MonthlyAttendanceRow[] = [
    { employee: emp("b"), totals, days: [day("2026-04-01", { status: "NOT_SCHEDULED" })] },
    { employee: emp("a"), totals, days: [day("2026-04-01", { status: "LATE", firstInLocal: "09:30", lastOutLocal: "18:00", workedMinutes: 480, breakMinutes: 30 }), day("2026-04-06")] },
  ];
  const grid = weekGrid([march, april], "2026-03-30");
  assert.deepEqual(grid.map((r) => r.employee.id), ["b", "a"], "last month's order");
  const a = grid[1]!;
  assert.deepEqual(a.cells.map((c) => c?.date ?? null), ["2026-03-30", "2026-03-31", "2026-04-01", null, null, null, null]);
  assert.deepEqual(a.totals, { workedDays: 2, workMinutes: 930, breakMinutes: 60 });
  assert.deepEqual(a.cells.map(missedDay), [false, true, false, false, false, false, false]);
  assert.deepEqual(grid[0]!.cells.slice(0, 2), [null, null], "not listed in March");
  assert.deepEqual(weekGrid([[]], "2026-03-02"), []);
});

test("loadWeekGrid: all pages of both months, so an employee on different pages per month is one full row", async () => {
  const at = (id: string, dates: string[]): MonthlyAttendanceRow => ({ employee: emp(id), totals, days: dates.map((d) => day(d, { status: "PRESENT", firstInLocal: "09:00", lastOutLocal: "17:00", workedMinutes: 480 })) });
  // March: [a, x] on page 1; April: [a, b] on page 1, [x] on page 2 (a new employee b shifted the boundary).
  const pages: Record<string, MonthlyAttendanceRow[][]> = {
    "2026-03": [[at("a", ["2026-03-30", "2026-03-31"]), at("x", ["2026-03-30", "2026-03-31"])]],
    "2026-04": [[at("a", ["2026-04-01"]), at("b", ["2026-04-01"])], [at("x", ["2026-04-01", "2026-04-02"])]],
  };
  const calls: string[] = [];
  const grid = await loadWeekGrid((month, page) => {
    calls.push(`${month}#${page}`);
    return Promise.resolve({ month, items: pages[month]![page - 1] ?? [], total: pages[month]!.flat().length, page, pageSize: 2 });
  }, "2026-03-30");
  assert.deepEqual(calls.sort(), ["2026-03#1", "2026-04#1", "2026-04#2"]);
  const x = grid.find((r) => r.employee.id === "x")!;
  assert.deepEqual(x.cells.map((c) => c?.date ?? null), ["2026-03-30", "2026-03-31", "2026-04-01", "2026-04-02", null, null, null]);
  assert.equal(x.totals.workMinutes, 4 * 480);
  assert.equal(grid.length, 3);
});

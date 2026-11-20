import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceRow, buildTimesheet, monthlyAttendanceQuerySchema, monthlyExportHeader, monthlyExportRows, monthRange } from "../dist/index.js";

const emp = (timezone: string) => ({ id: "e1", fullName: "Synthetic One", employeeCode: "S-1", timezone });
const s = (id: string, clockInAt: string, clockOutAt: string | null, breaks: [string, string | null][] = []) => ({
  id, clockInAt, clockOutAt, breaks: breaks.map(([startedAt, endedAt]) => ({ startedAt, endedAt })),
});
const schedule = { enabled: true, expectedStart: "09:00", graceMinutes: 10, workdays: "12345" };
const base = { scheduleFor: () => schedule, onLeave: () => false, holiday: () => false, now: Date.parse("2030-01-01T00:00:00Z") };

test("monthRange covers 28/29/30/31-day months", () => {
  assert.deepEqual(monthRange("2023-02"), { from: "2023-02-01", to: "2023-02-28" });
  assert.deepEqual(monthRange("2024-02"), { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(monthRange("2026-04"), { from: "2026-04-01", to: "2026-04-30" });
  assert.deepEqual(monthRange("2026-12"), { from: "2026-12-01", to: "2026-12-31" });
  assert.equal(monthlyAttendanceQuerySchema.safeParse({ month: "2026-13" }).success, false);
  assert.equal(monthlyAttendanceQuerySchema.safeParse({ month: "2026-1" }).success, false);
});

test("status precedence, OPEN, minutes and totals match the timesheet (IST)", () => {
  const e = emp("Asia/Kolkata");
  const { from, to } = monthRange("2026-03");
  const sessions = [
    s("a", "2026-03-02T03:25:00Z", "2026-03-02T13:00:00Z", [["2026-03-02T07:00:00Z", "2026-03-02T07:30:30Z"]]), // 08:55 IST on time, 9h04m30s net
    s("b", "2026-03-03T04:00:00Z", "2026-03-03T12:00:00Z"), // 09:30 IST: late 30 min
    s("c", "2026-03-04T16:00:00Z", "2026-03-05T00:30:00Z"), // 21:30 IST → 06:00 next day: cross-midnight, belongs to 03-04
    s("d", "2026-03-31T04:00:00Z", null), // open, late
  ];
  const row = attendanceRow({ ...base, employee: e, from, to, sessions, onLeave: (d) => d === "2026-03-06", holiday: (d) => d === "2026-03-09" });
  const day = (d: string) => row.days.find((x) => x.date === d)!;
  assert.equal(row.days.length, 31);
  assert.deepEqual(
    { ...day("2026-03-02") },
    { date: "2026-03-02", status: "PRESENT", firstInLocal: "08:55", lastOutLocal: "18:30", workedMinutes: 544, breakMinutes: 30, overtimeMinutes: 64, lateMinutes: null, dueLocal: "09:10" },
  );
  assert.equal(day("2026-03-03").status, "LATE");
  assert.equal(day("2026-03-03").lateMinutes, 30);
  assert.equal(day("2026-03-04").status, "LATE");
  assert.equal(day("2026-03-04").lastOutLocal, "06:00");
  assert.equal(day("2026-03-04").workedMinutes, 510);
  assert.equal(day("2026-03-05").status, "ABSENT", "the cross-midnight shift belongs to its start day");
  assert.equal(day("2026-03-06").status, "ON_LEAVE");
  assert.equal(day("2026-03-07").status, "NOT_SCHEDULED");
  assert.equal(day("2026-03-09").status, "HOLIDAY");
  assert.equal(day("2026-03-31").status, "OPEN");
  assert.equal(day("2026-03-31").lateMinutes, 30, "late info kept on an open day");
  assert.equal(day("2026-03-31").workedMinutes, 0, "open shifts are not counted");
  const sheet = buildTimesheet(sessions, { from, to, timeZone: e.timezone, now: base.now });
  assert.equal(row.totals.workedMinutes, Math.floor(sheet.totals.netMs / 60_000));
  assert.equal(row.totals.overtimeMinutes, Math.floor(sheet.totals.overtimeMs / 60_000));
  assert.equal(row.totals.workedDays, 4);
  assert.equal(row.totals.lateDays, 3, "two closed late days + the open late day");
  assert.equal(row.totals.presentDays, 4);
  assert.equal(row.totals.leaveDays, 1);
  assert.equal(row.totals.holidayDays, 1);
  // 22 weekdays in March 2026; minus 4 attended, 1 leave, 1 holiday = 16 absent.
  assert.equal(row.totals.absentDays, 16);
});

test("no policy, before employment, not yet due; DST day in New York", () => {
  const e = emp("America/New_York");
  const { from, to } = monthRange("2026-03");
  const sessions = [s("x", "2026-03-09T13:05:00Z", "2026-03-09T21:05:00Z")]; // Mon after DST start: 09:05 EDT
  const row = attendanceRow({ ...base, employee: e, from, to, sessions, employedFrom: "2026-03-03", scheduleFor: (d) => (d < "2026-03-20" ? schedule : null), now: Date.parse("2026-03-25T12:00:00Z") });
  const day = (d: string) => row.days.find((x) => x.date === d)!;
  assert.equal(day("2026-03-02").status, "NOT_SCHEDULED", "before the profile existed");
  assert.equal(day("2026-03-09").status, "PRESENT");
  assert.equal(day("2026-03-09").firstInLocal, "09:05");
  assert.equal(day("2026-03-09").dueLocal, "09:10");
  assert.equal(day("2026-03-23").status, "NO_POLICY");
  const row2 = attendanceRow({ ...base, employee: e, from, to, sessions: [], now: Date.parse("2026-03-25T12:00:00Z") });
  assert.equal(row2.days.find((x) => x.date === "2026-03-26")!.status, "NOT_YET_DUE");
  assert.equal(row2.totals.workedDays, 0);
});

test("export: one column per day, codes and in–out cells, totals", () => {
  const e = emp("UTC");
  const row = attendanceRow({ ...base, employee: e, ...monthRange("2024-02"), sessions: [s("a", "2024-02-01T09:00:00Z", "2024-02-01T17:30:00Z"), s("b", "2024-02-02T09:00:00Z", null)], holiday: (d) => d === "2024-02-05" });
  const header = monthlyExportHeader("2024-02");
  assert.equal(header.length, 3 + 29 + 8);
  const [r] = monthlyExportRows([row]);
  assert.equal(r!.length, header.length);
  assert.deepEqual(r!.slice(0, 8), ["S-1", "Synthetic One", "UTC", "09:00–17:30", "09:00–", "WO", "WO", "H"]);
  assert.equal(r![header.indexOf("2024-02-06")], "A");
  assert.equal(r![header.indexOf("Worked minutes")], 510);
});

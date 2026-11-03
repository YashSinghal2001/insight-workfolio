import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeaveSchema, dailyAttendanceStatus, leaveBalanceMeQuerySchema, leaveDaysInYear, leaveTypeSchema, parseHolidayCsv, shortHoursInMonth, updateLeaveTypeSchema } from "../dist/index.js";

const full = (s: string, e = s) => ({ startDate: s, endDate: e, portion: "FULL_DAY" as const });

test("leave types: name, paid, optional yearly days and monthly short hours (half steps)", () => {
  assert.ok(leaveTypeSchema.safeParse({ name: " Annual ", paid: true, yearlyAllowanceDays: 20.5, shortHoursPerMonth: null }).success);
  for (const bad of [
    { name: "", paid: true, yearlyAllowanceDays: 1, shortHoursPerMonth: null },
    { name: "X", paid: "yes", yearlyAllowanceDays: 1, shortHoursPerMonth: null },
    { name: "X", paid: true, yearlyAllowanceDays: 1.25, shortHoursPerMonth: null },
    { name: "X", paid: true, yearlyAllowanceDays: 400, shortHoursPerMonth: null },
    { name: "X", paid: true, yearlyAllowanceDays: null, shortHoursPerMonth: -1 },
    { name: "X", paid: true, yearlyAllowanceDays: null },
  ]) assert.equal(leaveTypeSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(updateLeaveTypeSchema.safeParse({}).success, false, "nothing to change");
  assert.ok(updateLeaveTypeSchema.safeParse({ active: false }).success);
  assert.ok(createLeaveSchema.safeParse({ ...full("2026-11-02"), leaveTypeId: "00000000-0000-4000-8000-000000000001" }).success);
  assert.equal(createLeaveSchema.safeParse({ ...full("2026-11-02"), leaveTypeId: "annual" }).success, false);
  assert.equal(leaveBalanceMeQuerySchema.safeParse({ month: "2026-13" }).success, false);
  assert.equal(leaveBalanceMeQuerySchema.safeParse({ month: "2026-11", employeeId: "x" }).success, false, "own balances only");
});

test("leave days: per calendar year, half days 0.5, skipping holidays and non-workdays; short leave in hours per month", () => {
  const none = new Set<string>();
  assert.equal(leaveDaysInYear(full("2026-11-02", "2026-11-08"), 2026, none, null), 7, "no schedule: every day");
  assert.equal(leaveDaysInYear(full("2026-11-02", "2026-11-08"), 2026, none, "12345"), 5, "weekend skipped");
  assert.equal(leaveDaysInYear(full("2026-11-02", "2026-11-08"), 2026, new Set(["2026-11-03"]), "12345"), 4, "holiday skipped");
  assert.equal(leaveDaysInYear(full("2026-12-30", "2027-01-02"), 2026, none, null), 2, "split at the year");
  assert.equal(leaveDaysInYear(full("2026-12-30", "2027-01-02"), 2027, none, null), 2);
  assert.equal(leaveDaysInYear({ startDate: "2026-11-02", endDate: "2026-11-02", portion: "FIRST_HALF" }, 2026, none, null), 0.5);
  assert.equal(leaveDaysInYear({ startDate: "2026-11-03", endDate: "2026-11-03", portion: "SECOND_HALF" }, 2026, new Set(["2026-11-03"]), null), 0);
  const short = { startDate: "2026-11-02", endDate: "2026-11-02", portion: "SHORT" as const, startTime: "14:00", endTime: "15:30" };
  assert.equal(leaveDaysInYear(short, 2026, none, null), 0);
  assert.equal(shortHoursInMonth(short, "2026-11"), 1.5);
  assert.equal(shortHoursInMonth(short, "2026-12"), 0);
  assert.equal(shortHoursInMonth(full("2026-11-02"), "2026-11"), 0);
});

test("holiday CSV: optional header, quoted names, all-or-nothing errors", () => {
  const ok = parseHolidayCsv('\uFEFFdate,name\r\n2026-12-25,Christmas Day\n\n2027-01-01,"New Year, Day ""1"""\n');
  assert.deepEqual(ok, { rows: [{ date: "2026-12-25", name: "Christmas Day" }, { date: "2027-01-01", name: 'New Year, Day "1"' }], errors: [] });
  const bad = parseHolidayCsv("2026-12-25,Christmas\n25/12/2026,Christmas\n2026-12-26,\n2026-12-25,Again");
  assert.deepEqual(bad.errors, ["Line 2: expected YYYY-MM-DD,name (name 1–120 characters)", "Line 3: expected YYYY-MM-DD,name (name 1–120 characters)", "Line 4: 2026-12-25 appears twice"]);
  assert.deepEqual(parseHolidayCsv("date,name\n").errors, ["The file has no holidays"]);
});

test("a holiday is never ABSENT (even on a workday, with no clock-in, after the due time)", () => {
  const policy = { enabled: true, expectedStart: "09:00", graceMinutes: 0, workdays: "1234567" };
  const base = { date: "2026-11-02", timeZone: "UTC", policy, firstClockInAt: null, onLeave: false, now: Date.parse("2026-11-03T00:00:00Z") };
  assert.equal(dailyAttendanceStatus(base).status, "ABSENT");
  assert.deepEqual(dailyAttendanceStatus({ ...base, holiday: true }), { status: "HOLIDAY", scheduled: false, dueAt: null, lateMinutes: null });
  assert.equal(dailyAttendanceStatus({ ...base, holiday: true, onLeave: true }).status, "HOLIDAY", "leave on a holiday uses no day");
  assert.equal(dailyAttendanceStatus({ ...base, holiday: true, policy: null }).status, "HOLIDAY");
});

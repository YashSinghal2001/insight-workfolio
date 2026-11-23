import assert from "node:assert/strict";
import { test } from "node:test";
import { autoClockOutPlan, nextWorkingOccurrence, createEmployeeSchema, shiftInputSchema, shiftOccurrence, shiftStatus, wallToUtc, type ShiftSettings } from "../dist/index.js";

const day = (over: Partial<ShiftSettings> = {}): ShiftSettings => ({ startTime: "09:00", endTime: "18:00", timezone: "UTC", graceMinutes: 60, autoClockOut: true, workdays: "1234567", updatedAt: "2026-01-01T00:00:00.000Z", ...over });
const at = (iso: string) => Date.parse(iso);
const plan = (s: ShiftSettings, clockInAt: string, lastChangeAt = clockInAt) => autoClockOutPlan(s, { clockInAt, lastChangeAt });

test("9:00–18:00 with the default 60 min grace: clocked out at 19:00, not 18:00", () => {
  const p = plan(day(), "2026-11-23T09:02:00.000Z")!;
  assert.equal(p.occurrence.endAt, "2026-11-23T18:00:00.000Z");
  assert.equal(p.occurrence.deadlineAt, "2026-11-23T19:00:00.000Z");
  assert.equal(p.clockOutAt, "2026-11-23T19:00:00.000Z");
  assert.equal(plan(day(), "2026-11-23T08:30:00.000Z")!.clockOutAt, "2026-11-23T19:00:00.000Z", "early clock-in, same shift");
});

test("time zone: the shift's own zone decides the instants (Asia/Kolkata, +05:30)", () => {
  const p = plan(day({ timezone: "Asia/Kolkata" }), "2026-11-23T03:30:00.000Z")!; // 09:00 IST
  assert.equal(p.occurrence.endAt, "2026-11-23T12:30:00.000Z"); // 18:00 IST
  assert.equal(p.clockOutAt, "2026-11-23T13:30:00.000Z"); // 19:00 IST
});

test("overnight 22:00–06:00: deadline 07:00 the next morning, from either side of midnight", () => {
  const s = day({ startTime: "22:00", endTime: "06:00" });
  assert.equal(plan(s, "2026-11-23T21:55:00.000Z")!.clockOutAt, "2026-11-24T07:00:00.000Z");
  assert.equal(plan(s, "2026-11-24T01:00:00.000Z")!.clockOutAt, "2026-11-24T07:00:00.000Z", "clocked in after midnight");
});

test("clock-in after the shift ended (in the grace period or later) belongs to the next shift: never an immediate clock-out", () => {
  assert.equal(plan(day(), "2026-11-23T18:30:00.000Z")!.clockOutAt, "2026-11-24T19:00:00.000Z", "inside grace");
  assert.equal(plan(day(), "2026-11-23T19:30:00.000Z")!.clockOutAt, "2026-11-24T19:00:00.000Z", "after the deadline");
  assert.equal(plan(day(), "2026-11-23T17:59:00.000Z")!.clockOutAt, "2026-11-23T19:00:00.000Z", "a minute before the end: this shift");
});

test("automatic clock-out off: no plan", () => {
  assert.equal(plan(day({ autoClockOut: false }), "2026-11-23T09:00:00.000Z"), null);
});

test("never before the last recorded change, nor before the settings changed (no retroactive clock-out)", () => {
  // Grace cut from 60 to 15 at 18:40, after the new deadline (18:15) had passed: clocked out at 18:40.
  const cut = day({ graceMinutes: 15, updatedAt: "2026-11-23T18:40:00.000Z" });
  assert.equal(plan(cut, "2026-11-23T09:00:00.000Z")!.clockOutAt, "2026-11-23T18:40:00.000Z");
  // Grace raised to 120 min: the later deadline applies.
  assert.equal(plan(day({ graceMinutes: 120 }), "2026-11-23T09:00:00.000Z")!.clockOutAt, "2026-11-23T20:00:00.000Z");
  // A break that started after the deadline (recorded before the worker ran) is never cut short backwards.
  assert.equal(plan(day(), "2026-11-23T09:00:00.000Z", "2026-11-23T19:05:00.000Z")!.clockOutAt, "2026-11-23T19:05:00.000Z");
});

test("DST, America/New_York: grace is real elapsed minutes; skipped wall times resolve forward", () => {
  const ny = (o: Partial<ShiftSettings>) => day({ timezone: "America/New_York", ...o });
  // Spring forward 2026-03-08 02:00 EST -> 03:00 EDT. Overnight 22:00–06:00 is 7 real hours that night.
  const spring = plan(ny({ startTime: "22:00", endTime: "06:00" }), "2026-03-08T03:00:00.000Z")!; // 22:00 EST
  assert.equal(spring.occurrence.endAt, "2026-03-08T10:00:00.000Z"); // 06:00 EDT
  assert.equal(spring.clockOutAt, "2026-03-08T11:00:00.000Z"); // 07:00 EDT
  // Fall back 2026-11-01: 22:00 EDT -> 06:00 EST is 9 real hours.
  const fall = plan(ny({ startTime: "22:00", endTime: "06:00" }), "2026-11-01T02:00:00.000Z")!; // 22:00 EDT on Oct 31
  assert.equal(fall.occurrence.endAt, "2026-11-01T11:00:00.000Z"); // 06:00 EST
  // A shift ending at 02:30 on spring-forward night (that time does not exist) ends at 03:30 EDT.
  assert.equal(wallToUtc("2026-03-08T02:30", "America/New_York"), at("2026-03-08T07:30:00.000Z"));
  assert.equal(shiftOccurrence(ny({ startTime: "20:00", endTime: "02:30" }), at("2026-03-08T01:00:00.000Z")).endAt, "2026-03-08T07:30:00.000Z");
  // Repeated 01:30 on fall-back night: the first one (EDT).
  assert.equal(wallToUtc("2026-11-01T01:30", "America/New_York"), at("2026-11-01T05:30:00.000Z"));
});

test("status: within shift, grace, pending, beyond (off), automatic / manual clock-out, none", () => {
  const open = { clockInAt: "2026-11-23T09:00:00.000Z", lastChangeAt: "2026-11-23T09:00:00.000Z" };
  const s = (shift: ShiftSettings | null, now: string, o: typeof open | null = open, last: "MANUAL" | "AUTOMATIC_SHIFT_END" | null = null) =>
    shiftStatus({ shift, open: o, lastClockOutReason: last, now: at(now) }).status;
  assert.equal(s(null, "2026-11-23T12:00:00.000Z"), "NO_SHIFT");
  assert.equal(s(day(), "2026-11-23T17:59:59.000Z"), "WITHIN_SHIFT");
  assert.equal(s(day(), "2026-11-23T18:00:00.000Z"), "GRACE_PERIOD");
  assert.equal(s(day(), "2026-11-23T19:00:00.000Z"), "AUTO_CLOCK_OUT_PENDING");
  assert.equal(s(day({ autoClockOut: false }), "2026-11-23T18:30:00.000Z"), "BEYOND_SHIFT");
  assert.equal(s(day(), "2026-11-23T20:00:00.000Z", null, "AUTOMATIC_SHIFT_END"), "AUTO_CLOCKED_OUT");
  assert.equal(s(day(), "2026-11-23T20:00:00.000Z", null, "MANUAL"), "MANUAL_CLOCK_OUT");
  assert.equal(s(day(), "2026-11-23T20:00:00.000Z", null, null), "NOT_CLOCKED_IN");
  const next = shiftStatus({ shift: day(), open: null, lastClockOutReason: null, now: at("2026-11-23T20:00:00.000Z") });
  assert.equal(next.nextAutoClockOutAt, "2026-11-24T19:00:00.000Z", "next shift's deadline");
});

test("validation: 24-hour HH:MM, start ≠ end, grace 0–480, IANA zone; defaults 60 min and on", () => {
  assert.deepEqual(shiftInputSchema.parse({ startTime: "09:00", endTime: "18:00" }), { startTime: "09:00", endTime: "18:00", graceMinutes: 60, autoClockOut: true, workdays: "12345" });
  for (const bad of [
    { startTime: "9:00", endTime: "18:00" },
    { startTime: "09:00", endTime: "24:00" },
    { startTime: "09:00", endTime: "6 PM" },
    { startTime: "09:00", endTime: "09:00" },
    { startTime: "09:00", endTime: "18:00", graceMinutes: -1 },
    { startTime: "09:00", endTime: "18:00", graceMinutes: 481 },
    { startTime: "09:00", endTime: "18:00", graceMinutes: 1.5 },
    { startTime: "09:00", endTime: "18:00", timezone: "EST" },
    { startTime: "09:00" },
    { startTime: "09:00", endTime: "18:00", employeeId: "x" },
  ]) assert.equal(shiftInputSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(shiftInputSchema.safeParse({ startTime: "22:00", endTime: "06:00", graceMinutes: 0 }).success, true, "overnight, no grace");
  assert.equal(createEmployeeSchema.safeParse({ email: "a@b.co", fullName: "A", employeeCode: "AB", shift: { startTime: "09:00" } }).success, false);
  assert.equal(createEmployeeSchema.parse({ email: "a@b.co", fullName: "A", employeeCode: "AB" }).shift, undefined, "shift stays optional");
});

test("working days: Mon–Fri shift; Saturday work is never auto clocked out; Friday overnight ends Saturday and counts", () => {
  const wk = day({ workdays: "12345" });
  // 2026-11-27 is a Friday, 2026-11-28 a Saturday.
  assert.equal(plan(wk, "2026-11-27T09:00:00.000Z")!.clockOutAt, "2026-11-27T19:00:00.000Z");
  assert.equal(plan(wk, "2026-11-28T09:00:00.000Z"), null, "Saturday: off day");
  const night = day({ startTime: "22:00", endTime: "06:00", workdays: "5" });
  assert.equal(plan(night, "2026-11-27T22:00:00.000Z")!.clockOutAt, "2026-11-28T07:00:00.000Z", "Friday night into Saturday");
  assert.equal(plan(night, "2026-11-28T22:00:00.000Z"), null, "Saturday night: not a working day");
  assert.equal(nextWorkingOccurrence(wk, Date.parse("2026-11-27T20:00:00.000Z"))!.date, "2026-11-30", "after Friday's shift: Monday");
  const st = shiftStatus({ shift: wk, open: { clockInAt: "2026-11-28T09:00:00.000Z", lastChangeAt: "2026-11-28T09:00:00.000Z" }, lastClockOutReason: null, now: Date.parse("2026-11-28T22:00:00.000Z") });
  assert.deepEqual([st.status, st.nextAutoClockOutAt], ["OFF_DAY", null]);
  assert.equal(shiftInputSchema.parse({ startTime: "09:00", endTime: "18:00", workdays: "531" }).workdays, "135", "stored sorted");
  assert.equal(shiftInputSchema.parse({ startTime: "09:00", endTime: "18:00" }).workdays, "12345", "default Mon–Fri");
  assert.throws(() => shiftInputSchema.parse({ startTime: "09:00", endTime: "18:00", workdays: "11" }));
});

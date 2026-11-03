import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeaveSchema, decideLeaveSchema, leaveOverlaps, leaveWhen } from "../dist/index.js";

const ok = (v: object) => createLeaveSchema.safeParse(v).success;

test("leave schema: full days, halves and short leave; no identity or stray fields", () => {
  assert.ok(ok({ startDate: "2026-11-02", endDate: "2026-11-04", portion: "FULL_DAY" }));
  assert.ok(ok({ startDate: "2026-11-02", endDate: "2026-11-02", portion: "SECOND_HALF", reason: "School play" }));
  assert.ok(ok({ startDate: "2026-11-02", endDate: "2026-11-02", portion: "SHORT", startTime: "09:00", endTime: "10:30" }));
  assert.equal(createLeaveSchema.parse({ startDate: "2026-11-02", endDate: "2026-11-02", portion: "FULL_DAY", reason: "   " }).reason, undefined);
  for (const bad of [
    { startDate: "2026-11-04", endDate: "2026-11-02", portion: "FULL_DAY" },
    { startDate: "2026-11-02", endDate: "2026-11-03", portion: "FIRST_HALF" },
    { startDate: "2026-11-02", endDate: "2026-11-02", portion: "SHORT", startTime: "10:00" },
    { startDate: "2026-11-02", endDate: "2026-11-02", portion: "SHORT", startTime: "10:00", endTime: "09:59" },
    { startDate: "2026-11-02", endDate: "2026-11-02", portion: "SHORT", startTime: "7:00", endTime: "09:00" },
    { startDate: "2026-11-02", endDate: "2026-11-02", portion: "FIRST_HALF", startTime: "09:00", endTime: "10:00" },
    { startDate: "2026-11-02", endDate: "2026-11-02", portion: "SICK" },
    { startDate: "2026-11-02", endDate: "2026-11-02", portion: "FULL_DAY", employeeId: "x" },
    { startDate: "2026-01-01", endDate: "2027-01-02", portion: "FULL_DAY" },
  ]) assert.equal(ok(bad), false, JSON.stringify(bad));
  assert.ok(ok({ startDate: "2026-01-01", endDate: "2027-01-01", portion: "FULL_DAY" }), "366 dates");
  assert.deepEqual(decideLeaveSchema.parse({ note: " " }), { note: undefined });
  assert.equal(decideLeaveSchema.safeParse({ note: "ok", status: "APPROVED" }).success, false);
});

test("leave overlaps", () => {
  const full = (s: string, e = s) => ({ startDate: s, endDate: e, portion: "FULL_DAY" as const });
  const half = (d: string, p: "FIRST_HALF" | "SECOND_HALF") => ({ startDate: d, endDate: d, portion: p });
  const short = (d: string, startTime: string, endTime: string) => ({ startDate: d, endDate: d, portion: "SHORT" as const, startTime, endTime });
  assert.ok(leaveOverlaps(full("2026-11-02", "2026-11-04"), full("2026-11-04")));
  assert.ok(!leaveOverlaps(full("2026-11-02", "2026-11-04"), full("2026-11-05")));
  assert.ok(leaveOverlaps(full("2026-11-02", "2026-11-04"), half("2026-11-03", "FIRST_HALF")));
  assert.ok(!leaveOverlaps(half("2026-11-03", "FIRST_HALF"), half("2026-11-03", "SECOND_HALF")));
  assert.ok(leaveOverlaps(half("2026-11-03", "FIRST_HALF"), half("2026-11-03", "FIRST_HALF")));
  assert.ok(leaveOverlaps(half("2026-11-03", "SECOND_HALF"), short("2026-11-03", "08:00", "09:00")), "half-day hours are undefined");
  assert.ok(!leaveOverlaps(short("2026-11-03", "10:00", "11:00"), short("2026-11-03", "11:00", "12:00")));
  assert.ok(leaveOverlaps(short("2026-11-03", "10:00", "11:00"), short("2026-11-03", "10:59", "12:00")));
  assert.ok(!leaveOverlaps(short("2026-11-03", "10:00", "11:00"), short("2026-11-04", "10:00", "11:00")));
});

test("leave descriptions", () => {
  assert.equal(leaveWhen({ startDate: "2026-11-02", endDate: "2026-11-04", portion: "FULL_DAY" }), "Mon, 2 Nov 2026 – Wed, 4 Nov 2026, full days");
  assert.equal(leaveWhen({ startDate: "2026-11-02", endDate: "2026-11-02", portion: "FULL_DAY" }), "Mon, 2 Nov 2026, full day");
  assert.equal(leaveWhen({ startDate: "2026-11-02", endDate: "2026-11-02", portion: "FIRST_HALF" }), "Mon, 2 Nov 2026, first half");
  assert.equal(leaveWhen({ startDate: "2026-11-02", endDate: "2026-11-02", portion: "SHORT", startTime: "14:00", endTime: "15:30" }), "Mon, 2 Nov 2026, 14:00–15:30");
});

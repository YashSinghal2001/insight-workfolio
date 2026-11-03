import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applicationCategorySchema, categorizeApplication, dailyAttendanceStatus, effectiveIdleThreshold, employeeTrackingOverrideSchema, idleExcludedAppsSchema, isoWeekday,
  withScheduleOverride, workScheduleSchema,
} from "../dist/index.js";

const policy = { enabled: true, expectedStart: "09:30", graceMinutes: 10, workdays: "12345" };
// 2026-11-02 is a Monday. 09:30 in Asia/Kolkata = 04:00Z; due (plus grace) = 04:10Z.
const base = { date: "2026-11-02", timeZone: "Asia/Kolkata", policy, firstClockInAt: null, onLeave: false, now: Date.parse("2026-11-03T00:00:00Z") };

test("daily status: precedence, grace boundary, absence only with an enabled policy and once due", () => {
  assert.equal(isoWeekday("2026-11-02"), 1);
  assert.equal(isoWeekday("2026-11-08"), 7);
  assert.deepEqual(dailyAttendanceStatus({ ...base, policy: null }), { status: "NO_POLICY", scheduled: null, dueAt: null, lateMinutes: null });
  assert.equal(dailyAttendanceStatus({ ...base, policy: { ...policy, enabled: false } }).status, "NO_POLICY", "disabled never labels absence");
  assert.equal(dailyAttendanceStatus({ ...base, policy: null, onLeave: true }).status, "ON_LEAVE");
  assert.equal(dailyAttendanceStatus({ ...base, date: "2026-11-07" }).status, "NOT_SCHEDULED", "Saturday");
  assert.equal(dailyAttendanceStatus({ ...base, onLeave: true, firstClockInAt: "2026-11-02T06:00:00Z" }).status, "ON_LEAVE");
  assert.deepEqual(dailyAttendanceStatus({ ...base, firstClockInAt: "2026-11-02T04:10:00.000Z" }), { status: "PRESENT", scheduled: true, dueAt: "2026-11-02T04:10:00.000Z", lateMinutes: null });
  assert.deepEqual(dailyAttendanceStatus({ ...base, firstClockInAt: "2026-11-02T04:10:01.000Z" }), { status: "LATE", scheduled: true, dueAt: "2026-11-02T04:10:00.000Z", lateMinutes: 10 });
  assert.equal(dailyAttendanceStatus(base).status, "ABSENT");
  assert.equal(dailyAttendanceStatus({ ...base, now: Date.parse("2026-11-02T04:09:00Z") }).status, "NOT_YET_DUE");
  // Same instant, different zone: 09:30 UTC.
  assert.equal(dailyAttendanceStatus({ ...base, timeZone: "UTC", firstClockInAt: "2026-11-02T09:35:00Z" }).status, "PRESENT");
});

test("schedule input: HH:MM, grace 0-240, unique ISO weekdays (sorted), reason required", () => {
  const ok = { enabled: true, expectedStart: "09:00", graceMinutes: 0, workdays: "54321", reason: "pilot" };
  assert.equal(workScheduleSchema.parse(ok).workdays, "12345");
  for (const bad of [{ expectedStart: "9:00" }, { expectedStart: "24:00" }, { graceMinutes: 241 }, { workdays: "" }, { workdays: "118" }, { workdays: "11" }, { reason: "x" }, { extra: 1 }]) {
    assert.equal(workScheduleSchema.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  }
});

test("application labels: identifier before name, case-insensitive, otherwise Unclassified", () => {
  const rules = [
    { id: "n", matchKind: "NAME" as const, value: "safari", category: "UNPRODUCTIVE" as const },
    { id: "i", matchKind: "IDENTIFIER" as const, value: "com.apple.Safari", category: "PRODUCTIVE" as const },
  ];
  assert.deepEqual(categorizeApplication({ applicationIdentifier: "COM.APPLE.SAFARI", applicationName: "Safari" }, rules), { category: "PRODUCTIVE", ruleId: "i" });
  assert.deepEqual(categorizeApplication({ applicationIdentifier: null, applicationName: "Safari" }, rules), { category: "UNPRODUCTIVE", ruleId: "n" });
  assert.deepEqual(categorizeApplication({ applicationIdentifier: "x", applicationName: "Code" }, rules), { category: "UNCLASSIFIED", ruleId: null });
  assert.equal(applicationCategorySchema.safeParse({ matchKind: "NAME", value: "Code", category: "UNCLASSIFIED" }).success, false);
  assert.equal(applicationCategorySchema.parse({ matchKind: "NAME", value: "  Code ", category: "NEUTRAL" }).value, "Code");
});

test("per-person override: null fields inherit; an override start/workdays changes the late flag; idle never below two samples", () => {
  assert.deepEqual(withScheduleOverride(policy, null), policy);
  assert.deepEqual(withScheduleOverride(policy, { expectedStart: null, workdays: "67" }), { ...policy, workdays: "67" });
  const late = { date: "2026-11-02", timeZone: "Asia/Kolkata", firstClockInAt: "2026-11-02T05:00:00.000Z", onLeave: false, now: Date.parse("2026-11-03T00:00:00Z") };
  assert.equal(dailyAttendanceStatus({ ...late, policy }).status, "LATE");
  assert.equal(dailyAttendanceStatus({ ...late, policy: withScheduleOverride(policy, { expectedStart: "10:30", workdays: null }) }).status, "PRESENT", "10:30 IST = 05:00Z");
  assert.equal(dailyAttendanceStatus({ ...late, policy: withScheduleOverride(policy, { expectedStart: null, workdays: "67" }) }).status, "NOT_SCHEDULED");
  assert.equal(effectiveIdleThreshold({ idleThresholdSeconds: 300, sampleSeconds: 15 }, null), 300);
  assert.equal(effectiveIdleThreshold({ idleThresholdSeconds: 300, sampleSeconds: 15 }, 900), 900);
  assert.equal(effectiveIdleThreshold({ idleThresholdSeconds: 300, sampleSeconds: 60 }, 60), 120);
  assert.equal(employeeTrackingOverrideSchema.parse({ expectedStart: null, workdays: "531", idleThresholdSeconds: null, reason: "night shift" }).workdays, "135");
  for (const bad of [{ expectedStart: "9:00" }, { workdays: "11" }, { idleThresholdSeconds: 10 }, { reason: "x" }, { extra: 1 }]) {
    assert.equal(employeeTrackingOverrideSchema.safeParse({ expectedStart: null, workdays: null, idleThresholdSeconds: null, reason: "valid", ...bad }).success, false, JSON.stringify(bad));
  }
  assert.deepEqual(idleExcludedAppsSchema.parse([" us.zoom.xos ", "US.ZOOM.XOS", "Teams.exe"]), ["us.zoom.xos", "Teams.exe"]);
  assert.equal(idleExcludedAppsSchema.safeParse([""]).success, false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createReportScheduleSchema, periodEnd, renderReport, reportPeriod } from "../dist/index.js";

test("report periods: last complete day, week and month in the schedule's zone", () => {
  // 2026-11-02T20:00Z is Mon 2 Nov in UTC but already Tue 3 Nov in Kolkata (01:30).
  const t = Date.parse("2026-11-02T20:00:00Z");
  assert.deepEqual(reportPeriod("DAILY", t, "UTC"), { from: "2026-11-01", to: "2026-11-01" });
  assert.deepEqual(reportPeriod("DAILY", t, "Asia/Kolkata"), { from: "2026-11-02", to: "2026-11-02" });
  assert.deepEqual(reportPeriod("WEEKLY", t, "UTC"), { from: "2026-10-26", to: "2026-11-01" }, "Monday weeks");
  assert.deepEqual(reportPeriod("WEEKLY", t, "UTC", 7), { from: "2026-10-25", to: "2026-10-31" }, "Sunday weeks");
  assert.deepEqual(reportPeriod("MONTHLY", t, "UTC"), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(reportPeriod("MONTHLY", Date.parse("2026-03-01T00:30:00Z"), "UTC"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(reportPeriod("MONTHLY", Date.parse("2026-02-28T23:30:00Z"), "Asia/Kolkata"), { from: "2026-02-01", to: "2026-02-28" }, "already 1 March in Kolkata");
  assert.deepEqual(reportPeriod("MONTHLY", Date.parse("2027-01-01T05:00:00Z"), "America/Los_Angeles"), { from: "2026-11-01", to: "2026-11-30" }, "still 31 Dec in Los Angeles");
  assert.equal(periodEnd({ to: "2026-11-01" }, "Asia/Kolkata"), "2026-11-01T18:30:00.000Z");
});

test("schedule input: frequency, real time zone, no free-form recipients", () => {
  assert.ok(createReportScheduleSchema.safeParse({ name: "W", frequency: "WEEKLY", timeZone: "Asia/Kolkata" }).success);
  for (const bad of [{ frequency: "HOURLY" }, { timeZone: "Nowhere/City" }, { recipients: ["x@example.com"] }]) {
    assert.equal(createReportScheduleSchema.safeParse({ name: "W", frequency: "WEEKLY", timeZone: "UTC", ...bad }).success, false, JSON.stringify(bad));
  }
});

test("an empty report says so instead of showing nothing", () => {
  const { subject, text } = renderReport({ name: "Daily", frequency: "DAILY", timeZone: "UTC", period: { from: "2026-11-01", to: "2026-11-01" }, generatedAt: "2026-11-02T00:05:00.000Z", employees: [], projects: [], runningTimers: 0 });
  assert.equal(subject, "[Workfolio] Daily: 2026-11-01");
  assert.match(text, /ATTENDANCE \(completed shifts\)\n- none/);
  assert.match(text, /- no task time recorded/);
  assert.match(text, /No employees are included in this report\./);
});

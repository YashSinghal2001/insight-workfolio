import assert from "node:assert/strict";
import { test } from "node:test";
import { createReportScheduleSchema, duePeriod, periodEnd, renderReport, reportDueAt, reportPeriod, updateReportScheduleSchema } from "../dist/index.js";

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
  const { subject, text } = renderReport({ name: "Daily", frequency: "DAILY", timeZone: "UTC", period: { from: "2026-11-01", to: "2026-11-01" }, generatedAt: "2026-11-02T00:05:00.000Z", employees: [], projects: [], runningTimers: 0, kind: "WORKED_HOURS", scope: "Organisation", exceptions: null });
  assert.equal(subject, "[Workfolio] Daily: 2026-11-01");
  assert.match(text, /ATTENDANCE \(completed shifts\)\n- none/);
  assert.match(text, /- no task time recorded/);
  assert.match(text, /No employees are included in this report\./);
});

test("due time: send time on the local day after the period; DST and month ends", () => {
  assert.equal(reportDueAt({ to: "2026-11-01" }, "Asia/Kolkata", "09:00"), "2026-11-02T03:30:00.000Z", "daily, IST");
  assert.equal(reportDueAt({ to: "2026-11-01" }, "UTC", null), periodEnd({ to: "2026-11-01" }, "UTC"), "null = period end");
  // New York: DST starts Sun 8 Mar 2026 (02:00 -> 03:00), ends Sun 1 Nov 2026 (02:00 -> 01:00).
  assert.equal(reportDueAt({ to: "2026-03-07" }, "America/New_York", "08:00"), "2026-03-08T12:00:00.000Z", "EDT after the jump");
  assert.equal(reportDueAt({ to: "2026-03-07" }, "America/New_York", "02:30"), "2026-03-08T06:30:00.000Z", "skipped 02:30: zonedToUtc gives 01:30 EST, still that local day, once");
  assert.equal(reportDueAt({ to: "2026-10-31" }, "America/New_York", "01:30"), "2026-11-01T05:30:00.000Z", "repeated 01:30: first occurrence (EDT)");
  assert.equal(reportDueAt({ to: "2026-10-31" }, "America/New_York", "08:00"), "2026-11-01T13:00:00.000Z", "EST after fall back");
  assert.equal(reportDueAt({ to: "2028-02-29" }, "UTC", "06:00"), "2028-03-01T06:00:00.000Z", "leap-year month end -> the 1st");
  assert.equal(reportDueAt({ to: "2026-12-31" }, "Asia/Kolkata", "00:00"), "2026-12-31T18:30:00.000Z", "year end");
});

test("due period: last period once due, else the one before (no skipped late send times)", () => {
  const at = (iso: string) => Date.parse(iso);
  assert.deepEqual(duePeriod("DAILY", at("2026-11-02T08:59:00Z"), "UTC", "09:00"), { from: "2026-10-31", to: "2026-10-31" }, "before 09:00: yesterday's not due yet");
  assert.deepEqual(duePeriod("DAILY", at("2026-11-02T09:00:00Z"), "UTC", "09:00"), { from: "2026-11-01", to: "2026-11-01" });
  assert.deepEqual(duePeriod("DAILY", at("2026-11-03T00:02:00Z"), "UTC", "23:59"), { from: "2026-11-01", to: "2026-11-01" }, "23:59 caught after midnight");
  assert.deepEqual(duePeriod("WEEKLY", at("2026-11-02T05:00:00Z"), "UTC", "06:00"), { from: "2026-10-19", to: "2026-10-25" });
  assert.deepEqual(duePeriod("WEEKLY", at("2026-11-02T06:00:00Z"), "UTC", "06:00"), { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(duePeriod("MONTHLY", at("2026-03-01T08:00:00Z"), "UTC", "09:00"), { from: "2026-01-01", to: "2026-01-31" });
  assert.deepEqual(duePeriod("MONTHLY", at("2026-03-01T09:00:00Z"), "UTC", "09:00"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(duePeriod("DAILY", at("2026-03-08T12:00:00Z"), "America/New_York", "08:00"), { from: "2026-03-07", to: "2026-03-07" }, "08:00 EDT on DST day");
  assert.deepEqual(duePeriod("DAILY", at("2026-03-08T11:59:00Z"), "America/New_York", "08:00"), { from: "2026-03-06", to: "2026-03-06" });
  assert.deepEqual(duePeriod("DAILY", at("2026-11-02T00:00:00Z"), "UTC", null), reportPeriod("DAILY", at("2026-11-02T00:00:00Z"), "UTC"), "no send time: unchanged");
});

test("schedule input: kinds, HH:MM send time, team or employee (not both)", () => {
  const base = { name: "W", frequency: "DAILY", timeZone: "UTC" };
  const ok = createReportScheduleSchema.parse(base);
  assert.deepEqual([ok.kind, ok.sendAtLocalTime], ["WORKED_HOURS", null]);
  assert.ok(createReportScheduleSchema.safeParse({ ...base, kind: "LATE", sendAtLocalTime: "23:59", teamId: crypto.randomUUID() }).success);
  for (const bad of [{ kind: "IDLE" }, { sendAtLocalTime: "24:00" }, { sendAtLocalTime: "9:00" }, { sendAtLocalTime: "09:60" }, { employeeId: crypto.randomUUID(), teamId: crypto.randomUUID() }]) {
    assert.equal(createReportScheduleSchema.safeParse({ ...base, ...bad }).success, false, JSON.stringify(bad));
  }
  assert.ok(updateReportScheduleSchema.safeParse({ teamId: null, employeeId: crypto.randomUUID() }).success);
  assert.equal(updateReportScheduleSchema.safeParse({ teamId: crypto.randomUUID(), employeeId: crypto.randomUUID() }).success, false);
});

test("late / absent rendering; names cannot add headers or lines", () => {
  const employee = { id: "e", fullName: "Pat\r\nBcc: x <script>", employeeCode: "E1", timezone: "UTC" };
  const d = { name: "Late\nBcc: evil@example.org", frequency: "DAILY", timeZone: "UTC", period: { from: "2026-11-01", to: "2026-11-01" }, generatedAt: "2026-11-02T00:05:00.000Z", employees: [], projects: null, runningTimers: null, kind: "LATE", scope: "Team Ops", exceptions: { people: 1, noPolicyDays: ["2026-11-01"], items: [{ employee, date: "2026-11-01", firstClockInLocal: "2026-11-01T09:42", lateMinutes: 42 }] } } as const;
  const { subject, text } = renderReport(d);
  assert.equal(subject, "[Workfolio] Late Bcc: evil@example.org: 2026-11-01");
  assert.ok(!/[\r\n]/.test(subject));
  assert.match(text, /^- 2026-11-01 Pat Bcc: x <script> \(E1\): clocked in 09:42, 42 min after the expected start$/m);
  assert.ok(!/^Bcc/m.test(text), "no forged line");
  assert.match(text, /Scope: Team Ops\./);
  assert.match(text, /No enabled work schedule on 2026-11-01/);
  const absent = renderReport({ ...d, kind: "ABSENT", exceptions: { people: 0, noPolicyDays: [], items: [] } }).text;
  assert.match(absent, /ABSENT \(no clock-in on a scheduled workday\)\n- none/);
  assert.match(absent, /No employees are included/);
  assert.ok(!absent.includes("ATTENDANCE"));
});

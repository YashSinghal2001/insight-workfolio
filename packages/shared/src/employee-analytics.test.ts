import assert from "node:assert/strict";
import { test } from "node:test";
import { analyticsRange, buildEmployeeAnalytics, employeeAnalyticsQuerySchema, medianLocalTime } from "../dist/index.js";

const ny = { id: "e1", fullName: "Nia York", employeeCode: "NY-1", timezone: "America/New_York" };
const none = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
const s = (id: string, clockInAt: string, clockOutAt: string | null, breaks: [string, string | null][] = [], extra = {}) => ({
  id, clockInAt, clockOutAt, breaks: breaks.map(([startedAt, endedAt]) => ({ startedAt, endedAt })), ...extra,
});

test("query: both dates or neither, from ≤ to, at most 92 days", () => {
  assert.ok(employeeAnalyticsQuerySchema.safeParse({}).success);
  assert.ok(employeeAnalyticsQuerySchema.safeParse({ from: "2026-01-01", to: "2026-04-02" }).success); // 92 days
  assert.ok(!employeeAnalyticsQuerySchema.safeParse({ from: "2026-01-01", to: "2026-04-03" }).success); // 93
  assert.ok(!employeeAnalyticsQuerySchema.safeParse({ from: "2026-01-02", to: "2026-01-01" }).success);
  assert.ok(!employeeAnalyticsQuerySchema.safeParse({ from: "2026-01-01" }).success);
  assert.ok(!employeeAnalyticsQuerySchema.safeParse({ from: "nope", to: "2026-01-01" }).success);
});

test("default range: the last 14 local days in the employee's zone", () => {
  // 03:00 UTC on 10 Mar is still 9 Mar in New York (EDT, UTC-4) and already 10 Mar in Kolkata.
  const now = Date.parse("2026-03-10T03:00:00Z");
  assert.deepEqual(analyticsRange({}, "America/New_York", now), { from: "2026-02-24", to: "2026-03-09" });
  assert.deepEqual(analyticsRange({}, "Asia/Kolkata", now), { from: "2026-02-25", to: "2026-03-10" });
  assert.deepEqual(analyticsRange({ from: "2026-01-01", to: "2026-01-02" }, "UTC", now), { from: "2026-01-01", to: "2026-01-02" });
});

test("median of local times (lower middle on an even count)", () => {
  assert.equal(medianLocalTime([]), null);
  assert.equal(medianLocalTime(["09:30", "08:00", "10:15"]), "09:30");
  assert.equal(medianLocalTime(["09:00", "10:00"]), "09:00");
});

test("empty range: zero-filled days, no log, nulls where there is no data", () => {
  const r = buildEmployeeAnalytics({ employee: ny, from: "2026-03-01", to: "2026-03-03", sessions: [], activity: null, corrections: none, leave: null, now: Date.parse("2026-03-04T00:00:00Z") });
  assert.deepEqual(r.days.map((d) => [d.date, d.workedMinutes, d.activeMinutes]), [["2026-03-01", 0, null], ["2026-03-02", 0, null], ["2026-03-03", 0, null]]);
  assert.deepEqual(r.clockLog, []);
  assert.equal(r.topApps, null);
  assert.deepEqual(r.kpis, { workedMinutes: 0, daysWorked: 0, activeMinutes: null, idleMinutes: null, idleShare: null, productiveShare: null, typicalFirstInLocal: null, typicalLastOutLocal: null });
});

test("DST week in New York: local times stay wall-clock, durations are real elapsed time", () => {
  // 7 Mar (EST, UTC-5) 09:00–17:00 with a 30 min break; 9 Mar (EDT, UTC-4) 09:30–18:00; 10 Mar still open.
  const sessions = [
    s("a", "2026-03-07T14:00:00.000Z", "2026-03-07T22:00:00.000Z", [["2026-03-07T17:00:00.000Z", "2026-03-07T17:30:00.000Z"]], { clockInSource: "ONLINE" }),
    s("b", "2026-03-09T13:30:00.000Z", "2026-03-09T22:00:00.000Z", [], { clockInSource: "CORRECTION", corrected: true }),
    s("c", "2026-03-10T13:00:00.000Z", null, [], { clockInSource: "OFFLINE_SYNC" }),
    s("x", "2026-03-11T13:00:00.000Z", "2026-03-11T14:00:00.000Z"), // outside the range
  ];
  const activity = {
    days: [{ date: "2026-03-07", activeMs: 6 * 3_600_000, idleMs: 2 * 3_600_000 }],
    applications: [
      { applicationName: "Mail", activeMs: 3_600_000, category: "NEUTRAL" as const },
      { applicationName: "Code", activeMs: 5 * 3_600_000, category: "PRODUCTIVE" as const },
    ],
    productiveShare: 0.5,
    categoriesConfigured: true,
  };
  const r = buildEmployeeAnalytics({ employee: ny, from: "2026-03-07", to: "2026-03-10", sessions, activity, corrections: { ...none, PENDING: 2 }, leave: null, now: Date.parse("2026-03-10T15:00:00Z") });
  assert.deepEqual(r.days.map((d) => [d.date, d.workedMinutes, d.breakMinutes]), [["2026-03-07", 450, 30], ["2026-03-08", 0, 0], ["2026-03-09", 510, 0], ["2026-03-10", 0, 0]]);
  assert.equal(r.kpis.workedMinutes, 960);
  assert.equal(r.kpis.daysWorked, 3);
  assert.equal(r.kpis.typicalFirstInLocal, "09:00"); // 09:00, 09:30, 09:00 → median 09:00
  assert.equal(r.kpis.typicalLastOutLocal, "17:00"); // 17:00, 18:00 → lower middle
  assert.equal(r.kpis.idleShare, 0.25);
  assert.equal(r.kpis.productiveShare, 0.5);
  assert.deepEqual(r.clockLog.map((e) => [e.date, e.startLocal, e.endLocal, e.workedMinutes, e.source, e.corrected, e.open]), [
    ["2026-03-10", "09:00", null, 120, "OFFLINE_SYNC", false, true],
    ["2026-03-09", "09:30", "18:00", 510, "CORRECTION", true, false],
    ["2026-03-07", "09:00", "17:00", 450, "ONLINE", false, false],
  ]);
  assert.deepEqual(r.topApps!.map((a) => a.applicationName), ["Code", "Mail"]);
  assert.equal(r.corrections.PENDING, 2);
});

test("productive share is null when no app labels are configured", () => {
  const activity = { days: [], applications: [], productiveShare: 0, categoriesConfigured: false };
  const r = buildEmployeeAnalytics({ employee: ny, from: "2026-03-07", to: "2026-03-07", sessions: [], activity, corrections: none, leave: null });
  assert.equal(r.kpis.productiveShare, null);
  assert.equal(r.kpis.idleShare, null);
  assert.equal(r.kpis.activeMinutes, 0);
  assert.deepEqual(r.topApps, []);
});

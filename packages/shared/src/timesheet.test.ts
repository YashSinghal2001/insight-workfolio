import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimesheet, createCorrectionSchema, dateRangeSchema, localDate, toZonedLocal, weekStart, zonedToUtc } from "../dist/index.js";

const H = 3_600_000;
const M = 60_000;
const s = (id: string, clockInAt: string, clockOutAt: string | null, breaks: [string, string | null][] = [], extra = {}) => ({
  id, clockInAt, clockOutAt, breaks: breaks.map(([startedAt, endedAt]) => ({ startedAt, endedAt })), ...extra,
});

test("zonedToUtc converts wall time in a zone, including across DST", () => {
  assert.equal(zonedToUtc("2026-10-12T09:30", "Asia/Kolkata"), "2026-10-12T04:00:00.000Z");
  assert.equal(zonedToUtc("2026-03-07T09:00", "America/New_York"), "2026-03-07T14:00:00.000Z"); // EST
  assert.equal(zonedToUtc("2026-03-09T09:00", "America/New_York"), "2026-03-09T13:00:00.000Z"); // EDT
  assert.equal(zonedToUtc("2026-11-01T01:30", "America/New_York"), "2026-11-01T05:30:00.000Z"); // repeated hour: first
  assert.equal(localDate("2026-10-12T20:00:00Z", "Asia/Kolkata"), "2026-10-13");
  for (const [local, tz] of [["2026-10-12T23:45", "Asia/Kolkata"], ["2026-03-08T03:30", "America/New_York"], ["2026-01-01T00:00", "UTC"]]) {
    assert.equal(toZonedLocal(zonedToUtc(local!, tz!), tz!), local, `round trip ${local} ${tz}`);
  }
});

test("weeks start on the configured day (Monday default, Sunday optional)", () => {
  assert.equal(weekStart("2026-10-14"), "2026-10-12"); // Wed -> Mon
  assert.equal(weekStart("2026-10-18"), "2026-10-12"); // Sun -> Mon
  assert.equal(weekStart("2026-10-18", 7), "2026-10-18"); // Sun-start week
  assert.equal(weekStart("2026-10-14", 7), "2026-10-11");
});

test("multiple shifts in a day: first in, last out, summed totals and overtime vs 8 h", () => {
  const t = buildTimesheet(
    [
      s("a", "2026-10-12T03:30:00Z", "2026-10-12T08:30:00Z", [["2026-10-12T06:30:00Z", "2026-10-12T07:00:00Z"]]), // 09:00-14:00 IST
      s("b", "2026-10-12T09:30:00Z", "2026-10-12T14:30:00Z"), // 15:00-20:00 IST
    ],
    { from: "2026-10-12", to: "2026-10-18", timeZone: "Asia/Kolkata" },
  );
  const d = t.days[0]!;
  assert.deepEqual([d.date, d.shifts, d.firstClockIn, d.lastClockOut], ["2026-10-12", 2, "2026-10-12T03:30:00Z", "2026-10-12T14:30:00Z"]);
  assert.deepEqual([d.grossMs, d.breakMs, d.netMs, d.overtimeMs], [10 * H, 30 * M, 9.5 * H, 1.5 * H]);
  assert.equal(t.weeks[0]!.weekStart, "2026-10-12");
  assert.equal(t.totals.overtimeMs, 1.5 * H);
});

test("midnight-crossing shift belongs to its clock-in date", () => {
  const t = buildTimesheet([s("n", "2026-10-12T16:30:00Z", "2026-10-13T00:30:00Z")], { from: "2026-10-12", to: "2026-10-13", timeZone: "Asia/Kolkata" });
  assert.deepEqual(t.days.map((d) => [d.date, d.netMs]), [["2026-10-12", 8 * H]]);
  // Clock-in on the 13th (local) is outside a range ending on the 12th.
  assert.equal(buildTimesheet([s("x", "2026-10-12T19:00:00Z", null)], { from: "2026-10-12", to: "2026-10-12", timeZone: "Asia/Kolkata" }).days.length, 0);
});

test("DST: spring-forward night shift is 1 h shorter on the wall clock than in reality", () => {
  // New York 2026-03-07 22:00 EST -> 2026-03-08 07:00 EDT: 9 h on the wall, 8 h worked.
  const t = buildTimesheet([s("d", zonedToUtc("2026-03-07T22:00", "America/New_York"), zonedToUtc("2026-03-08T07:00", "America/New_York"))], {
    from: "2026-03-01", to: "2026-03-31", timeZone: "America/New_York",
  });
  assert.deepEqual([t.days[0]!.date, t.days[0]!.netMs, t.days[0]!.overtimeMs], ["2026-03-07", 8 * H, 0]);
});

test("incomplete shifts are flagged and excluded from finalized totals", () => {
  const now = Date.parse("2026-10-13T08:00:00Z");
  const t = buildTimesheet(
    [s("done", "2026-10-12T03:30:00Z", "2026-10-12T11:30:00Z"), s("open", "2026-10-13T03:30:00Z", null, [["2026-10-13T06:00:00Z", null]])],
    { from: "2026-10-12", to: "2026-10-13", timeZone: "Asia/Kolkata", now },
  );
  const open = t.days.find((d) => d.date === "2026-10-13")!;
  assert.deepEqual([open.incomplete, open.netMs, open.overtimeMs, open.lastClockOut], [true, 0, 0, null]);
  assert.equal(open.inProgressNetMs, 2.5 * H, "live figure is informational");
  assert.deepEqual([t.totals.netMs, t.totals.incompleteDays], [8 * H, 1]);
});

test("weekly totals split at the week boundary; custom scheduled hours; corrected/offline flags", () => {
  const t = buildTimesheet(
    [
      s("sun", "2026-10-18T03:30:00Z", "2026-10-18T09:30:00Z", [], { corrected: true }),
      s("mon", "2026-10-19T03:30:00Z", "2026-10-19T10:30:00Z", [], { clockInSource: "OFFLINE_SYNC" }),
    ],
    { from: "2026-10-12", to: "2026-10-25", timeZone: "Asia/Kolkata", policy: { weekStartsOn: 1, scheduledDailyMinutes: 360, maxOfflineAgeDays: 7 } },
  );
  assert.deepEqual(t.weeks.map((w) => [w.weekStart, w.netMs, w.overtimeMs]), [["2026-10-12", 6 * H, 0], ["2026-10-19", 7 * H, H]]);
  assert.deepEqual(t.days.map((d) => [d.corrected, d.offlineShifts]), [[true, 0], [false, 1]]);
});

test("range and correction request validation", () => {
  assert.equal(dateRangeSchema.safeParse({ from: "2026-10-12", to: "2026-10-11" }).success, false);
  assert.equal(dateRangeSchema.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success, false, "max 92 days");
  assert.equal(dateRangeSchema.safeParse({ from: "2026-10-01", to: "2026-10-31" }).success, true);
  const ok = createCorrectionSchema.safeParse({ type: "MISSING_CLOCK_IN", clockInAt: "2026-10-12T09:00:00+05:30", clockOutAt: "2026-10-12T17:00:00+05:30", reason: "Forgot the app" });
  assert.equal(ok.success && ok.data.type === "MISSING_CLOCK_IN" && ok.data.clockInAt, "2026-10-12T03:30:00.000Z", "normalized to UTC");
  const bad = (v: object) => createCorrectionSchema.safeParse(v).success;
  assert.equal(bad({ type: "MISSING_CLOCK_IN", clockInAt: "2026-10-12T17:00:00Z", clockOutAt: "2026-10-12T09:00:00Z", reason: "oops" }), false);
  assert.equal(bad({ type: "ATTENDANCE_TIME", sessionId: "6f1c1b2a-3d4e-4f50-8a6b-7c8d9e0f1a2b", reason: "nothing" }), false);
  assert.equal(bad({ type: "MISSING_CLOCK_OUT", sessionId: "6f1c1b2a-3d4e-4f50-8a6b-7c8d9e0f1a2b", clockOutAt: "2026-10-12T17:00:00Z", reason: "" }), false);
  assert.equal(bad({ type: "DELETE_SHIFT", reason: "please" }), false);
});

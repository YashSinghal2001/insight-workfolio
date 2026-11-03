import assert from "node:assert/strict";
import { test } from "node:test";
import { activityOverviewQuerySchema, leaveSummaryMeQuerySchema, leaveSummaryQuerySchema, leaveTallyLabel, tallyLeave } from "../dist/index.js";

const r = (startDate: string, endDate: string, portion: string, status: string, startTime: string | null = null, endTime: string | null = null) =>
  ({ startDate, endDate, portion, status, startTime, endTime }) as Parameters<typeof tallyLeave>[0][number];

test("tallyLeave: calendar days clipped to the range, halves 0.5, short in minutes, per status", () => {
  const t = tallyLeave(
    [
      r("2026-10-30", "2026-11-03", "FULL_DAY", "APPROVED"), // 3 dates inside Nov 1–30 (weekend included)
      r("2026-11-10", "2026-11-10", "FIRST_HALF", "APPROVED"),
      r("2026-11-11", "2026-11-11", "SHORT", "APPROVED", "09:00", "10:30"),
      r("2026-11-20", "2026-11-21", "FULL_DAY", "PENDING"),
      r("2026-11-05", "2026-11-05", "SECOND_HALF", "REJECTED"),
      r("2026-11-06", "2026-11-06", "FULL_DAY", "CANCELLED"),
      r("2026-12-01", "2026-12-02", "FULL_DAY", "APPROVED"), // outside: ignored
    ],
    "2026-11-01",
    "2026-11-30",
  );
  assert.deepEqual(t.APPROVED, { requests: 3, fullDays: 3, halfDays: 1, shortRequests: 1, shortMinutes: 90, days: 3.5 });
  assert.deepEqual(t.PENDING, { requests: 1, fullDays: 2, halfDays: 0, shortRequests: 0, shortMinutes: 0, days: 2 });
  assert.equal(t.REJECTED.days, 0.5);
  assert.equal(t.CANCELLED.days, 1);
  assert.equal(leaveTallyLabel(t.APPROVED), "3.5 days + 1 short (90 min)");
  assert.equal(leaveTallyLabel(t.CANCELLED), "1 day");
  assert.equal(leaveTallyLabel(tallyLeave([], "2026-11-01", "2026-11-30").APPROVED), "—");
  assert.equal(leaveTallyLabel(tallyLeave([r("2026-11-11", "2026-11-11", "SHORT", "PENDING", "14:00", "14:30")], "2026-11-01", "2026-11-30").PENDING), "1 short (30 min)");
});

test("leave summary queries: ≤ 366 days, from ≤ to; /me takes no employeeId", () => {
  assert.equal(leaveSummaryQuerySchema.safeParse({ from: "2026-01-01", to: "2027-01-01" }).success, true); // 366 dates
  assert.equal(leaveSummaryQuerySchema.safeParse({ from: "2026-01-01", to: "2027-01-02" }).success, false);
  assert.equal(leaveSummaryQuerySchema.safeParse({ from: "2026-02-01", to: "2026-01-01" }).success, false);
  assert.equal(leaveSummaryQuerySchema.safeParse({ from: "2026-01-01", to: "2026-01-31", pageSize: "101" }).success, false);
  assert.equal(leaveSummaryMeQuerySchema.safeParse({ from: "2026-01-01", to: "2026-01-31" }).success, true);
  assert.equal(leaveSummaryMeQuerySchema.safeParse({ from: "2026-01-01", to: "2026-01-31", employeeId: "6f1c1b2a-3d4e-4f50-8a6b-7c8d9e0f1a2b" }).success, false);
});

test("activity overview query: ≤ 31 days", () => {
  assert.equal(activityOverviewQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-31" }).success, true);
  assert.equal(activityOverviewQuerySchema.safeParse({ from: "2026-10-01", to: "2026-11-01" }).success, false);
});

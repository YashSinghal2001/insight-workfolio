import assert from "node:assert/strict";
import { test } from "node:test";
import { lessHours, RISK_LESS_HOURS_SHARE, riskRules, riskUsersQuerySchema, sortRiskUsers } from "../dist/index.js";

const day = (status: string, workedMinutes: number, date = "2026-03-02") => ({ date, status, workedMinutes }) as Parameters<typeof lessHours>[0][number];

const T = "2026-03-10";
test("lessHours: today and later never count (an unfinished day)", () => {
  assert.equal(lessHours([day("PRESENT", 480), day("PRESENT", 60, T), day("ABSENT", 0, "2026-03-11")], 480, T), null);
  assert.equal(lessHours([day("PRESENT", 60, T)], 480, T), null);
});

test("lessHours: only PRESENT / LATE / ABSENT days count; 7 h of 8 h threshold; boundary is not a trigger", () => {
  assert.equal(RISK_LESS_HOURS_SHARE, 0.875);
  assert.equal(lessHours([], 480, T), null, "nothing scheduled");
  assert.equal(lessHours([day("HOLIDAY", 0), day("ON_LEAVE", 0), day("NOT_SCHEDULED", 0), day("OPEN", 10), day("NOT_YET_DUE", 0), day("NO_POLICY", 0)], 480, T), null);
  assert.equal(lessHours([day("PRESENT", 420)], 480, T), null, "exactly 7 h");
  assert.deepEqual(lessHours([day("PRESENT", 419)], 480, T), { scheduledDays: 1, shortDays: 1, averageWorkedMinutes: 419, thresholdMinutes: 420 });
  assert.deepEqual(lessHours([day("PRESENT", 480), day("LATE", 480), day("ABSENT", 0), day("HOLIDAY", 0)], 480, T), { scheduledDays: 3, shortDays: 1, averageWorkedMinutes: 320, thresholdMinutes: 420 });
  assert.equal(lessHours([day("ABSENT", 0)], 0, T), null, "no scheduled minutes");
});

test("sortRiskUsers / riskRules: distinct triggers, then total, then name; per-trigger totals", () => {
  const u = (name: string, triggers: [string, number][]) => ({
    employee: { id: name, fullName: name, employeeCode: name, timezone: "UTC" },
    triggers: triggers.map(([trigger, count]) => ({ trigger, count })),
    total: triggers.reduce((n, [, c]) => n + c, 0, T),
    lessHours: null,
  }) as Parameters<typeof sortRiskUsers>[0][number];
  const sorted = sortRiskUsers([u("Zed", [["LATE_CLOCK_IN", 1]]), u("Amy", [["LATE_CLOCK_IN", 1]]), u("Bob", [["LATE_CLOCK_IN", 5]]), u("Cat", [["LESS_WORKING_HOURS", 1], ["LATE_CLOCK_IN", 1]])]);
  assert.deepEqual(sorted.map((x) => x.employee.fullName), ["Cat", "Bob", "Amy", "Zed"]);
  const rules = riskRules(sorted);
  assert.deepEqual(rules.find((r) => r.trigger === "LATE_CLOCK_IN"), { trigger: "LATE_CLOCK_IN", employees: 4, count: 8 });
  assert.equal(rules.length, 5);
  assert.equal(rules[0]!.trigger, "LESS_WORKING_HOURS");
});

test("riskUsersQuerySchema: ≤ 92 days, from ≤ to, uuid team", () => {
  assert.ok(riskUsersQuerySchema.safeParse({ from: "2026-01-01", to: "2026-04-02" }).success, "92 days");
  assert.ok(!riskUsersQuerySchema.safeParse({ from: "2026-01-01", to: "2026-04-03" }).success, "93 days");
  assert.ok(!riskUsersQuerySchema.safeParse({ from: "2026-01-02", to: "2026-01-01" }).success);
  assert.ok(!riskUsersQuerySchema.safeParse({ from: "2026-01-01", to: "2026-01-02", teamId: "x" }).success);
});

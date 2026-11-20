import assert from "node:assert/strict";
import { test } from "node:test";
import { overviewQuerySchema, WORKLOAD_THRESHOLDS, workloadBucket, workloadDays } from "../dist/index.js";

test("workloadBucket: boundaries at 80 % and 110 % of the scheduled day", () => {
  assert.deepEqual(WORKLOAD_THRESHOLDS, { overworkedAbove: 1.1, lessUtilisedBelow: 0.8 });
  assert.equal(workloadBucket(0, 480), null, "no work: not counted");
  assert.equal(workloadBucket(-5, 480), null);
  assert.equal(workloadBucket(Number.NaN, 480), null);
  assert.equal(workloadBucket(60, 0), null, "no scheduled day: not counted");
  assert.equal(workloadBucket(383, 480), "LESS_UTILISED");
  assert.equal(workloadBucket(384, 480), "HEALTHY", "exactly 80 % is healthy");
  assert.equal(workloadBucket(528, 480), "HEALTHY", "exactly 110 % is healthy");
  assert.equal(workloadBucket(529, 480), "OVERWORKED");
});

test("workloadDays: members per bucket per date; days without work are skipped", () => {
  const a = new Map([["2026-11-01", 600], ["2026-11-02", 480]]);
  const b = new Map([["2026-11-01", 100]]);
  const c = new Map<string, number>();
  assert.deepEqual(workloadDays(["2026-11-01", "2026-11-02", "2026-11-03"], [a, b, c], 480), [
    { date: "2026-11-01", overworked: 1, healthy: 0, lessUtilised: 1 },
    { date: "2026-11-02", overworked: 0, healthy: 1, lessUtilised: 0 },
    { date: "2026-11-03", overworked: 0, healthy: 0, lessUtilised: 0 },
  ]);
  assert.deepEqual(workloadDays([], [a], 480), []);
});

test("overviewQuerySchema: optional date and team, validated", () => {
  assert.deepEqual(overviewQuerySchema.parse({}), {});
  assert.equal(overviewQuerySchema.safeParse({ date: "2026-02-30" }).success, false);
  assert.equal(overviewQuerySchema.safeParse({ teamId: "nope" }).success, false);
});

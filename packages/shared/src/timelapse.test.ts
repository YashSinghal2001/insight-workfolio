import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { TIMELAPSE_LIMITS, timelapseContentQuerySchema, timelapseCreateSchema, timelapseDurationSeconds, timelapseSessionsSchema } from "../dist/index.js";

test("timelapse duration is frames / fps", () => {
  assert.equal(timelapseDurationSeconds(3, 2), 1.5);
  assert.equal(timelapseDurationSeconds(600, 8), 75);
  assert.equal(timelapseDurationSeconds(TIMELAPSE_LIMITS.maxFrames, TIMELAPSE_LIMITS.fps.min), 2000);
  assert.equal(timelapseDurationSeconds(10, 3), 3.33);
});

test("timelapse requests: session only (no employee id), bounded fps, strict", () => {
  const sessionId = randomUUID();
  assert.deepEqual(timelapseCreateSchema.parse({ sessionId }), { sessionId, fps: 8, confirm: false });
  for (const bad of [{}, { sessionId: "x" }, { sessionId, fps: 0 }, { sessionId, fps: 31 }, { sessionId, fps: 1.5 }, { sessionId, employeeId: randomUUID() }]) {
    assert.ok(!timelapseCreateSchema.safeParse(bad).success, JSON.stringify(bad));
  }
  assert.ok(!timelapseSessionsSchema.safeParse({ from: "2026-10-01", to: "2026-10-02" }).success, "employee required");
  assert.ok(timelapseSessionsSchema.safeParse({ employeeId: randomUUID(), from: "2026-10-01", to: "2026-10-02" }).success);
  assert.equal(timelapseContentQuerySchema.parse({ download: "true" }).download, true);
  assert.equal(timelapseContentQuerySchema.parse({}).download, false);
  assert.ok(!timelapseContentQuerySchema.safeParse({ download: "yes" }).success);
});

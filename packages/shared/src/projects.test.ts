import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceEnd, createProjectSchema, startTimerSchema, totalMs, updateProjectSchema, updateTaskSchema } from "../dist/index.js";

test("project schemas: normalized codes, no stray fields, explicit changes", () => {
  assert.deepEqual(createProjectSchema.parse({ code: " apollo-1 ", name: " Apollo " }), { code: "APOLLO-1", name: "Apollo", description: null });
  assert.equal(createProjectSchema.safeParse({ code: "A", name: "x" }).success, false);
  assert.equal(createProjectSchema.safeParse({ code: "AB", name: "x", owner: "me" }).success, false);
  assert.equal(updateProjectSchema.safeParse({}).success, false);
  assert.deepEqual(updateProjectSchema.parse({ description: "" }), { description: null }, "clear");
  assert.deepEqual(updateProjectSchema.parse({ name: "B" }), { name: "B" }, "absent description untouched");
  assert.equal(updateTaskSchema.safeParse({ status: "DONE" }).success, false);
  assert.equal(startTimerSchema.safeParse({ taskId: "6f1c3e5a-1b2c-4d3e-8f90-123456789abc", employeeId: "x" }).success, false);
});

test("attendance ends a timer at the first break or the clock-out, never before it started", () => {
  const t = "2026-11-02T10:00:00.000Z";
  assert.equal(attendanceEnd(t, { clockOutAt: null, breaks: [] }), null);
  assert.equal(attendanceEnd(t, { clockOutAt: null, breaks: [{ startedAt: "2026-11-02T09:00:00.000Z", endedAt: "2026-11-02T09:30:00.000Z" }] }), null, "an earlier, finished break");
  assert.deepEqual(attendanceEnd(t, { clockOutAt: null, breaks: [{ startedAt: "2026-11-02T12:00:00.000Z", endedAt: null }, { startedAt: "2026-11-02T11:00:00.000Z", endedAt: "2026-11-02T11:15:00.000Z" }] }), { at: "2026-11-02T11:00:00.000Z", reason: "BREAK" });
  assert.deepEqual(attendanceEnd(t, { clockOutAt: "2026-11-02T10:30:00.000Z", breaks: [{ startedAt: "2026-11-02T11:00:00.000Z", endedAt: null }] }), { at: "2026-11-02T10:30:00.000Z", reason: "CLOCK_OUT" });
  assert.deepEqual(attendanceEnd(t, { clockOutAt: null, breaks: [{ startedAt: "2026-11-02T09:50:00.000Z", endedAt: "2026-11-02T10:20:00.000Z" }] }), { at: t, reason: "BREAK" }, "a break covering the start: zero time");
  assert.deepEqual(attendanceEnd(t, { clockOutAt: "2026-11-02T09:00:00.000Z", breaks: [] }), { at: t, reason: "CLOCK_OUT" }, "a clock-out corrected to before the start: zero time");
  assert.equal(totalMs([{ durationMs: 1000 }, { durationMs: null }, { durationMs: 500 }]), 1500, "running entries count as nothing");
});

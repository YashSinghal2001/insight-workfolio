// F11: the Tasks tab's wording for attendance and history lines (the server decides the rules).
import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceNote, entryLine } from "../src/tasks.ts";

const entry = (over: object = {}) => ({
  id: "e1",
  employee: { id: "p1", fullName: "Ana", employeeCode: "A-1", timezone: "UTC" },
  project: { id: "j1", code: "APOLLO", name: "Apollo" },
  task: { id: "t1", title: "Design" },
  startedAt: "2026-11-02T09:00:00.000Z",
  endedAt: "2026-11-02T10:30:00.000Z",
  endReason: "STOPPED" as const,
  durationMs: 90 * 60_000,
  ...over,
});
const hhmm = (iso: string) => iso.slice(11, 16);

test("timer card: attendance requirements in plain words", () => {
  assert.match(attendanceNote({ clockedIn: false, onBreak: false })!, /Clock in/);
  assert.match(attendanceNote({ clockedIn: true, onBreak: true })!, /on a break/);
  assert.equal(attendanceNote({ clockedIn: true, onBreak: false }), null);
});

test("history lines: span, duration and why the entry ended", () => {
  assert.equal(entryLine(entry(), hhmm), "APOLLO · Design — 09:00–10:30 (1h 30m, stopped)");
  assert.equal(entryLine(entry({ endReason: "BREAK" }), hhmm), "APOLLO · Design — 09:00–10:30 (1h 30m, ended by your break)");
  assert.equal(entryLine(entry({ endedAt: null, endReason: null, durationMs: null }), hhmm), "APOLLO · Design — 09:00–now (running)");
});

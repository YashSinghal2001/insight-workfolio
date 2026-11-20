import assert from "node:assert/strict";
import { test } from "node:test";
import { ANOMALY_THRESHOLDS, createCorrectionSchema, detectAnomalies, missingClockOutsQuerySchema, workdayEnd } from "../dist/index.js";

const H = 3_600_000;
const M = 60_000;
const at = (s: string) => Date.parse(s);
const IST = "Asia/Kolkata";
const NY = "America/New_York";
// 2026-11-19 09:00 IST = 03:30Z; with a 09:00 schedule the workday ends 17:00 IST (11:30Z), flagged after 19:00 IST (13:30Z).
const clockIn = "2026-11-19T03:30:00.000Z";
const base = { clockInAt: clockIn, clockOutAt: null, timeZone: IST, expectedStart: "09:00", lastDeviceSeenAt: null as string | null, openBreakSince: null as string | null };
const seen = (ms: number) => new Date(ms).toISOString();

test("thresholds are the contract defaults", () => {
  assert.deepEqual(ANOMALY_THRESHOLDS, { workdayMinutes: 480, workdayGraceMinutes: 120, maxShiftMinutes: 840, staleDeviceMinutes: 30, longBreakMinutes: 120 });
});

test("healthy open shift and closed shifts have no reasons", () => {
  const now = at(clockIn) + 2 * H;
  assert.deepEqual(detectAnomalies({ ...base, lastDeviceSeenAt: seen(now - 5 * M) }, now), []);
  // A closed shift is ignored whatever its age.
  assert.deepEqual(detectAnomalies({ ...base, clockOutAt: seen(at(clockIn) + 30 * H) }, at(clockIn) + 40 * H), []);
});

test("DEVICE_STALE alone, strict boundary, clock-in counts as contact, not during a break", () => {
  const now = at(clockIn) + 2 * H;
  assert.deepEqual(detectAnomalies({ ...base, lastDeviceSeenAt: seen(now - 30 * M) }, now), []);
  assert.deepEqual(detectAnomalies({ ...base, lastDeviceSeenAt: seen(now - 30 * M - 1) }, now), ["DEVICE_STALE"]);
  // Never seen: measured from the clock-in.
  assert.deepEqual(detectAnomalies(base, at(clockIn) + 30 * M), []);
  assert.deepEqual(detectAnomalies(base, at(clockIn) + 31 * M), ["DEVICE_STALE"]);
  // On a (short) break: a closed laptop is normal.
  assert.deepEqual(detectAnomalies({ ...base, openBreakSince: seen(now - 45 * M) }, now), []);
});

test("LONG_BREAK alone, strict boundary", () => {
  const now = at(clockIn) + 5 * H;
  assert.deepEqual(detectAnomalies({ ...base, openBreakSince: seen(now - 2 * H) }, now), []);
  assert.deepEqual(detectAnomalies({ ...base, openBreakSince: seen(now - 2 * H - 1) }, now), ["LONG_BREAK"]);
});

test("WORKDAY_ENDED alone with a schedule: expected start + 8 h + 2 h grace", () => {
  assert.equal(workdayEnd(base), at("2026-11-19T11:30:00Z"));
  const fresh = (now: number) => ({ ...base, lastDeviceSeenAt: seen(now - M) });
  const now = at("2026-11-19T13:30:00Z");
  assert.deepEqual(detectAnomalies(fresh(now), now), []);
  assert.deepEqual(detectAnomalies(fresh(now + 1), now + 1), ["WORKDAY_ENDED"]);
});

test("without a schedule (or an evening shift past the scheduled end) the day ends at the next local midnight", () => {
  assert.equal(workdayEnd({ ...base, expectedStart: null }), at("2026-11-19T18:30:00Z"));
  // Clock-in 18:00 IST, after the 17:00 scheduled end: not flagged at once, falls back to the local midnight.
  const evening = { ...base, clockInAt: "2026-11-19T12:30:00.000Z" };
  assert.equal(workdayEnd(evening), at("2026-11-19T18:30:00Z"));
  assert.deepEqual(detectAnomalies({ ...evening, lastDeviceSeenAt: seen(at("2026-11-19T13:00:00Z")) }, at("2026-11-19T13:01:00Z")), []);
});

test("MAX_SHIFT_EXCEEDED alone: 14 h of real time", () => {
  // 00:30 IST clock-in, no schedule: workday flagged after 02:00 IST next day; 14 h reached at 14:30 IST the same day.
  const early = { ...base, clockInAt: "2026-11-18T19:00:00.000Z", expectedStart: null };
  const now = at("2026-11-19T09:00:00Z");
  assert.deepEqual(detectAnomalies({ ...early, lastDeviceSeenAt: seen(now) }, now), []);
  assert.deepEqual(detectAnomalies({ ...early, lastDeviceSeenAt: seen(now) }, now + 1), ["MAX_SHIFT_EXCEEDED"]);
});

test("PREVIOUS_DAY alone: a shift crossing local midnight (IST)", () => {
  // 23:00 IST clock-in; at 00:30 IST it is the previous local day, workday end (00:00 + 2 h) not reached yet.
  const late = { ...base, clockInAt: "2026-11-19T17:30:00.000Z", expectedStart: null };
  const now = at("2026-11-19T19:00:00Z");
  assert.deepEqual(detectAnomalies({ ...late, lastDeviceSeenAt: seen(now) }, now), ["PREVIOUS_DAY"]);
  assert.deepEqual(detectAnomalies({ ...late, lastDeviceSeenAt: seen(now) }, at("2026-11-19T18:29:00Z")), [], "still the same local day");
  assert.deepEqual(detectAnomalies({ ...late, lastDeviceSeenAt: "2026-11-19T20:30:00.000Z" }, at("2026-11-19T20:30:01Z")), ["PREVIOUS_DAY", "WORKDAY_ENDED"]);
});

test("combinations: the three production cases", () => {
  // 1. Clocked in 16:18 IST, last device contact 17:06, now 23:17 (schedule 09:00).
  assert.deepEqual(
    detectAnomalies({ ...base, clockInAt: "2026-11-19T10:48:00.000Z", lastDeviceSeenAt: "2026-11-19T11:36:00.000Z" }, at("2026-11-19T17:47:00Z")),
    ["WORKDAY_ENDED", "DEVICE_STALE"],
  );
  // 2. A shift open 26 h overnight.
  assert.deepEqual(
    detectAnomalies({ ...base, lastDeviceSeenAt: seen(at(clockIn) + 8 * H) }, at(clockIn) + 26 * H),
    ["PREVIOUS_DAY", "WORKDAY_ENDED", "MAX_SHIFT_EXCEEDED", "DEVICE_STALE"],
  );
  // 3. A break left open most of the day (same day, 13:00 to 21:30 IST).
  assert.deepEqual(
    detectAnomalies({ ...base, openBreakSince: "2026-11-19T07:30:00.000Z", lastDeviceSeenAt: "2026-11-19T07:30:00.000Z" }, at("2026-11-19T16:00:00Z")),
    ["WORKDAY_ENDED", "LONG_BREAK"],
  );
});

test("DST: America/New_York spring forward (2026-03-08) and fall back (2026-11-01)", () => {
  // 14:00 EDT = 18:00Z on the transition day; the local day ends at 00:00 EDT = 04:00Z (a 23 h day; 24 h from
  // local midnight would wrongly give 05:00Z). A 09:00 schedule = 13:00Z, so the workday ends 21:00Z.
  const spring = { ...base, clockInAt: "2026-03-08T18:00:00.000Z", timeZone: NY, expectedStart: null };
  assert.equal(workdayEnd(spring), at("2026-03-09T04:00:00Z"));
  assert.equal(workdayEnd({ ...spring, expectedStart: "09:00" }), at("2026-03-08T21:00:00Z"));
  const quiet = { ...spring, lastDeviceSeenAt: "2026-03-09T06:00:00.000Z" };
  assert.deepEqual(detectAnomalies(quiet, at("2026-03-09T06:00:00Z")), ["PREVIOUS_DAY"]);
  assert.deepEqual(detectAnomalies(quiet, at("2026-03-09T06:00:00Z") + 1), ["PREVIOUS_DAY", "WORKDAY_ENDED"]);
  // Fall back: 25 h local day, ends 00:00 EST = 05:00Z.
  assert.equal(workdayEnd({ ...spring, clockInAt: "2026-11-01T14:00:00.000Z" }), at("2026-11-02T05:00:00Z"));
  // 14 h of real time across the jump (20:00 EST → 11:00 EDT is 15 h on the wall clock).
  const night = { ...spring, clockInAt: "2026-03-08T01:00:00.000Z", lastDeviceSeenAt: "2026-03-08T15:00:00.000Z" };
  assert.ok(!detectAnomalies(night, at("2026-03-08T15:00:00Z")).includes("MAX_SHIFT_EXCEEDED"));
  assert.ok(detectAnomalies(night, at("2026-03-08T15:00:00Z") + 1).includes("MAX_SHIFT_EXCEEDED"));
});

test("query and correction schemas: team / employee ids must be uuids", () => {
  assert.equal(missingClockOutsQuerySchema.safeParse({}).success, true);
  assert.equal(missingClockOutsQuerySchema.safeParse({ teamId: "nope" }).success, false);
  const req = { type: "MISSING_CLOCK_OUT", sessionId: "6f1c1a52-6a43-4b8e-9d0e-2f7a3f0e1b11", clockOutAt: "2026-11-19T12:00:00Z", reason: "Forgot" };
  assert.equal(createCorrectionSchema.safeParse(req).success, true);
  assert.equal(createCorrectionSchema.safeParse({ ...req, employeeId: "6f1c1a52-6a43-4b8e-9d0e-2f7a3f0e1b12" }).success, true);
  assert.equal(createCorrectionSchema.safeParse({ ...req, employeeId: "x" }).success, false);
});

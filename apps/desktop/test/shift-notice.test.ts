import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttendanceCurrent } from "@workfolio/shared";
import { shiftNotice } from "../src/shift-notice.ts";

const cur = (over: Partial<AttendanceCurrent> = {}) =>
  ({ state: "CLOCKED_IN", session: null, serverTime: "", missingClockOut: false, shiftEndAt: "2026-11-23T13:00:00.000Z", autoClockOutAt: "2026-11-23T14:00:00.000Z", ...over }) as AttendanceCurrent;
const at = (iso: string) => Date.parse(iso);

test("before the shift end, in the grace period (minutes left), then due", () => {
  assert.equal(shiftNotice(cur(), "CLOCKED_IN", at("2026-11-23T12:00:00.000Z"))!.phase, "before");
  const g = shiftNotice(cur(), "ON_BREAK", at("2026-11-23T13:20:30.000Z"))!;
  assert.deepEqual([g.phase, g.minutesLeft], ["grace", 40]);
  assert.equal(shiftNotice(cur(), "CLOCKED_IN", at("2026-11-23T14:00:00.000Z"))!.phase, "due");
});

test("nothing without a plan (no shift, auto clock-out off, day off) or once clocked out locally", () => {
  assert.equal(shiftNotice(cur({ autoClockOutAt: null, shiftEndAt: null }), "CLOCKED_IN", 0), null);
  assert.equal(shiftNotice(cur(), "CLOCKED_OUT", at("2026-11-23T13:30:00.000Z")), null);
  assert.equal(shiftNotice(null, "CLOCKED_IN", 0), null);
  assert.equal(shiftNotice(cur({ autoClockOutAt: undefined }), "CLOCKED_IN", 0), null, "older API without the field");
});

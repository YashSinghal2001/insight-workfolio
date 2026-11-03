// F10: the Leave tab checks the form with the server's own schema before sending.
import assert from "node:assert/strict";
import { test } from "node:test";
import { leaveFormError } from "../src/leave.ts";

test("leave form: same rules as the server, with plain messages", () => {
  assert.equal(leaveFormError({ portion: "FULL_DAY", startDate: "2026-11-02", endDate: "2026-11-04" }), null);
  assert.equal(leaveFormError({ portion: "FIRST_HALF", startDate: "2026-11-02", endDate: "2026-11-02" }), null);
  assert.equal(leaveFormError({ portion: "SHORT", startDate: "2026-11-02", endDate: "2026-11-02", startTime: "14:00", endTime: "15:00" }), null);
  assert.equal(leaveFormError({ portion: "FULL_DAY", startDate: "", endDate: "" }), "Choose the date(s).");
  assert.equal(leaveFormError({ portion: "FULL_DAY", startDate: "2026-11-02", endDate: "" }), "Choose the date(s).");
  assert.match(leaveFormError({ portion: "FULL_DAY", startDate: "2026-11-04", endDate: "2026-11-02" })!, /end date must not be before/);
  assert.match(leaveFormError({ portion: "SHORT", startDate: "2026-11-02", endDate: "2026-11-02", startTime: "", endTime: "" })!, /24-hour time|start and an end time/);
  assert.match(leaveFormError({ portion: "SHORT", startDate: "2026-11-02", endDate: "2026-11-02", startTime: "15:00", endTime: "14:00" })!, /after the start time/);
});

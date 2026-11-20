import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AttendanceSession } from "@workfolio/shared";
import { setText } from "../src/platform.ts";
import { staleClockInSince } from "../src/sync.ts";

const open = (clockInAt: string, clockOutAt: string | null = null) => ({
  state: clockOutAt ? ("CLOCKED_OUT" as const) : ("CLOCKED_IN" as const),
  session: { id: "s", clockInAt, clockOutAt, status: clockOutAt ? "CLOSED" : "OPEN", breaks: [], corrected: false, clockInSource: "ONLINE" } as AttendanceSession,
});
const at = (iso: string) => Date.parse(iso);

test("still clocked in: an earlier local date in the employee's zone (IST), not the device's or UTC's", () => {
  const s = open("2026-11-19T18:00:00.000Z"); // 23:30 IST on the 19th
  assert.equal(staleClockInSince(s, "Asia/Kolkata", at("2026-11-19T19:00:00.000Z")), s.session.clockInAt, "00:30 IST on the 20th");
  assert.equal(staleClockInSince(s, "UTC", at("2026-11-19T19:00:00.000Z")), null, "same date in UTC, 1 h open");
  assert.equal(staleClockInSince(s, "Asia/Kolkata", at("2026-11-19T18:29:00.000Z")), null, "23:59 IST, same date");
});

test("still clocked in: open more than 14 h on the same local date (America/New_York), boundary exclusive", () => {
  const s = open("2026-11-20T13:00:00.000Z"); // 08:00 EST
  const tz = "America/New_York";
  assert.equal(staleClockInSince(s, tz, at("2026-11-21T03:00:00.000Z")), null, "exactly 14 h (22:00 local)");
  assert.equal(staleClockInSince(s, tz, at("2026-11-21T03:00:01.000Z")), s.session.clockInAt, "14 h + 1 s");
  assert.equal(staleClockInSince(s, tz, at("2026-11-20T21:00:00.000Z")), null, "an ordinary 8 h shift");
});

test("still clocked in: DST days count real elapsed time, not wall-clock time", () => {
  const tz = "America/New_York";
  // Spring forward 2026-03-08: 01:30 EST -> 16:15 EDT is 14 h 45 on the wall clock but 13 h 45 elapsed.
  assert.equal(staleClockInSince(open("2026-03-08T06:30:00.000Z"), tz, at("2026-03-08T20:15:00.000Z")), null);
  // Fall back 2026-11-01: 01:30 EDT -> 14:45 EST is 13 h 15 on the wall clock but 14 h 15 elapsed.
  const fall = open("2026-11-01T05:30:00.000Z");
  assert.equal(staleClockInSince(fall, tz, at("2026-11-01T19:45:00.000Z")), fall.session.clockInAt);
});

test("not flagged: clocked out, a closed session, no session; on a break is still flagged", () => {
  const now = at("2026-11-20T12:00:00.000Z");
  assert.equal(staleClockInSince(open("2026-11-18T09:00:00.000Z", "2026-11-18T17:00:00.000Z"), "UTC", now), null);
  assert.equal(staleClockInSince({ state: "CLOCKED_IN", session: open("2026-11-18T09:00:00.000Z", "2026-11-18T17:00:00.000Z").session }, "UTC", now), null);
  assert.equal(staleClockInSince({ state: "CLOCKED_OUT", session: open("2026-11-18T09:00:00.000Z").session }, "UTC", now), null, "clock-out queued offline");
  assert.equal(staleClockInSince({ state: "CLOCKED_IN", session: null }, "UTC", now), null);
  const brk = { ...open("2026-11-19T09:00:00.000Z"), state: "ON_BREAK" as const };
  assert.equal(staleClockInSince(brk, "UTC", now), brk.session.clockInAt);
});

test("the banner exists in the window and nothing is clocked out or corrected automatically", () => {
  assert.match(readFileSync(new URL("../index.html", import.meta.url), "utf8"), /id="att-stale" class="notice" role="status" hidden/);
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.ok(main.includes("setText($(\"#att-stale\"), `You are still clocked in since ${formatTime(staleSince)}. Clock out, then request a correction of the real end time."));
});

test("live regions are rewritten only when their text changes (render runs every second)", () => {
  let writes = 0;
  let value: string | null = "";
  const el = { get textContent() { return value; }, set textContent(v) { writes++; value = v; } };
  assert.equal(setText(el, "A"), true);
  assert.equal(setText(el, "A"), false);
  assert.equal(setText(el, "A"), false);
  assert.equal(setText(el, "B"), true);
  assert.equal(writes, 2);
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.ok(main.includes('setText($("#device-blocked-text"), blocked ?? "")'));
  assert.ok(!/\$\("#att-stale"\)\.textContent =/.test(main), "the stale notice is never rewritten directly");
});

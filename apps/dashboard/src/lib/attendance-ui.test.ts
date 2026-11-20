import { test } from "node:test";
import assert from "node:assert/strict";
import { ANOMALY_THRESHOLDS, MISSING_CLOCK_OUT_REASONS, type MonthlyAttendanceDay } from "@workfolio/shared";
import { ago, DAY_CODE, dayTitle, eventSourceLabel, lastSeenLabel, parseAttendanceTab, reasonText } from "./attendance-ui";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const minsAgo = (min: number) => new Date(NOW - min * 60_000).toISOString();

test("tab: ?tab= wins, legacy ?view= still read, unknown falls back to live", () => {
  assert.equal(parseAttendanceTab(new URLSearchParams("tab=monthly")), "monthly");
  assert.equal(parseAttendanceTab(new URLSearchParams("view=daily")), "daily");
  assert.equal(parseAttendanceTab(new URLSearchParams("tab=missing&view=daily")), "missing");
  assert.equal(parseAttendanceTab(new URLSearchParams("tab=nope")), "live");
  assert.equal(parseAttendanceTab(new URLSearchParams("")), "live");
});

test("monthly codes cover every status with the agreed letters", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(DAY_CODE).map(([k, v]) => [k, v.code])),
    { PRESENT: "P", LATE: "L", ABSENT: "A", ON_LEAVE: "LV", HOLIDAY: "H", NOT_SCHEDULED: "WO", OPEN: "OPEN", NO_POLICY: "", NOT_YET_DUE: "" },
  );
});

test("day title: In–Out, worked and late; blank day stays short", () => {
  const day: MonthlyAttendanceDay = { date: "2026-11-03", status: "LATE", firstInLocal: "09:20", lastOutLocal: "17:35", workedMinutes: 485, breakMinutes: 30, overtimeMinutes: 0, lateMinutes: 20, dueLocal: "09:10" };
  assert.equal(dayTitle(day), "2026-11-03 · Late · In 09:20 – Out 17:35 · worked 8h 05m · late by 20 min");
  assert.equal(dayTitle({ ...day, status: "OPEN", lastOutLocal: null, workedMinutes: 0, lateMinutes: null }), "2026-11-03 · Shift still open · In 09:20 – Out —");
  assert.equal(dayTitle({ ...day, status: "NOT_SCHEDULED", firstInLocal: null, lastOutLocal: null, workedMinutes: 0, lateMinutes: null }), "2026-11-03 · Weekly off");
});

test("every missing clock-out reason has a label and an explanation using the thresholds", () => {
  for (const r of MISSING_CLOCK_OUT_REASONS) {
    const t = reasonText(r, ANOMALY_THRESHOLDS);
    assert.ok(t.label && t.explain, r);
  }
  assert.match(reasonText("MAX_SHIFT_EXCEEDED", ANOMALY_THRESHOLDS).explain, /14 h/);
  assert.match(reasonText("DEVICE_STALE", ANOMALY_THRESHOLDS).explain, /30 min/);
  assert.match(reasonText("LONG_BREAK", { ...ANOMALY_THRESHOLDS, longBreakMinutes: 90 }).explain, /1h 30m/);
});

test("ago boundaries", () => {
  const M = 60_000;
  assert.equal(ago(0), "just now");
  assert.equal(ago(-5 * M), "just now"); // device clock ahead
  assert.equal(ago(59 * M), "59 m ago");
  assert.equal(ago(60 * M), "1 h ago");
  assert.equal(ago((23 * 60 + 59) * M), "23 h 59 m ago");
  assert.equal(ago(24 * 60 * M), "1 d ago");
  assert.equal(ago(26 * 60 * 3 * M), "3 d ago");
});

test("regression: an online *event* never makes a stale device look online", () => {
  // Production: last event sent online at 17:06, device silent for 6 h → must not read "Online".
  assert.equal(lastSeenLabel(false, minsAgo(6 * 60), NOW), "Last seen 6 h ago");
  assert.equal(lastSeenLabel(true, minsAgo(1), NOW), "Online");
  assert.equal(lastSeenLabel(false, null, NOW), "Never seen");
  assert.equal(eventSourceLabel("ONLINE"), "Sent online");
  assert.equal(eventSourceLabel("OFFLINE_SYNC"), "Synced later");
});

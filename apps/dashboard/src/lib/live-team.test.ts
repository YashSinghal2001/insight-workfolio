// Run: pnpm --filter @workfolio/dashboard test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttendanceSession } from "@workfolio/shared";
import { ago } from "./attendance-ui.ts";
import { countByChip, describeMember, matches, NO_EXTRAS, type MemberRow } from "./live-team.ts";

// 2026-11-20 15:00 IST (09:30Z).
const NOW = Date.parse("2026-11-20T09:30:00Z");
const TZ = "Asia/Kolkata";
const min = (n: number) => new Date(NOW - n * 60_000).toISOString();

/** Timesheet total read for a date: closed shifts clocked in that day. */
const ts = (netMs = 0, date = "2026-11-20") => ({ ...NO_EXTRAS, closed: { date, netMs } });
const session = (p: Partial<AttendanceSession>): AttendanceSession => ({
  id: "s1", clockInAt: "2026-11-20T03:42:00Z", clockOutAt: null, status: "OPEN", breaks: [], corrected: false, clockInSource: "ONLINE", ...p,
});
const row = (p: Partial<MemberRow> = {}): MemberRow => ({
  employeeId: "e1", fullName: "Asha Rao", employeeCode: "EMP-1", timezone: TZ, state: "CLOCKED_IN", session: null, lastEvent: null,
  deviceLastSeenAt: min(1), lastSeenAt: min(1), online: true, liveStatus: "ACTIVE", liveSince: null, missingClockOut: false, screenshotState: "DISABLED", ...p,
});

test("working: open session, device fresh", () => {
  const c = describeMember(row({ session: session({}) }), ts(), NOW);
  assert.equal(c.state, "WORKING");
  assert.equal(c.statusLine, "Working since 09:12");
  assert.equal(c.presence, "Online");
  assert.equal(c.clockIn, "09:12");
  assert.equal(c.workedMs, (5 * 60 + 48) * 60_000);
  assert.equal(c.scheduledMs, 8 * 3_600_000);
});

test("on break: open break wins, even with a stale device", () => {
  const s = session({ breaks: [{ startedAt: "2026-11-20T07:30:00Z", endedAt: null } as AttendanceSession["breaks"][number]] });
  const c = describeMember(row({ session: s, lastSeenAt: min(90), online: false }), ts(), NOW);
  assert.equal(c.state, "ON_BREAK");
  assert.equal(c.statusLine, "On break since 13:00");
  assert.equal(c.presence, "Last seen 1 h 30 m ago");
  assert.equal(c.workedMs, (3 * 60 + 48) * 60_000);
});

test("stale device while clocked in is Offline, never Working; fresh-but-not-online is still Working", () => {
  assert.equal(describeMember(row({ session: session({}), lastSeenAt: min(31), online: false }), NO_EXTRAS, NOW).state, "OFFLINE");
  const c = describeMember(row({ session: session({}), lastSeenAt: min(10), online: false }), NO_EXTRAS, NOW);
  assert.equal(c.state, "WORKING");
  assert.equal(c.presence, "Last seen 10 m ago");
});

test("open session from yesterday: flagged, only today's part counted", () => {
  const s = session({ clockInAt: "2026-11-19T04:00:00Z" });
  const stale = describeMember(row({ session: s, missingClockOut: true, lastSeenAt: min(6 * 60), online: false }), ts(), NOW);
  assert.equal(stale.state, "OFFLINE");
  assert.equal(stale.presence, "Last seen 6 h ago");
  assert.equal(stale.missingClockOut, true);
  // Local midnight 2026-11-20 IST = 2026-11-19T18:30Z → 15 h today.
  assert.equal(stale.workedMs, 15 * 3_600_000);
  assert.equal(describeMember(row({ session: s, missingClockOut: true }), NO_EXTRAS, NOW).state, "WORKING");
});

test("stopped today", () => {
  const c = describeMember(row({ state: "CLOCKED_OUT", session: session({ clockOutAt: min(224), status: "CLOSED" }), online: false, lastSeenAt: min(200) }), NO_EXTRAS, NOW);
  assert.equal(c.state, "STOPPED");
  assert.equal(c.statusLine, "Stopped 3 h 44 m ago");
  assert.equal(c.clockIn, "09:12");
});

test("not started: no session, or last session closed on an earlier day", () => {
  assert.equal(describeMember(row({ state: "CLOCKED_OUT" }), NO_EXTRAS, NOW).state, "NOT_STARTED");
  const c = describeMember(row({ state: "CLOCKED_OUT", session: session({ clockInAt: "2026-11-19T03:00:00Z", clockOutAt: "2026-11-19T12:00:00Z", status: "CLOSED" }) }), ts(), NOW);
  assert.equal(c.state, "NOT_STARTED");
  assert.equal(c.statusLine, "Not started yet today");
  assert.equal(c.workedMs, 0);
  assert.equal(c.clockIn, null);
});

test("on leave beats not started and no device; working on a leave day stays Working", () => {
  const leave = { ...NO_EXTRAS, onLeave: true };
  assert.equal(describeMember(row({ state: "CLOCKED_OUT" }), leave, NOW).state, "ON_LEAVE");
  assert.equal(describeMember(row({ state: "CLOCKED_OUT", lastSeenAt: null, online: false }), leave, NOW).state, "ON_LEAVE");
  assert.equal(describeMember(row({ session: session({}) }), leave, NOW).state, "WORKING");
});

test("no device: App not installed, never seen", () => {
  const c = describeMember(row({ state: "CLOCKED_OUT", lastSeenAt: null, deviceLastSeenAt: null, online: false }), NO_EXTRAS, NOW);
  assert.equal(c.state, "APP_NOT_INSTALLED");
  assert.equal(c.presence, "Never seen");
  // A session without a device (revoked mid-shift) is Offline, not Working.
  assert.equal(describeMember(row({ session: session({}), lastSeenAt: null, online: false }), NO_EXTRAS, NOW).state, "OFFLINE");
});

test("two-session day: closed morning shift (timesheet total) + open afternoon shift", () => {
  // Morning 09:00–12:30 IST closed (3 h 30 m net, from /attendance/timesheets); open again since 13:30 IST (08:00Z).
  const c = describeMember(row({ session: session({ clockInAt: "2026-11-20T08:00:00Z" }) }), ts(3.5 * 3_600_000), NOW);
  assert.equal(c.statusLine, "Working since 13:30");
  assert.equal(c.workedMs, 5 * 3_600_000);
  // Both shifts closed: the latest one is already in the total, not added twice.
  const stopped = describeMember(row({ state: "CLOCKED_OUT", session: session({ clockInAt: "2026-11-20T08:00:00Z", clockOutAt: "2026-11-20T09:00:00Z", status: "CLOSED" }) }), ts(4.5 * 3_600_000), NOW);
  assert.equal(stopped.state, "STOPPED");
  assert.equal(stopped.workedMs, 4.5 * 3_600_000);
});

test("worked today is unknown without a timesheet total for the employee's today", () => {
  assert.equal(describeMember(row({ session: session({}) }), NO_EXTRAS, NOW).workedMs, null);
  // Read for the viewer's date, but it is already the 21st for this employee.
  const tokyoNext = Date.parse("2026-11-20T16:00:00Z");
  assert.equal(describeMember(row({ timezone: "Asia/Tokyo" }), ts(), tokyoNext).workedMs, null);
});

test("non-workday has no scheduled bar; active share passes through", () => {
  const c = describeMember(row(), { ...NO_EXTRAS, scheduled: false, activeShare: 0.82 }, NOW);
  assert.equal(c.scheduledMs, null);
  assert.equal(c.activeShare, 0.82);
});

test("America/New_York across the DST change uses the local day", () => {
  // 2026-11-01 02:00 EDT → 01:00 EST. Clocked in 00:30 EDT (04:30Z), now 09:00 EST (14:00Z).
  const now = Date.parse("2026-11-01T14:00:00Z");
  const c = describeMember(row({ timezone: "America/New_York", session: session({ clockInAt: "2026-11-01T04:30:00Z" }), lastSeenAt: new Date(now).toISOString() }), ts(0, "2026-11-01"), now);
  assert.equal(c.statusLine, "Working since 00:30");
  assert.equal(c.workedMs, 9.5 * 3_600_000);
});

test("ago", () => {
  assert.equal(ago(20_000), "just now");
  assert.equal(ago(12 * 60_000), "12 m ago");
  assert.equal(ago(26 * 3_600_000), "1 d ago");
});

test("counts and filters", () => {
  const counts = countByChip(["WORKING", "WORKING", "STOPPED", "OFFLINE"]);
  assert.equal(counts.ALL, 4);
  assert.equal(counts.WORKING, 2);
  assert.equal(counts.ON_LEAVE, 0);
  const m = { fullName: "Asha Rao", employeeCode: "EMP-1", state: "WORKING" as const };
  assert.equal(matches(m, "ALL", ""), true);
  assert.equal(matches(m, "STOPPED", ""), false);
  assert.equal(matches(m, "WORKING", " emp-1 "), true);
  assert.equal(matches(m, "ALL", "ravi"), false);
});

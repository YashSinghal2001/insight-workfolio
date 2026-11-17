import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activitySyncSchema,
  attendanceTimelineQuerySchema,
  can,
  deriveLiveStatus,
  hasPermission,
  LIVE_STATUS_STALE_MS,
  missingClockOut,
  PERMISSIONS,
  SCREENSHOT_STATE_STALE_MS,
  screenshotFeatureState,
  SUPER_ADMIN_ONLY,
} from "../dist/index.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const open = { clockInAt: at(120), clockOutAt: null, breaks: [] as { id: string; startedAt: string; endedAt: string | null }[] };
const report = (state: "ACTIVE" | "IDLE" | "UNOBSERVED", sinceAgo: number, reportedAgo: number) => ({ state, since: at(sinceAgo), reportedAt: at(reportedAgo) });

test("can: Super Admin-only permissions are refused to an Admin; everything else follows the role", () => {
  const superAdmin = { role: "ADMIN", platformRole: "SUPER_ADMIN" } as const;
  const admin = { role: "ADMIN", platformRole: "ADMIN" } as const;
  const employee = { role: "EMPLOYEE", platformRole: "EMPLOYEE" } as const;
  assert.deepEqual([...SUPER_ADMIN_ONLY].sort(), ["roles:manage", "screenshots:delete", "storage:manage", "updates:publish"]);
  for (const p of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
    const superOnly = (SUPER_ADMIN_ONLY as readonly string[]).includes(p);
    assert.equal(can(superAdmin, p), hasPermission("ADMIN", p), p);
    assert.equal(can(admin, p), hasPermission("ADMIN", p) && !superOnly, p);
    assert.equal(can(employee, p), hasPermission("EMPLOYEE", p), p);
    if (superOnly) assert.deepEqual([can(superAdmin, p), can(admin, p), can(employee, p)], [true, false, false], p);
  }
  // What the IT Admin keeps: all monitoring data and configuration.
  for (const p of ["screenshots:read", "activity:read-all", "attendance:read-all", "employees:read", "devices:read", "settings:manage", "audit:read"] as const) assert.equal(can(admin, p), true, p);
  // A client-claimed identity without the role gets nothing.
  assert.equal(can({ role: "EMPLOYEE", platformRole: "SUPER_ADMIN" }, "screenshots:delete"), false);
});

test("deriveLiveStatus: attendance wins over whatever the device reports", () => {
  const active = report("ACTIVE", 1, 0);
  assert.deepEqual(deriveLiveStatus(null, active, NOW), { liveStatus: "NOT_CLOCKED_IN", liveSince: null });
  assert.deepEqual(deriveLiveStatus({ ...open, clockOutAt: at(30) }, active, NOW), { liveStatus: "NOT_CLOCKED_IN", liveSince: at(30) });
  const onBreak = { ...open, breaks: [{ id: "b1", startedAt: at(90), endedAt: at(80) }, { id: "b2", startedAt: at(10), endedAt: null }] };
  assert.deepEqual(deriveLiveStatus(onBreak, active, NOW), { liveStatus: "ON_BREAK", liveSince: at(10) });
});

test("deriveLiveStatus: clocked in, the device's report only while fresh and from this working stretch", () => {
  assert.deepEqual(deriveLiveStatus(open, null, NOW), { liveStatus: "UNKNOWN", liveSince: null });
  assert.deepEqual(deriveLiveStatus(open, report("IDLE", 25, 1), NOW), { liveStatus: "IDLE", liveSince: at(25) });
  assert.deepEqual(deriveLiveStatus(open, report("ACTIVE", 3, 1), NOW), { liveStatus: "ACTIVE", liveSince: at(3) });
  assert.deepEqual(deriveLiveStatus(open, report("UNOBSERVED", 3, 1), NOW), { liveStatus: "UNKNOWN", liveSince: null });
  // Staleness boundary: exactly the window is still believed, one millisecond more is not.
  const edge = { state: "IDLE" as const, since: at(25), reportedAt: new Date(NOW - LIVE_STATUS_STALE_MS).toISOString() };
  assert.equal(deriveLiveStatus(open, edge, NOW).liveStatus, "IDLE");
  assert.equal(deriveLiveStatus(open, edge, NOW + 1).liveStatus, "UNKNOWN");
  assert.equal(LIVE_STATUS_STALE_MS, 180_000);
  // Idle since before the clock-in: the status starts at the clock-in, not earlier.
  assert.deepEqual(deriveLiveStatus(open, report("IDLE", 500, 1), NOW), { liveStatus: "IDLE", liveSince: at(120) });
  // After a break: a report received before the break ended says nothing about now; a later one counts from the break's end.
  const afterBreak = { ...open, breaks: [{ id: "b1", startedAt: at(30), endedAt: at(2) }] };
  assert.equal(deriveLiveStatus(afterBreak, report("ACTIVE", 40, 2.5), NOW).liveStatus, "UNKNOWN");
  assert.deepEqual(deriveLiveStatus(afterBreak, report("ACTIVE", 40, 1), NOW), { liveStatus: "ACTIVE", liveSince: at(2) });
  // A report left over from an earlier session (received before this clock-in).
  assert.equal(deriveLiveStatus({ ...open, clockInAt: at(1) }, report("ACTIVE", 5, 2), NOW).liveStatus, "UNKNOWN");
});

test("screenshotFeatureState: switch, then consent, then a fresh device problem", () => {
  const denied = { state: "PERMISSION_DENIED" as const, reportedAt: at(1) };
  assert.equal(screenshotFeatureState({ enabled: false, consented: true, report: denied }, NOW), "DISABLED");
  assert.equal(screenshotFeatureState({ enabled: true, consented: false, report: denied }, NOW), "AWAITING_CONSENT");
  assert.equal(screenshotFeatureState({ enabled: true, consented: true, report: null }, NOW), "ENABLED");
  assert.equal(screenshotFeatureState({ enabled: true, consented: true, report: { state: "OK", reportedAt: at(1) } }, NOW), "ENABLED");
  assert.equal(screenshotFeatureState({ enabled: true, consented: true, report: denied }, NOW), "PERMISSION_DENIED");
  assert.equal(screenshotFeatureState({ enabled: true, consented: true, report: { state: "CAPTURE_FAILED", reportedAt: at(14) } }, NOW), "CAPTURE_FAILED");
  const edge = { state: "CAPTURE_FAILED" as const, reportedAt: new Date(NOW - SCREENSHOT_STATE_STALE_MS).toISOString() };
  assert.equal(screenshotFeatureState({ enabled: true, consented: true, report: edge }, NOW), "CAPTURE_FAILED");
  assert.equal(screenshotFeatureState({ enabled: true, consented: true, report: edge }, NOW + 1), "ENABLED", "a stale problem is not shown");
});

test("missingClockOut: an open session from an earlier local date, in the employee's time zone", () => {
  const session = (clockInAt: string, clockOutAt: string | null = null) => ({ clockInAt, clockOutAt });
  assert.equal(missingClockOut(null, "UTC", NOW), false);
  assert.equal(missingClockOut(session("2026-11-10T00:00:00.000Z"), "UTC", NOW), false, "today");
  assert.equal(missingClockOut(session("2026-11-09T23:59:59.000Z"), "UTC", NOW), true, "yesterday");
  assert.equal(missingClockOut(session("2026-11-09T09:00:00.000Z", "2026-11-09T17:00:00.000Z"), "UTC", NOW), false, "closed");
  // 2026-11-09T19:00Z is already 00:30 on the 10th in Kolkata, and still the 9th in New York.
  assert.equal(missingClockOut(session("2026-11-09T19:00:00.000Z"), "Asia/Kolkata", NOW), false);
  assert.equal(missingClockOut(session("2026-11-09T19:00:00.000Z"), "America/New_York", NOW), true);
  // A night shift is flagged once the local date changes; the flag is a prompt, nothing is closed.
  assert.equal(missingClockOut(session("2026-11-09T22:00:00.000Z"), "UTC", Date.parse("2026-11-09T23:59:00.000Z")), false);
  assert.equal(missingClockOut(session("2026-11-09T22:00:00.000Z"), "UTC", Date.parse("2026-11-10T00:01:00.000Z")), true);
});

test("activitySyncSchema: `current` may ride alone; an empty upload without it is refused; nothing else is accepted", () => {
  const base = { sentAt: at(0), platform: "macos" };
  const interval = { id: "3f2b8c1e-4d5a-4f6b-8a7c-9d0e1f2a3b4c", kind: "IDLE", startedAt: at(10), endedAt: at(5) };
  assert.ok(activitySyncSchema.safeParse({ ...base, intervals: [interval] }).success, "older desktops: unchanged");
  assert.ok(activitySyncSchema.safeParse({ ...base, intervals: [], current: { state: "IDLE", since: at(5) } }).success);
  assert.ok(activitySyncSchema.safeParse({ ...base, intervals: [interval], current: { state: "ACTIVE", since: at(5), screenshot: "PERMISSION_DENIED" } }).success);
  for (const bad of [
    { ...base, intervals: [] },
    { ...base, current: { state: "IDLE", since: at(5) } }, // intervals is still required
    { ...base, intervals: [], current: { state: "TYPING", since: at(5) } },
    { ...base, intervals: [], current: { state: "IDLE" } },
    { ...base, intervals: [], current: { state: "IDLE", since: "5 minutes ago" } },
    { ...base, intervals: [], current: { state: "IDLE", since: at(5), screenshot: "BLOCKED" } },
    { ...base, intervals: [], current: { state: "IDLE", since: at(5), windowTitle: "secret" } },
  ]) assert.equal(activitySyncSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("attendanceTimelineQuerySchema: one optional local date, bounded pages, no extras", () => {
  assert.deepEqual(attendanceTimelineQuerySchema.parse({}), { page: 1, pageSize: 100 });
  assert.deepEqual(attendanceTimelineQuerySchema.parse({ date: "2026-11-10", page: "2", pageSize: "50" }), { date: "2026-11-10", page: 2, pageSize: 50 });
  for (const bad of [{ date: "10/11/2026" }, { pageSize: "201" }, { page: "0" }, { employeeId: "me" }, { from: "2026-11-10" }]) assert.equal(attendanceTimelineQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
});

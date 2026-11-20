import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttendanceCurrent, AttendanceSession, TimesheetDay } from "@workfolio/shared";
import { allPages, calendarMonth, lateRange, overlapping, pickTeam, shiftMonth, stillClockedInSince } from "./attendance";

const session = (clockInAt: string, clockOutAt: string | null = null, openBreak?: string) =>
  ({ id: "s1", clockInAt, clockOutAt, status: clockOutAt ? "CLOSED" : "OPEN", breaks: openBreak ? [{ id: "b1", startedAt: openBreak, endedAt: null }] : [] }) as unknown as AttendanceSession;
const current = (s: AttendanceSession | null, state: AttendanceCurrent["state"], serverTime: string): AttendanceCurrent => ({ state, session: s, serverTime, missingClockOut: false });

test("banner: open shift from an earlier local date (IST), not for one started after local midnight", () => {
  // 23:30 IST on the 19th, now 00:30 IST on the 20th: an earlier local date although only 1 h open.
  const s = session("2026-11-19T18:00:00.000Z");
  assert.equal(stillClockedInSince(current(s, "CLOCKED_IN", "2026-11-19T19:00:00.000Z"), "Asia/Kolkata"), s.clockInAt);
  // 01:30 IST on the 20th, now 11:30 IST: same local date, 10 h open.
  assert.equal(stillClockedInSince(current(session("2026-11-19T20:00:00.000Z"), "CLOCKED_IN", "2026-11-20T06:00:00.000Z"), "Asia/Kolkata"), null);
  // Same instants read in UTC: the 19th vs the 20th → flagged.
  assert.equal(stillClockedInSince(current(session("2026-11-19T20:00:00.000Z"), "CLOCKED_IN", "2026-11-20T06:00:00.000Z"), "UTC"), "2026-11-19T20:00:00.000Z");
});

test("banner: open > 14 h of real time on one local date across the New York DST change", () => {
  // 00:30 EDT on 1 Nov 2026; clocks go back at 02:00, so the local date stays 1 Nov all along.
  const s = session("2026-11-01T04:30:00.000Z");
  const at = (h: number, m = 0) => new Date(Date.parse(s.clockInAt) + (h * 60 + m) * 60_000).toISOString();
  assert.equal(stillClockedInSince(current(s, "CLOCKED_IN", at(14)), "America/New_York"), null, "exactly 14 h is not over");
  assert.equal(stillClockedInSince(current(s, "CLOCKED_IN", at(14, 1)), "America/New_York"), s.clockInAt);
  assert.equal(stillClockedInSince(current(s, "CLOCKED_IN", at(10)), "America/New_York", Date.parse(at(14, 1))), s.clockInAt, "injected clock wins over serverTime");
});

test("banner: an open break still counts; closed shifts and CLOCKED_OUT never do", () => {
  const brk = session("2026-11-18T09:00:00.000Z", null, "2026-11-18T12:00:00.000Z");
  assert.equal(stillClockedInSince(current(brk, "ON_BREAK", "2026-11-19T08:00:00.000Z"), "UTC"), brk.clockInAt);
  const closed = session("2026-11-18T09:00:00.000Z", "2026-11-18T17:00:00.000Z");
  assert.equal(stillClockedInSince(current(closed, "CLOCKED_OUT", "2026-11-20T08:00:00.000Z"), "UTC"), null);
  assert.equal(stillClockedInSince(current(null, "CLOCKED_OUT", "2026-11-20T08:00:00.000Z"), "UTC"), null);
});

const day = (date: string, firstClockIn: string, netMs: number, incomplete = false) => ({ date, firstClockIn, netMs, incomplete }) as TimesheetDay;
const win = (date: string, start = "09:00", due = "09:15") => ({ date, startAt: `${date}T${start}:00.000Z`, dueAt: `${date}T${due}:00.000Z` });

test("calendar: Monday-first weeks with padding, statuses from the shared daily rule", () => {
  const weeks = calendarMonth({
    month: "2026-11",
    timeZone: "UTC",
    timesheet: { days: [day("2026-11-02", "2026-11-02T09:05:00.000Z", 8 * 3_600_000), day("2026-11-03", "2026-11-03T09:30:00.000Z", 7 * 3_600_000), day("2026-11-06", "2026-11-06T09:00:00.000Z", 0, true)] },
    expected: { days: ["02", "03", "04", "05", "06", "25"].map((d) => win(`2026-11-${d}`)) },
    leave: [{ startDate: "2026-11-05", endDate: "2026-11-05", status: "APPROVED" }, { startDate: "2026-11-04", endDate: "2026-11-04", status: "REJECTED" }],
    now: Date.parse("2026-11-20T12:00:00.000Z"),
  });
  assert.equal(weeks.length, 6);
  assert.ok(weeks.every((w) => w.length === 7));
  assert.deepEqual(weeks[0].slice(0, 6), Array(6).fill(null), "1 Nov 2026 is a Sunday");
  const by = new Map(weeks.flat().filter((d) => d).map((d) => [d!.date, d!]));
  assert.equal(by.size, 30);
  assert.equal(by.get("2026-11-02")!.status, "PRESENT");
  assert.equal(by.get("2026-11-02")!.workedMs, 8 * 3_600_000);
  assert.deepEqual([by.get("2026-11-03")!.status, by.get("2026-11-03")!.lateMinutes], ["LATE", 30]);
  assert.equal(by.get("2026-11-04")!.status, "ABSENT", "rejected leave does not count");
  assert.equal(by.get("2026-11-05")!.status, "ON_LEAVE");
  assert.equal(by.get("2026-11-06")!.status, "OPEN");
  assert.equal(by.get("2026-11-07")!.status, "NOT_SCHEDULED", "no window while a schedule exists");
  assert.equal(by.get("2026-11-25")!.status, "NOT_YET_DUE");
  assert.equal(by.get("2026-11-20")!.today, true);
  assert.equal(by.get("2026-11-19")!.today, false);
});

test("calendar: without any schedule days are NO_POLICY (leave still shown); today is in the employee's zone", () => {
  const weeks = calendarMonth({
    month: "2026-11",
    timeZone: "Asia/Kolkata",
    timesheet: { days: [day("2026-11-10", "2026-11-10T04:00:00.000Z", 3_600_000)] },
    expected: { days: [] },
    leave: [{ startDate: "2026-11-11", endDate: "2026-11-12", status: "APPROVED" }],
    now: Date.parse("2026-11-19T19:00:00.000Z"), // 00:30 IST on the 20th
  });
  const by = new Map(weeks.flat().filter((d) => d).map((d) => [d!.date, d!]));
  assert.equal(by.get("2026-11-10")!.status, "NO_POLICY");
  assert.equal(by.get("2026-11-10")!.workedMs, 3_600_000);
  assert.equal(by.get("2026-11-12")!.status, "ON_LEAVE");
  assert.equal(by.get("2026-11-20")!.today, true);
});

test("shiftMonth crosses years; team helpers", () => {
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-03", -14), "2025-01");
  assert.equal(shiftMonth("2026-03", 0), "2026-03");
  const teams = [{ id: "a" }, { id: "b" }];
  assert.equal(pickTeam(teams, "b"), "b");
  assert.equal(pickTeam(teams, "gone"), "a");
  assert.equal(pickTeam(teams, null), "a");
  assert.equal(pickTeam([], "a"), null);
  assert.deepEqual(lateRange("2026-03-02"), { from: "2026-02-24", to: "2026-03-02" });
});

test("leave: every page is read until total; overlap with the month is inclusive", async () => {
  const all = Array.from({ length: 205 }, (_, i) => i);
  const asked: number[] = [];
  const got = await allPages(async (page) => (asked.push(page), { items: all.slice((page - 1) * 100, page * 100), total: all.length, page, pageSize: 100 }));
  assert.deepEqual(asked, [1, 2, 3]);
  assert.equal(got.length, 205);
  assert.deepEqual(await allPages(async (page) => ({ items: [], total: 0, page, pageSize: 100 })), []);
  // A shrinking list (total says more, page is empty) stops instead of looping.
  assert.deepEqual(await allPages(async (page) => ({ items: page === 1 ? ["a"] : [], total: 5, page, pageSize: 1 })), ["a"]);
  const l = (startDate: string, endDate: string) => ({ startDate, endDate });
  assert.deepEqual(
    overlapping([l("2026-10-25", "2026-11-01"), l("2026-11-30", "2026-12-02"), l("2026-10-01", "2026-10-31"), l("2026-12-01", "2026-12-01"), l("2026-10-01", "2026-12-31")], "2026-11-01", "2026-11-30"),
    [l("2026-10-25", "2026-11-01"), l("2026-11-30", "2026-12-02"), l("2026-10-01", "2026-12-31")],
  );
});

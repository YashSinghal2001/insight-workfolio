import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATTENDANCE_EVENT_TYPES,
  ATTENDANCE_STATES,
  attendanceTotals,
  formatDuration,
  formatDurationShort,
  invalidTransitionMessage,
  syncRequestSchema,
  transition,
} from "../dist/index.js";

const H = 3_600_000;
const M = 60_000;

test("state machine: exactly the four allowed transitions", () => {
  const allowed = new Map<string, string>([
    ["CLOCKED_OUT:CLOCK_IN", "CLOCKED_IN"],
    ["CLOCKED_IN:BREAK_START", "ON_BREAK"],
    ["ON_BREAK:BREAK_END", "CLOCKED_IN"],
    ["CLOCKED_IN:CLOCK_OUT", "CLOCKED_OUT"],
  ]);
  for (const s of ATTENDANCE_STATES) {
    for (const e of ATTENDANCE_EVENT_TYPES) {
      assert.equal(transition(s, e), allowed.get(`${s}:${e}`) ?? null, `${s} + ${e}`);
    }
  }
  assert.equal(invalidTransitionMessage("ON_BREAK", "CLOCK_OUT"), "End your break before clocking out");
  assert.equal(invalidTransitionMessage("CLOCKED_IN", "CLOCK_IN"), "Cannot clock in while clocked in");
});

test("totals: midnight-crossing night shift (Asia/Kolkata 22:00 -> 06:00) with a break across midnight", () => {
  const t = attendanceTotals(
    { start: "2026-10-12T16:30:00.000Z", end: "2026-10-13T00:30:00.000Z" },
    [{ start: "2026-10-12T18:00:00.000Z", end: "2026-10-12T18:45:00.000Z" }],
  );
  assert.deepEqual(t, { elapsedMs: 8 * H, breakMs: 45 * M, netMs: 7 * H + 15 * M });
  assert.equal(formatDuration(t.netMs), "7h 15m");
});

test("totals: DST spring-forward and fall-back shifts use real elapsed time, not wall clock", () => {
  // New York, 2026-03-08: 01:00 EST -> 05:00 EDT on the wall is only 3 h.
  const spring = attendanceTotals({ start: "2026-03-08T06:00:00Z", end: "2026-03-08T09:00:00Z" }, []);
  assert.equal(spring.elapsedMs, 3 * H);
  const ny = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  assert.deepEqual([ny("2026-03-08T06:00:00Z"), ny("2026-03-08T09:00:00Z")], ["01:00", "05:00"]);
  // 2026-11-01: 01:00 EDT -> 02:00 EST on the wall is 2 h.
  assert.equal(attendanceTotals({ start: "2026-11-01T05:00:00Z", end: "2026-11-01T07:00:00Z" }, []).elapsedMs, 2 * H);
});

test("totals: open session and open break are measured up to now; current shift duration", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const t = attendanceTotals(
    { start: "2026-10-12T09:00:00Z", end: null },
    [
      { start: "2026-10-12T10:00:00Z", end: "2026-10-12T10:15:00Z" },
      { start: "2026-10-12T11:50:00Z", end: null },
    ],
    now,
  );
  assert.deepEqual(t, { elapsedMs: 3 * H, breakMs: 25 * M, netMs: 2 * H + 35 * M });
});

test("totals never go negative and breaks never exceed the session", () => {
  const t = attendanceTotals({ start: "2026-10-12T10:00:00Z", end: "2026-10-12T10:30:00Z" }, [
    { start: "2026-10-12T09:00:00Z", end: "2026-10-12T11:00:00Z" },
  ]);
  assert.equal(t.netMs, 0);
  assert.equal(formatDuration(-5), "0h 00m");
  assert.equal(formatDuration(25 * H + 59 * M + 59_999), "25h 59m");
  assert.deepEqual([38_400, 247_000, 2 * H + 5 * M].map(formatDurationShort), ["38s", "4m 07s", "2h 05m"]);
});

test("sync request schema: bounded batch, uuids, ISO timestamps", () => {
  const ev = { id: "6f1c1b2a-3d4e-4f50-8a6b-7c8d9e0f1a2b", type: "CLOCK_IN", occurredAt: "2026-10-12T09:00:00.000Z" };
  assert.equal(syncRequestSchema.safeParse({ sentAt: "2026-10-12T09:00:01Z", events: [ev] }).success, true);
  assert.equal(syncRequestSchema.safeParse({ sentAt: "2026-10-12T09:00:01Z", events: [] }).success, false);
  assert.equal(syncRequestSchema.safeParse({ sentAt: "yesterday", events: [ev] }).success, false);
  assert.equal(syncRequestSchema.safeParse({ sentAt: "2026-10-12T09:00:01Z", events: [{ ...ev, type: "NAP" }] }).success, false);
  assert.equal(syncRequestSchema.safeParse({ sentAt: "2026-10-12T09:00:01Z", events: Array(101).fill(ev) }).success, false);
});

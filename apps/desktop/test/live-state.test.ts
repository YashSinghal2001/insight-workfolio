import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEPALIVE_MS, liveState, nextReport, reportDue, retryDelayMs, type LiveInputs, type Reported } from "../src/live-state.ts";

const c: LiveInputs = { collecting: true, idle: false, locked: false, lastSampleMs: 1 };

test("live state: idle or locked is IDLE, asleep or another user is UNOBSERVED, otherwise ACTIVE", () => {
  assert.equal(liveState(c, true, true), "ACTIVE");
  assert.equal(liveState({ ...c, idle: true }, true, true), "IDLE");
  assert.equal(liveState({ ...c, locked: true }, true, true), "IDLE", "a locked screen counts as idle (employee notice)");
  assert.equal(liveState({ ...c, locked: true, asleep: true }, true, true), "UNOBSERVED");
  assert.equal(liveState({ ...c, idle: true, sessionInactive: true }, true, true), "UNOBSERVED");
});

test("nothing is reported when not monitoring, unreachable or before the first sample", () => {
  assert.equal(liveState(c, false, true), null, "clocked out, on a break or no consent");
  assert.equal(liveState(c, true, false), null, "offline or attendance not synced yet");
  assert.equal(liveState({ ...c, collecting: false }, true, true), null);
  assert.equal(liveState({ ...c, lastSampleMs: null }, true, true), null);
});

test("reports go out on a state change and once per keepalive window, never in between", () => {
  const T = 1_000_000;
  let prev: Reported | null = null;
  const sent: [number, string, number][] = [];
  // Polled every 5 s for 10 min: active, idle from 200 s (last input at 150 s... threshold shortened), active again from 400 s.
  for (let t = 0; t <= 600_000; t += 5_000) {
    const state = t >= 200_000 && t < 400_000 ? "IDLE" : "ACTIVE";
    if (!reportDue(prev, state, T + t)) continue;
    prev = nextReport(prev, state, state === "IDLE" ? T + 150_000 : null, T + t);
    sent.push([t / 1000, prev.state, (prev.sinceMs - T) / 1000]);
  }
  assert.deepEqual(sent, [
    [0, "ACTIVE", 0], [60, "ACTIVE", 0], [120, "ACTIVE", 0], [180, "ACTIVE", 0],
    [200, "IDLE", 150], [260, "IDLE", 150], [320, "IDLE", 150], [380, "IDLE", 150],
    [400, "ACTIVE", 400], [460, "ACTIVE", 400], [520, "ACTIVE", 400], [580, "ACTIVE", 400],
  ]);
});

test("a report that rode along with an interval upload restarts the keepalive window", () => {
  const first = nextReport(null, "ACTIVE", null, 0);
  const rode = nextReport(first, "ACTIVE", null, 50_000); // attached to a regular upload
  assert.equal(reportDue(rode, "ACTIVE", 60_000), false, "no duplicate 10 s later");
  assert.equal(reportDue(rode, "ACTIVE", 50_000 + KEEPALIVE_MS), true);
  assert.equal(reportDue(rode, "IDLE", 50_001), true, "a change is reported at once");
  assert.equal(reportDue(null, "ACTIVE", 0), true, "first report after monitoring (re)starts");
});

test("idle keeps its start across the 15-minute interval split and never starts in the future", () => {
  const a = nextReport(null, "IDLE", 1_000, 5_000);
  assert.equal(a.sinceMs, 1_000);
  assert.equal(nextReport(a, "IDLE", 901_000, 905_000).sinceMs, 1_000, "the split moves idleSinceMs, not the reported start");
  assert.equal(nextReport(null, "IDLE", 9_000, 5_000).sinceMs, 5_000);
  assert.equal(nextReport(null, "IDLE", null, 5_000).sinceMs, 5_000);
});

test("a failed report is retried with the upload queue's backoff, and stays due meanwhile", () => {
  assert.deepEqual([1, 2, 3, 4, 9, 50].map(retryDelayMs), [2_000, 4_000, 8_000, 16_000, 300_000, 300_000]);
  // The caller restores the previous report on failure, so the change is still due at the next poll.
  const before = nextReport(null, "ACTIVE", null, 0);
  assert.equal(reportDue(before, "IDLE", 5_000), true);
  // After a success the same state is not due again inside the keepalive window.
  assert.equal(reportDue(nextReport(before, "IDLE", 1_000, 5_000), "IDLE", 10_000), false);
});

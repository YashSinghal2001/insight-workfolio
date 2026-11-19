import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceTotals, type AttendanceCurrent } from "@workfolio/shared";
import { lockBreakStep, type LockBreakMarker, type LockInput } from "../src/lock-break.ts";
import { project, type QueuedEvent } from "../src/sync.ts";

// Synthetic events only: a fake clocked-in session and an in-memory queue, driven the way main.ts does
// (marker before BREAK_START, cleared after BREAK_END, events through the attendance state machine).
const T0 = Date.parse("2026-11-17T09:00:00Z");
const at = (s: number) => T0 + s * 1000;
const clockedIn: AttendanceCurrent = {
  state: "CLOCKED_IN",
  session: { id: "s1", clockInAt: new Date(T0).toISOString(), clockOutAt: null, status: "OPEN", breaks: [], corrected: false, clockInSource: "ONLINE" },
  serverTime: new Date(T0).toISOString(),
  missingClockOut: false,
};

function device(current: AttendanceCurrent = clockedIn) {
  const queued: QueuedEvent[] = [];
  let marker: LockBreakMarker | null = null;
  return {
    queued,
    get marker() {
      return marker;
    },
    restartWith(m: LockBreakMarker | null) {
      marker = m; // persisted in the kv store across restarts
    },
    state: () => project(current, queued)!.state,
    session: () => project(current, queued)!.session!,
    send(input: LockInput) {
      const step = lockBreakStep(this.state(), marker, input);
      if (step.marker) marker = step.marker;
      if (step.event) queued.push({ id: crypto.randomUUID(), userId: "u", deviceId: "d", type: step.event.type, occurredAt: new Date(step.event.atMs).toISOString(), status: "PENDING" });
      if (!step.marker) marker = null;
    },
  };
}

test("lock → break from the lock time; unlock → break ends, duration recorded, then working (not assumed active)", () => {
  const d = device();
  d.send({ kind: "locked", atMs: at(600) });
  assert.equal(d.state(), "ON_BREAK");
  assert.deepEqual(d.session().breaks.map((b) => [b.startedAt, b.endedAt]), [[new Date(at(600)).toISOString(), null]]);
  d.send({ kind: "unlocked", atMs: at(900) });
  assert.equal(d.state(), "CLOCKED_IN", "back to clocked in: activity detection decides ACTIVE/IDLE from the next sample");
  const totals = attendanceTotals({ start: d.session().clockInAt, end: null }, d.session().breaks.map((b) => ({ start: b.startedAt, end: b.endedAt })), at(1200));
  assert.equal(totals.breakMs, 300_000, "5 min break");
  assert.equal(totals.netMs, 900_000);
  assert.equal(d.marker, null);
  assert.deepEqual(d.queued.map((e) => e.type), ["BREAK_START", "BREAK_END"]);
});

test("repeated lock and unlock notifications create one break", () => {
  const d = device();
  for (const s of [10, 11, 12]) d.send({ kind: "locked", atMs: at(s) });
  for (const s of [20, 21]) d.send({ kind: "unlocked", atMs: at(s) });
  d.send({ kind: "check", locked: false, nowMs: at(30) });
  assert.deepEqual(d.queued.map((e) => e.type), ["BREAK_START", "BREAK_END"]);
  assert.equal(d.queued[1]!.occurredAt, new Date(at(20)).toISOString(), "the first unlock ends it");
});

test("a break the employee started is never ended by an unlock or a check", () => {
  const d = device();
  d.queued.push({ id: "manual", userId: "u", deviceId: "d", type: "BREAK_START", occurredAt: new Date(at(5)).toISOString(), status: "PENDING" });
  d.send({ kind: "locked", atMs: at(10) }); // already on a break: nothing
  d.send({ kind: "unlocked", atMs: at(20) });
  d.send({ kind: "check", locked: false, nowMs: at(30) });
  assert.equal(d.state(), "ON_BREAK");
  assert.equal(d.queued.length, 1);
});

test("clocked out: a lock does nothing", () => {
  const d = device({ ...clockedIn, state: "CLOCKED_OUT", session: { ...clockedIn.session!, clockOutAt: new Date(T0).toISOString(), status: "CLOSED" } });
  d.send({ kind: "locked", atMs: at(10) });
  d.send({ kind: "unlocked", atMs: at(20) });
  assert.equal(d.queued.length, 0);
});

test("restart while locked keeps the break; restart after a missed unlock ends it at the check", () => {
  const d = device();
  d.send({ kind: "locked", atMs: at(100) });
  const persisted = d.marker;
  d.restartWith(persisted); // app restarted; the queue and marker survive on disk
  d.send({ kind: "check", locked: true, nowMs: at(200) });
  assert.equal(d.state(), "ON_BREAK", "still locked: still on break");
  d.send({ kind: "check", locked: false, nowMs: at(400) });
  assert.equal(d.state(), "CLOCKED_IN");
  assert.equal(d.queued.at(-1)!.occurredAt, new Date(at(400)).toISOString(), "unlock time unknown: ended when seen unlocked");
});

test("offline: the break stays a break while events wait in the queue (never idle)", () => {
  const d = device();
  d.send({ kind: "locked", atMs: at(100) });
  // Nothing uploaded: the projection from the local queue still says on break.
  assert.equal(d.state(), "ON_BREAK");
  d.send({ kind: "unlocked", atMs: at(700) });
  assert.ok(d.queued.every((e) => e.status === "PENDING"), "both wait for upload with their device times");
  assert.equal(d.state(), "CLOCKED_IN");
});

test("an unlock stamped before the lock (clock step, reordering) never ends the break before it started", () => {
  const d = device();
  d.send({ kind: "locked", atMs: at(100) });
  d.send({ kind: "unlocked", atMs: at(50) });
  assert.ok(Date.parse(d.queued[1]!.occurredAt) > Date.parse(d.queued[0]!.occurredAt));
});

// Runs with node's built-in TypeScript stripping: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { trayBridge, trayUpdate, type TrayInput, type TrayUpdate } from "../src/tray-bridge.ts";
import type { Projection } from "../src/sync.ts";

const IN = "2026-11-02T09:00:00.000Z";
const BREAK = "2026-11-02T12:00:00.000Z";
const session = (breaks: { startedAt: string; endedAt: string | null }[] = []) =>
  ({ id: "s1", clockInAt: IN, clockOutAt: null, status: "OPEN", breaks: breaks.map((b, i) => ({ id: `b${i}`, ...b })), corrected: false, clockInSource: "ONLINE" }) as Projection["session"];
const working: Projection = { state: "CLOCKED_IN", session: session(), unsynced: 0 };
const onBreak: Projection = { state: "ON_BREAK", session: session([{ startedAt: "2026-11-02T10:00:00.000Z", endedAt: "2026-11-02T10:15:00.000Z" }, { startedAt: BREAK, endedAt: null }]), unsynced: 0 };
const base: TrayInput = { signedIn: true, online: true, deviceStatus: "ACTIVE", projection: working, syncPhase: "idle", rejected: 0, activity: "On", screenshots: "On" };
const at = (patch: Partial<TrayInput>) => trayUpdate({ ...base, ...patch });

test("tray: attendance states map to WORKING / ON_BREAK / CLOCKED_OUT with the right timer start", () => {
  assert.deepEqual(at({}), { state: "WORKING", label: "Clocked in", since: IN, monitoring: "Activity on · Screenshots on" });
  assert.deepEqual(at({ projection: onBreak, activity: "Paused (break)", screenshots: "Paused (break)" }), {
    state: "ON_BREAK", label: "On break", since: BREAK, monitoring: "Activity paused (break) · Screenshots paused (break)",
  });
  const out = at({ projection: { state: "CLOCKED_OUT", session: null, unsynced: 0 }, activity: "Off", screenshots: "Off" });
  assert.equal(out.state, "CLOCKED_OUT");
  assert.equal(out.since, undefined);
  assert.equal(at({ projection: { ...working, unsynced: 1 } }).label, "Clocked in (not synced yet)");
});

test("tray: signed out sends nothing personal", () => {
  assert.deepEqual(at({ signedIn: false }), { state: "SIGNED_OUT", label: "Signed out: nothing is recorded" });
});

test("tray: offline keeps the running timer (local projection)", () => {
  const u = at({ online: false, projection: { ...working, unsynced: 1 } });
  assert.deepEqual([u.state, u.label, u.since], ["OFFLINE", "Offline · Clocked in (not synced yet)", IN]);
  assert.equal(at({ syncPhase: "offline" }).state, "OFFLINE");
  assert.equal(at({ online: false, projection: null }).label, "Offline · Attendance status unknown");
});

test("tray: problems the employee must act on win over everything else", () => {
  const cases: [Partial<TrayInput>, string][] = [
    [{ deviceStatus: "REVOKED", activity: null, screenshots: null }, "This device was revoked: attendance can't be recorded"],
    [{ deviceStatus: "NOT_REGISTERED", projection: null, activity: null, screenshots: null }, "Register this device to record attendance"],
    [{ syncPhase: "blocked" }, "Attendance sync is blocked: open the app"],
    [{ rejected: 2 }, "2 attendance change(s) not recorded by the server"],
    [{ screenshots: "Needs permission" }, "Screen recording permission needed"],
    [{ screenshots: "Error" }, "Screenshots have a problem: open the app"],
    [{ activity: "Error" }, "Activity monitoring has a problem: open the app"],
    [{ activity: "Paused" }, "Monitoring paused: attendance can't be verified"],
  ];
  for (const [patch, label] of cases) {
    const u = at(patch);
    assert.deepEqual([u.state, u.label], ["ATTENTION", label], label);
  }
  assert.equal(at({ screenshots: "Needs permission" }).since, IN, "the timer keeps showing while attention is needed");
  assert.equal(at({ online: false, activity: "Paused" }).state, "OFFLINE", "offline pause is not a separate problem");
  assert.equal(at({ deviceStatus: "NOT_REGISTERED", online: false, projection: null, activity: null, screenshots: null }).state, "OFFLINE");
});

test("tray bridge: debounced, sends only changes, survives a missing native command", async () => {
  const sent: TrayUpdate[] = [];
  const timers: (() => void)[] = [];
  const push = trayBridge(
    async (u) => {
      sent.push(u);
      throw new Error("command tray_update not found");
    },
    250,
    ((fn: () => void) => timers.push(fn)) as unknown as typeof setTimeout,
    (() => undefined) as unknown as typeof clearTimeout,
  );
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(push(at({})), true);
    assert.equal(push(at({})), false, "identical update ignored");
    assert.equal(push(at({ projection: onBreak })), true);
    timers.at(-1)!(); // only the latest pending update is sent
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent.map((u) => u.state), ["ON_BREAK"]);
  } finally {
    console.warn = warn;
  }
});

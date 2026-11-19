import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttendanceCurrent } from "@workfolio/shared";
import { appNapText, collectorStateText, decideMonitoring, type MonitoringInputs } from "../src/monitoring.ts";
import { project, type QueuedEvent } from "../src/sync.ts";

const OUT: AttendanceCurrent = { state: "CLOCKED_OUT", session: null, serverTime: "2026-10-12T08:00:00.000Z", missingClockOut: false };
const ev = (type: QueuedEvent["type"], id = type): QueuedEvent => ({ id, userId: "u", deviceId: "d", type, occurredAt: "2026-10-12T09:00:00.000Z", status: "PENDING" });
const base: MonitoringInputs = {
  signedIn: true, supported: true, deviceStatus: "ACTIVE", enabled: true, consented: true,
  projection: project(OUT, []), pendingClockIn: false, unverified: false, collectorError: null,
};
const mode = (patch: Partial<MonitoringInputs>) => decideMonitoring({ ...base, ...patch }).mode;
const server = (state: AttendanceCurrent["state"]): AttendanceCurrent => ({
  state, serverTime: OUT.serverTime, missingClockOut: false,
  session: state === "CLOCKED_OUT" ? null : { id: "s", clockInAt: "2026-10-12T08:00:00.000Z", clockOutAt: null, status: "OPEN", corrected: false, clockInSource: "ONLINE", breaks: state === "ON_BREAK" ? [{ id: "b", startedAt: "2026-10-12T09:00:00.000Z", endedAt: null }] : [] },
});

test("no monitoring before clock-in; on at clock-in; paused for breaks; stopped at clock-out", () => {
  assert.equal(mode({ projection: project(OUT, []) }), "STOPPED");
  assert.equal(mode({ projection: project(server("CLOCKED_IN"), []) }), "ACTIVE");
  assert.equal(mode({ projection: project(server("CLOCKED_IN"), [ev("BREAK_START")]) }), "PAUSED_BREAK", "break pauses immediately, even before sync");
  assert.equal(mode({ projection: project(server("ON_BREAK"), [ev("BREAK_END")]) }), "ACTIVE", "ending the break resumes");
  assert.equal(mode({ projection: project(server("CLOCKED_IN"), [ev("CLOCK_OUT")]) }), "STOPPED", "clock-out stops");
});

test("offline clock-in activates monitoring only as pending server confirmation", () => {
  const d = decideMonitoring({ ...base, projection: project(OUT, [ev("CLOCK_IN")]), pendingClockIn: true });
  assert.deepEqual([d.mode, d.pendingConfirmation], ["ACTIVE", true]);
  assert.match(d.reason, /pending server confirmation/);
  // The server rejected that clock-in: the projection falls back to the server state and monitoring stops.
  const rejected = { ...ev("CLOCK_IN"), status: "REJECTED" as const };
  assert.equal(mode({ projection: project(OUT, [rejected]), pendingClockIn: false }), "STOPPED");
});

test("never monitors without an active device, consent, a supported OS or verifiable attendance", () => {
  const clockedIn = project(server("CLOCKED_IN"), []);
  assert.equal(mode({ projection: clockedIn, deviceStatus: "REVOKED" }), "STOPPED");
  assert.equal(mode({ projection: clockedIn, deviceStatus: "NOT_REGISTERED" }), "STOPPED");
  assert.equal(mode({ projection: clockedIn, consented: false }), "STOPPED");
  assert.equal(mode({ projection: clockedIn, enabled: false }), "STOPPED", "turned off in the server settings");
  assert.match(decideMonitoring({ ...base, projection: clockedIn, enabled: false }).reason, /turned off by your organization/);
  assert.equal(mode({ projection: clockedIn, supported: false }), "STOPPED");
  assert.equal(mode({ projection: clockedIn, signedIn: false }), "STOPPED");
  assert.equal(mode({ projection: null }), "PAUSED_OFFLINE_OR_UNVERIFIED", "unknown attendance");
  assert.equal(mode({ projection: clockedIn, unverified: true }), "PAUSED_OFFLINE_OR_UNVERIFIED");
  assert.equal(mode({ projection: clockedIn, collectorError: "Could not save activity locally" }), "ERROR");
});

test("employee-facing collector states: locked, asleep, session inactive, idle, App Nap", () => {
  const clock = () => "09:30";
  const on = { collecting: true, currentApp: { name: "Code" }, idle: false, idleSinceMs: null, locked: false };
  assert.equal(collectorStateText(on, true, clock), "Code");
  assert.equal(collectorStateText(on, false, clock), "—", "nothing shown while not recording");
  assert.match(collectorStateText({ ...on, locked: true }, true, clock), /^Screen locked\. This time counts as idle/);
  assert.equal(collectorStateText({ ...on, locked: true, lockBreak: true }, true, clock), "Screen locked. Starting a break until you unlock.", "Windows Win+L");
  assert.match(collectorStateText({ ...on, asleep: true }, true, clock), /^Mac asleep/);
  assert.equal(collectorStateText({ ...on, locked: true, sessionInactive: true }, true, clock), "Session inactive (another user or logged out). Nothing is recorded.");
  assert.equal(collectorStateText({ ...on, idle: true }, true, clock), "Idle since 09:30 (no keyboard or mouse input)");
  assert.equal(collectorStateText({ ...on, idleSeconds: 150, idleThresholdSeconds: 300 }, true, clock), "Code (no input for 2 min; idle after 5 min)");
  assert.match(appNapText({ collecting: true, appNapPrevented: true })!, /App Nap is off.*can still sleep/);
  assert.equal(appNapText({ collecting: false, appNapPrevented: false }), null);
});

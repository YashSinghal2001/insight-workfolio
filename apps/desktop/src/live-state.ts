// What this device reports to the server as "right now" (ACTIVE / IDLE / UNOBSERVED) and when.
// Pure (no DOM, no Tauri) so node tests cover it. The open interval is never uploaded, so this
// report is the only way the dashboards learn that an employee is idle at this moment.
import type { ActivityCurrent } from "@workfolio/shared";

export type LiveState = ActivityCurrent["state"];

/** The native collector fields the live state is derived from. */
export interface LiveInputs {
  collecting: boolean;
  idle: boolean;
  locked: boolean;
  asleep?: boolean;
  sessionInactive?: boolean;
  lastSampleMs: number | null;
}

/**
 * The state to report, or null when nothing may be reported: not monitoring (clocked out, on a
 * break, no consent, signed out), offline, attendance still waiting to sync, or no sample yet.
 * A locked screen is IDLE (the employee notice says so); asleep or another user in front is UNOBSERVED.
 */
export function liveState(c: LiveInputs, monitoring: boolean, reachable: boolean): LiveState | null {
  if (!monitoring || !reachable || !c.collecting || c.lastSampleMs === null) return null;
  if (c.asleep || c.sessionInactive) return "UNOBSERVED";
  return c.idle || c.locked ? "IDLE" : "ACTIVE";
}

/** The last report sent: its state, when that state began and when it was sent (epoch ms). */
export interface Reported {
  state: LiveState;
  sinceMs: number;
  atMs: number;
}

/** The server shows UNKNOWN after 3 minutes without a report; one a minute keeps it current. */
export const KEEPALIVE_MS = 60_000;

/** Wait before retrying a failed report: the upload queue's backoff (2 s doubling, at most 5 min). */
export const retryDelayMs = (failures: number): number => Math.min(300_000, 2_000 * 2 ** (Math.max(1, failures) - 1));

/** Whether a report must go out by itself: the state changed, or the keepalive window has passed. */
export const reportDue = (prev: Reported | null, state: LiveState, now: number): boolean =>
  !prev || prev.state !== state || now - prev.atMs >= KEEPALIVE_MS;

/** The report for `state` at `now`. An unchanged state keeps its start; idle starts at the last input (or the lock). */
export const nextReport = (prev: Reported | null, state: LiveState, idleSinceMs: number | null, now: number): Reported => ({
  state,
  sinceMs: prev?.state === state ? prev.sinceMs : state === "IDLE" ? Math.min(idleSinceMs ?? now, now) : now,
  atMs: now,
});

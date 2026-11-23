// Automatic clock-out notice. The server decides and performs the clock-out (shift end + grace); this only
// explains it from the server's last /attendance/current. No Tauri imports, so node tests can drive it.
import type { AttendanceCurrent, AttendanceState } from "@workfolio/shared";

export interface ShiftNotice {
  /** before: shift not over yet; grace: past the shift end; due: the clock-out time has passed (refresh). */
  phase: "before" | "grace" | "due";
  shiftEndAt: string;
  autoClockOutAt: string;
  minutesLeft: number;
}

/** `state` is the projected state (queued local actions included); a local clock-out hides the notice. */
export function shiftNotice(current: AttendanceCurrent | null, state: AttendanceState | undefined, serverNowMs: number): ShiftNotice | null {
  if (!current?.autoClockOutAt || !current.shiftEndAt || !state || state === "CLOCKED_OUT") return null;
  const at = Date.parse(current.autoClockOutAt);
  const phase = serverNowMs >= at ? "due" : serverNowMs >= Date.parse(current.shiftEndAt) ? "grace" : "before";
  return { phase, shiftEndAt: current.shiftEndAt, autoClockOutAt: current.autoClockOutAt, minutesLeft: Math.max(0, Math.ceil((at - serverNowMs) / 60_000)) };
}

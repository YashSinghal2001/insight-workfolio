// Windows only: screen lock by hand (Win+L) → attendance break. macOS keeps a lock as IDLE (collector.rs
// LOCK_BREAKS; main.ts ignores this on macOS). The native collector decides what a hand lock is (while
// monitoring, recent input, not sleep/wake/display sleep; collector.rs) and emits `screen-lock`. This
// decides the attendance event, using the one attendance state machine (BREAK_START / BREAK_END
// through the durable offline queue). Pure (no DOM, no Tauri) so node tests cover it.
import type { AttendanceEventType, AttendanceState } from "@workfolio/shared";

/** Persisted (kv `lock_break:<userId>`) while a break that a screen lock opened is running. */
export interface LockBreakMarker {
  lockedAtMs: number;
}

export type LockInput =
  /** A confirmed hand lock at `atMs` (the break starts there). */
  | { kind: "locked"; atMs: number }
  /** Any unlock at `atMs`. */
  | { kind: "unlocked"; atMs: number }
  /** Startup and periodic check: the screen's lock state now (a missed unlock, or the app restarted). */
  | { kind: "check"; locked: boolean; nowMs: number };

export interface LockStep {
  event: { type: AttendanceEventType; atMs: number } | null;
  marker: LockBreakMarker | null;
}

/**
 * Only a break the lock opened is ever ended here: a break the employee started stays theirs. Repeated
 * lock or unlock notifications change nothing (the state machine allows one break at a time). A missed
 * unlock ends the break when the check sees the screen unlocked. Clocked out: nothing.
 */
export function lockBreakStep(state: AttendanceState | null, marker: LockBreakMarker | null, input: LockInput): LockStep {
  const mine = state === "ON_BREAK" ? marker : null;
  switch (input.kind) {
    case "locked":
      return state === "CLOCKED_IN" ? { event: { type: "BREAK_START", atMs: input.atMs }, marker: { lockedAtMs: input.atMs } } : { event: null, marker: mine };
    case "unlocked":
      // Never before the break started, even with a late or reordered notification.
      return mine ? { event: { type: "BREAK_END", atMs: Math.max(input.atMs, mine.lockedAtMs + 1) }, marker: null } : { event: null, marker: null };
    case "check":
      return mine && !input.locked ? { event: { type: "BREAK_END", atMs: Math.max(input.nowMs, mine.lockedAtMs + 1) }, marker: null } : { event: null, marker: mine };
  }
}

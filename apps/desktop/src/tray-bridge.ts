// Menu-bar (macOS) / system-tray (Windows) status: derived from app state, sent to the native tray only when it changes.
// No Tauri imports, so node tests can drive it; main.ts injects the `tray_update` call.
import type { Projection, SyncPhase } from "./sync.ts";

export type TrayState = "SIGNED_OUT" | "CLOCKED_OUT" | "WORKING" | "ON_BREAK" | "OFFLINE" | "ATTENTION";

export interface TrayUpdate {
  state: TrayState;
  /** Short status sentence (tray status line and the Status card). */
  label: string;
  /** ISO start of the running timer: clock-in while working, break start while on break. */
  since?: string;
  /** e.g. "Activity on · Screenshots paused (break)". */
  monitoring?: string;
}

export interface TrayInput {
  signedIn: boolean;
  /** Session online and the server reachable. */
  online: boolean;
  deviceStatus: "ACTIVE" | "REVOKED" | "NOT_REGISTERED" | null;
  projection: Projection | null;
  syncPhase?: SyncPhase;
  /** Attendance events the server rejected and the employee has not dismissed. */
  rejected: number;
  /** Activity / screenshot pill labels as shown in their panels ("On", "Paused (break)", "Needs permission"…); null = panel not shown. */
  activity: string | null;
  screenshots: string | null;
}

const BASE = { CLOCKED_IN: "Clocked in", ON_BREAK: "On break", CLOCKED_OUT: "Clocked out" } as const;

function attention(i: TrayInput, working: boolean): string | null {
  if (i.deviceStatus === "REVOKED") return "This device was revoked: attendance can't be recorded";
  if (i.deviceStatus === "NOT_REGISTERED" && i.online) return "Register this device to record attendance";
  if (i.syncPhase === "blocked") return "Attendance sync is blocked: open the app";
  if (i.rejected) return `${i.rejected} attendance change(s) not recorded by the server`;
  if (i.screenshots === "Needs permission") return "Screen recording permission needed";
  if (i.screenshots === "Error") return "Screenshots have a problem: open the app";
  if (i.activity === "Error") return "Activity monitoring has a problem: open the app";
  // Paused while clocked in and online means attendance can't be verified (a break says "Paused (break)").
  if (working && i.online && i.activity === "Paused") return "Monitoring paused: attendance can't be verified";
  return null;
}

/** Pure mapping from app state to the tray update. */
export function trayUpdate(i: TrayInput): TrayUpdate {
  if (!i.signedIn) return { state: "SIGNED_OUT", label: "Signed out: nothing is recorded" };
  const p = i.projection;
  const working = p?.state === "CLOCKED_IN";
  const since = working ? p.session?.clockInAt : p?.state === "ON_BREAK" ? p.session?.breaks.at(-1)?.startedAt : undefined;
  const monitoring = i.activity && i.screenshots ? `Activity ${i.activity.toLowerCase()} · Screenshots ${i.screenshots.toLowerCase()}` : undefined;
  const base = !p ? "Attendance status unknown" : `${BASE[p.state]}${p.unsynced ? " (not synced yet)" : ""}`;
  const problem = attention(i, working);
  const offline = !i.online || i.syncPhase === "offline";
  const [state, label]: [TrayState, string] = problem
    ? ["ATTENTION", problem]
    : offline
      ? ["OFFLINE", `Offline · ${base}`]
      : !p
        ? ["CLOCKED_OUT", base]
        : [working ? "WORKING" : p.state === "ON_BREAK" ? "ON_BREAK" : "CLOCKED_OUT", base];
  return { state, label, ...(since && { since }), ...(monitoring && { monitoring }) };
}

/**
 * Debounced, de-duplicated sender. `push` is cheap to call on every render; the native side hears
 * only real changes. Send failures (e.g. an older shell without `tray_update`) are logged, never thrown.
 * Returns true when the update differs from the previous one.
 */
export function trayBridge(send: (u: TrayUpdate) => Promise<unknown>, delayMs = 250, setTimer = setTimeout, clearTimer = clearTimeout) {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (u: TrayUpdate): boolean => {
    const key = JSON.stringify(u);
    if (key === last) return false;
    last = key;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      send(u).catch((err) => console.warn("tray_update failed", err));
    }, delayMs);
    return true;
  };
}

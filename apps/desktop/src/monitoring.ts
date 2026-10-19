// When activity monitoring runs. Attendance is the authority: the collector runs only while the
// employee is clocked in and not on a break, on an active registered device, after consent.
import type { Projection } from "./sync.ts";

export type MonitoringMode = "STOPPED" | "ACTIVE" | "PAUSED_BREAK" | "PAUSED_OFFLINE_OR_UNVERIFIED" | "ERROR";

export interface MonitoringInputs {
  signedIn: boolean;
  /** This build has a collector for the OS (macOS yes, Windows pending). */
  supported: boolean;
  deviceStatus: "ACTIVE" | "REVOKED" | "NOT_REGISTERED" | null;
  /** Organization-wide switch from the server's monitoring settings. */
  enabled: boolean;
  consented: boolean;
  /** Server snapshot + pending local events; null when the state is unknown. */
  projection: Projection | null;
  /** The current clock-in exists only locally (offline), not yet confirmed by the server. */
  pendingClockIn: boolean;
  /** Attendance cannot be verified: sync blocked (signed out/revoked) or offline past the policy limit. */
  unverified: boolean;
  collectorError: string | null;
}

export interface MonitoringDecision {
  mode: MonitoringMode;
  /** Plain-language explanation shown to the employee. */
  reason: string;
  /** ACTIVE on an offline clock-in that the server has not confirmed yet. */
  pendingConfirmation: boolean;
}

const decision = (mode: MonitoringMode, reason: string, pendingConfirmation = false): MonitoringDecision => ({ mode, reason, pendingConfirmation });

export function decideMonitoring(i: MonitoringInputs): MonitoringDecision {
  if (!i.signedIn) return decision("STOPPED", "Signed out. Nothing is recorded.");
  if (!i.supported) return decision("STOPPED", "Activity collection is not available on this operating system yet. Only attendance is recorded.");
  if (i.deviceStatus !== "ACTIVE") {
    return decision("STOPPED", i.deviceStatus === "REVOKED" ? "This device was revoked. Nothing is recorded." : "This device is not registered. Nothing is recorded.");
  }
  if (!i.enabled) return decision("STOPPED", "Activity monitoring is turned off by your organization. Only attendance is recorded.");
  if (!i.consented) return decision("STOPPED", "Read and acknowledge the monitoring notice below. Nothing is recorded until then.");
  if (!i.projection) return decision("PAUSED_OFFLINE_OR_UNVERIFIED", "Paused: your attendance status is unknown until this device reaches the server.");
  if (i.projection.state === "CLOCKED_OUT") return decision("STOPPED", "Off: you are not clocked in. Nothing is recorded.");
  if (i.projection.state === "ON_BREAK") return decision("PAUSED_BREAK", "Paused for your break. Nothing is recorded until you end it.");
  if (i.unverified) return decision("PAUSED_OFFLINE_OR_UNVERIFIED", "Paused: your attendance can't be verified (signed out, device problem or offline too long).");
  if (i.collectorError) return decision("ERROR", i.collectorError);
  return i.pendingClockIn
    ? decision("ACTIVE", "On: recording the active application and idle time. Your clock-in is offline and pending server confirmation.", true)
    : decision("ACTIVE", "On: recording the active application and idle time while you are clocked in.");
}

// ---- Screenshots ---------------------------------------------------------------------------

export type ScreenshotMode = MonitoringMode | "NEEDS_PERMISSION";

export interface ScreenshotInputs {
  signedIn: boolean;
  /** This build can capture (macOS 14+); Windows capture is not implemented. */
  supported: boolean;
  deviceStatus: "ACTIVE" | "REVOKED" | "NOT_REGISTERED" | null;
  /** Organization-wide screenshot switch (separate from activity monitoring). */
  enabled: boolean;
  /** The current screenshot-specific notice is acknowledged. */
  consented: boolean;
  /** macOS Screen Recording permission granted to this app. */
  permission: boolean;
  projection: Projection | null;
  pendingClockIn: boolean;
  unverified: boolean;
  error: string | null;
}

export interface ScreenshotDecision {
  mode: ScreenshotMode;
  reason: string;
}

/** When screenshots are taken: the attendance rules of activity monitoring, plus its own switch, notice and OS permission. */
export function decideScreenshots(i: ScreenshotInputs): ScreenshotDecision {
  const d = (mode: ScreenshotMode, reason: string) => ({ mode, reason });
  if (!i.signedIn) return d("STOPPED", "Signed out. No screenshots are taken.");
  if (!i.supported) return d("STOPPED", "Screenshots are not available on this operating system. None are taken.");
  if (i.deviceStatus !== "ACTIVE") return d("STOPPED", "This device is not registered or was revoked. No screenshots are taken.");
  if (!i.enabled) return d("STOPPED", "Screenshots are turned off by your organization. None are taken.");
  if (!i.consented) return d("STOPPED", "Read and acknowledge the screenshot notice below. No screenshots are taken until then.");
  if (!i.projection) return d("PAUSED_OFFLINE_OR_UNVERIFIED", "Paused: your attendance status is unknown until this device reaches the server.");
  if (i.projection.state === "CLOCKED_OUT") return d("STOPPED", "Off: you are not clocked in. No screenshots are taken.");
  if (i.projection.state === "ON_BREAK") return d("PAUSED_BREAK", "Paused for your break. No screenshots are taken until you end it.");
  if (i.unverified) return d("PAUSED_OFFLINE_OR_UNVERIFIED", "Paused: your attendance can't be verified (signed out, device problem or offline too long).");
  if (!i.permission) return d("NEEDS_PERMISSION", "Waiting for you to allow screen recording for this app in macOS. No screenshots are taken until then.");
  if (i.error) return d("ERROR", i.error);
  return d(
    "ACTIVE",
    i.pendingClockIn
      ? "On: a screenshot of your main screen is taken at the interval below. Your clock-in is offline and pending server confirmation."
      : "On: a screenshot of your main screen is taken at the interval below while you are clocked in.",
  );
}

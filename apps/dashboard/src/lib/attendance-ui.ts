import { formatDuration, type AnomalyThresholds, type MissingClockOutReason, type MonthlyAttendanceDay } from "@workfolio/shared";

/** Status tones as in components/kit (kept here as a string union so this file stays React-free). */
type Tone = "success" | "warning" | "danger" | "neutral" | "info";

export const ATTENDANCE_TABS = [
  { id: "live", label: "Live" },
  { id: "daily", label: "Daily" },
  { id: "monthly", label: "Monthly" },
  { id: "late", label: "Late" },
  { id: "missing", label: "Missing clock-outs" },
  { id: "shifts", label: "Shifts" },
] as const;
export type AttendanceTab = (typeof ATTENDANCE_TABS)[number]["id"];

/** `?tab=`; the older `?view=` (bookmarks, browser suites) is still read. Unknown → live. */
export function parseAttendanceTab(params: URLSearchParams): AttendanceTab {
  const v = params.get("tab") ?? params.get("view");
  return ATTENDANCE_TABS.find((t) => t.id === v)?.id ?? "live";
}

/** Monthly matrix codes. NO_POLICY / NOT_YET_DUE have no code (blank cell, label in the title). */
export const DAY_CODE: Record<MonthlyAttendanceDay["status"], { code: string; label: string; tone: Tone }> = {
  PRESENT: { code: "P", label: "Present", tone: "success" },
  LATE: { code: "L", label: "Late", tone: "warning" },
  ABSENT: { code: "A", label: "Absent", tone: "danger" },
  ON_LEAVE: { code: "LV", label: "On leave", tone: "info" },
  HOLIDAY: { code: "H", label: "Holiday", tone: "info" },
  NOT_SCHEDULED: { code: "WO", label: "Weekly off", tone: "neutral" },
  OPEN: { code: "OPEN", label: "Shift still open", tone: "danger" },
  NO_POLICY: { code: "", label: "No schedule", tone: "neutral" },
  NOT_YET_DUE: { code: "", label: "Not yet due", tone: "neutral" },
};

/** Hover text for one matrix cell: date, status, In–Out, worked and late minutes. */
export function dayTitle(d: MonthlyAttendanceDay): string {
  const parts = [d.date, DAY_CODE[d.status].label];
  if (d.firstInLocal || d.lastOutLocal) parts.push(`In ${d.firstInLocal ?? "—"} – Out ${d.lastOutLocal ?? "—"}`);
  if (d.workedMinutes > 0) parts.push(`worked ${formatDuration(d.workedMinutes * 60_000)}`);
  if (d.lateMinutes) parts.push(`late by ${d.lateMinutes} min`);
  return parts.join(" · ");
}

/** Plain-language reason chips for a missing clock-out (thresholds come from the API response). */
export function reasonText(reason: MissingClockOutReason, t: AnomalyThresholds): { label: string; explain: string } {
  const h = (m: number) => (m % 60 ? formatDuration(m * 60_000) : `${m / 60} h`);
  switch (reason) {
    case "PREVIOUS_DAY":
      return { label: "From an earlier day", explain: "Clocked in on an earlier date and never clocked out." };
    case "WORKDAY_ENDED":
      return { label: "Workday over", explain: `The working day ended more than ${h(t.workdayGraceMinutes)} ago and the shift is still open.` };
    case "MAX_SHIFT_EXCEEDED":
      return { label: "Very long shift", explain: `Open for more than ${h(t.maxShiftMinutes)}.` };
    case "DEVICE_STALE":
      return { label: "Device silent", explain: `The desktop app has not been in contact for more than ${t.staleDeviceMinutes} min while clocked in.` };
    case "LONG_BREAK":
      return { label: "Long break", explain: `A break has been running for more than ${h(t.longBreakMinutes)}.` };
  }
}

/** Elapsed time: "just now", "12 m ago", "3 h 44 m ago", "6 h ago", "2 d ago" (negative = clock skew = just now). */
export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} m ago` : `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Device freshness: "Online" only when the API says so; otherwise when it was last seen. */
export function lastSeenLabel(online: boolean, lastSeenAt: string | null, now: number): string {
  if (online) return "Online";
  return lastSeenAt ? `Last seen ${ago(now - Date.parse(lastSeenAt))}` : "Never seen";
}

/** How the last attendance event reached the server (not whether the device is online now). */
export const eventSourceLabel = (source: "ONLINE" | "OFFLINE_SYNC") => (source === "ONLINE" ? "Sent online" : "Synced later");

import {
  ANOMALY_THRESHOLDS,
  attendanceTotals,
  DEFAULT_POLICY,
  localDate,
  zonedToUtc,
  type AttendanceOverviewRow,
  type OverviewFreshness,
} from "@workfolio/shared";
import type { Tone } from "@/components/kit";

export type MemberRow = AttendanceOverviewRow & OverviewFreshness;

/** Per-member data from the optional reads (/attendance/daily, /activity/overview); null/false when unavailable. */
export interface MemberExtras {
  onLeave: boolean;
  /** Today is a workday under the schedule; null = unknown or no schedule (the 8 h default applies). */
  scheduled: boolean | null;
  /** activeMs / clockedInMs today, 0..1; null when not monitored or nothing clocked in. */
  activeShare: number | null;
}

export const NO_EXTRAS: MemberExtras = { onLeave: false, scheduled: null, activeShare: null };

export const MEMBER_STATES = ["WORKING", "ON_BREAK", "STOPPED", "ON_LEAVE", "APP_NOT_INSTALLED", "NOT_STARTED", "OFFLINE"] as const;
export type MemberState = (typeof MEMBER_STATES)[number];

export const STATE_META: Record<MemberState, { label: string; tone: Tone }> = {
  WORKING: { label: "Working", tone: "success" },
  ON_BREAK: { label: "On break", tone: "warning" },
  STOPPED: { label: "Stopped", tone: "danger" },
  ON_LEAVE: { label: "On leave", tone: "info" },
  APP_NOT_INSTALLED: { label: "App not installed", tone: "neutral" },
  NOT_STARTED: { label: "Not started", tone: "warning" },
  OFFLINE: { label: "Offline", tone: "neutral" },
};

/** Clocked in (not on a break) with no device contact for this long: shown as Offline, not Working (contract §9). */
export const STALE_DEVICE_MS = ANOMALY_THRESHOLDS.staleDeviceMinutes * 60_000;

export interface MemberCard {
  state: MemberState;
  /** "Working since 09:12", "Stopped 3 h 44 m ago", … */
  statusLine: string;
  /** "Online" only when the overview says online; else "Last seen …" / "Never seen". */
  presence: string;
  /** Clock-in of the open or today's session, "HH:MM" in the employee's zone. */
  clockIn: string | null;
  /** Net worked time today (latest session, clipped to the employee's local day). */
  workedMs: number;
  /** Scheduled time today; null on a non-workday. */
  scheduledMs: number | null;
  activeShare: number | null;
  missingClockOut: boolean;
}

/** "just now", "12 m ago", "3 h 44 m ago", "6 h ago", "2 d ago". */
export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} m ago` : `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export const clockTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));

export function describeMember(row: MemberRow, extras: MemberExtras, now: number): MemberCard {
  const tz = row.timezone;
  const today = localDate(now, tz);
  const s = row.session;
  const open = s && !s.clockOutAt ? s : null;
  const openBreak = open?.breaks.find((b) => !b.endedAt);
  const seenMs = row.lastSeenAt ? now - Date.parse(row.lastSeenAt) : Infinity;

  const [state, statusLine]: [MemberState, string] = open
    ? openBreak
      ? ["ON_BREAK", `On break since ${clockTime(openBreak.startedAt, tz)}`]
      : seenMs > STALE_DEVICE_MS
        ? ["OFFLINE", `Clocked in ${clockTime(open.clockInAt, tz)}, no contact from the desktop app`]
        : ["WORKING", `Working since ${clockTime(open.clockInAt, tz)}`]
    : extras.onLeave
      ? ["ON_LEAVE", "On approved leave today"]
      : !row.lastSeenAt
        ? ["APP_NOT_INSTALLED", "Desktop app not installed"]
        : s?.clockOutAt && localDate(s.clockOutAt, tz) === today
          ? ["STOPPED", `Stopped ${ago(now - Date.parse(s.clockOutAt))}`]
          : ["NOT_STARTED", "Not started yet today"];

  // Today's part of the latest session: every interval clipped to the employee's local midnight.
  const midnight = Date.parse(zonedToUtc(`${today}T00:00`, tz));
  const clip = (iso: string) => new Date(Math.max(Date.parse(iso), midnight)).toISOString();
  const touchesToday = s && (!s.clockOutAt || Date.parse(s.clockOutAt) > midnight);
  const workedMs = touchesToday
    ? attendanceTotals(
        { start: clip(s.clockInAt), end: s.clockOutAt && clip(s.clockOutAt) },
        s.breaks.filter((b) => !b.endedAt || Date.parse(b.endedAt) > midnight).map((b) => ({ start: clip(b.startedAt), end: b.endedAt && clip(b.endedAt) })),
        now,
      ).netMs
    : 0;

  return {
    state,
    statusLine,
    presence: row.online === true ? "Online" : row.lastSeenAt ? `Last seen ${ago(seenMs)}` : "Never seen",
    clockIn: touchesToday ? clockTime(s.clockInAt, tz) : null,
    workedMs,
    scheduledMs: extras.scheduled === false ? null : DEFAULT_POLICY.scheduledDailyMinutes * 60_000,
    activeShare: extras.activeShare,
    missingClockOut: row.missingClockOut,
  };
}

export const CHIPS = ["ALL", "WORKING", "ON_BREAK", "STOPPED", "ON_LEAVE", "APP_NOT_INSTALLED", "NOT_STARTED", "OFFLINE"] as const;
export type Chip = (typeof CHIPS)[number];

export function countByChip(states: MemberState[]): Record<Chip, number> {
  const counts = Object.fromEntries(CHIPS.map((c) => [c, 0])) as Record<Chip, number>;
  counts.ALL = states.length;
  for (const s of states) counts[s]++;
  return counts;
}

/** Chip + case-insensitive name/code search. */
export const matches = (m: { fullName: string; employeeCode: string; state: MemberState }, chip: Chip, q: string) =>
  (chip === "ALL" || m.state === chip) && (!q || `${m.fullName} ${m.employeeCode}`.toLowerCase().includes(q.trim().toLowerCase()));

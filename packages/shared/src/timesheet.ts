import { z } from "zod";
import { attendanceTotals } from "./attendance.js";

// ---- Policy -----------------------------------------------------------------------
// Configurable MVP defaults, not legal rules. The API reads overrides from env and returns the
// effective policy with every timesheet so clients never assume their own values.

export interface AttendancePolicy {
  /** ISO weekday the workweek starts on: 1 = Monday … 7 = Sunday. */
  weekStartsOn: number;
  /** Scheduled work per worked day; net time above it is reported as overtime (not payroll). */
  scheduledDailyMinutes: number;
  /** Offline events older than this are rejected on sync and need a correction. */
  maxOfflineAgeDays: number;
}

export const DEFAULT_POLICY: AttendancePolicy = { weekStartsOn: 1, scheduledDailyMinutes: 8 * 60, maxOfflineAgeDays: 7 };

// ---- Time zones -------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Local calendar date (YYYY-MM-DD) of a UTC instant in `timeZone`. */
export function localDate(instant: string | number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    })
      .formatToParts(utcMs)
      .map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Wall-clock time in `timeZone` ("2026-03-08T09:30") to a UTC ISO instant. Times skipped by a DST
 * jump resolve forward; repeated times resolve to the first occurrence.
 */
export function zonedToUtc(local: string, timeZone: string): string {
  const wall = Date.parse(`${local.length === 16 ? `${local}:00` : local}Z`);
  if (Number.isNaN(wall)) throw new RangeError(`Invalid local time: ${local}`);
  let t = wall - offsetMs(wall, timeZone);
  t = wall - offsetMs(t, timeZone);
  return new Date(t).toISOString();
}

/** UTC instant to wall-clock "YYYY-MM-DDTHH:mm" in `timeZone` (the inverse of zonedToUtc). */
export function toZonedLocal(instant: string | number, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(instant));
  return `${localDate(instant, timeZone)}T${time}`;
}

/** UTC instant to ISO 8601 local time with its offset in `timeZone`, e.g. "2026-10-28T09:00:00+05:30". */
export function zonedIso(instant: string | number, timeZone: string): string {
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  const off = offsetMs(ms, timeZone);
  const abs = Math.abs(off) / 60_000;
  const sign = off < 0 ? "-" : "+";
  return `${new Date(Math.floor(ms / 1000) * 1000 + off).toISOString().slice(0, 19)}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Calendar arithmetic on YYYY-MM-DD strings (no time zone involved). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** First day of the workweek containing `date`. */
export function weekStart(date: string, weekStartsOn = DEFAULT_POLICY.weekStartsOn): string {
  const isoDay = new Date(`${date}T00:00:00Z`).getUTCDay() || 7; // 1 = Mon … 7 = Sun
  return addDays(date, -((isoDay - weekStartsOn + 7) % 7));
}

// ---- Timesheet engine ---------------------------------------------------------------

export interface TimesheetSessionInput {
  id: string;
  clockInAt: string;
  clockOutAt: string | null;
  breaks: { startedAt: string; endedAt: string | null }[];
  corrected?: boolean;
  clockInSource?: SessionSource;
}

export type SessionSource = "ONLINE" | "OFFLINE_SYNC" | "CORRECTION";

export interface TimesheetDay {
  /** Local date of clock-in; a midnight-crossing shift belongs to the day it started. */
  date: string;
  shifts: number;
  firstClockIn: string;
  /** Latest clock-out of the day's completed shifts (null if none completed). */
  lastClockOut: string | null;
  /** Totals of completed shifts only: these are the reportable hours. */
  grossMs: number;
  breakMs: number;
  netMs: number;
  /** A shift is still open: not finalized, excluded from the totals above. */
  incomplete: boolean;
  /** Net time so far of the open shift (live, informational). */
  inProgressNetMs: number;
  /** Completed net time beyond the scheduled day. Reported, never applied to payroll. */
  overtimeMs: number;
  corrected: boolean;
  /** Shifts whose clock-in was uploaded from the offline queue. */
  offlineShifts: number;
}

export interface TimesheetTotals {
  shifts: number;
  grossMs: number;
  breakMs: number;
  netMs: number;
  overtimeMs: number;
  incompleteDays: number;
}

export interface TimesheetWeek extends TimesheetTotals {
  weekStart: string;
  days: number;
}

export interface Timesheet {
  from: string;
  to: string;
  timeZone: string;
  policy: AttendancePolicy;
  days: TimesheetDay[];
  weeks: TimesheetWeek[];
  totals: TimesheetTotals;
}

const emptyTotals = (): TimesheetTotals => ({ shifts: 0, grossMs: 0, breakMs: 0, netMs: 0, overtimeMs: 0, incompleteDays: 0 });

function addTo(t: TimesheetTotals, d: TimesheetDay) {
  t.shifts += d.shifts;
  t.grossMs += d.grossMs;
  t.breakMs += d.breakMs;
  t.netMs += d.netMs;
  t.overtimeMs += d.overtimeMs;
  t.incompleteDays += d.incomplete ? 1 : 0;
}

/**
 * Daily and weekly totals for sessions whose clock-in falls on a local date in [from, to].
 * Durations are differences of UTC instants (DST-safe); only completed shifts count.
 * Days without shifts are omitted: no schedule of working days is assumed.
 */
export function buildTimesheet(
  sessions: TimesheetSessionInput[],
  opts: { from: string; to: string; timeZone: string; policy?: AttendancePolicy; now?: number },
): Timesheet {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const now = opts.now ?? Date.now();
  const byDay = new Map<string, TimesheetSessionInput[]>();
  for (const s of [...sessions].sort((a, b) => a.clockInAt.localeCompare(b.clockInAt))) {
    const date = localDate(s.clockInAt, opts.timeZone);
    if (date < opts.from || date > opts.to) continue;
    byDay.set(date, [...(byDay.get(date) ?? []), s]);
  }

  const days: TimesheetDay[] = [...byDay].map(([date, list]) => {
    const day: TimesheetDay = {
      date, shifts: list.length, firstClockIn: list[0]!.clockInAt, lastClockOut: null, grossMs: 0, breakMs: 0, netMs: 0,
      incomplete: false, inProgressNetMs: 0, overtimeMs: 0, corrected: false, offlineShifts: 0,
    };
    for (const s of list) {
      const t = attendanceTotals(
        { start: s.clockInAt, end: s.clockOutAt },
        s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt })),
        now,
      );
      day.corrected ||= !!s.corrected;
      if (s.clockInSource === "OFFLINE_SYNC") day.offlineShifts++;
      if (!s.clockOutAt) {
        day.incomplete = true;
        day.inProgressNetMs += t.netMs;
        continue;
      }
      day.grossMs += t.elapsedMs;
      day.breakMs += t.breakMs;
      day.netMs += t.netMs;
      if (!day.lastClockOut || s.clockOutAt > day.lastClockOut) day.lastClockOut = s.clockOutAt;
    }
    day.overtimeMs = Math.max(0, day.netMs - policy.scheduledDailyMinutes * 60_000);
    return day;
  });

  const weeks = new Map<string, TimesheetWeek>();
  const totals = emptyTotals();
  for (const d of days) {
    const key = weekStart(d.date, policy.weekStartsOn);
    const w = weeks.get(key) ?? { weekStart: key, days: 0, ...emptyTotals() };
    w.days++;
    addTo(w, d);
    addTo(totals, d);
    weeks.set(key, w);
  }
  return { from: opts.from, to: opts.to, timeZone: opts.timeZone, policy, days, weeks: [...weeks.values()], totals };
}

// ---- Request schemas ------------------------------------------------------------------

const dateSchema = z.iso.date();
export const MAX_RANGE_DAYS = 92;

/** Inclusive local-date range in the employee's time zone. */
export const dateRangeSchema = z
  .object({ from: dateSchema, to: dateSchema })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= (MAX_RANGE_DAYS - 1) * DAY_MS, `Range is limited to ${MAX_RANGE_DAYS} days`);

export const employeeFilterSchema = z.object({ employeeId: z.uuid().optional() });

/**
 * A forgotten clock-out: the session is still open and was clocked in on an earlier local date (in the
 * employee's time zone). Nothing is closed automatically; the employee requests a correction.
 */
export function missingClockOut(session: { clockInAt: string; clockOutAt: string | null } | null, timeZone: string, now = Date.now()): boolean {
  return !!session && !session.clockOutAt && localDate(session.clockInAt, timeZone) < localDate(now, timeZone);
}

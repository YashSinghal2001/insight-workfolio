// Overview aggregate (W2-OVERVIEW): GET /overview?date=&teamId=, one round trip for the admin Overview page.
// Every section reuses an existing read (attendance summary/overview, schedule daily, anomalies, timesheet
// engine, screenshots gallery, holidays, leave); a section the caller may not see is null, never an error.
import { z } from "zod";
import type { EmployeeRef } from "./api.js";
import type { AttendanceState } from "./attendance.js";
import type { AttendanceAnomaly } from "./attendance-anomalies.js";
import type { LeavePortion } from "./leave.js";
import type { DailyAttendanceRow } from "./schedule.js";
import type { ScreenshotGalleryItem } from "./screenshots.js";

export const overviewQuerySchema = z.object({ date: z.iso.date().optional(), teamId: z.uuid().optional() });
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;

/** Local days in the workload chart (the date and the 6 before it). */
export const WORKLOAD_DAYS = 7;
/** Upcoming windows, in local days from the date (inclusive). */
export const UPCOMING_HOLIDAY_DAYS = 30;
export const UPCOMING_LEAVE_DAYS = 14;
export const RECENT_SCREENSHOTS = 12;
export const TOP_APPS = 8;

/**
 * Workload of one member on one local day, by completed net work (breaks excluded) against the scheduled day
 * (AttendancePolicy.scheduledDailyMinutes, 480): more than 110 % = over-worked, under 80 % = less utilised,
 * otherwise healthy. A day without completed work is not counted (rest day, absence, or a shift still open).
 */
export const WORKLOAD_THRESHOLDS = { overworkedAbove: 1.1, lessUtilisedBelow: 0.8 } as const;
export const WORKLOAD_BUCKETS = ["OVERWORKED", "HEALTHY", "LESS_UTILISED"] as const;
export type WorkloadBucket = (typeof WORKLOAD_BUCKETS)[number];

export function workloadBucket(workedMinutes: number, scheduledMinutes: number): WorkloadBucket | null {
  if (!(workedMinutes > 0) || !(scheduledMinutes > 0)) return null;
  const ratio = workedMinutes / scheduledMinutes;
  return ratio > WORKLOAD_THRESHOLDS.overworkedAbove ? "OVERWORKED" : ratio < WORKLOAD_THRESHOLDS.lessUtilisedBelow ? "LESS_UTILISED" : "HEALTHY";
}

export interface WorkloadDay {
  date: string;
  overworked: number;
  healthy: number;
  lessUtilised: number;
}

/** Members per bucket for each date, from each member's worked minutes by local date. */
export function workloadDays(dates: string[], members: Map<string, number>[], scheduledMinutes: number): WorkloadDay[] {
  return dates.map((date) => {
    const day: WorkloadDay = { date, overworked: 0, healthy: 0, lessUtilised: 0 };
    for (const m of members) {
      const b = workloadBucket(m.get(date) ?? 0, scheduledMinutes);
      if (b === "OVERWORKED") day.overworked++;
      else if (b === "HEALTHY") day.healthy++;
      else if (b === "LESS_UTILISED") day.lessUtilised++;
    }
    return day;
  });
}

export interface OverviewKpis {
  /** Active employees (account active, employment not terminated). */
  totalMembers: number;
  workingNow: number;
  onBreak: number;
  /** Worked on the date, no shift open now. */
  clockedOut: number;
  /** No clock-in on the date (not "absent": leave, rest days and schedules are not considered). */
  notStarted: number;
  /** Approved leave covering the date. */
  onLeave: number;
  /** Active members without a registered (non-revoked) device. */
  appNotInstalled: number;
  /** null when no enabled work schedule applied on the date (nobody is labelled late or absent). */
  late: number | null;
  absent: number | null;
  missingClockOuts: number;
  screenshotsStored: number;
  netWorkMs: number;
  breakMs: number;
}

export interface OverviewWorkHoursRow {
  employee: EmployeeRef;
  /** Net minutes on the date (breaks excluded); an open shift counts up to now. */
  workedMinutes: number;
  firstClockInAt: string | null;
  state: AttendanceState;
  missingClockOut: boolean;
  online: boolean;
  lastSeenAt: string | null;
}

export interface OverviewAppTotal {
  applicationName: string;
  activeMs: number;
}

export interface OverviewLeave {
  id: string;
  employee: EmployeeRef;
  startDate: string;
  endDate: string;
  portion: LeavePortion;
  leaveType: string;
}

export interface OverviewResponse {
  date: string;
  teamId: string | null;
  generatedAt: string;
  kpis: OverviewKpis;
  workload: { scheduledDailyMinutes: number; thresholds: typeof WORKLOAD_THRESHOLDS; days: WorkloadDay[] };
  /** Active time per application on the date (top TOP_APPS, the rest as `otherMs`); null without activity:read-all. */
  topApps: { totalActiveMs: number; otherMs: number; items: OverviewAppTotal[] } | null;
  late: DailyAttendanceRow[];
  absent: DailyAttendanceRow[];
  missingClockOuts: AttendanceAnomaly[];
  workHours: OverviewWorkHoursRow[];
  /** Metadata only; images load through /screenshots/:id/content (access-logged). null without screenshots:read. */
  recentScreenshots: ScreenshotGalleryItem[] | null;
  upcomingHolidays: { id: string; date: string; name: string }[];
  /** Approved leave overlapping the next UPCOMING_LEAVE_DAYS days; null without leave:read-all. */
  upcomingLeaves: OverviewLeave[] | null;
  pendingApprovals: { leave: number; corrections: number };
}

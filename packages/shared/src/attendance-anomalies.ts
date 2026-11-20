import { z } from "zod";
import type { EmployeeRef } from "./api.js";
import type { AccountStatus, EmploymentStatus } from "./schemas.js";
import { addDays, localDate, missingClockOut, zonedToUtc } from "./timesheet.js";

// ---- Missing clock-out detection (flag only) --------------------------------------------------
// Computed from stored records on request. Nothing is ever closed or changed: the fix is a correction.

export const MISSING_CLOCK_OUT_REASONS = ["PREVIOUS_DAY", "WORKDAY_ENDED", "MAX_SHIFT_EXCEEDED", "DEVICE_STALE", "LONG_BREAK"] as const;
export type MissingClockOutReason = (typeof MISSING_CLOCK_OUT_REASONS)[number];

export interface AnomalyThresholds {
  /** Scheduled working day after the expected start. */
  workdayMinutes: number;
  /** Allowed after the end of the working day (scheduled, or the end of the clock-in's local day without one). */
  workdayGraceMinutes: number;
  maxShiftMinutes: number;
  /** No device contact for this long while clocked in (not on a break). */
  staleDeviceMinutes: number;
  longBreakMinutes: number;
}

/** Contract defaults (docs/IMPLEMENTATION-CONTRACTS.md §9) until the owner decides otherwise. */
export const ANOMALY_THRESHOLDS: AnomalyThresholds = {
  workdayMinutes: 8 * 60,
  workdayGraceMinutes: 2 * 60,
  maxShiftMinutes: 14 * 60,
  staleDeviceMinutes: 30,
  longBreakMinutes: 2 * 60,
};

export interface AttendanceAnomaly {
  employee: EmployeeRef;
  /** Disabled or terminated people with an open shift are still listed. */
  accountStatus: AccountStatus;
  employmentStatus: EmploymentStatus;
  sessionId: string;
  clockInAt: string;
  /** Clock-in in the employee's zone, "YYYY-MM-DDTHH:mm". */
  clockInLocal: string;
  openForMinutes: number;
  /** Latest contact from any of the employee's active devices. */
  lastDeviceSeenAt: string | null;
  openBreakSince: string | null;
  /** Never empty. */
  reasons: MissingClockOutReason[];
  pendingCorrectionId: string | null;
}

export interface MissingClockOutsResponse {
  generatedAt: string;
  thresholds: AnomalyThresholds;
  items: AttendanceAnomaly[];
}

export const missingClockOutsQuerySchema = z.strictObject({ teamId: z.uuid().optional() });
export type MissingClockOutsQuery = z.infer<typeof missingClockOutsQuerySchema>;

export interface AnomalyInput {
  clockInAt: string;
  clockOutAt: string | null;
  timeZone: string;
  /** "HH:MM" when a schedule makes the clock-in's local date a workday; null otherwise. */
  expectedStart: string | null;
  lastDeviceSeenAt: string | null;
  openBreakSince: string | null;
}

/**
 * End of the working day of a shift (before the grace period). With a schedule: expected start + workday on
 * the clock-in's local date. Without one, or when the clock-in is already past that (an evening shift): the
 * end of the clock-in's local day (next local midnight, DST-safe).
 */
export function workdayEnd(input: Pick<AnomalyInput, "clockInAt" | "timeZone" | "expectedStart">, t = ANOMALY_THRESHOLDS): number {
  const date = localDate(input.clockInAt, input.timeZone);
  if (input.expectedStart) {
    const end = Date.parse(zonedToUtc(`${date}T${input.expectedStart}`, input.timeZone)) + t.workdayMinutes * 60_000;
    if (Date.parse(input.clockInAt) < end) return end;
  }
  return Date.parse(zonedToUtc(`${addDays(date, 1)}T00:00`, input.timeZone));
}

/** Why an open shift looks forgotten, in MISSING_CLOCK_OUT_REASONS order; empty for a closed or healthy one. Thresholds are strict. */
export function detectAnomalies(input: AnomalyInput, now: number, t = ANOMALY_THRESHOLDS): MissingClockOutReason[] {
  if (input.clockOutAt) return [];
  const clockIn = Date.parse(input.clockInAt);
  const over = (since: number, minutes: number) => now - since > minutes * 60_000;
  const contact = Math.max(clockIn, input.lastDeviceSeenAt ? Date.parse(input.lastDeviceSeenAt) : 0);
  const hit: Record<MissingClockOutReason, boolean> = {
    PREVIOUS_DAY: missingClockOut(input, input.timeZone, now),
    WORKDAY_ENDED: over(workdayEnd(input, t), t.workdayGraceMinutes),
    MAX_SHIFT_EXCEEDED: over(clockIn, t.maxShiftMinutes),
    DEVICE_STALE: !input.openBreakSince && over(contact, t.staleDeviceMinutes),
    LONG_BREAK: !!input.openBreakSince && over(Date.parse(input.openBreakSince), t.longBreakMinutes),
  };
  return MISSING_CLOCK_OUT_REASONS.filter((r) => hit[r]);
}

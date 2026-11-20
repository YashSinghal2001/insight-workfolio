import { z } from "zod";
import type { EmployeeRef } from "./api.js";
import { ALERT_RULE_KINDS } from "./alerts.js";
import type { MonthlyAttendanceDay } from "./attendance-reports.js";
import { MAX_RANGE_DAYS } from "./timesheet.js";

/**
 * Risk users (W3-APPS): computed, nothing stored. Triggers are the alert rows raised in the range (one per rule,
 * employee and local date; docs/alerts.md) grouped by rule kind, plus "less working hours" from the daily
 * attendance rules (holidays, approved leave and unscheduled days never count).
 */
export const RISK_TRIGGERS = ["LESS_WORKING_HOURS", ...ALERT_RULE_KINDS] as const;
export type RiskTrigger = (typeof RISK_TRIGGERS)[number];

export const RISK_TRIGGER_LABEL: Record<RiskTrigger, string> = {
  LESS_WORKING_HOURS: "Less working hours",
  LATE_CLOCK_IN: "Late clock-in",
  NOT_CLOCKED_IN_BY: "Not clocked in by the set time",
  IDLE_SHARE_ABOVE: "High idle share",
  NO_ACTIVITY_FOR: "No activity while clocked in",
};

/** Less working hours: average worked time per scheduled day below this share of the scheduled day (7 h of 8 h). */
export const RISK_LESS_HOURS_SHARE = 7 / 8;

/** Days the schedule expected work: the rest (holiday, leave, rest day, not yet due, open shift, no schedule) never count. */
const SCHEDULED: readonly MonthlyAttendanceDay["status"][] = ["PRESENT", "LATE", "ABSENT"];

export interface LessHours {
  scheduledDays: number;
  /** Scheduled days worked below the threshold (the trigger's count). */
  shortDays: number;
  averageWorkedMinutes: number;
  thresholdMinutes: number;
}

/** The less-working-hours figures of one employee's days, or null when it does not trigger. */
export function lessHours(days: readonly Pick<MonthlyAttendanceDay, "status" | "workedMinutes">[], scheduledDailyMinutes: number, share = RISK_LESS_HOURS_SHARE): LessHours | null {
  const scheduled = days.filter((d) => SCHEDULED.includes(d.status));
  if (!scheduled.length || scheduledDailyMinutes <= 0) return null;
  const thresholdMinutes = Math.round(scheduledDailyMinutes * share);
  const averageWorkedMinutes = Math.round(scheduled.reduce((n, d) => n + d.workedMinutes, 0) / scheduled.length);
  if (averageWorkedMinutes >= thresholdMinutes) return null;
  return { scheduledDays: scheduled.length, shortDays: scheduled.filter((d) => d.workedMinutes < thresholdMinutes).length, averageWorkedMinutes, thresholdMinutes };
}

export interface RiskTriggerCount {
  trigger: RiskTrigger;
  /** Days the trigger was violated in the range. */
  count: number;
}
export interface RiskUser {
  employee: EmployeeRef;
  /** In RISK_TRIGGERS order; never empty. */
  triggers: RiskTriggerCount[];
  total: number;
  lessHours: LessHours | null;
}
export interface RiskUsersResponse {
  from: string;
  to: string;
  teamId: string | null;
  scheduledDailyMinutes: number;
  lessHoursShare: number;
  /** Most severe first: more distinct triggers, then more violations, then name. */
  items: RiskUser[];
  /** Per trigger: employees affected and total violations (RISK_TRIGGERS order, zero rows included). */
  rules: { trigger: RiskTrigger; employees: number; count: number }[];
}

/** Severity order: more distinct triggers first, then more violations, then name. */
export function sortRiskUsers(items: RiskUser[]): RiskUser[] {
  return [...items].sort((a, b) => b.triggers.length - a.triggers.length || b.total - a.total || a.employee.fullName.localeCompare(b.employee.fullName));
}

/** Per-trigger totals over the risky employees. */
export function riskRules(items: readonly RiskUser[]): RiskUsersResponse["rules"] {
  return RISK_TRIGGERS.map((trigger) => {
    const hits = items.flatMap((i) => i.triggers.filter((t) => t.trigger === trigger));
    return { trigger, employees: hits.length, count: hits.reduce((n, t) => n + t.count, 0) };
  });
}

const DAY_MS = 86_400_000;
export const riskUsersQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date(), teamId: z.uuid().optional() })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= (MAX_RANGE_DAYS - 1) * DAY_MS, `Range is limited to ${MAX_RANGE_DAYS} days`);
export type RiskUsersQuery = z.infer<typeof riskUsersQuerySchema>;

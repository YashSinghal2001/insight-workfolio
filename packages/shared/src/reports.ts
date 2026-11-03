import { z } from "zod";
import type { EmployeeRef, UserRef } from "./api.js";
import { formatDuration } from "./attendance.js";
import { timeZoneSchema } from "./schemas.js";
import { addDays, localDate, weekStart, zonedToUtc } from "./timesheet.js";

/**
 * Scheduled email reports (F12). Content comes only from attendance (timesheet totals) and, when
 * enabled, project/task timer totals. Never: screenshots, application activity, leave details,
 * websites or productivity scores. Delivery is provider-independent (docs/email-reports.md).
 */
export const REPORT_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];
export const REPORT_DELIVERY_STATUSES = ["PENDING", "SENDING", "RETRYING", "SENT", "MOCKED", "NOT_CONFIGURED", "SKIPPED", "FAILED"] as const;
export type ReportDeliveryStatus = (typeof REPORT_DELIVERY_STATUSES)[number];
/** Delivery providers this build knows. "none": nothing is emailed; "mock": development and tests only. */
export const REPORT_MAIL_PROVIDERS = ["none", "mock"] as const;
export type ReportMailProvider = (typeof REPORT_MAIL_PROVIDERS)[number];

export const createReportScheduleSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  frequency: z.enum(REPORT_FREQUENCIES),
  /** Zone that defines the report period (each employee's figures use their own zone, as timesheets do). */
  timeZone: timeZoneSchema,
  /** One employee's report; omitted = all current employees. */
  employeeId: z.uuid().optional(),
  includeProjects: z.boolean().default(true),
});
export const updateReportScheduleSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    frequency: z.enum(REPORT_FREQUENCIES).optional(),
    active: z.boolean().optional(),
    includeProjects: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to change");
export const addRecipientSchema = z.strictObject({ userId: z.uuid() });

export interface ReportSchedule {
  id: string;
  name: string;
  frequency: ReportFrequency;
  timeZone: string;
  employee: EmployeeRef | null;
  includeProjects: boolean;
  active: boolean;
  createdBy: UserRef;
  createdAt: string;
  recipients: (UserRef & { role: string; addedAt: string })[];
}

export interface ReportDelivery {
  id: string;
  recipient: UserRef;
  status: ReportDeliveryStatus;
  provider: string;
  attempts: { attempt: number; outcome: string; error: string | null; at: string }[];
  lastError: string | null;
  nextAttemptAt: string | null;
  finishedAt: string | null;
}

export interface ReportRun {
  id: string;
  scheduleId: string;
  period: { from: string; to: string };
  triggeredBy: UserRef | null;
  createdAt: string;
  /**
   * Derived from the deliveries. NOT_EMAILED: finished, but at least one delivery was only mocked or
   * had no provider. DELIVERED: every delivery went to a real provider (or was skipped).
   */
  status: "NO_RECIPIENTS" | "IN_PROGRESS" | "FAILED" | "NOT_EMAILED" | "DELIVERED";
  deliveries: ReportDelivery[];
}

export interface ReportData {
  name: string;
  frequency: ReportFrequency;
  timeZone: string;
  period: { from: string; to: string };
  generatedAt: string;
  employees: {
    employee: EmployeeRef;
    shifts: number;
    workedMs: number;
    breakMs: number;
    overtimeMs: number;
    openShifts: number;
    pendingCorrections: number;
    deviceLastSeenAt: string | null;
    /** Completed task-timer time; null when project time is not included. */
    taskMs: number | null;
  }[];
  /** Null when project time is not included. */
  projects: { code: string; name: string; archived: boolean; taskMs: number; entries: number }[] | null;
  runningTimers: number | null;
}

/** The last complete period before `now` in the schedule's zone (local dates, inclusive). */
export function reportPeriod(frequency: ReportFrequency, now: number, timeZone: string, weekStartsOn = 1): { from: string; to: string } {
  const today = localDate(now, timeZone);
  if (frequency === "DAILY") return { from: addDays(today, -1), to: addDays(today, -1) };
  if (frequency === "WEEKLY") {
    const ws = weekStart(today, weekStartsOn);
    return { from: addDays(ws, -7), to: addDays(ws, -1) };
  }
  const to = addDays(`${today.slice(0, 8)}01`, -1);
  return { from: `${to.slice(0, 8)}01`, to };
}

/** When the period ends (start of the next local day in the schedule's zone). */
export const periodEnd = (period: { to: string }, timeZone: string) => zonedToUtc(`${addDays(period.to, 1)}T00:00`, timeZone);

/** Missing-record and freshness warnings, in the order shown. */
export function reportWarnings(d: ReportData): string[] {
  const end = periodEnd(d.period, d.timeZone);
  const w: string[] = [];
  if (!d.employees.length) w.push("No employees are included in this report.");
  for (const e of d.employees) {
    const who = `${e.employee.fullName} (${e.employee.employeeCode})`;
    if (!e.shifts) w.push(`${who}: no attendance recorded in this period.`);
    if (e.openShifts) w.push(`${who}: ${e.openShifts} day(s) with an open shift (no clock-out recorded); not counted.`);
    if (e.pendingCorrections) w.push(`${who}: ${e.pendingCorrections} correction request(s) pending; figures may change.`);
    if (!e.deviceLastSeenAt) w.push(`${who}: no device has connected; records may be missing.`);
    else if (e.deviceLastSeenAt < end) w.push(`${who}: device last connected ${e.deviceLastSeenAt.slice(0, 16).replace("T", " ")} UTC, before the period ended; later records may still be waiting to sync.`);
  }
  if (d.runningTimers) w.push(`${d.runningTimers} task timer(s) were running when this report was generated and are not counted.`);
  return w;
}

/** Plain-text email. Only aggregate attendance and task-time figures; nothing else. */
export function renderReport(d: ReportData): { subject: string; text: string } {
  const range = d.period.from === d.period.to ? d.period.from : `${d.period.from} to ${d.period.to}`;
  const lines = [
    `${d.name}: ${d.frequency.toLowerCase()} report for ${range}`,
    `Period: ${range} (local dates; each employee's figures use their own time zone; schedule zone ${d.timeZone}).`,
    `Generated: ${d.generatedAt} (UTC). Draft format, not approved for payroll.`,
    "",
    "ATTENDANCE (completed shifts)",
    ...(d.employees.length
      ? d.employees.map((e) =>
          [
            `- ${e.employee.fullName} (${e.employee.employeeCode}): ${e.shifts} shift(s), worked ${formatDuration(e.workedMs)}, breaks ${formatDuration(e.breakMs)}`,
            e.overtimeMs ? `, overtime (reported only) ${formatDuration(e.overtimeMs)}` : "",
            e.taskMs === null ? "" : `; task time ${formatDuration(e.taskMs)}`,
          ].join(""),
        )
      : ["- none"]),
  ];
  if (d.projects) {
    lines.push("", "PROJECT TIME (completed task-timer entries)");
    lines.push(...(d.projects.length ? d.projects.map((p) => `- ${p.code} ${p.name}${p.archived ? " (archived)" : ""}: ${formatDuration(p.taskMs)} over ${p.entries} entr${p.entries === 1 ? "y" : "ies"}`) : ["- no task time recorded"]));
  }
  const warnings = reportWarnings(d);
  lines.push("", "WARNINGS", ...(warnings.length ? warnings.map((x) => `- ${x}`) : ["- none"]));
  lines.push(
    "",
    "Figures are as recorded when generated; later syncs and approved corrections can change them.",
    "Task time is timer time (idle time included) and is separate from attendance; neither measures productivity.",
    "This report contains no screenshots, application activity, leave details or website data.",
  );
  return { subject: `[Workfolio] ${d.name}: ${range}`, text: `${lines.join("\n")}\n` };
}

/** `GET /reports/provider`. */
export interface ReportProviderInfo {
  provider: ReportMailProvider;
  /** False for "none" and "mock": nothing is actually emailed. */
  delivers: boolean;
  schedulerSeconds: number;
}

/** `GET /reports/schedules/:id/eligible-recipients`. */
export interface EligibleRecipient {
  id: string;
  email: string;
  role: string;
}

/** `POST /reports/schedules/:id/run`. `duplicate`: a run for this period already existed and is returned. */
export interface RunNowResponse {
  duplicate: boolean;
  run: ReportRun;
}

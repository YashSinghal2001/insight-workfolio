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
/** "graph-delegated": Microsoft Graph sendMail with the OneDrive connection's token (as invitations and notifications). */
export const REPORT_MAIL_PROVIDERS = ["none", "mock", "graph-delegated"] as const;
export type ReportMailProvider = (typeof REPORT_MAIL_PROVIDERS)[number];
/** WORKED_HOURS: attendance totals (F12). LATE / ABSENT: per-day lists by the work schedule rules (/attendance/daily). */
export const REPORT_KINDS = ["WORKED_HOURS", "LATE", "ABSENT"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_KIND_LABELS: Record<ReportKind, string> = { WORKED_HOURS: "Worked hours", LATE: "Late clock-in", ABSENT: "Absent" };

const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const oneScope = (v: { employeeId?: string | null; teamId?: string | null }) => !(v.employeeId && v.teamId);
const SCOPE_ERROR = { message: "Choose a team or one employee, not both", path: ["teamId"] };

export const createReportScheduleSchema = z
  .strictObject({
    kind: z.enum(REPORT_KINDS).default("WORKED_HOURS"),
    name: z.string().trim().min(1).max(120),
    frequency: z.enum(REPORT_FREQUENCIES),
    /** Zone that defines the report period and send time (each employee's figures use their own zone, as timesheets do). */
    timeZone: timeZoneSchema,
    /** Local HH:MM on the day after the period; null = the first scheduler check after the period ends. */
    sendAtLocalTime: localTimeSchema.nullable().default(null),
    /** One employee's report; omitted = all current employees (or teamId). */
    employeeId: z.uuid().optional(),
    /** One team's active members; omitted = organisation (or employeeId). */
    teamId: z.uuid().optional(),
    includeProjects: z.boolean().default(true),
  })
  .refine(oneScope, SCOPE_ERROR);
export const updateReportScheduleSchema = z
  .strictObject({
    kind: z.enum(REPORT_KINDS).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    frequency: z.enum(REPORT_FREQUENCIES).optional(),
    timeZone: timeZoneSchema.optional(),
    sendAtLocalTime: localTimeSchema.nullable().optional(),
    /** null clears the scope back to the organisation. */
    employeeId: z.uuid().nullable().optional(),
    teamId: z.uuid().nullable().optional(),
    active: z.boolean().optional(),
    includeProjects: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to change")
  .refine(oneScope, SCOPE_ERROR);
export type CreateReportScheduleInput = z.infer<typeof createReportScheduleSchema>;
export type UpdateReportScheduleInput = z.infer<typeof updateReportScheduleSchema>;
export const addRecipientSchema = z.strictObject({ userId: z.uuid() });

export interface ReportSchedule {
  id: string;
  name: string;
  kind: ReportKind;
  frequency: ReportFrequency;
  timeZone: string;
  /** HH:MM in timeZone; null = first scheduler check after the period ends. */
  sendAtLocalTime: string | null;
  employee: EmployeeRef | null;
  team: { id: string; name: string } | null;
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

/** One LATE or ABSENT day in a report (the employee's own local date and clock-in time). */
export interface ReportException {
  employee: EmployeeRef;
  date: string;
  firstClockInLocal: string | null;
  lateMinutes: number | null;
}

export interface ReportData {
  name: string;
  kind: ReportKind;
  /** "Organisation", "Team <name>" or "<employee> (<code>)". */
  scope: string;
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
  /** LATE / ABSENT only (null for WORKED_HOURS): employees in scope, dates without an enabled work schedule, the listed days. */
  exceptions: { people: number; noPolicyDays: string[]; items: ReportException[] } | null;
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

/**
 * When a period's report is due: `sendAtLocalTime` (default 00:00, i.e. the period end) on the local day after
 * the period in the schedule's zone (daily: next day; weekly: first day after the week; monthly: the 1st).
 * DST-safe: always on that local date (a time skipped by a DST jump lands next to the gap, a repeated one on its
 * first occurrence, per zonedToUtc), and the run is unique per period, so it fires once.
 */
export const reportDueAt = (period: { to: string }, timeZone: string, sendAtLocalTime: string | null) =>
  zonedToUtc(`${addDays(period.to, 1)}T${sendAtLocalTime ?? "00:00"}`, timeZone);

/** When the period ends (start of the next local day in the schedule's zone). */
export const periodEnd = (period: { to: string }, timeZone: string) => reportDueAt(period, timeZone, null);

/**
 * The most recent period whose report is due at `now`: the last complete period once its send time has passed,
 * otherwise the one before it (always due by then). Covers late send times such as 23:59 that a periodic check
 * would otherwise skip once the next period has begun.
 */
export function duePeriod(frequency: ReportFrequency, now: number, timeZone: string, sendAtLocalTime: string | null, weekStartsOn = 1) {
  const last = reportPeriod(frequency, now, timeZone, weekStartsOn);
  if (Date.parse(reportDueAt(last, timeZone, sendAtLocalTime)) <= now) return last;
  return reportPeriod(frequency, Date.parse(zonedToUtc(`${last.from}T12:00`, timeZone)), timeZone, weekStartsOn);
}

/** Control characters (newlines included) become spaces: names can never add a header or forge a line. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

/** Missing-record and freshness warnings, in the order shown. */
export function reportWarnings(d: ReportData): string[] {
  const end = periodEnd(d.period, d.timeZone);
  const w: string[] = [];
  if (d.exceptions) {
    if (!d.exceptions.people) w.push("No employees are included in this report.");
    if (d.exceptions.noPolicyDays.length) w.push(`No enabled work schedule on ${d.exceptions.noPolicyDays.join(", ")}: nobody is labelled late or absent on those days.`);
    return w;
  }
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

/**
 * Plain-text email (sent as Text by Graph, so names are never interpreted as markup). Only aggregate attendance
 * and task-time figures, or late / absent days; nothing else.
 */
export function renderReport(d: ReportData): { subject: string; text: string } {
  const range = d.period.from === d.period.to ? d.period.from : `${d.period.from} to ${d.period.to}`;
  const name = oneLine(d.name);
  const who = (e: EmployeeRef) => `${oneLine(e.fullName)} (${oneLine(e.employeeCode)})`;
  const lines = [
    `${name}: ${d.frequency.toLowerCase()} ${REPORT_KIND_LABELS[d.kind].toLowerCase()} report for ${range}`,
    `Period: ${range} (local dates; each employee's figures use their own time zone; schedule zone ${d.timeZone}).`,
    `Scope: ${oneLine(d.scope)}.`,
    `Generated: ${d.generatedAt} (UTC). Draft format, not approved for payroll.`,
    "",
  ];
  if (d.exceptions) {
    const items = d.exceptions.items;
    lines.push(d.kind === "LATE" ? "LATE CLOCK-INS" : "ABSENT (no clock-in on a scheduled workday)");
    lines.push(
      ...(items.length
        ? items.map((x) => `- ${x.date} ${who(x.employee)}${d.kind === "LATE" ? `: clocked in ${x.firstClockInLocal?.slice(11) ?? "?"}, ${x.lateMinutes ?? 0} min after the expected start` : ""}`)
        : ["- none"]),
    );
    const warnings = reportWarnings(d);
    lines.push("", "WARNINGS", ...(warnings.length ? warnings.map((x) => `- ${x}`) : ["- none"]));
    lines.push(
      "",
      "Late and absent follow the work schedule in force on each local date; approved leave, holidays and non-working days are never listed.",
      "This report contains no screenshots, application activity, leave details or website data.",
    );
    return { subject: `[Workfolio] ${name}: ${range}`, text: `${lines.join("\n")}\n` };
  }
  lines.push(
    "ATTENDANCE (completed shifts)",
    ...(d.employees.length
      ? d.employees.map((e) =>
          [
            `- ${who(e.employee)}: ${e.shifts} shift(s), worked ${formatDuration(e.workedMs)}, breaks ${formatDuration(e.breakMs)}`,
            e.overtimeMs ? `, overtime (reported only) ${formatDuration(e.overtimeMs)}` : "",
            e.taskMs === null ? "" : `; task time ${formatDuration(e.taskMs)}`,
          ].join(""),
        )
      : ["- none"]),
  );
  if (d.projects) {
    lines.push("", "PROJECT TIME (completed task-timer entries)");
    lines.push(...(d.projects.length ? d.projects.map((p) => `- ${oneLine(p.code)} ${oneLine(p.name)}${p.archived ? " (archived)" : ""}: ${formatDuration(p.taskMs)} over ${p.entries} entr${p.entries === 1 ? "y" : "ies"}`) : ["- no task time recorded"]));
  }
  const warnings = reportWarnings(d);
  lines.push("", "WARNINGS", ...(warnings.length ? warnings.map((x) => `- ${x}`) : ["- none"]));
  lines.push(
    "",
    "Figures are as recorded when generated; later syncs and approved corrections can change them.",
    "Task time is timer time (idle time included) and is separate from attendance; neither measures productivity.",
    "This report contains no screenshots, application activity, leave details or website data.",
  );
  return { subject: `[Workfolio] ${name}: ${range}`, text: `${lines.join("\n")}\n` };
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

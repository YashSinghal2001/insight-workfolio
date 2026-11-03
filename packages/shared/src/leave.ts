import { z } from "zod";
import type { EmployeeRef, Paginated, UserRef } from "./api.js";

/**
 * Leave requests (F10) with admin-defined leave types and computed balances (W36) and a monthly
 * short-leave quota (W35). No accrual, carry-forward or payroll; approved leave never changes
 * attendance records (the daily view only labels the day). See docs/leave-requests.md.
 */
export const LEAVE_PORTIONS = ["FULL_DAY", "FIRST_HALF", "SECOND_HALF", "SHORT"] as const;
export type LeavePortion = (typeof LEAVE_PORTIONS)[number];
export const LEAVE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** Input sanity limits, not policy: a request spans at most this many calendar dates... */
export const MAX_LEAVE_DAYS = 366;
/** ...and lies within this many days before or after today (the employee's time zone; checked by the API). */
export const LEAVE_WINDOW_DAYS = 366;

const DAY_MS = 86_400_000;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 14:30");

export const createLeaveSchema = z
  .strictObject({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    portion: z.enum(LEAVE_PORTIONS),
    /** Omitted: the default "General" type (older clients such as the desktop app send none). */
    leaveTypeId: z.uuid().optional(),
    startTime: time.optional(),
    endTime: time.optional(),
    // Optional on purpose: no reason is required, and none should be medical detail.
    reason: z.string().trim().max(500).optional().transform((v) => v || undefined),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (v.endDate < v.startDate) issue("The end date must not be before the start date");
    else if (Date.parse(v.endDate) - Date.parse(v.startDate) > (MAX_LEAVE_DAYS - 1) * DAY_MS) issue(`A request can cover at most ${MAX_LEAVE_DAYS} days`);
    if (v.portion !== "FULL_DAY" && v.endDate !== v.startDate) issue("A half day or short leave is on a single date");
    if (v.portion === "SHORT") {
      if (!v.startTime || !v.endTime) issue("Give a start and an end time");
      else if (v.endTime <= v.startTime) issue("The end time must be after the start time");
    } else if (v.startTime || v.endTime) issue("Times are only for a short leave");
  });
export type CreateLeaveInput = z.input<typeof createLeaveSchema>;
export type CreateLeave = z.infer<typeof createLeaveSchema>;

/** Approve and reject: the note is optional (kept with the decision). */
export const decideLeaveSchema = z.strictObject({ note: z.string().trim().max(1000).optional().transform((v) => v || undefined) });

export const listLeaveQuerySchema = z.object({
  status: z.enum(LEAVE_STATUSES).optional(),
  employeeId: z.uuid().optional(),
  /** "true": only the caller's own profile (from the session), even for administrators. */
  mine: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
  .refine((q) => !(q.mine && q.employeeId), { message: "Use either mine or employeeId, not both", path: ["mine"] });

export interface LeaveRequest {
  id: string;
  employee: EmployeeRef;
  startDate: string;
  endDate: string;
  portion: LeavePortion;
  leaveType: { id: string; name: string; paid: boolean };
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
  status: LeaveStatus;
  requestedBy: UserRef;
  requestedAt: string;
  decidedBy: UserRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Every recorded step, oldest first (derived from the immutable request row). */
  history: { action: "SUBMITTED" | Exclude<LeaveStatus, "PENDING">; at: string; by: UserRef; note: string | null }[];
}

type Slot = Pick<LeaveRequest, "startDate" | "endDate" | "portion"> & { startTime?: string | null; endTime?: string | null };

/**
 * Whether two requests claim the same time. Two halves of one day, or short leaves at different
 * times, do not overlap. A half day and a short leave on the same date always count as overlapping:
 * which hours a half day covers is not defined.
 */
export function leaveOverlaps(a: Slot, b: Slot): boolean {
  if (a.startDate > b.endDate || b.startDate > a.endDate) return false;
  if (a.portion === "FULL_DAY" || b.portion === "FULL_DAY") return true;
  if (a.portion === "SHORT" && b.portion === "SHORT") return a.startTime! < b.endTime! && b.startTime! < a.endTime!;
  return a.portion === b.portion || a.portion === "SHORT" || b.portion === "SHORT";
}

/** "Mon 2 Nov 2026 – Wed 4 Nov 2026", "Mon 2 Nov 2026, first half", "Mon 2 Nov 2026, 14:00–16:00". */
export function leaveWhen(r: Slot): string {
  const day = (d: string) =>
    new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
  if (r.portion === "FULL_DAY") return r.startDate === r.endDate ? `${day(r.startDate)}, full day` : `${day(r.startDate)} – ${day(r.endDate)}, full days`;
  if (r.portion === "SHORT") return `${day(r.startDate)}, ${r.startTime}–${r.endTime}`;
  return `${day(r.startDate)}, ${r.portion === "FIRST_HALF" ? "first" : "second"} half`;
}

// ---- Leave summary (W37) ---------------------------------------------------------------------
// Counts of recorded requests per status for a date range. Not balances or entitlements (none are
// configured). Full days count every calendar date inside the range, weekends included: there is no
// workweek or holiday calendar for leave. Half days count 0.5. Short leave is counted in minutes only.

/** A summary range spans at most this many calendar dates. */
export const LEAVE_SUMMARY_MAX_DAYS = 366;
export const LEAVE_SUMMARY_DAY_RULE =
  "Full days count every calendar date inside the range, weekends included (no workweek or holiday calendar is configured). A half day counts 0.5. Short leave is counted in minutes, not days. These are recorded requests, not balances or entitlements.";

const summaryRange = {
  from: z.iso.date(),
  to: z.iso.date(),
};
const rangeOk = (r: { from: string; to: string }, ctx: z.RefinementCtx) => {
  if (r.from > r.to) ctx.addIssue({ code: "custom", message: "from must not be after to", path: ["from"] });
  else if (Date.parse(r.to) - Date.parse(r.from) > (LEAVE_SUMMARY_MAX_DAYS - 1) * DAY_MS) ctx.addIssue({ code: "custom", message: `Range is limited to ${LEAVE_SUMMARY_MAX_DAYS} days`, path: ["to"] });
};
/** GET /leave/summary (admins): one row per employee, searchable and paginated. */
export const leaveSummaryQuerySchema = z
  .object({
    ...summaryRange,
    q: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .superRefine(rangeOk);
export type LeaveSummaryQuery = z.infer<typeof leaveSummaryQuerySchema>;
/** GET /leave/summary/me: the caller's own row (employee from the session; no employeeId accepted). */
export const leaveSummaryMeQuerySchema = z.strictObject(summaryRange).superRefine(rangeOk);

export interface LeaveTally {
  /** Requests of this status overlapping the range (every portion). */
  requests: number;
  /** Calendar dates of full-day requests inside the range. */
  fullDays: number;
  /** First- or second-half requests inside the range (0.5 day each). */
  halfDays: number;
  shortRequests: number;
  shortMinutes: number;
  /** fullDays + 0.5 × halfDays (short leave excluded). */
  days: number;
}
export interface LeaveSummaryRow {
  employee: EmployeeRef;
  byStatus: Record<LeaveStatus, LeaveTally>;
}
export interface LeaveSummaryMeta {
  dayRule: string;
  balancesConfigured: false;
}
export interface LeaveSummaryResponse extends Paginated<LeaveSummaryRow> {
  from: string;
  to: string;
  meta: LeaveSummaryMeta;
}
export interface LeaveSummaryMeResponse {
  from: string;
  to: string;
  row: LeaveSummaryRow;
  meta: LeaveSummaryMeta;
}

const emptyTally = (): LeaveTally => ({ requests: 0, fullDays: 0, halfDays: 0, shortRequests: 0, shortMinutes: 0, days: 0 });
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Per-status totals of the requests overlapping [from, to] (local dates; requests outside are ignored). */
export function tallyLeave(requests: readonly (Slot & { status: LeaveStatus })[], from: string, to: string): Record<LeaveStatus, LeaveTally> {
  const out = Object.fromEntries(LEAVE_STATUSES.map((s) => [s, emptyTally()])) as Record<LeaveStatus, LeaveTally>;
  for (const r of requests) {
    if (r.startDate > to || r.endDate < from) continue;
    const t = out[r.status];
    t.requests++;
    if (r.portion === "FULL_DAY") {
      const start = r.startDate < from ? from : r.startDate;
      const end = r.endDate > to ? to : r.endDate;
      t.fullDays += Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
    } else if (r.portion === "SHORT") {
      t.shortRequests++;
      t.shortMinutes += minutesOf(r.endTime!) - minutesOf(r.startTime!);
    } else t.halfDays++;
  }
  for (const t of Object.values(out)) t.days = t.fullDays + t.halfDays / 2;
  return out;
}

/** "2.5 days" / "1 day", plus short leave: "2.5 days + 1 short (90 min)". "—" when there is nothing. */
export function leaveTallyLabel(t: LeaveTally): string {
  if (!t.requests) return "—";
  const parts: string[] = [];
  if (t.days || !t.shortRequests) parts.push(`${t.days} ${t.days === 1 ? "day" : "days"}`);
  if (t.shortRequests) parts.push(`${t.shortRequests} short (${t.shortMinutes} min)`);
  return parts.join(" + ");
}

// ---- Leave types and balances (W36) and short-leave quota (W35) ------------------------------
// A balance is computed, never stored: the yearly allowance minus approved days in that calendar
// year. Days skip holidays and, when an enabled work schedule exists, its non-workdays. Half days
// count 0.5. Short leave never uses days; it uses the type's monthly hours quota. null = no limit.

/** Created by migration 0021; every request recorded before types existed belongs to it. */
export const DEFAULT_LEAVE_TYPE_ID = "00000000-0000-4000-8000-000000000001";

const hours = (max: number) => z.number().min(0).max(max).multipleOf(0.5, "Use steps of 0.5");
export const leaveTypeSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  paid: z.boolean(),
  /** null = no yearly limit. */
  yearlyAllowanceDays: hours(366).nullable(),
  /** null = no monthly short-leave limit. */
  shortHoursPerMonth: hours(744).nullable(),
});
export type LeaveTypeInput = z.infer<typeof leaveTypeSchema>;
export const updateLeaveTypeSchema = leaveTypeSchema.partial().extend({ active: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;

export interface LeaveType {
  id: string;
  name: string;
  paid: boolean;
  yearlyAllowanceDays: number | null;
  shortHoursPerMonth: number | null;
  active: boolean;
}

/** GET /leave/balances (admins) and /leave/balances/me: balances for the year of `month`, short leave for `month`. */
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM").optional();
export const leaveBalanceQuerySchema = z.object({
  month,
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const leaveBalanceMeQuerySchema = z.strictObject({ month });

export interface LeaveBalance {
  leaveType: LeaveType;
  year: number;
  allowanceDays: number | null;
  approvedDays: number;
  pendingDays: number;
  /** allowance − approved; null when there is no allowance. */
  remainingDays: number | null;
  month: string;
  shortHoursPerMonth: number | null;
  shortApprovedHours: number;
  shortPendingHours: number;
  shortRemainingHours: number | null;
}
export interface LeaveBalanceRow {
  employee: EmployeeRef;
  balances: LeaveBalance[];
}
export interface LeaveBalancesResponse extends Paginated<LeaveBalanceRow> {
  month: string;
  dayRule: string;
}
export interface LeaveBalanceMeResponse {
  month: string;
  row: LeaveBalanceRow;
  dayRule: string;
}
export const LEAVE_BALANCE_DAY_RULE =
  "A full day counts 1 and a half day 0.5, except on holidays and, when the work schedule is enabled, on the employee's non-workdays (their own workdays if set, else the organisation's). Short leave counts against the monthly hours quota, not days. Balances use the calendar year.";

/** Leave days of one request inside `year` (YYYY), skipping holidays and non-workdays (workdays null = every day counts). */
export function leaveDaysInYear(r: Slot, year: number, holidays: ReadonlySet<string>, workdays: string | null): number {
  if (r.portion === "SHORT") return 0;
  const from = r.startDate > `${year}-01-01` ? r.startDate : `${year}-01-01`;
  const to = r.endDate < `${year}-12-31` ? r.endDate : `${year}-12-31`;
  let days = 0;
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (holidays.has(d) || (workdays && !workdays.includes(String(new Date(t).getUTCDay() || 7)))) continue;
    days++;
  }
  return r.portion === "FULL_DAY" ? days : days / 2;
}

/** Short-leave hours of one request inside `month` (YYYY-MM); 0 for other portions. */
export function shortHoursInMonth(r: Slot, month: string): number {
  if (r.portion !== "SHORT" || !r.startDate.startsWith(month)) return 0;
  return (minutesOf(r.endTime!) - minutesOf(r.startTime!)) / 60;
}

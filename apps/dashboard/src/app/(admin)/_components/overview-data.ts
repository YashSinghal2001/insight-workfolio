// Pure Overview widget logic (W2-OVERVIEW): what each card / chart shows for a GET /overview response.
import { formatDuration, type AttendanceState, type MissingClockOutReason, type OverviewKpis, type OverviewResponse, type WorkloadDay } from "@workfolio/shared";
import type { BarCategory, BarSeries } from "@/components/charts";
import type { Tone } from "@/components/kit";
import type { DonutDatum } from "@/lib/charts";

export interface KpiCard {
  label: string;
  value: number | string | null;
  hint?: string;
  reason?: string;
  href?: string;
  tone?: Exclude<Tone, "neutral">;
}

/**
 * The KPI strip. Labels stay as the browser suite reads them ("Working now", "Late today", …); for a date other
 * than today "today" becomes "that day". Late/absent are null without an enabled work schedule.
 */
export function kpiCards(k: OverviewKpis, isToday: boolean): KpiCard[] {
  const day = isToday ? "today" : "that day";
  const noSchedule = "Work schedule not configured";
  return [
    { label: "Active employees", value: k.totalMembers, hint: "Account active, not terminated", href: "/employees" },
    { label: "Working now", value: k.workingNow, hint: "Clocked in, not on a break", href: "/attendance", tone: "success" },
    { label: "On a break", value: k.onBreak, href: "/attendance", tone: "warning" },
    { label: `Clocked out ${day}`, value: k.clockedOut, hint: "Worked, no shift open now", href: "/attendance" },
    { label: `Not clocked in ${day}`, value: k.notStarted, hint: "Not the same as absent: leave, rest days and schedules are not considered here" },
    { label: "On leave", value: k.onLeave, hint: "Approved leave covering the date", href: "/leave" },
    { label: "App not installed", value: k.appNotInstalled, hint: "No registered device", href: "/devices", tone: k.appNotInstalled ? "warning" : undefined },
    { label: `Late ${day}`, value: k.late, reason: noSchedule, href: k.late === null ? "/settings/schedule" : "/attendance?view=daily", tone: k.late ? "danger" : undefined },
    { label: `Absent ${day}`, value: k.absent, reason: noSchedule, href: k.absent === null ? "/settings/schedule" : "/attendance?view=daily", tone: k.absent ? "danger" : undefined },
    { label: "Missing clock-outs", value: k.missingClockOuts, hint: "Open shifts that look forgotten (flag only)", href: "/attendance", tone: k.missingClockOuts ? "danger" : undefined },
    { label: `Screenshots stored ${day}`, value: k.screenshotsStored, href: "/screenshots" },
    { label: `Net work ${day}`, value: formatDuration(k.netWorkMs), hint: `Breaks excluded; ${formatDuration(k.breakMs)} of breaks` },
  ];
}

export const WORKLOAD_SERIES: BarSeries[] = [
  { label: "Over worked", color: "var(--danger)" },
  { label: "Healthy", color: "var(--success)" },
  { label: "Less utilised", color: "var(--warning)" },
];

/** "Mon 16" for a YYYY-MM-DD local date (the date itself, not the viewer's zone). */
export const dayLabel = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/** "Mon 16 Nov". */
export const longDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

export const workloadData = (days: WorkloadDay[]): BarCategory[] => days.map((d) => ({ label: dayLabel(d.date), values: [d.overworked, d.healthy, d.lessUtilised] }));

/** Donut slices: the top applications, then everything else as one "Other apps" slice. */
export function appSlices(top: NonNullable<OverviewResponse["topApps"]>): DonutDatum[] {
  const slices: DonutDatum[] = top.items.map((a) => ({ label: a.applicationName, value: a.activeMs }));
  if (top.otherMs > 0) slices.push({ label: "Other apps", value: top.otherMs, color: "var(--muted)" });
  return slices;
}

/** "HH:MM" of a "YYYY-MM-DDTHH:mm" local value. */
export const hhmm = (local: string | null) => (local ? local.slice(11, 16) : "—");

/** An instant as HH:MM in a zone; "—" when missing or the zone is unknown. */
export function clock(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));
  } catch {
    return "—";
  }
}

export function stateBadge(state: AttendanceState, missingClockOut: boolean): { tone: Tone; label: string } {
  if (missingClockOut) return { tone: "danger", label: "Missing clock-out" };
  if (state === "CLOCKED_IN") return { tone: "success", label: "Working" };
  if (state === "ON_BREAK") return { tone: "warning", label: "On a break" };
  return { tone: "neutral", label: "Clocked out" };
}

export const REASON_LABEL: Record<MissingClockOutReason, string> = {
  PREVIOUS_DAY: "Open since an earlier day",
  WORKDAY_ENDED: "Workday ended",
  MAX_SHIFT_EXCEEDED: "Longer than the maximum shift",
  DEVICE_STALE: "Device not seen recently",
  LONG_BREAK: "Long break",
};

/** "12 Nov" or "12–14 Nov" for an inclusive local-date range. */
export function dateRange(from: string, to: string): string {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
  if (from === to) return f(from, { day: "numeric", month: "short" });
  return from.slice(0, 7) === to.slice(0, 7) ? `${f(from, { day: "numeric" })}–${f(to, { day: "numeric", month: "short" })}` : `${f(from, { day: "numeric", month: "short" })} – ${f(to, { day: "numeric", month: "short" })}`;
}

/** The request path for the global filters. */
export const overviewPath = (date: string, teamId: string | null) => `/overview?date=${date}${teamId ? `&teamId=${teamId}` : ""}`;

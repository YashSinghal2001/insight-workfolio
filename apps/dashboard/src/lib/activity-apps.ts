// Pure data shaping for the /activity tabs and /risk-users (W3-APPS). No React; unit-tested in activity-apps.test.ts.
import { RISK_TRIGGER_LABEL, type ActivityAppHistoryResponse, type ActivityAppsResponse, type ApplicationCategory, type RiskUsersResponse } from "@workfolio/shared";
import type { BarCategory, DonutDatum, StackedRow, StackedSeries } from "@/components/charts";

export const ACTIVITY_TABS = [
  { id: "summary", label: "Summary" },
  { id: "employees", label: "Per employee" },
  { id: "history", label: "App history" },
  { id: "review", label: "Review apps" },
  { id: "employee", label: "One employee" },
] as const;
export type ActivityTab = (typeof ACTIVITY_TABS)[number]["id"];

/** `?tab=` (unknown → summary); a valid `employeeId` without a tab opens the one-employee view (old links). */
export function parseActivityTab(params: URLSearchParams): ActivityTab {
  const tab = ACTIVITY_TABS.find((t) => t.id === params.get("tab"))?.id;
  if (tab) return tab;
  return /^[0-9a-f-]{36}$/i.test(params.get("employeeId") ?? "") ? "employee" : "summary";
}

/** Status colours (contract §6): productive green, neutral blue, unproductive red, unclassified grey. */
export const CATEGORY_COLOR: Record<ApplicationCategory, string> = {
  PRODUCTIVE: "var(--success)",
  NEUTRAL: "var(--info)",
  UNPRODUCTIVE: "var(--danger)",
  UNCLASSIFIED: "var(--muted)",
};
export const CATEGORY_LABEL: Record<ApplicationCategory, string> = { PRODUCTIVE: "Productive", NEUTRAL: "Neutral", UNPRODUCTIVE: "Unproductive", UNCLASSIFIED: "Unclassified" };
const ORDER: ApplicationCategory[] = ["PRODUCTIVE", "NEUTRAL", "UNPRODUCTIVE", "UNCLASSIFIED"];

/** Donut slices: the top `max - 1` apps coloured by their label, the rest as one "Other apps" slice. */
export function appDonut(apps: ActivityAppsResponse["applications"], max = 8): DonutDatum[] {
  const top = apps.slice(0, max - 1).map((a) => ({ label: `${a.applicationName} (${CATEGORY_LABEL[a.category]})`, value: a.activeMs, color: CATEGORY_COLOR[a.category] }));
  const rest = apps.slice(max - 1).reduce((n, a) => n + a.activeMs, 0);
  return rest > 0 ? [...top, { label: "Other apps", value: rest, color: "var(--border-strong)" }] : top;
}

/** One 100 % bar per group: label share of active time (everyone, then each employee with usage). */
export function categoryShare(data: Pick<ActivityAppsResponse, "categories" | "employees">, employees = 0): { series: StackedSeries[]; rows: StackedRow[] } {
  const series = ORDER.map((c) => ({ label: CATEGORY_LABEL[c], color: CATEGORY_COLOR[c] }));
  const row = (label: string, t: Record<ApplicationCategory, number>) => ({ label, values: ORDER.map((c) => t[c]) });
  const people = data.employees.filter((e) => e.activeMs > 0).sort((a, b) => b.activeMs - a.activeMs).slice(0, employees);
  return { series, rows: [row("Everyone", data.categories), ...people.map((e) => row(e.employee.fullName, e.categories))] };
}

/** Apps nobody has labelled yet, largest first (what "Review apps" points at). */
export const unreviewed = (apps: ActivityAppsResponse["applications"]) => apps.filter((a) => a.category === "UNCLASSIFIED");

/** One bar per local date (all employees). */
export function historyBars(days: ActivityAppHistoryResponse["days"]): BarCategory[] {
  return days.map((d) => ({ label: d.date.slice(5), values: [d.activeMs] }));
}

/** "Rules violated" accordion: triggers with at least one employee, most employees first; labels attached. */
export function violatedRules(rules: RiskUsersResponse["rules"]) {
  return rules.filter((r) => r.employees > 0).sort((a, b) => b.employees - a.employees || b.count - a.count).map((r) => ({ ...r, label: RISK_TRIGGER_LABEL[r.trigger] }));
}

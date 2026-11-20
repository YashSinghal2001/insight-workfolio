// SSR render tests for the Overview widgets (W2-OVERVIEW): loading / error / hidden / empty / content per widget.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OverviewResponse } from "@workfolio/shared";
import type { OverviewLoad } from "@/app/(admin)/_components/overview-widgets";

// next/link has no exports map: Node needs the file name (the shared loader only maps the @/ alias).
registerHooks({ resolve: (specifier, context, next) => next(specifier === "next/link" ? "next/link.js" : specifier, context) });
const {
  AbsentWidget, ApprovalsWidget, HolidaysWidget, KpiStrip, LateWidget, LeavesWidget, MissingClockOutsWidget,
  ScreenshotsWidget, TopAppsWidget, WorkHoursWidget, WorkloadWidget,
} = await import("@/app/(admin)/_components/overview-widgets");

const ref = (id: string, fullName: string) => ({ id, fullName, employeeCode: id.toUpperCase(), timezone: "UTC" });
const DATA: OverviewResponse = {
  date: "2026-11-20", teamId: null, generatedAt: "2026-11-20T12:00:00.000Z",
  kpis: { totalMembers: 2, workingNow: 1, onBreak: 0, clockedOut: 1, notStarted: 0, onLeave: 0, appNotInstalled: 0, late: 1, absent: 0, missingClockOuts: 0, screenshotsStored: 0, netWorkMs: 0, breakMs: 0 },
  workload: { scheduledDailyMinutes: 480, thresholds: { overworkedAbove: 1.1, lessUtilisedBelow: 0.8 }, days: [{ date: "2026-11-20", overworked: 0, healthy: 1, lessUtilised: 0 }] },
  topApps: { totalActiveMs: 3_600_000, otherMs: 0, items: [{ applicationName: "Editor", activeMs: 3_600_000 }] },
  late: [{ employee: ref("a", "Ana <b>"), date: "2026-11-20", scheduled: true, dueAt: null, firstClockInAt: null, firstClockInLocal: "2026-11-20T09:40", lateMinutes: 40, leave: null, holiday: null, status: "LATE" }],
  absent: [],
  missingClockOuts: [],
  workHours: [
    { employee: ref("a", "Ana <b>"), workedMinutes: 300, firstClockInAt: "2026-11-20T09:40:00.000Z", state: "CLOCKED_IN", missingClockOut: false, online: true, lastSeenAt: "2026-11-20T11:59:00.000Z" },
    { employee: ref("b", "Ben"), workedMinutes: 480, firstClockInAt: "2026-11-20T08:00:00.000Z", state: "CLOCKED_OUT", missingClockOut: false, online: false, lastSeenAt: null },
  ],
  recentScreenshots: null,
  upcomingHolidays: [{ id: "h", date: "2026-12-25", name: "Synthetic holiday" }],
  upcomingLeaves: null,
  pendingApprovals: { leave: 2, corrections: 0 },
};
const ok: OverviewLoad = { status: "ok", data: DATA };
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const WIDGETS = [KpiStrip, WorkloadWidget, TopAppsWidget, LateWidget, AbsentWidget, MissingClockOutsWidget, ScreenshotsWidget, WorkHoursWidget, HolidaysWidget, LeavesWidget, ApprovalsWidget];

test("every widget: loading skeleton and its own error with a retry", () => {
  for (const W of WIDGETS) {
    assert.match(html(<W load={{ status: "loading" }} isToday />), /role="status"[^]*Loading /, W.name);
    const err = html(<W load={{ status: "error", message: "API down", retry: () => {} }} isToday />);
    assert.match(err, /role="alert"[^]*API down[^]*Try again/, W.name);
  }
});

test("content: KPI labels, late list with links, work hours sorted by worked desc, holidays, approvals", () => {
  const kpi = html(<KpiStrip load={ok} isToday />);
  assert.match(kpi, />Working now<\/p><p[^>]*>1</);
  assert.match(kpi, />Late today</);
  const late = html(<LateWidget load={ok} />);
  assert.match(late, /href="\/employees\/a"[^>]*>Ana &lt;b&gt;<\/a>/, "names are escaped and linked");
  assert.match(late, /in 09:40[^]*late by 40m/);
  const hours = html(<WorkHoursWidget load={ok} />);
  assert.match(hours, /aria-label="Work hours"/);
  assert.ok(hours.indexOf(">Ben<") < hours.indexOf(">Ana &lt;b&gt;<"), "8h before 5h");
  assert.match(hours, /aria-sort="descending"/);
  assert.match(hours, /Never seen[^]*Offline[^]*Last seen[^]*Online/);
  assert.match(html(<HolidaysWidget load={ok} />), /Synthetic holiday[^]*Fri 25 Dec/);
  assert.match(html(<ApprovalsWidget load={ok} />), /href="\/leave"[^]*Pending leave requests[^]*2/);
  assert.match(html(<TopAppsWidget load={ok} />), /Editor/);
  assert.match(html(<WorkloadWidget load={ok} />), /Members per workload level/);
});

test("hidden (null) sections say so; empty ones show their own message; no schedule explains late/absent", () => {
  assert.match(html(<ScreenshotsWidget load={ok} />), /Not available for your role/);
  assert.match(html(<LeavesWidget load={ok} />), /Not available for your role/);
  assert.match(html(<AbsentWidget load={ok} />), /Nobody is absent/);
  assert.match(html(<MissingClockOutsWidget load={ok} />), /No open shift looks forgotten/);
  const none: OverviewLoad = { status: "ok", data: { ...DATA, kpis: { ...DATA.kpis, late: null, absent: null }, topApps: { totalActiveMs: 0, otherMs: 0, items: [] }, workload: { ...DATA.workload, days: [] } } };
  assert.match(html(<LateWidget load={none} />), /Work schedule not configured[^]*href="\/settings\/schedule"/);
  assert.doesNotMatch(html(<LateWidget load={none} />), /rounded-full[^"]*">0</, "no count badge without a schedule");
  assert.match(html(<TopAppsWidget load={none} />), /No application activity/);
  assert.match(html(<WorkloadWidget load={none} />), /No completed work/);
  const empty: OverviewLoad = { status: "ok", data: { ...DATA, kpis: { ...DATA.kpis, totalMembers: 0 } } };
  assert.match(html(<KpiStrip load={empty} isToday />), /No employees here yet/);
});

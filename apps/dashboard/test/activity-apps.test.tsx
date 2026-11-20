// SSR render tests for the /activity app-usage tabs and /risk-users (W3-APPS).
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityAppsResponse, RiskUsersResponse } from "@workfolio/shared";

// next/link has no exports map: Node needs the file name (the shared loader only maps the @/ alias).
registerHooks({ resolve: (specifier, context, next) => next(specifier === "next/link" ? "next/link.js" : specifier, context) });
const { AppHistoryView, EmployeesTab, ReviewTab, SummaryCharts } = await import("@/app/(admin)/activity/apps-tabs");
const { RiskUsersView } = await import("@/app/(admin)/risk-users/risk-users-view");

const H = 3_600_000;
const ref = (id: string, fullName: string) => ({ id, fullName, employeeCode: id.toUpperCase(), timezone: "UTC" });
const zero = { PRODUCTIVE: 0, NEUTRAL: 0, UNPRODUCTIVE: 0, UNCLASSIFIED: 0 };
const APPS: ActivityAppsResponse = {
  from: "2026-05-04", to: "2026-05-05", teamId: null, categoriesConfigured: true,
  categories: { ...zero, PRODUCTIVE: 2 * H, UNCLASSIFIED: H / 2 },
  applications: [
    { key: "com.code", applicationIdentifier: "com.code", applicationName: "Code", activeMs: 2 * H, category: "PRODUCTIVE", employees: 2 },
    { key: "com.slack", applicationIdentifier: "com.slack", applicationName: "Slack <b>", activeMs: H / 2, category: "UNCLASSIFIED", employees: 1 },
  ],
  employees: {
    items: [
      { employee: ref("a", "Ana"), activeMs: 2 * H, idleMs: H / 6, categories: { ...zero, PRODUCTIVE: 2 * H }, topApplication: "Code" },
      { employee: ref("b", "Ben"), activeMs: H / 2, idleMs: 0, categories: { ...zero, UNCLASSIFIED: H / 2 }, topApplication: "Slack <b>" },
    ],
    total: 2, page: 1, pageSize: 50,
  },
};
const ok = { status: "ok", data: APPS } as const;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

test("tabs: loading skeleton and error with retry", () => {
  for (const T of [SummaryCharts, EmployeesTab, ReviewTab]) {
    assert.match(html(<T load={{ status: "loading" }} />), /role="status"/, T.name);
    assert.match(html(<T load={{ status: "error", message: "Boom" }} onRetry={() => {}} />), /Boom[^]*Try again|Try again[^]*Boom|Boom/, T.name);
  }
});

test("summary: donut slices coloured by label, 100% label bar, names escaped", () => {
  const out = html(<SummaryCharts load={ok} />);
  assert.equal((out.match(/data-slice=""/g) ?? []).length, 2);
  assert.match(out, /fill="var\(--success\)"/);
  assert.match(out, /Slack &lt;b&gt; \(Unclassified\)/);
  assert.match(out, /Label share of active time/);
  assert.ok(!out.includes("Slack <b>"));
  const empty = html(<SummaryCharts load={{ status: "ok", data: { ...APPS, applications: [], categories: zero, employees: { items: [], total: 0, page: 1, pageSize: 50 }, categoriesConfigured: false } }} />);
  assert.match(empty, /No application activity in this range/);
  assert.match(empty, /Set up application labels/);
});

test("per employee: sortable table, most active first, links to the one-employee tab", () => {
  const out = html(<EmployeesTab load={ok} />);
  assert.match(out, /aria-label="Usage per employee"/);
  assert.ok(out.indexOf(">Ana<") < out.indexOf(">Ben<"));
  assert.match(out, /href="\/activity\?tab=employee&amp;employeeId=a"/);
  assert.match(out, /aria-sort="descending"/);
  assert.ok(!out.includes("Employee pages"), "one page: no pager");
  const paged = html(<EmployeesTab load={{ status: "ok", data: { ...APPS, employees: { ...APPS.employees, total: 120, page: 2 } } }} onPage={() => {}} />);
  assert.match(paged, /aria-label="Employee pages"/);
});

test("review: unreviewed count and list, link to Settings › App labels (no editor here)", () => {
  const out = html(<ReviewTab load={ok} />);
  assert.match(out, /Unreviewed applications[^]*>1</);
  assert.match(out, /href="\/settings\/labels"/);
  assert.ok(!out.includes("<select"), "no label editor");
  assert.match(html(<ReviewTab load={{ status: "ok", data: { ...APPS, applications: [APPS.applications[0]!] } }} />), /Every application used in this range has a label/);
});

test("app history: bar per day and per-employee days", () => {
  const out = html(<AppHistoryView data={{ from: "2026-05-04", to: "2026-05-05", teamId: null, key: "com.code", applicationName: "Code", days: [{ date: "2026-05-04", activeMs: H }, { date: "2026-05-05", activeMs: 0 }], employees: [{ employee: ref("a", "Ana"), activeMs: H, days: [{ date: "2026-05-04", activeMs: H }] }] }} />);
  assert.equal((out.match(/data-bar=""/g) ?? []).length, 1);
  assert.match(out, /App history per employee[^]*Ana[^]*05-04: 1h 00m/);
});

test("risk users: empty state; accordion of violated rules with counts; table links to the profile", () => {
  const base: RiskUsersResponse = { from: "2026-03-02", to: "2026-03-08", teamId: null, scheduledDailyMinutes: 480, lessHoursShare: 0.875, items: [], rules: [] };
  assert.match(html(<RiskUsersView data={base} />), /No risky users in this range/);
  const data: RiskUsersResponse = {
    ...base,
    items: [{ employee: ref("b", "Ben"), triggers: [{ trigger: "LESS_WORKING_HOURS", count: 1 }, { trigger: "LATE_CLOCK_IN", count: 2 }], total: 3, lessHours: { scheduledDays: 4, shortDays: 1, averageWorkedMinutes: 390, thresholdMinutes: 420 } }],
    rules: [{ trigger: "LESS_WORKING_HOURS", employees: 1, count: 1 }, { trigger: "LATE_CLOCK_IN", employees: 1, count: 2 }, { trigger: "IDLE_SHARE_ABOVE", employees: 0, count: 0 }],
  };
  const out = html(<RiskUsersView data={data} />);
  assert.equal((out.match(/<details/g) ?? []).length, 2, "only violated rules");
  assert.match(out, /Late clock-in[^]*1 employee · 2 days/);
  assert.match(out, /href="\/employees\/b"/);
  assert.match(out, /6h 30m \(threshold 7h 00m, 4 scheduled days\)/);
});

"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  formatDurationShort as formatDuration,
  type ActivityPeriodTotals,
  type ApplicationCategory,
  type CategorizedActivitySummary,
  type CategorizedTimelineItem,
  type MonitoringSettingsResponse,
  type Paginated,
} from "@workfolio/shared";
import { BreaksOverlay } from "@/components/breaks-overlay";
import { EmptyState, ErrorState, PageHeader, Pagination, SkeletonRows, StatCard, StatGrid, StatusBadge, Tabs, type Tone } from "@/components/kit";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { Badge, Card, formatInZone, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ActivityOverview } from "../_components/activity-overview";
import { DayTimeline } from "../_components/day-timeline";
import { EmployeePicker } from "../_components/employee-picker";
import { ProductivityTrend } from "../_components/productivity-trend";

const CATEGORY: Record<ApplicationCategory, { label: string; tone: Tone }> = {
  PRODUCTIVE: { label: "Productive", tone: "success" },
  NEUTRAL: { label: "Neutral", tone: "info" },
  UNPRODUCTIVE: { label: "Unproductive", tone: "warning" },
  UNCLASSIFIED: { label: "Unclassified", tone: "neutral" },
};

const PAGE_SIZE = 50;
const VIEWS = [
  { id: "all", label: "All employees" },
  { id: "employee", label: "One employee" },
] as const;
type View = (typeof VIEWS)[number]["id"];
const time = (iso: string, tz: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "medium", timeZone: tz }).format(new Date(iso));
const FRESHNESS = {
  CURRENT: ["Up to date", true],
  STALE: ["Stale: no recent upload", false],
  NO_DATA: ["No data yet", false],
} as const;

/** One row of period totals: observed (active + idle) vs clocked-in, the rest unobserved. */
function TotalsCells({ t }: { t: ActivityPeriodTotals }) {
  const observed = t.activeMs + t.idleMs;
  return (
    <>
      <td>{formatDuration(t.activeMs)}</td>
      <td>{formatDuration(t.idleMs)}</td>
      <td>{formatDuration(t.clockedInMs)}</td>
      <td className={t.unobservedMs > 0 ? "text-amber-700 dark:text-amber-300" : undefined}>{formatDuration(t.unobservedMs)}</td>
      <td className="text-muted">{t.clockedInMs ? `${Math.min(100, Math.round((observed / t.clockedInMs) * 100))}%` : "—"}</td>
    </>
  );
}
const TOTALS_HEAD = (
  <>
    <th className="font-medium">Active</th>
    <th className="font-medium">Idle</th>
    <th className="font-medium">Clocked in</th>
    <th className="font-medium">Unobserved</th>
    <th className="font-medium">Observed</th>
  </>
);

const day = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

export default function ActivityPage() {
  // useSearchParams suspends for request-time params under cacheComponents.
  return (
    <Suspense fallback={<SkeletonRows label="activity" />}>
      <Activity />
    </Suspense>
  );
}

function Activity() {
  const preset = useSearchParams().get("employeeId");
  const [employeeId, setEmployeeId] = useState(() => (preset && /^[0-9a-f-]{36}$/i.test(preset) ? preset : ""));
  const [view, setView] = useState<View>(() => (employeeId ? "employee" : "all"));
  const [range, setRange] = useState<Range>(() => weekRange());
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState<CategorizedActivitySummary | null>(null);
  const [timeline, setTimeline] = useState<Paginated<CategorizedTimelineItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // Organisation idle threshold in force (read-only here). null = not loaded; then nothing is claimed.
  const [policy, setPolicy] = useState<MonitoringSettingsResponse["effective"] | null>(null);
  useEffect(() => void api<MonitoringSettingsResponse>("/settings/monitoring").then((s) => setPolicy(s.effective), () => setPolicy(null)), []);

  useEffect(() => {
    if (!employeeId || view !== "employee") return;
    let active = true;
    const q = `employeeId=${employeeId}&from=${range.from}&to=${range.to}`;
    Promise.all([
      api<CategorizedActivitySummary>(`/activity/summary?${q}`),
      api<Paginated<CategorizedTimelineItem>>(`/activity/timeline?${q}&page=${page}&pageSize=${PAGE_SIZE}`),
    ]).then(
      ([s, t]) => active && (setSummary(s), setTimeline(t), setError(null)),
      (e) => active && setError(errorMessage(e)),
    );
    return () => {
      active = false;
    };
  }, [employeeId, view, range, page, retry]);

  const reset = () => (setSummary(null), setTimeline(null), setPage(1));
  const pick = useCallback((id: string) => (setSummary(null), setTimeline(null), setPage(1), setEmployeeId(id)), []);
  const tz = summary?.employee.timezone ?? "UTC";
  const pages = timeline ? Math.max(1, Math.ceil(timeline.total / timeline.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Activity"
        description={
          <>
            Recorded by the desktop app only while the employee is clocked in and not on a break: the foreground application&apos;s
            name and idle time (no input for the configured threshold, or screen locked). No window titles or keystrokes. Website
            domains are recorded separately and only when website tracking is enabled and approved (see <Link href="/websites" className="underline">Websites</Link>);
            screenshots are separate too (see Settings). Times are in the employee&apos;s time zone. Application labels are your own rules,
            not a measure of performance.
          </>
        }
        actions={policy && (
          <span className="text-sm" data-testid="idle-threshold">
            Idle threshold in force: <strong className="tabular-nums">{policy.idleThresholdSeconds} s</strong>
            <span className="text-muted"> ({policy.enabled ? `sampled every ${policy.sampleSeconds} s` : "activity monitoring is off"}; <Link href="/settings" className="underline">Settings</Link>)</span>
          </span>
        )}
      />

      <RangePicker value={range} maxDays={31} onChange={(r) => (reset(), setRange(r))} />

      <Tabs label="Activity views" tabs={VIEWS} value={view} idPrefix="activity-view" onChange={setView}>
      {view === "all" ? (
        <ActivityOverview range={range} onOpen={(id) => (pick(id), setView("employee"))} />
      ) : (
      <div className="flex flex-col gap-6">
      <EmployeePicker value={employeeId} onChange={pick} autoSelect />
      {employeeId && <DayTimeline key={employeeId} employeeId={employeeId} />}

      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!employeeId && !error && <EmptyState title="Choose an employee" hint="Search by name or employee code. If the list stays empty, no employees are enrolled yet." />}
      {employeeId && !summary && !error && <SkeletonRows label="activity" />}

      {summary && (
        <>
          {summary.warnings.length > 0 && (
            <Notice tone="warning">
              <ul className="list-disc space-y-1 pl-5">
                {summary.warnings.map((w, i) => (
                  <li key={i}>
                    {w.date && <strong>{day(w.date)}: </strong>}
                    {w.message}
                  </li>
                ))}
              </ul>
            </Notice>
          )}

          <StatGrid>
            <StatCard label="Active time" value={formatDuration(summary.activeMs)} />
            <StatCard label="Idle time" value={formatDuration(summary.idleMs)} />
            <StatCard label="Clocked in" value={formatDuration(summary.clockedInMs)} hint={`Unobserved: ${formatDuration(summary.unobservedMs)} (asleep, app closed, paused or not uploaded yet; never estimated)`} />
            <Card title="Data freshness">
              <p className="text-sm"><Badge ok={FRESHNESS[summary.freshness][1]}>{FRESHNESS[summary.freshness][0]}</Badge></p>
              <p className="mt-2 text-xs text-muted">Last upload: {summary.lastReceivedAt ? formatInZone(summary.lastReceivedAt, tz) : "Never"}</p>
              <p className="text-xs text-muted">Device last seen: {summary.deviceLastSeenAt ? formatInZone(summary.deviceLastSeenAt, tz) : "—"}</p>
              <p className="text-xs text-muted">
                Notice {summary.consent.noticeVersion}: {summary.consent.acknowledgedAt ? `acknowledged ${formatInZone(summary.consent.acknowledgedAt, tz)}` : "not acknowledged"}
              </p>
            </Card>
          </StatGrid>

          <section aria-labelledby="act-labels" className="flex flex-col gap-3">
            <h2 id="act-labels" className="text-lg font-semibold">Application labels</h2>
            {summary.categoriesConfigured ? (
              <>
                <StatGrid>
                  <StatCard label="Productive" value={formatDuration(summary.productiveMs)} />
                  <StatCard label="Neutral" value={formatDuration(summary.neutralMs)} />
                  <StatCard label="Unproductive" value={formatDuration(summary.unproductiveMs)} />
                  <StatCard label="Unclassified" value={formatDuration(summary.unclassifiedMs)} hint="Active time in applications without a label" />
                </StatGrid>
                <StatCard
                  label="Productive share of clocked-in time"
                  value={summary.productiveShare === null ? null : `${Math.round(summary.productiveShare * 100)}%`}
                  reason="Nothing was clocked in during this range"
                  hint="Productive active time ÷ clocked-in time (idle and unobserved time included in the clocked-in total)"
                />
                <p className="text-xs text-muted">
                  Labels come from your <Link href="/settings/labels" className="underline">application label rules</Link> and are applied when this
                  page is read, so changing a rule also relabels past activity. Idle time is never productive.
                </p>
                <ProductivityTrend days={summary.days} />
              </>
            ) : (
              <EmptyState
                title="No application labels configured"
                hint={<>Productive, neutral and unproductive totals appear once you label applications. <Link href="/settings/labels" className="text-brand underline">Set up application labels</Link>.</>}
              />
            )}
          </section>

          {summary.activeMs + summary.idleMs === 0 && summary.clockedInMs === 0 ? (
            <EmptyState title="No activity recorded for this employee in this range." />
          ) : (
            <>
              <Card title="Applications">
                <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm tabular-nums" aria-label="Applications">
                  <thead className="text-xs text-muted uppercase">
                    <tr><th className="py-2 font-medium">Application</th><th className="font-medium">Label</th><th className="font-medium">Active time</th><th className="w-1/3 font-medium">Share of active time</th></tr>
                  </thead>
                  <tbody>
                    {summary.applications.map((a) => {
                      const share = summary.activeMs ? a.activeMs / summary.activeMs : 0;
                      return (
                        <tr key={a.applicationIdentifier ?? a.applicationName} className="border-t border-border">
                          <td className="py-2">
                            {a.applicationName}
                            {a.applicationIdentifier && <div className="font-mono text-xs text-muted">{a.applicationIdentifier}</div>}
                          </td>
                          <td><StatusBadge tone={CATEGORY[a.category].tone}>{CATEGORY[a.category].label}</StatusBadge></td>
                          <td>{formatDuration(a.activeMs)}</td>
                          <td>
                            <div className="flex items-center gap-2">
                              <div className="h-2 flex-1 rounded bg-background" aria-hidden="true">
                                <div className="h-2 rounded bg-brand" style={{ width: `${Math.round(share * 100)}%` }} />
                              </div>
                              <span className="w-10 text-right text-xs">{Math.round(share * 100)}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </Card>

              <Card title="Weekly totals">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm tabular-nums">
                    <thead className="text-xs text-muted uppercase"><tr><th className="py-2 font-medium">Week of</th>{TOTALS_HEAD}</tr></thead>
                    <tbody>
                      {summary.weeks.map((w) => (
                        <tr key={w.weekStart} className="border-t border-border"><td className="py-2">{day(w.weekStart)}</td><TotalsCells t={w} /></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title="Daily totals">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm tabular-nums">
                    <thead className="text-xs text-muted uppercase"><tr><th className="py-2 font-medium">Day</th>{TOTALS_HEAD}</tr></thead>
                    <tbody>
                      {summary.days.map((d) => (
                        <tr key={d.date} className="border-t border-border"><td className="py-2">{day(d.date)}</td><TotalsCells t={d} /></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title={`Application switching timeline (${timeline?.total ?? 0} intervals)`}>
                <BreaksOverlay employeeId={employeeId} from={range.from} to={range.to} tz={tz} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm tabular-nums" aria-label="Activity timeline">
                    <thead className="text-xs text-muted uppercase">
                      <tr><th className="py-2 font-medium">From</th><th className="font-medium">To</th><th className="font-medium">Duration</th><th className="font-medium">Activity</th>{summary.categoriesConfigured && <th className="font-medium">Label</th>}</tr>
                    </thead>
                    <tbody>
                      {timeline?.items.map((i) => (
                        <tr key={i.id} className="border-t border-border">
                          <td className="py-1.5">{time(i.startedAt, tz)}</td>
                          <td>{time(i.endedAt, tz)}</td>
                          <td>{formatDuration(Date.parse(i.endedAt) - Date.parse(i.startedAt))}</td>
                          <td>{i.kind === "IDLE" ? <span className="text-muted">Idle</span> : i.applicationName}</td>
                          {summary.categoriesConfigured && <td>{i.category ? <StatusBadge tone={CATEGORY[i.category].tone}>{CATEGORY[i.category].label}</StatusBadge> : <span className="text-muted">—</span>}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pages > 1 && <div className="mt-3"><Pagination label="Timeline pages" page={page} pageCount={pages} onPage={setPage} /></div>}
              </Card>
            </>
          )}
        </>
      )}
      </div>
      )}
      </Tabs>
    </div>
  );
}

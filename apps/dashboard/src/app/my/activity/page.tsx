"use client";

import { useState } from "react";
import Link from "next/link";
import {
  addDays,
  formatDuration,
  formatDurationShort,
  todayIn,
  type ActivityStatusResponse,
  type CategorizedActivitySummary,
  type CategorizedTimelineItem,
  type ActivityWarning,
  type Paginated,
  type WebsiteUsageResponse,
} from "@workfolio/shared";
import { BreaksOverlay } from "@/components/breaks-overlay";
import { Button, DataTable, EmptyState, PageHeader, Pagination, StatCard, StatGrid } from "@/components/kit";
import { dayLabel, timeIn, UpdatedAt, useApi, useMe } from "@/components/my-ui";
import { Card, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { CategoryBadge, CategoryTotals } from "../_components/categories";
import { Loaded } from "../_components/states";
import { ProductivityTrend } from "../../(admin)/_components/productivity-trend";

const TIMELINE_PAGE = 200;
const TOP_DOMAINS = 10;
/** The trend shows the selected day and the six before it. */
const TREND_DAYS = 7;

/** Employee wording for the summary's warnings (same as the desktop app; the API words them for admins). */
const NOTE: Partial<Record<ActivityWarning["code"], string>> = {
  MONITORING_DISABLED: "Activity monitoring is turned off by your organization, so nothing is recorded.",
  NO_CONSENT: "Nothing is recorded until you acknowledge the current monitoring notice in the desktop app.",
  NO_ACTIVE_DEVICE: "No device is registered, so activity cannot be recorded.",
  UNSUPPORTED_PLATFORM: "On Windows, activity is recorded only by the latest Insight Workfolio desktop app; if nothing appears, update the app.",
  STALE_SYNC: "You are clocked in but no recent activity has reached the server yet. Activity still on your computer is not included.",
};

/** Own application activity for one day (employee's zone). Read-only: recorded by the desktop app. */
export default function MyActivityPage() {
  const tz = useMe().timezone;
  const today = todayIn(tz);
  const [day, setDay] = useState(today);
  const [page, setPage] = useState(1);
  const go = (d: string) => (setDay(d > today ? today : d), setPage(1));
  const q = `from=${day}&to=${day}`;
  const status = useApi<ActivityStatusResponse>("/activity/me");
  const summary = useApi<CategorizedActivitySummary>(`/activity/summary?${q}`);
  const timeline = useApi<Paginated<CategorizedTimelineItem>>(`/activity/timeline?${q}&page=${page}&pageSize=${TIMELINE_PAGE}`);
  const trend = useApi<CategorizedActivitySummary>(`/activity/summary?from=${addDays(day, -(TREND_DAYS - 1))}&to=${day}`);
  const websites = useApi<WebsiteUsageResponse>(`/websites/me/usage?${q}`);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="My activity"
        description={`Which application was in front and when you were idle, as recorded by the desktop app. Times in ${tz}. Never keystrokes, window titles or URLs.`}
      />

      <Loaded load={status.load} reload={status.reload} label="your monitoring status">
        {(s) => <MonitoringState status={s} tz={tz} />}
      </Loaded>

      <nav aria-label="Day" className="flex flex-wrap items-end gap-2 text-sm">
        <button type="button" className={secondaryButtonClass} onClick={() => go(addDays(day, -1))}>Previous day</button>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Day</span>
          <input type="date" value={day} max={today} className={inputClass} onChange={(e) => e.target.value && go(e.target.value)} />
        </label>
        <Button variant="secondary" disabledReason={day >= today ? "Today is the latest day" : null} onClick={() => go(addDays(day, 1))}>Next day</Button>
        {day !== today && <button type="button" className={secondaryButtonClass} onClick={() => go(today)}>Today</button>}
        <span className="pb-2 text-muted">{dayLabel(day)}</span>
      </nav>

      <Card title="Totals" actions={summary.load.state === "ready" && <UpdatedAt at={summary.load.at} />}>
        <Loaded load={summary.load} reload={summary.reload} label="your activity totals">
          {(a) => <Totals summary={a} />}
        </Loaded>
      </Card>

      <Card title="Applications">
        <Loaded load={summary.load} reload={summary.reload} label="your application activity">
          {(a) =>
            a.applications.length === 0 ? (
              <EmptyState title="No applications recorded on this day." />
            ) : (
              <DataTable label="My application activity" head={["Application", "Active (in front)", ...(a.categoriesConfigured ? ["Label (organization)"] : [])]}>
                {a.applications.map((app) => (
                  <tr key={app.applicationIdentifier ?? `name:${app.applicationName}`}>
                    <td>{app.applicationName}</td>
                    <td className="tabular-nums">{formatDurationShort(app.activeMs)}</td>
                    {a.categoriesConfigured && <td><CategoryBadge category={app.category} /></td>}
                  </tr>
                ))}
              </DataTable>
            )
          }
        </Loaded>
      </Card>

      <Card title="Timeline">
        <BreaksOverlay from={day} to={day} tz={tz} />
        <Loaded load={timeline.load} reload={timeline.reload} label="your activity timeline">
          {(t) => <Timeline page={t} tz={tz} onPage={setPage} labelled={summary.load.state === "ready" && summary.load.data.categoriesConfigured} />}
        </Loaded>
      </Card>

      {trend.load.state === "ready" && trend.load.data.categoriesConfigured && (
        <Card title={`Last ${TREND_DAYS} days to ${dayLabel(day)}`}>
          <ProductivityTrend days={trend.load.data.days} />
        </Card>
      )}

      <Card title="Websites" actions={<Link href="/my/websites" className="text-sm text-brand hover:underline">All website activity</Link>}>
        <Loaded load={websites.load} reload={websites.reload} label="your website activity">
          {(w) =>
            w.byDomain.length === 0 ? (
              <EmptyState title="No website activity recorded on this day." />
            ) : (
              <div className="flex flex-col gap-2 text-sm">
                <p className="text-xs text-muted">Recorded: {formatDuration(w.totalMs)} (domain names only, from the browser extension).</p>
                <ul className="flex flex-col gap-1">
                  {[...w.byDomain].sort((x, y) => y.durationMs - x.durationMs).slice(0, TOP_DOMAINS).map((d) => (
                    <li key={d.domain} className="flex justify-between gap-3">
                      <span className="font-mono break-all">{d.domain}</span>
                      <span className="tabular-nums">{formatDurationShort(d.durationMs)}</span>
                    </li>
                  ))}
                </ul>
                {w.byDomain.length > TOP_DOMAINS && <p className="text-xs text-muted">{w.byDomain.length - TOP_DOMAINS} more on the website activity page.</p>}
              </div>
            )
          }
        </Loaded>
      </Card>
    </div>
  );
}

function MonitoringState({ status, tz }: { status: ActivityStatusResponse; tz: string }) {
  if (!status.policy.enabled) return <Notice tone="warning">Activity monitoring is turned off by your organization, so nothing is recorded.</Notice>;
  if (!status.consent.acknowledgedAt) {
    return (
      <Notice tone="warning">
        Not recording: you have not acknowledged the current monitoring notice ({status.notice.title}, version {status.consent.noticeVersion}). Nothing is recorded until you acknowledge it in the desktop app.
      </Notice>
    );
  }
  return (
    <p data-testid="my-activity-state" className="text-sm">
      Monitoring is on. You acknowledged notice version {status.consent.noticeVersion} on {new Date(status.consent.acknowledgedAt).toLocaleDateString("en-GB", { timeZone: tz, dateStyle: "medium" })}.
      {" "}Last upload: {status.lastReceivedAt ? `${dayLabel(todayIn(tz, Date.parse(status.lastReceivedAt)))} ${timeIn(status.lastReceivedAt, tz)}` : "none yet"}.
    </p>
  );
}

function Totals({ summary: a }: { summary: CategorizedActivitySummary }) {
  const notes = [...new Set(a.warnings.map((w) => NOTE[w.code]).filter((n): n is string => !!n))];
  return (
    <div className="flex flex-col gap-3">
      {notes.length > 0 && <Notice tone="warning">{notes.join("\n")}</Notice>}
      <StatGrid>
        <StatCard label="Clocked in" value={formatDuration(a.clockedInMs)} />
        <StatCard label="Active (an application in front)" value={formatDuration(a.activeMs)} />
        <StatCard label="Idle" value={formatDuration(a.idleMs)} hint="No keyboard or mouse input" />
        <StatCard label="No record" value={formatDuration(a.unobservedMs)} hint="Clocked in but nothing recorded" />
      </StatGrid>
      <CategoryTotals summary={a} />
      {a.activeMs + a.idleMs === 0 && <EmptyState title="No activity recorded on this day." />}
    </div>
  );
}

function Timeline({ page, tz, onPage, labelled }: { page: Paginated<CategorizedTimelineItem>; tz: string; onPage: (p: number) => void; labelled: boolean }) {
  if (!page.items.length) return <EmptyState title="No activity recorded on this day." />;
  const pages = Math.ceil(page.total / page.pageSize);
  return (
    <div className="flex flex-col gap-3">
      <DataTable label="My activity timeline" head={["From", "To", "Duration", "State", "Application", ...(labelled ? ["Label (organization)"] : [])]}>
        {page.items.map((i) => (
          <tr key={i.id}>
            <td className="tabular-nums">{timeIn(i.startedAt, tz)}</td>
            <td className="tabular-nums">{timeIn(i.endedAt, tz)}</td>
            <td className="tabular-nums">{formatDurationShort(Date.parse(i.endedAt) - Date.parse(i.startedAt))}</td>
            <td>{i.kind === "IDLE" ? "Idle" : "Active"}</td>
            <td>{i.kind === "IDLE" ? <span className="text-muted">—</span> : (i.applicationName ?? "Unknown")}</td>
            {labelled && <td>{i.category ? <CategoryBadge category={i.category} /> : <span className="text-muted">—</span>}</td>}
          </tr>
        ))}
      </DataTable>
      {pages > 1 && <Pagination label="Timeline pages" page={page.page} pageCount={pages} onPage={onPage} />}
    </div>
  );
}

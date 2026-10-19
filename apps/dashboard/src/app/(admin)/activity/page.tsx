"use client";

import { useEffect, useState } from "react";
import {
  formatDurationShort as formatDuration,
  type ActivityPeriodTotals,
  type ActivitySummaryResponse,
  type ActivityTimelineItem,
  type Employee,
  type Paginated,
} from "@workfolio/shared";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { Badge, Card, formatInZone, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 50;
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
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [range, setRange] = useState<Range>(() => weekRange());
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState<ActivitySummaryResponse | null>(null);
  const [timeline, setTimeline] = useState<Paginated<ActivityTimelineItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Paginated<Employee>>("/employees?pageSize=100").then(
      (r) => {
        setEmployees(r.items);
        if (r.items[0]) setEmployeeId((id) => id || r.items[0]!.id);
      },
      (e) => setError(errorMessage(e)),
    );
  }, []);

  useEffect(() => {
    if (!employeeId) return;
    let active = true;
    const q = `employeeId=${employeeId}&from=${range.from}&to=${range.to}`;
    Promise.all([
      api<ActivitySummaryResponse>(`/activity/summary?${q}`),
      api<Paginated<ActivityTimelineItem>>(`/activity/timeline?${q}&page=${page}&pageSize=${PAGE_SIZE}`),
    ]).then(
      ([s, t]) => active && (setSummary(s), setTimeline(t), setError(null)),
      (e) => active && setError(errorMessage(e)),
    );
    return () => {
      active = false;
    };
  }, [employeeId, range, page]);

  const reset = () => (setSummary(null), setTimeline(null), setPage(1));
  const tz = summary?.employee.timezone ?? "UTC";
  const pages = timeline ? Math.max(1, Math.ceil(timeline.total / timeline.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="mt-1 text-sm text-muted">
          Recorded by the desktop app only while the employee is clocked in and not on a break: the foreground application&apos;s
          name and idle time (no input for the configured threshold, or screen locked). No window titles, websites or keystrokes
          (screenshots are separate; see Settings). Times are in the employee&apos;s time zone. No productivity scores are calculated: these are records of
          what was observed, not a measure of performance.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted">Employee</span>
          <select value={employeeId} onChange={(e) => (reset(), setEmployeeId(e.target.value))} className={inputClass} disabled={!employees}>
            {employees?.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
          </select>
        </label>
        <RangePicker value={range} onChange={(r) => (reset(), setRange(r))} />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {employees?.length === 0 && <p className="text-sm text-muted">No employees enrolled yet.</p>}
      {employeeId && !summary && !error && <p role="status" className="text-sm text-muted">Loading…</p>}

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

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card title="Active time"><p className="text-2xl font-semibold tabular-nums">{formatDuration(summary.activeMs)}</p></Card>
            <Card title="Idle time"><p className="text-2xl font-semibold tabular-nums">{formatDuration(summary.idleMs)}</p></Card>
            <Card title="Clocked in">
              <p className="text-2xl font-semibold tabular-nums">{formatDuration(summary.clockedInMs)}</p>
              <p className="mt-1 text-xs text-muted">Unobserved: {formatDuration(summary.unobservedMs)} (asleep, app closed, paused or not uploaded yet; never estimated)</p>
            </Card>
            <Card title="Data freshness">
              <p className="text-sm"><Badge ok={FRESHNESS[summary.freshness][1]}>{FRESHNESS[summary.freshness][0]}</Badge></p>
              <p className="mt-2 text-xs text-muted">Last upload: {summary.lastReceivedAt ? formatInZone(summary.lastReceivedAt, tz) : "Never"}</p>
              <p className="text-xs text-muted">Device last seen: {summary.deviceLastSeenAt ? formatInZone(summary.deviceLastSeenAt, tz) : "—"}</p>
              <p className="text-xs text-muted">
                Notice {summary.consent.noticeVersion}: {summary.consent.acknowledgedAt ? `acknowledged ${formatInZone(summary.consent.acknowledgedAt, tz)}` : "not acknowledged"}
              </p>
            </Card>
          </div>

          {summary.activeMs + summary.idleMs === 0 && summary.clockedInMs === 0 ? (
            <p className="text-sm text-muted">No activity recorded for this employee in this range.</p>
          ) : (
            <>
              <Card title="Applications">
                <table className="w-full text-left text-sm tabular-nums">
                  <thead className="text-xs text-muted uppercase">
                    <tr><th className="py-2 font-medium">Application</th><th className="font-medium">Active time</th><th className="w-1/3 font-medium">Share of active time</th></tr>
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
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm tabular-nums">
                    <thead className="text-xs text-muted uppercase">
                      <tr><th className="py-2 font-medium">From</th><th className="font-medium">To</th><th className="font-medium">Duration</th><th className="font-medium">Activity</th></tr>
                    </thead>
                    <tbody>
                      {timeline?.items.map((i) => (
                        <tr key={i.id} className="border-t border-border">
                          <td className="py-1.5">{time(i.startedAt, tz)}</td>
                          <td>{time(i.endedAt, tz)}</td>
                          <td>{formatDuration(Date.parse(i.endedAt) - Date.parse(i.startedAt))}</td>
                          <td>{i.kind === "IDLE" ? <span className="text-muted">Idle</span> : i.applicationName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pages > 1 && (
                  <nav aria-label="Timeline pages" className="mt-3 flex items-center justify-between text-sm">
                    <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={secondaryButtonClass}>Previous</button>
                    <span className="text-muted">Page {page} of {pages}</span>
                    <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className={secondaryButtonClass}>Next</button>
                  </nav>
                )}
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

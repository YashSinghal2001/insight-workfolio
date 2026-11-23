"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  attendanceTotals,
  DAILY_ATTENDANCE_STATUSES,
  formatDuration,
  type AttendanceOverviewRow,
  type AttendanceSession,
  type DailyAttendanceResponse,
  type DailyAttendanceStatus,
  type LeavePortion,
  type LiveStatus,
  type OverviewFreshness,
  type Paginated,
  type ScreenshotFeatureState,
} from "@workfolio/shared";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SkeletonRows, StatusBadge, Tabs, type Tone } from "@/components/kit";
import { formatInZone, inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ATTENDANCE_TABS, eventSourceLabel, lastSeenLabel, parseAttendanceTab, type AttendanceTab } from "@/lib/attendance-ui";
import { pollWhileVisible } from "@/lib/poll";
import { LateTab } from "./_components/late";
import { MissingTab } from "./_components/missing";
import { MonthlyTab } from "./_components/monthly";
import { ShiftsTab } from "./_components/shifts";

const PAGE_SIZE = 20;
const REFRESH_MS = 30_000;

const STATE: Record<AttendanceOverviewRow["state"], { label: string; tone: Tone }> = {
  CLOCKED_IN: { label: "Clocked in", tone: "success" },
  ON_BREAK: { label: "On break", tone: "warning" },
  CLOCKED_OUT: { label: "Clocked out", tone: "neutral" },
};

/** UNKNOWN (no fresh report from the desktop) is shown as unknown, never as active or idle. */
const LIVE: Record<LiveStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: "Active", tone: "success" },
  IDLE: { label: "Idle", tone: "warning" },
  ON_BREAK: { label: "On break", tone: "info" },
  NOT_CLOCKED_IN: { label: "Not clocked in", tone: "neutral" },
  UNKNOWN: { label: "Unknown", tone: "neutral" },
};
const SHOTS: Record<ScreenshotFeatureState, { label: string; tone: Tone }> = {
  DISABLED: { label: "Disabled", tone: "neutral" },
  AWAITING_CONSENT: { label: "Awaiting consent", tone: "info" },
  ENABLED: { label: "Enabled", tone: "success" },
  PERMISSION_DENIED: { label: "Permission denied", tone: "danger" },
  CAPTURE_FAILED: { label: "Capture failed", tone: "danger" },
};

const totals = (s: AttendanceSession, now: number) =>
  attendanceTotals({ start: s.clockInAt, end: s.clockOutAt }, s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt })), now);

type LiveRow = AttendanceOverviewRow & OverviewFreshness;

export default function AttendancePage() {
  // useSearchParams suspends for request-time params under cacheComponents.
  return (
    <Suspense fallback={<SkeletonRows label="attendance" />}>
      <Attendance />
    </Suspense>
  );
}

function Attendance() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { date, teamId } = useGlobalFilters();
  const tab = parseAttendanceTab(new URLSearchParams(params.toString()));
  const select = (t: AttendanceTab) => {
    const next = new URLSearchParams(params.toString());
    next.delete("view");
    if (t === "live") next.delete("tab");
    else next.set("tab", t);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const team = teamId ?? "all";
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Attendance"
        about="Live status from employees' desktop apps, daily and monthly views against the work schedule, late arrivals and shifts that look forgotten. Times are shown in each employee's time zone. Attendance is never edited here: fixes go through correction requests that a different administrator approves."
      />
      {/* Live is "now" and the other tabs have their own period, so only Daily uses the global date. */}
      <GlobalFilters date={tab === "daily"} />
      <Tabs label="Attendance views" tabs={ATTENDANCE_TABS} value={tab} idPrefix="att" onChange={select}>
        {tab === "live" && <Live key={team} teamId={teamId} />}
        {tab === "daily" && <Daily key={`${team}-${date}`} teamId={teamId} date={date} />}
        {tab === "monthly" && <MonthlyTab key={team} teamId={teamId} />}
        {tab === "late" && <LateTab key={team} teamId={teamId} />}
        {tab === "missing" && <MissingTab key={team} teamId={teamId} />}
        {tab === "shifts" && <ShiftsTab key={team} teamId={teamId} />}
      </Tabs>
    </div>
  );
}

function Live({ teamId }: { teamId: string | null }) {
  const [query, setQuery] = useState({ q: "", page: 1 });
  const [data, setData] = useState<Paginated<LiveRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (query.q) params.set("q", query.q);
    if (teamId) params.set("teamId", teamId);
    // Every 30 s while the tab is visible; only the newest response is applied.
    return pollWhileVisible(
      () => api<Paginated<LiveRow>>(`/attendance/overview?${params}`),
      (r) => (setData(r), setError(null), setNow(Date.now())),
      (e) => setError(errorMessage(e)),
      REFRESH_MS,
    );
  }, [query, teamId]);

  function onSearch(e: FormEvent<HTMLFormElement>) {
    setData(null);
    setQuery({ q: String(new FormData(e.currentTarget).get("q") ?? "").trim(), page: 1 });
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">Refreshed every 30 seconds.</p>
      <FilterBar label="Search employees" onSubmit={onSearch}>
        <input name="q" type="search" placeholder="Search name, email or employee code" aria-label="Search employees" maxLength={100} className={`${inputClass} flex-1 sm:w-auto`} />
        <button type="submit" className={secondaryButtonClass}>Search</button>
      </FilterBar>
      {error && <ErrorState message={error} onRetry={() => setQuery((q) => ({ ...q }))} />}
      {!data && !error && <SkeletonRows label="attendance" />}
      {data?.items.length === 0 && <EmptyState title={query.q ? "No employees match your search." : "No employees enrolled yet."} />}
      {data && data.items.length > 0 && (
        <DataTable label="Live attendance" head={["Employee", "Status", "Activity", "Clocked in", "Breaks", "Net working time", "Screenshots", "Device"]} minWidth={1080}>
          {data.items.map((row) => <Row key={row.employeeId} row={row} now={now} />)}
        </DataTable>
      )}
      {data && pages > 1 && <Pagination page={query.page} pageCount={pages} onPage={(page) => setQuery((q) => ({ ...q, page }))} />}
    </div>
  );
}

const DAILY: Record<DailyAttendanceStatus, { label: string; tone: Tone }> = {
  NO_POLICY: { label: "No schedule", tone: "neutral" },
  NOT_SCHEDULED: { label: "Not a workday", tone: "neutral" },
  HOLIDAY: { label: "Holiday", tone: "info" },
  ON_LEAVE: { label: "On leave", tone: "info" },
  PRESENT: { label: "Present", tone: "success" },
  LATE: { label: "Late", tone: "warning" },
  ABSENT: { label: "Absent", tone: "danger" },
  NOT_YET_DUE: { label: "Not yet due", tone: "neutral" },
};
const PORTION: Record<LeavePortion, string> = { FULL_DAY: "full day", FIRST_HALF: "first half", SECOND_HALF: "second half", SHORT: "part of the day" };

function Daily({ date, teamId }: { date: string; teamId: string | null }) {
  const [query, setQuery] = useState({ q: "", page: 1 });
  const [data, setData] = useState<DailyAttendanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ date, page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (query.q) params.set("q", query.q);
    if (teamId) params.set("teamId", teamId);
    api<DailyAttendanceResponse>(`/attendance/daily?${params}`).then(
      (r) => active && (setData(r), setError(null)),
      (e) => active && (setError(errorMessage(e)), setData(null)),
    );
    return () => {
      active = false;
    };
  }, [query, date, teamId, retry]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const noPolicy = data && data.total > 0 && data.summary.NO_POLICY + data.summary.ON_LEAVE + data.summary.HOLIDAY === data.total && data.summary.NO_POLICY > 0;

  return (
    <div className="flex flex-col gap-4">
      <FilterBar label="Daily attendance filters" onSubmit={(e) => (setData(null), setQuery((q) => ({ ...q, q: String(new FormData(e.currentTarget).get("q") ?? "").trim(), page: 1 })))}>
        <input name="q" type="search" placeholder="Search name, email or employee code" aria-label="Search employees" maxLength={100} className={`${inputClass} flex-1 sm:w-auto`} />
        <button type="submit" className={secondaryButtonClass}>Search</button>
      </FilterBar>
      <p className="text-xs text-muted">
        Showing {date} (change it with the date filter at the top). The date is read in each employee&apos;s own time zone. {data?.meta.policyRule} A <Link href="/holidays" className="text-brand underline">holiday</Link> is
        shown as Holiday, never Absent{data && !data.meta.holidaysConfigured ? " (no holidays are configured yet)" : ""}. An employee&apos;s own start time or workdays, set on their employee page, replace the organisation&apos;s schedule for them.
      </p>
      {noPolicy && (
        <EmptyState
          title="No work schedule applied to this date"
          hint={<>Late and absent are only worked out under an enabled work schedule; without one nobody is labelled late or absent. Approved leave is still shown. <Link href="/settings/schedule" className="text-brand underline">Configure the work schedule</Link>.</>}
        />
      )}
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="daily attendance" />}
      {data && (
        <>
          <ul aria-label="Status counts" className="flex flex-wrap gap-2 text-sm">
            {DAILY_ATTENDANCE_STATUSES.filter((s) => data.summary[s] > 0).map((s) => (
              <li key={s}><StatusBadge tone={DAILY[s].tone}>{DAILY[s].label}: {data.summary[s]}</StatusBadge></li>
            ))}
          </ul>
          {data.items.length === 0 ? (
            <EmptyState title={query.q ? "No employees match your search." : "No employees enrolled yet."} />
          ) : (
            <DataTable label="Daily attendance" head={["Employee", "Status", "First clock-in", "Late by", "Leave or holiday"]} minWidth={720}>
              {data.items.map((r) => (
                <tr key={r.employee.id} className="align-top">
                  <td>
                    <Link href={`/timesheets/${r.employee.id}`} className="font-medium text-brand hover:underline">{r.employee.fullName}</Link>
                    <div className="font-mono text-xs text-muted">{r.employee.employeeCode} · {r.employee.timezone}</div>
                  </td>
                  <td><StatusBadge tone={DAILY[r.status].tone}>{DAILY[r.status].label}</StatusBadge></td>
                  <td className="tabular-nums">{r.firstClockInLocal ? r.firstClockInLocal.replace("T", " ") : "—"}</td>
                  <td className="tabular-nums">{r.lateMinutes !== null ? `${r.lateMinutes} min` : "—"}</td>
                  <td>{r.holiday ? r.holiday.name : r.leave ? `Approved leave (${PORTION[r.leave.portion]}${r.leave.startTime ? ` ${r.leave.startTime}–${r.leave.endTime ?? ""}` : ""})` : "—"}</td>
                </tr>
              ))}
            </DataTable>
          )}
          {pages > 1 && <Pagination page={query.page} pageCount={pages} onPage={(page) => setQuery((q) => ({ ...q, page }))} />}
        </>
      )}
    </div>
  );
}

function Row({ row, now }: { row: LiveRow; now: number }) {
  const s = row.session;
  const open = s && row.state !== "CLOCKED_OUT";
  const t = s && totals(s, now);
  const openBreak = s?.breaks.find((b) => !b.endedAt);
  const ev = row.lastEvent;
  return (
    <tr className="align-top">
      <td>
        <Link href={`/employees/${row.employeeId}`} className="font-medium text-brand hover:underline">{row.fullName}</Link>
        <div className="font-mono text-xs text-muted">{row.employeeCode}</div>
      </td>
      <td>
        <StatusBadge tone={STATE[row.state].tone}>{STATE[row.state].label}</StatusBadge>
        {row.missingClockOut && <div className="mt-1"><StatusBadge tone="danger">Missing clock-out</StatusBadge></div>}
      </td>
      <td>
        <StatusBadge tone={LIVE[row.liveStatus].tone}>{LIVE[row.liveStatus].label}</StatusBadge>
        {row.liveSince && <div className="text-xs text-muted">since {formatInZone(row.liveSince, row.timezone)}</div>}
        {row.liveStatus === "UNKNOWN" && <div className="text-xs text-muted">No recent report from the desktop app</div>}
      </td>
      <td>{open ? formatInZone(s.clockInAt, row.timezone) : "—"}</td>
      <td>
        {!open || !t ? "—" : openBreak ? `On break since ${formatInZone(openBreak.startedAt, row.timezone)}` : `${s.breaks.length} · ${formatDuration(t.breakMs)}`}
      </td>
      <td className="tabular-nums">
        {open && t ? formatDuration(t.netMs) : s && t ? <span className="text-muted">Last shift {formatDuration(t.netMs)}</span> : "—"}
      </td>
      <td><StatusBadge tone={SHOTS[row.screenshotState].tone}>{SHOTS[row.screenshotState].label}</StatusBadge></td>
      <td>
        {/* Freshness comes from the device's last contact, never from how the last event was sent. */}
        <span title={row.lastSeenAt ? formatInZone(row.lastSeenAt, row.timezone) : undefined}>
          <StatusBadge tone={row.online ? "success" : "neutral"}>{lastSeenLabel(row.online, row.lastSeenAt, now)}</StatusBadge>
        </span>
        {ev && (
          <div className={`mt-1 text-xs ${ev.outcome === "REJECTED" ? "text-danger" : "text-muted"}`}>
            Last event {formatInZone(ev.receivedAt, row.timezone)} · {ev.outcome === "REJECTED" ? "rejected" : eventSourceLabel(ev.source)}
          </div>
        )}
      </td>
    </tr>
  );
}

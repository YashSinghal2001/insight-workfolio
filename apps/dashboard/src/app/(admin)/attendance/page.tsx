"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  attendanceTotals,
  DAILY_ATTENDANCE_STATUSES,
  formatDuration,
  localDate,
  type AttendanceOverviewRow,
  type AttendanceSession,
  type DailyAttendanceResponse,
  type DailyAttendanceStatus,
  type LeavePortion,
  type LiveStatus,
  type Paginated,
  type ScreenshotFeatureState,
} from "@workfolio/shared";
import { DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SkeletonRows, StatusBadge, Tabs, type Tone } from "@/components/kit";
import { formatInZone, inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

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

const VIEWS = [
  { id: "live", label: "Live" },
  { id: "daily", label: "Daily" },
] as const;
type View = (typeof VIEWS)[number]["id"];

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
  const view: View = params.get("view") === "daily" ? "daily" : "live";
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Attendance"
        description="Live status from employees' desktop apps, and a daily view against the work schedule. Times are shown in each employee's time zone. Read-only: attendance cannot be edited here."
      />
      <Tabs label="Attendance views" tabs={VIEWS} value={view} idPrefix="att" onChange={(v) => router.replace(v === "daily" ? `${pathname}?view=daily` : pathname)}>
        {view === "live" ? <Live /> : <Daily />}
      </Tabs>
    </div>
  );
}

function Live() {
  const [query, setQuery] = useState({ q: "", page: 1 });
  const [data, setData] = useState<Paginated<AttendanceOverviewRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (query.q) params.set("q", query.q);
    const load = () =>
      api<Paginated<AttendanceOverviewRow>>(`/attendance/overview?${params}`).then(
        (r) => active && (setData(r), setError(null), setNow(Date.now())),
        (e) => active && setError(errorMessage(e)),
      );
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [query]);

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
        <DataTable label="Live attendance" head={["Employee", "Status", "Activity", "Clocked in", "Breaks", "Net working time", "Screenshots", "Last sync"]} minWidth={1080}>
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
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PORTION: Record<LeavePortion, string> = { FULL_DAY: "full day", FIRST_HALF: "first half", SECOND_HALF: "second half", SHORT: "part of the day" };

function Daily() {
  const [query, setQuery] = useState(() => ({ date: localDate(Date.now(), TZ), q: "", page: 1 }));
  const [data, setData] = useState<DailyAttendanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ date: query.date, page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (query.q) params.set("q", query.q);
    api<DailyAttendanceResponse>(`/attendance/daily?${params}`).then(
      (r) => active && (setData(r), setError(null)),
      (e) => active && (setError(errorMessage(e)), setData(null)),
    );
    return () => {
      active = false;
    };
  }, [query, retry]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const noPolicy = data && data.total > 0 && data.summary.NO_POLICY + data.summary.ON_LEAVE + data.summary.HOLIDAY === data.total && data.summary.NO_POLICY > 0;

  return (
    <div className="flex flex-col gap-4">
      <FilterBar label="Daily attendance filters" onSubmit={(e) => (setData(null), setQuery((q) => ({ ...q, q: String(new FormData(e.currentTarget).get("q") ?? "").trim(), page: 1 })))}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted">Date</span>
          <input type="date" required value={query.date} onChange={(e) => e.target.value && (setData(null), setQuery((q) => ({ ...q, date: e.target.value, page: 1 })))} className={inputClass} />
        </label>
        <input name="q" type="search" placeholder="Search name, email or employee code" aria-label="Search employees" maxLength={100} className={`${inputClass} flex-1 sm:w-auto`} />
        <button type="submit" className={secondaryButtonClass}>Search</button>
      </FilterBar>
      <p className="text-xs text-muted">
        The date is read in each employee&apos;s own time zone. {data?.meta.policyRule} A <Link href="/holidays" className="text-brand underline">holiday</Link> is
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

function Row({ row, now }: { row: AttendanceOverviewRow; now: number }) {
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
        {!ev ? (
          <span className="text-muted">Never</span>
        ) : (
          <>
            <div>{formatInZone(ev.receivedAt, row.timezone)}</div>
            <div className={`text-xs ${ev.outcome === "REJECTED" ? "text-red-700 dark:text-red-300" : "text-muted"}`}>
              {ev.outcome === "REJECTED" ? "Last event rejected" : ev.source === "OFFLINE_SYNC" ? "Uploaded from offline queue" : "Online"}
            </div>
          </>
        )}
        {row.deviceLastSeenAt && <div className="text-xs text-muted">Device seen {formatInZone(row.deviceLastSeenAt, row.timezone)}</div>}
      </td>
    </tr>
  );
}

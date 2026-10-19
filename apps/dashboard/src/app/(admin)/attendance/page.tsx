"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  attendanceTotals,
  formatDuration,
  type AttendanceOverviewRow,
  type AttendanceSession,
  type Paginated,
} from "@workfolio/shared";
import { formatInZone, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 20;
const REFRESH_MS = 30_000;

const STATE = {
  CLOCKED_IN: { label: "Clocked in", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  ON_BREAK: { label: "On break", className: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
  CLOCKED_OUT: { label: "Clocked out", className: "bg-gray-500/15 text-muted" },
} as const;

const totals = (s: AttendanceSession, now: number) =>
  attendanceTotals({ start: s.clockInAt, end: s.clockOutAt }, s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt })), now);

export default function AttendancePage() {
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
    e.preventDefault();
    setData(null);
    setQuery({ q: String(new FormData(e.currentTarget).get("q") ?? "").trim(), page: 1 });
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Attendance</h1>
        <p className="mt-1 text-sm text-muted">
          Live status from employees&apos; desktop apps, refreshed every 30 seconds. Times are shown in each employee&apos;s
          timezone. Read-only: attendance cannot be edited here.
        </p>
      </div>

      <form role="search" onSubmit={onSearch} className="flex gap-2">
        <input name="q" type="search" placeholder="Search name, email or employee code" aria-label="Search employees" maxLength={100} className={inputClass} />
        <button type="submit" className={secondaryButtonClass}>Search</button>
      </form>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Employee</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
              <th scope="col" className="px-4 py-3 font-medium">Clocked in</th>
              <th scope="col" className="px-4 py-3 font-medium">Breaks</th>
              <th scope="col" className="px-4 py-3 font-medium">Net working time</th>
              <th scope="col" className="px-4 py-3 font-medium">Last sync</th>
            </tr>
          </thead>
          <tbody>
            {!data && !error && (
              <tr><td colSpan={6} role="status" className="px-4 py-8 text-center text-muted">Loading…</td></tr>
            )}
            {data?.items.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted">
                {query.q ? "No employees match your search." : "No employees enrolled yet."}
              </td></tr>
            )}
            {data?.items.map((row) => <Row key={row.employeeId} row={row} now={now} />)}
          </tbody>
        </table>
      </div>

      {data && pages > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          <button type="button" disabled={query.page <= 1} onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))} className={secondaryButtonClass}>
            Previous
          </button>
          <span className="text-muted">Page {query.page} of {pages}</span>
          <button type="button" disabled={query.page >= pages} onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))} className={secondaryButtonClass}>
            Next
          </button>
        </nav>
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
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3">
        <Link href={`/employees/${row.employeeId}`} className="font-medium text-brand hover:underline">{row.fullName}</Link>
        <div className="font-mono text-xs text-muted">{row.employeeCode}</div>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATE[row.state].className}`}>{STATE[row.state].label}</span>
      </td>
      <td className="px-4 py-3">{open ? formatInZone(s.clockInAt, row.timezone) : "—"}</td>
      <td className="px-4 py-3">
        {!open || !t ? "—" : openBreak ? `On break since ${formatInZone(openBreak.startedAt, row.timezone)}` : `${s.breaks.length} · ${formatDuration(t.breakMs)}`}
      </td>
      <td className="px-4 py-3 tabular-nums">
        {open && t ? formatDuration(t.netMs) : s && t ? <span className="text-muted">Last shift {formatDuration(t.netMs)}</span> : "—"}
      </td>
      <td className="px-4 py-3">
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

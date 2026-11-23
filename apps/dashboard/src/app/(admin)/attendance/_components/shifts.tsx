"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { MAX_RANGE_DAYS, SHIFT_STATUSES, type AutoClockOutHistoryRow, type Paginated, type ShiftListResponse, type ShiftStatus } from "@workfolio/shared";
import { DataTable, EmptyState, ErrorState, FilterBar, Pagination, SkeletonRows, StatCard, StatGrid, StatusBadge } from "@/components/kit";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { SHIFT_STATUS, shiftLabel } from "@/components/shifts";
import { formatInZone, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { pollWhileVisible } from "@/lib/poll";

const PAGE_SIZE = 50;
const minutesUntil = (iso: string, now: number) => Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));

/** Shift assignments with live status, plus the automatic clock-out history. Read-only; shifts are edited on each employee. */
export function ShiftsTab({ teamId }: { teamId: string | null }) {
  return (
    <div className="flex flex-col gap-8">
      <ShiftOverview teamId={teamId} />
      <AutoClockOutHistory teamId={teamId} />
    </div>
  );
}

function ShiftOverview({ teamId }: { teamId: string | null }) {
  const [query, setQuery] = useState<{ q: string; status: ShiftStatus | ""; page: number }>({ q: "", status: "", page: 1 });
  const [data, setData] = useState<ShiftListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (query.q) params.set("q", query.q);
    if (query.status) params.set("status", query.status);
    if (teamId) params.set("teamId", teamId);
    return pollWhileVisible(
      () => api<ShiftListResponse>(`/attendance/shifts?${params}`),
      (r) => (setData(r), setError(null), setNow(Date.now())),
      (e) => setError(errorMessage(e)),
      30_000,
    );
  }, [query, teamId]);

  function onFilter(e: FormEvent<HTMLFormElement>) {
    const f = new FormData(e.currentTarget);
    setData(null);
    setQuery({ q: String(f.get("q") ?? "").trim(), status: String(f.get("status") ?? "") as ShiftStatus | "", page: 1 });
  }
  const tile = (s: ShiftStatus, label: string, tone?: "success" | "warning" | "danger" | "info") => (
    <StatCard label={label} value={data?.summary[s]} tone={tone} />
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section aria-label="Shifts" className="flex flex-col gap-4">
      <p className="text-xs text-muted">
        Each employee&apos;s shift and automatic clock-out, refreshed every 30 seconds. An employee still clocked in at shift end + grace period is
        clocked out by the server at that time (their app stays signed in). Assign or change shifts on the employee&apos;s Edit tab.
      </p>
      <StatGrid>
        {tile("WITHIN_SHIFT", "Within shift", "success")}
        {tile("GRACE_PERIOD", "Beyond shift end, in grace", "warning")}
        {tile("AUTO_CLOCKED_OUT", "Last clock-out automatic", "info")}
        {tile("NO_SHIFT", "No shift assigned")}
      </StatGrid>
      {data && data.recentFailures.length > 0 && (
        <Notice tone="error">
          <strong>{data.recentFailures.length} automatic clock-out attempt{data.recentFailures.length === 1 ? "" : "s"} failed in the last 24 hours.</strong>{" "}
          They are retried every 30 seconds. Latest: {data.recentFailures[0]!.employee.fullName}, {formatInZone(data.recentFailures[0]!.failedAt, data.recentFailures[0]!.employee.timezone)}: {data.recentFailures[0]!.error}
        </Notice>
      )}
      <FilterBar label="Filter shifts" onSubmit={onFilter}>
        <input name="q" type="search" placeholder="Search name, email or employee code" aria-label="Search employees" maxLength={100} className={`${inputClass} flex-1 sm:w-auto`} />
        <select name="status" aria-label="Shift status" defaultValue="" className={`${inputClass} sm:w-auto`}>
          <option value="">All statuses</option>
          {SHIFT_STATUSES.map((s) => <option key={s} value={s}>{SHIFT_STATUS[s].label}</option>)}
        </select>
        <button type="submit" className={secondaryButtonClass}>Apply</button>
      </FilterBar>
      {error && <ErrorState message={error} onRetry={() => setQuery((q) => ({ ...q }))} />}
      {!data && !error && <SkeletonRows label="shifts" />}
      {data?.items.length === 0 && <EmptyState title="No employees match these filters." />}
      {data && data.items.length > 0 && (
        <DataTable label="Employee shifts" head={["Employee", "Assigned shift", "Grace", "Auto clock-out", "Status", "Clocked in", "Next automatic clock-out", "Last automatic clock-out"]} minWidth={1100}>
          {data.items.map((r) => {
            const tz = r.employee.timezone;
            return (
              <tr key={r.employee.id}>
                <td>
                  <Link href={`/employees/${r.employee.id}`} className="font-medium text-brand hover:underline">{r.employee.fullName}</Link>{" "}
                  <span className="font-mono text-xs text-muted">{r.employee.employeeCode}</span>
                </td>
                <td>{r.shift ? shiftLabel(r.shift) : <span className="text-muted">—</span>}</td>
                <td className="tabular-nums">{r.shift ? `${r.shift.graceMinutes} min` : "—"}</td>
                <td>{r.shift ? <StatusBadge tone={r.shift.autoClockOut ? "success" : "neutral"}>{r.shift.autoClockOut ? "Enabled" : "Disabled"}</StatusBadge> : "—"}</td>
                <td><StatusBadge tone={SHIFT_STATUS[r.status].tone}>{SHIFT_STATUS[r.status].label}</StatusBadge></td>
                <td>{formatInZone(r.clockedInAt, tz)}</td>
                <td>
                  {r.nextAutoClockOutAt ? (
                    <>
                      {formatInZone(r.nextAutoClockOutAt, tz)}
                      {r.status === "GRACE_PERIOD" && <span className="block text-xs text-warning">in {minutesUntil(r.nextAutoClockOutAt, now)} min</span>}
                    </>
                  ) : "—"}
                </td>
                <td>{r.lastAutoClockOut ? formatInZone(r.lastAutoClockOut.clockOutAt, tz) : "—"}</td>
              </tr>
            );
          })}
        </DataTable>
      )}
      {data && pages > 1 && <Pagination page={query.page} pageCount={pages} onPage={(p) => setQuery((q) => ({ ...q, page: p }))} label="Shifts pages" />}
    </section>
  );
}

function AutoClockOutHistory({ teamId }: { teamId: string | null }) {
  const [query, setQuery] = useState<Range & { page: number }>(() => ({ ...weekRange(0), page: 1 }));
  const [data, setData] = useState<Paginated<AutoClockOutHistoryRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ from: query.from, to: query.to, page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (teamId) params.set("teamId", teamId);
    api<Paginated<AutoClockOutHistoryRow>>(`/attendance/auto-clock-outs?${params}`).then(
      (r) => active && (setData(r), setError(null)),
      (e) => active && (setError(errorMessage(e)), setData(null)),
    );
    return () => void (active = false);
  }, [query, teamId, retry]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section aria-label="Automatic clock-out history" className="flex flex-col gap-4">
      <h3 className="font-medium">Automatic clock-out history</h3>
      <RangePicker value={query} maxDays={MAX_RANGE_DAYS} onChange={(r) => (setData(null), setQuery({ ...r, page: 1 }))} />
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="automatic clock-outs" />}
      {data?.items.length === 0 && <EmptyState title="No automatic clock-outs in this period." />}
      {data && data.items.length > 0 && (
        <DataTable label="Automatic clock-outs" head={["Employee", "Shift", "Shift ended", "Clocked out (deadline)", "Processed", "Break ended"]} minWidth={960}>
          {data.items.map((r) => (
            <tr key={r.attendanceSessionId}>
              <td><Link href={`/employees/${r.employee.id}`} className="font-medium text-brand hover:underline">{r.employee.fullName}</Link></td>
              <td>{r.shiftStartTime}–{r.shiftEndTime} · {r.graceMinutes} min grace · {r.shiftTimezone}</td>
              <td>{formatInZone(r.scheduledShiftEndAt, r.employee.timezone)}</td>
              <td>{formatInZone(r.clockOutAt, r.employee.timezone)}</td>
              <td>{formatInZone(r.processedAt, r.employee.timezone)}</td>
              <td>{r.breakEnded ? "Yes" : "No"}</td>
            </tr>
          ))}
        </DataTable>
      )}
      {data && pages > 1 && <Pagination page={query.page} pageCount={pages} onPage={(p) => setQuery((q) => ({ ...q, page: p }))} label="Automatic clock-out pages" />}
    </section>
  );
}

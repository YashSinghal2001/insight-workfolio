"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LEAVE_SUMMARY_MAX_DAYS, leaveTallyLabel, localDate, type LeaveStatus, type LeaveSummaryResponse, type LeaveTally } from "@workfolio/shared";
import { DataTable, EmptyState, ErrorState, FilterBar, Pagination, SkeletonRows } from "@/components/kit";
import { RangePicker, type Range } from "@/components/range-picker";
import { inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 20;
export const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = { APPROVED: "Approved", PENDING: "Pending", REJECTED: "Rejected", CANCELLED: "Cancelled" };
export const SUMMARY_ORDER: readonly LeaveStatus[] = ["APPROVED", "PENDING", "REJECTED", "CANCELLED"];

/** The calendar month containing today (browser time zone unless one is given). */
export function monthRange(timeZone?: string): Range {
  const today = localDate(Date.now(), timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [y, m] = today.split("-").map(Number) as [number, number];
  return { from: `${today.slice(0, 8)}01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

/** One status cell: days (and short leave) with the request count underneath. */
export function TallyCell({ t }: { t: LeaveTally }) {
  return (
    <>
      <span className="tabular-nums">{leaveTallyLabel(t)}</span>
      {t.requests > 0 && <span className="block text-xs text-muted">{t.requests} {t.requests === 1 ? "request" : "requests"}</span>}
    </>
  );
}

/** Admin: recorded leave per employee and status for a range (GET /leave/summary). */
export function LeaveSummary() {
  const [range, setRange] = useState<Range>(() => monthRange());
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LeaveSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ from: range.from, to: range.to, page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("q", search);
    api<LeaveSummaryResponse>(`/leave/summary?${params}`).then(
      (r) => live && (setData(r), setError(null)),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [range, search, page, retry]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="flex flex-col gap-4">
      <FilterBar label="Leave summary filters" onSubmit={() => (setData(null), setPage(1), setSearch(q.trim()))}>
        <RangePicker value={range} maxDays={LEAVE_SUMMARY_MAX_DAYS} onChange={(r) => (setData(null), setPage(1), setRange(r))} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted">Employee name, e-mail or code</span>
          <input type="search" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} className={`${inputClass} w-56 max-w-full`} />
        </label>
        <button type="submit" className={secondaryButtonClass}>Search</button>
      </FilterBar>
      <Notice tone="info">
        {data?.meta.dayRule ?? "Full days count every calendar date inside the range, weekends included. A half day counts 0.5. Short leave is counted in minutes."} Dates are each employee&apos;s own dates.
      </Notice>
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="leave summary" />}
      {data && data.items.length === 0 && <EmptyState title={search ? "No employees match this search." : "No employees enrolled yet."} />}
      {data && data.items.length > 0 && (
        <DataTable label="Leave summary" caption={`${data.from} to ${data.to}`} head={["Employee", ...SUMMARY_ORDER.map((s) => LEAVE_STATUS_LABEL[s])]} minWidth={720}>
          {data.items.map((r) => (
            <tr key={r.employee.id} data-employee={r.employee.id} className="align-top">
              <td>
                <Link href={`/timesheets/${r.employee.id}`} className="font-medium text-brand hover:underline">{r.employee.fullName}</Link>{" "}
                <span className="font-mono text-xs text-muted">{r.employee.employeeCode}</span>
              </td>
              {SUMMARY_ORDER.map((s) => <td key={s} data-status={s}><TallyCell t={r.byStatus[s]} /></td>)}
            </tr>
          ))}
        </DataTable>
      )}
      {data && pages > 1 && <Pagination label="Leave summary pages" page={page} pageCount={pages} onPage={(p) => (setData(null), setPage(p))} />}
    </div>
  );
}

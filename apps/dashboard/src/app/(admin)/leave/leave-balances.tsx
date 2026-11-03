"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LeaveBalance, LeaveBalancesResponse } from "@workfolio/shared";
import { DataTable, EmptyState, ErrorState, FilterBar, Pagination, SkeletonRows } from "@/components/kit";
import { inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 20;
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** "3 of 20 days left (17 used, 1 pending)" plus short leave when the type has a quota. Shared with My leave. */
export function BalanceText({ b }: { b: LeaveBalance }) {
  const days = b.allowanceDays === null ? `${b.approvedDays} days used (no limit)` : `${b.remainingDays} of ${b.allowanceDays} days left (${b.approvedDays} used)`;
  return (
    <>
      <span className="tabular-nums">{days}{b.pendingDays ? `, ${b.pendingDays} pending` : ""}</span>
      {(b.shortHoursPerMonth !== null || b.shortApprovedHours > 0) && (
        <span className="block text-xs text-muted tabular-nums">
          Short leave {b.month}: {b.shortHoursPerMonth === null ? `${b.shortApprovedHours} h used (no limit)` : `${b.shortRemainingHours} of ${b.shortHoursPerMonth} h left`}
          {b.shortPendingHours ? `, ${b.shortPendingHours} h pending` : ""}
        </span>
      )}
    </>
  );
}

/** Admin: every employee's balance per leave type (GET /leave/balances). */
export function LeaveBalances() {
  const [month, setMonth] = useState(thisMonth);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LeaveBalancesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ month, page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("q", search);
    api<LeaveBalancesResponse>(`/leave/balances?${params}`).then(
      (r) => live && (setData(r), setError(null)),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [month, search, page, retry]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // Inactive types appear only for employees who still have usage, so take the union of the page.
  const types = [...new Map((data?.items ?? []).flatMap((r) => r.balances.map((b) => [b.leaveType.id, b.leaveType] as const))).values()];
  return (
    <div className="flex flex-col gap-4">
      <FilterBar label="Leave balance filters" onSubmit={() => (setData(null), setPage(1), setSearch(q.trim()))}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted">Month (balances use its year)</span>
          <input type="month" required value={month} onChange={(e) => e.target.value && (setData(null), setPage(1), setMonth(e.target.value))} className={inputClass} />
        </label>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or employee code" aria-label="Search employees" maxLength={100} className={`${inputClass} flex-1 sm:w-auto`} />
        <button type="submit" className={secondaryButtonClass}>Search</button>
      </FilterBar>
      {data && <p className="text-xs text-muted">{data.dayRule}</p>}
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="leave balances" />}
      {data?.items.length === 0 && <EmptyState title={search ? "No employees match your search." : "No employees yet."} />}
      {data && data.items.length > 0 && (
        <DataTable label="Leave balances" head={["Employee", ...types.map((t) => t.name)]} minWidth={720}>
          {data.items.map((r) => (
            <tr key={r.employee.id} className="align-top">
              <td>
                <Link href={`/timesheets/${r.employee.id}`} className="font-medium text-brand hover:underline">{r.employee.fullName}</Link>
                <div className="font-mono text-xs text-muted">{r.employee.employeeCode}</div>
              </td>
              {types.map((t) => {
                const b = r.balances.find((x) => x.leaveType.id === t.id);
                return <td key={t.id}>{b ? <BalanceText b={b} /> : "—"}</td>;
              })}
            </tr>
          ))}
        </DataTable>
      )}
      {data && pages > 1 && <Pagination page={page} pageCount={pages} onPage={setPage} />}
    </div>
  );
}

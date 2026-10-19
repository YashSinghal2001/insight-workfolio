"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { formatDuration, type Paginated, type TimesheetSummaryRow } from "@workfolio/shared";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 20;

export default function TimesheetsPage() {
  const [range, setRange] = useState<Range>(() => weekRange());
  const [query, setQuery] = useState({ q: "", page: 1 });
  const [data, setData] = useState<Paginated<TimesheetSummaryRow> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ ...range, page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (query.q) params.set("q", query.q);
    api<Paginated<TimesheetSummaryRow>>(`/attendance/timesheets?${params}`).then(
      (r) => active && (setData(r), setError(null)),
      (e) => active && setError(errorMessage(e)),
    );
    return () => {
      active = false;
    };
  }, [range, query]);

  function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setData(null);
    setQuery({ q: String(new FormData(e.currentTarget).get("q") ?? "").trim(), page: 1 });
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Timesheets</h1>
        <p className="mt-1 text-sm text-muted">
          Completed shifts only, by the local date each shift started in the employee&apos;s time zone. Overtime is reported, not
          applied to payroll. Open shifts are not counted until they are clocked out or corrected.
        </p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <RangePicker value={range} onChange={(r) => (setData(null), setRange(r), setQuery((q) => ({ ...q, page: 1 })))} />
        <form role="search" onSubmit={onSearch} className="flex gap-2">
          <input name="q" type="search" placeholder="Filter employees" aria-label="Filter employees" maxLength={100} className={inputClass} />
          <button type="submit" className={secondaryButtonClass}>Filter</button>
        </form>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Employee</th>
              <th scope="col" className="px-4 py-3 font-medium">Shifts</th>
              <th scope="col" className="px-4 py-3 font-medium">Worked</th>
              <th scope="col" className="px-4 py-3 font-medium">Breaks</th>
              <th scope="col" className="px-4 py-3 font-medium">Overtime</th>
              <th scope="col" className="px-4 py-3 font-medium">Needs attention</th>
            </tr>
          </thead>
          <tbody>
            {!data && !error && <tr><td colSpan={6} role="status" className="px-4 py-8 text-center text-muted">Loading…</td></tr>}
            {data?.items.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-muted">No employees found.</td></tr>}
            {data?.items.map(({ employee, totals, openShift, pendingCorrections }) => (
              <tr key={employee.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3">
                  <Link href={`/timesheets/${employee.id}`} className="font-medium text-brand hover:underline">{employee.fullName}</Link>
                  <div className="font-mono text-xs text-muted">{employee.employeeCode}</div>
                </td>
                <td className="px-4 py-3 tabular-nums">{totals.shifts}</td>
                <td className="px-4 py-3 tabular-nums">{formatDuration(totals.netMs)}</td>
                <td className="px-4 py-3 tabular-nums">{formatDuration(totals.breakMs)}</td>
                <td className="px-4 py-3 tabular-nums">
                  {totals.overtimeMs ? <span className="text-amber-800 dark:text-amber-300">{formatDuration(totals.overtimeMs)}</span> : "—"}
                </td>
                <td className="px-4 py-3 text-xs">
                  {[
                    openShift && "Shift open now",
                    totals.incompleteDays > 0 && `${totals.incompleteDays} incomplete day(s)`,
                    pendingCorrections > 0 && `${pendingCorrections} pending correction(s)`,
                  ].filter(Boolean).join(" · ") || <span className="text-muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && pages > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          <button type="button" disabled={query.page <= 1} onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))} className={secondaryButtonClass}>Previous</button>
          <span className="text-muted">Page {query.page} of {pages}</span>
          <button type="button" disabled={query.page >= pages} onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))} className={secondaryButtonClass}>Next</button>
        </nav>
      )}
    </div>
  );
}

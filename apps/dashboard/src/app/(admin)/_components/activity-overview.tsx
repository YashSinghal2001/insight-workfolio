"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatDurationShort, type ActivityOverviewResponse } from "@workfolio/shared";
import { DataTable, EmptyState, ErrorState, FilterBar, Pagination, SkeletonRows } from "@/components/kit";
import type { Range } from "@/components/range-picker";
import { formatInZone, inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { shareText } from "./productivity-trend";

const PAGE_SIZE = 20;

/**
 * Organisation activity overview: one row per employee for the range (GET /activity/overview,
 * each employee's own time zone). `onOpen` opens the per-employee view in place (the /activity
 * page); without it the name links to /activity?employeeId=…
 */
export function ActivityOverview({ range, onOpen, teamId }: { range: Range; onOpen?: (employeeId: string) => void; teamId?: string | null }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ActivityOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // A different team (or range) starts again at page 1 (state adjusted during render, not in an effect).
  const [filter, setFilter] = useState({ range, teamId });
  if (filter.range !== range || filter.teamId !== teamId) {
    setFilter({ range, teamId });
    setPage(1);
    setData(null);
  }

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ from: range.from, to: range.to, page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("q", search);
    if (teamId) params.set("teamId", teamId);
    api<ActivityOverviewResponse>(`/activity/overview?${params}`).then(
      (r) => live && (setData(r), setError(null)),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [range, search, page, retry, teamId]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const head = ["Employee", "Clocked in", "Active", "Idle", "Unobserved", ...(data?.categoriesConfigured ? ["Productive", "Productive share"] : []), "Last upload"];

  return (
    <div className="flex flex-col gap-3">
      <FilterBar label="Search employees" onSubmit={() => (setData(null), setPage(1), setSearch(q.trim()))}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted">Name, e-mail or code</span>
          <input type="search" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} className={`${inputClass} w-56 max-w-full`} />
        </label>
        <button type="submit" className={secondaryButtonClass}>Search</button>
      </FilterBar>
      <p className="text-xs text-muted">
        {range.from} to {range.to}, in each employee&apos;s own time zone. Unobserved = clocked in with no activity record (never estimated).{" "}
        {data && !data.categoriesConfigured && <>Productive figures appear once <Link href="/settings/labels" className="underline">application labels</Link> are configured.</>}
      </p>
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="activity overview" />}
      {data && data.items.length === 0 && <EmptyState title={search ? "No employees match this search." : "No employees enrolled yet."} />}
      {data && data.items.length > 0 && (
        <DataTable label="Activity overview" head={head} minWidth={data.categoriesConfigured ? 900 : 720}>
          {data.items.map((r) => {
            const href = `/activity?employeeId=${r.employee.id}`;
            return (
              <tr key={r.employee.id} data-employee={r.employee.id}>
                <td>
                  <Link
                    href={href}
                    className="font-medium text-brand hover:underline"
                    onClick={onOpen && ((e) => (e.preventDefault(), onOpen(r.employee.id)))}
                  >
                    {r.employee.fullName}
                  </Link>{" "}
                  <span className="font-mono text-xs text-muted">{r.employee.employeeCode}</span>
                </td>
                <td className="tabular-nums">{formatDurationShort(r.clockedInMs)}</td>
                <td className="tabular-nums">{formatDurationShort(r.activeMs)}</td>
                <td className="tabular-nums">{formatDurationShort(r.idleMs)}</td>
                <td className="tabular-nums">{formatDurationShort(r.unobservedMs)}</td>
                {data.categoriesConfigured && <td className="tabular-nums">{r.productiveMs === null ? "—" : formatDurationShort(r.productiveMs)}</td>}
                {data.categoriesConfigured && <td className="tabular-nums" title={r.productiveShare === null ? "Nothing clocked in" : undefined}>{shareText(r.productiveShare)}</td>}
                <td className="text-xs whitespace-nowrap">{r.lastReceivedAt ? formatInZone(r.lastReceivedAt, r.employee.timezone) : "Never"}</td>
              </tr>
            );
          })}
        </DataTable>
      )}
      {data && pages > 1 && <Pagination label="Overview pages" page={page} pageCount={pages} onPage={(p) => (setData(null), setPage(p))} />}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MAX_RANGE_DAYS, type LateArrivalsResponse } from "@workfolio/shared";
import { DataTable, EmptyState, ErrorState, Pagination, SkeletonRows } from "@/components/kit";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 50;

/** Late clock-ins over a range (≤ 92 days), each against the schedule in force that day. */
export function LateTab({ teamId }: { teamId: string | null }) {
  const [query, setQuery] = useState<Range & { page: number }>(() => ({ ...weekRange(0), page: 1 }));
  const [data, setData] = useState<LateArrivalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ from: query.from, to: query.to, page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (teamId) params.set("teamId", teamId);
    api<LateArrivalsResponse>(`/attendance/late?${params}`).then(
      (r) => active && (setData(r), setError(null)),
      (e) => active && (setError(errorMessage(e)), setData(null)),
    );
    return () => void (active = false);
  }, [query, teamId, retry]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <RangePicker value={query} maxDays={MAX_RANGE_DAYS} onChange={(r) => (setData(null), setQuery({ ...r, page: 1 }))} />
      <p className="text-xs text-muted">
        Late means the first clock-in of the day came after the expected start plus grace, in the employee&apos;s own time zone. Nobody is late without an
        enabled <Link href="/settings/schedule" className="text-brand underline">work schedule</Link>.
      </p>
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="late arrivals" />}
      {data?.items.length === 0 && <EmptyState title="No late arrivals in this range." />}
      {data && data.items.length > 0 && (
        <DataTable label="Late arrivals" head={["Employee", "Date", "Due by", "First clock-in", "Late by"]} minWidth={600}>
          {data.items.map((r) => (
            <tr key={`${r.employee.id}-${r.date}`}>
              <td>
                <Link href={`/timesheets/${r.employee.id}`} className="font-medium text-brand hover:underline">{r.employee.fullName}</Link>
                <div className="font-mono text-xs text-muted">{r.employee.employeeCode} · {r.employee.timezone}</div>
              </td>
              <td className="tabular-nums">{r.date}</td>
              <td className="tabular-nums">{r.dueLocal}</td>
              <td className="tabular-nums">{r.firstClockInLocal}</td>
              <td className="tabular-nums">{r.lateMinutes} min</td>
            </tr>
          ))}
        </DataTable>
      )}
      {data && pages > 1 && <Pagination page={query.page} pageCount={pages} onPage={(page) => setQuery((q) => ({ ...q, page }))} />}
    </div>
  );
}

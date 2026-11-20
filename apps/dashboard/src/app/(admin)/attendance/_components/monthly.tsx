"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EXPORT_CONTENT_TYPES, formatDuration, monthlyAttendanceFilename, type ExportFormat, type MonthlyAttendanceResponse } from "@workfolio/shared";
import { Button, EmptyState, ErrorState, Pagination, SkeletonRows, StatusBadge } from "@/components/kit";
import { inputClass } from "@/components/ui";
import { api, apiBlob, errorMessage } from "@/lib/api";
import { DAY_CODE, dayTitle } from "@/lib/attendance-ui";
import { todayLocal } from "@/lib/global-filters";

const PAGE_SIZE = 50;
const STICKY = "sticky left-0 z-[1] bg-surface";
const TOTALS = [
  ["Present", "presentDays"],
  ["Late", "lateDays"],
  ["Absent", "absentDays"],
  ["Leave", "leaveDays"],
  ["Holiday", "holidayDays"],
] as const;

async function download(month: string, format: ExportFormat, teamId: string | null) {
  const params = new URLSearchParams({ month, format });
  if (teamId) params.set("teamId", teamId);
  const url = URL.createObjectURL(await apiBlob(`/attendance/monthly/export?${params}`, EXPORT_CONTENT_TYPES[format]));
  const a = Object.assign(document.createElement("a"), { href: url, download: monthlyAttendanceFilename(month, format) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Employee rows × day columns (status codes; In–Out on hover), totals, month picker and export. */
export function MonthlyTab({ teamId }: { teamId: string | null }) {
  const [query, setQuery] = useState(() => ({ month: todayLocal().slice(0, 7), page: 1 }));
  const [data, setData] = useState<MonthlyAttendanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ month: query.month, page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (teamId) params.set("teamId", teamId);
    api<MonthlyAttendanceResponse>(`/attendance/monthly?${params}`).then(
      (r) => active && (setData(r), setError(null)),
      (e) => active && (setError(errorMessage(e)), setData(null)),
    );
    return () => void (active = false);
  }, [query, teamId, retry]);

  async function onExport(format: ExportFormat) {
    setExporting(format);
    setExportError(null);
    try {
      await download(query.month, format, teamId);
    } catch (e) {
      setExportError(errorMessage(e));
    } finally {
      setExporting(null);
    }
  }

  const days = data?.items[0]?.days ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted">Month</span>
          <input
            type="month"
            required
            value={query.month}
            onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && (setData(null), setQuery({ month: e.target.value, page: 1 }))}
            className={`${inputClass} w-auto`}
          />
        </label>
        <Button variant="secondary" pending={exporting === "xlsx"} disabled={!!exporting} onClick={() => void onExport("xlsx")}>Export XLSX</Button>
        <Button variant="secondary" pending={exporting === "csv"} disabled={!!exporting} onClick={() => void onExport("csv")}>Export CSV</Button>
      </div>
      {exportError && <ErrorState title="Export failed" message={exportError} onRetry={() => setExportError(null)} />}
      <p className="text-xs text-muted">
        P present · L late · A absent · LV leave · H holiday · WO weekly off · OPEN shift still open; blank: no schedule or not yet due.
        Hover a day for clock-in and clock-out. Days are read in each employee&apos;s own time zone.
      </p>
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="monthly attendance" />}
      {data?.items.length === 0 && <EmptyState title="No employees for this month and team." />}
      {data && data.items.length > 0 && (
        <div className="relative max-w-full overflow-x-auto rounded-lg border border-border bg-surface">
          <table aria-label="Monthly attendance" className="w-full text-left text-[13px]">
            <thead className="bg-surface-muted text-xs text-muted">
              <tr>
                <th scope="col" className={`${STICKY} border-b border-border bg-surface-muted px-3 py-2 font-medium`}>Employee</th>
                {days.map((d) => (
                  <th key={d.date} scope="col" title={d.date} className="border-b border-border px-1 py-2 text-center font-medium tabular-nums">{Number(d.date.slice(8))}</th>
                ))}
                {TOTALS.map(([label]) => <th key={label} scope="col" className="border-b border-border px-2 py-2 font-medium">{label}</th>)}
                <th scope="col" className="border-b border-border px-2 py-2 font-medium whitespace-nowrap">Worked</th>
                <th scope="col" className="border-b border-border px-2 py-2 font-medium whitespace-nowrap">Overtime</th>
              </tr>
            </thead>
            <tbody className="[&_td]:border-b [&_td]:border-border [&_tr:last-child_td]:border-0">
              {data.items.map((r) => (
                <tr key={r.employee.id}>
                  <th scope="row" className={`${STICKY} max-w-40 border-b border-border px-3 py-2 text-left font-normal`}>
                    <Link href={`/timesheets/${r.employee.id}`} className="block truncate font-medium text-brand hover:underline">{r.employee.fullName}</Link>
                    <div className="font-mono text-xs text-muted">{r.employee.employeeCode}</div>
                  </th>
                  {r.days.map((d) => {
                    const c = DAY_CODE[d.status];
                    return (
                      <td key={d.date} title={dayTitle(d)} className="px-1 py-2 text-center">
                        {c.code ? <StatusBadge tone={c.tone}>{c.code}</StatusBadge> : <span className="sr-only">{c.label}</span>}
                      </td>
                    );
                  })}
                  {TOTALS.map(([label, key]) => <td key={label} className="px-2 py-2 text-center tabular-nums">{r.totals[key]}</td>)}
                  <td className="px-2 py-2 tabular-nums">{formatDuration(r.totals.workedMinutes * 60_000)}</td>
                  <td className="px-2 py-2 tabular-nums">{formatDuration(r.totals.overtimeMinutes * 60_000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && pages > 1 && <Pagination page={query.page} pageCount={pages} onPage={(page) => setQuery((q) => ({ ...q, page }))} />}
    </div>
  );
}

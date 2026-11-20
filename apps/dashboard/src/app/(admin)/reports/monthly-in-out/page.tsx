"use client";

import { useState } from "react";
import { MONTHLY_EXPORT_LEGEND, monthlyAttendanceFilename, type MonthlyAttendanceResponse } from "@workfolio/shared";
import { FilterBar, PageHeader, Pagination } from "@/components/kit";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { inOutCell, inOutCounts } from "@/lib/reports";
import { DayMatrix, Loadable, MonthField, qs, ServerExport, thisMonth, TINT, useApiData, usePage } from "../_parts";

const PAGE_SIZE = 50;

export default function MonthlyInOutReport() {
  const { teamId } = useGlobalFilters();
  const [month, setMonth] = useState(thisMonth);
  const [page, setPage] = usePage(`${month}|${teamId}`);
  const state = useApiData<MonthlyAttendanceResponse>(`/attendance/monthly?${qs({ month, page, pageSize: PAGE_SIZE }, teamId)}`);
  const exportPath = (format: string) => `/attendance/monthly/export?${qs({ month, format }, teamId)}`;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <GlobalFilters date={false} />
      <PageHeader
        title="Monthly in/out"
        description={`First clock-in and last clock-out per day, ${month}.`}
        actions={<ServerExport files={[{ label: "Export CSV", path: exportPath("csv"), filename: monthlyAttendanceFilename(month, "csv") }, { label: "Export XLSX", path: exportPath("xlsx"), filename: monthlyAttendanceFilename(month, "xlsx") }]} />}
        about="Local times in each employee's own time zone. Non-worked days are scheduled days without a clock-in (absent or on leave). The export is the same matrix with totals."
      />
      <FilterBar label="Report month">
        <MonthField value={month} onChange={setMonth} />
      </FilterBar>
      <Loadable state={state} label="employees" empty={(d) => d.items.length === 0}>
        {(d) => (
          <>
            <DayMatrix
              label="Monthly in/out"
              rows={d.items}
              lead={[
                { header: "Worked days", value: (r) => inOutCounts(r).worked },
                { header: "Non-worked days", value: (r) => inOutCounts(r).nonWorked },
                { header: "Late days", value: (r) => inOutCounts(r).late },
              ]}
              cell={(day) => ({
                text: inOutCell(day),
                tint: day.status === "ABSENT" || day.status === "LATE" ? "danger" : day.firstInLocal ? "none" : "muted",
                title: day.status === "LATE" ? `${day.date}: late by ${day.lateMinutes} min` : day.date,
              })}
            />
            {d.total > d.pageSize && <Pagination page={page} pageCount={Math.ceil(d.total / d.pageSize)} onPage={setPage} />}
          </>
        )}
      </Loadable>
      <section aria-labelledby="inout-legend" className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
        <h2 id="inout-legend" className="mb-2 font-medium">Legend</h2>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
          {MONTHLY_EXPORT_LEGEND.map(([code, meaning]) => (
            <div key={code} className="contents">
              <dt className="font-mono text-xs">{code}</dt>
              <dd className="text-muted">{meaning}</dd>
            </div>
          ))}
          <div className="contents">
            <dt><span className={`rounded px-1 text-xs ${TINT.danger}`}>red</span></dt>
            <dd className="text-muted">Absent, or a late clock-in (hover for minutes)</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

"use client";

import { useState } from "react";
import { summaryReportFilename, type SummaryReportResponse } from "@workfolio/shared";
import { DataTable, FilterBar, PageHeader, Pagination } from "@/components/kit";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { hm } from "@/lib/reports";
import { EmployeeCell, Loadable, qs, ServerExport, useApiData, usePage } from "../_parts";

const PAGE_SIZE = 50;
const MAX_DAYS = 92;

export default function SummaryReport() {
  const { teamId } = useGlobalFilters();
  const [range, setRange] = useState<Range>(() => weekRange());
  const [page, setPage] = usePage(`${range.from}|${range.to}|${teamId}`);
  const state = useApiData<SummaryReportResponse>(`/attendance/summary-report?${qs({ ...range, page, pageSize: PAGE_SIZE }, teamId)}`);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <GlobalFilters date={false} />
      <PageHeader
        title="Summary"
        description={`Worked, active, idle and break time per employee, ${range.from} to ${range.to}${teamId ? " (selected team)" : " (organisation)"}.`}
        actions={<ServerExport files={[{ label: "Export XLSX", path: `/attendance/summary-report?${qs({ ...range, format: "xlsx" }, teamId)}`, filename: summaryReportFilename(range.from, range.to) }]} />}
        about="Completed shifts only, by the local date each shift started in the employee's own time zone; worked and break time equal the timesheet totals to the minute. Active and idle are the recorded activity of those shifts. The totals row covers every employee in the selection, not only this page."
      />
      <FilterBar label="Date range">
        <RangePicker value={range} maxDays={MAX_DAYS} onChange={setRange} />
      </FilterBar>
      <Loadable state={state} label="employees" empty={(d) => d.items.length === 0}>
        {(d) => (
          <>
            <DataTable label="Summary" head={["Employee", "Worked days", "Total worked", "Active", "Idle", "Break"]} minWidth={680}>
              {d.items.map((r) => (
                <tr key={r.employee.id}>
                  <td><EmployeeCell employee={r.employee} /></td>
                  <td className="tabular-nums">{r.workedDays}</td>
                  {[r.workedMinutes, r.activeMinutes, r.idleMinutes, r.breakMinutes].map((m, i) => <td key={i} className="tabular-nums whitespace-nowrap">{hm(m)}</td>)}
                </tr>
              ))}
              <tr className="bg-surface-muted font-semibold">
                <td>All {d.totals.employees} employees</td>
                <td className="tabular-nums">{d.totals.workedDays}</td>
                {[d.totals.workedMinutes, d.totals.activeMinutes, d.totals.idleMinutes, d.totals.breakMinutes].map((m, i) => <td key={i} className="tabular-nums whitespace-nowrap">{hm(m)}</td>)}
              </tr>
            </DataTable>
            {d.total > d.pageSize && <Pagination page={page} pageCount={Math.ceil(d.total / d.pageSize)} onPage={setPage} />}
          </>
        )}
      </Loadable>
    </div>
  );
}

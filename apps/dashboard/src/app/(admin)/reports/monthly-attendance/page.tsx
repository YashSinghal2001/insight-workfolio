"use client";

import { useState } from "react";
import { monthlyAttendanceFilename, type MonthlyAttendanceResponse } from "@workfolio/shared";
import { DataTable, FilterBar, PageHeader, Pagination } from "@/components/kit";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { hm } from "@/lib/reports";
import { EmployeeCell, Loadable, MonthField, qs, ServerExport, thisMonth, useApiData, usePage } from "../_parts";

const PAGE_SIZE = 50;

export default function MonthlyAttendanceReport() {
  const { teamId } = useGlobalFilters();
  const [month, setMonth] = useState(thisMonth);
  const [page, setPage] = usePage(`${month}|${teamId}`);
  const state = useApiData<MonthlyAttendanceResponse>(`/attendance/monthly?${qs({ month, page, pageSize: PAGE_SIZE }, teamId)}`);
  const exportPath = (format: string) => `/attendance/monthly/export?${qs({ month, format }, teamId)}`;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <GlobalFilters date={false} />
      <PageHeader
        title="Monthly attendance"
        description={`Per-employee totals for ${month}.`}
        actions={<ServerExport files={[{ label: "Export CSV", path: exportPath("csv"), filename: monthlyAttendanceFilename(month, "csv") }, { label: "Export XLSX", path: exportPath("xlsx"), filename: monthlyAttendanceFilename(month, "xlsx") }]} />}
        about="Each employee's own time zone. Worked days = days with a clock-in; present = scheduled days attended (on time or late); absent = scheduled days without a clock-in after the grace period. Hours and overtime count completed shifts only, as on the timesheet; overtime is reported, not applied to payroll."
      />
      <FilterBar label="Report month">
        <MonthField value={month} onChange={setMonth} />
      </FilterBar>
      <Loadable state={state} label="employees" empty={(d) => d.items.length === 0}>
        {(d) => (
          <>
            <DataTable label="Monthly attendance" head={["Employee", "Worked days", "Present", "Late", "Absent", "Leave", "Holidays", "Worked hours", "Overtime"]} minWidth={860}>
              {d.items.map(({ employee, totals: t }) => (
                <tr key={employee.id}>
                  <td><EmployeeCell employee={employee} /></td>
                  {[t.workedDays, t.presentDays, t.lateDays, t.absentDays, t.leaveDays, t.holidayDays].map((n, i) => <td key={i} className="tabular-nums">{n}</td>)}
                  <td className="tabular-nums whitespace-nowrap">{hm(t.workedMinutes)}</td>
                  <td className="tabular-nums whitespace-nowrap">{t.overtimeMinutes ? hm(t.overtimeMinutes) : "—"}</td>
                </tr>
              ))}
            </DataTable>
            {d.total > d.pageSize && <Pagination page={page} pageCount={Math.ceil(d.total / d.pageSize)} onPage={setPage} />}
          </>
        )}
      </Loadable>
    </div>
  );
}

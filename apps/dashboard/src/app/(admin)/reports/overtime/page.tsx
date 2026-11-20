"use client";

import { useState } from "react";
import type { MonthlyAttendanceResponse } from "@workfolio/shared";
import { FilterBar, PageHeader, Pagination } from "@/components/kit";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { hm, overtimeSummary } from "@/lib/reports";
import { DayMatrix, Loadable, MonthField, qs, thisMonth, useApiData, usePage } from "../_parts";

const PAGE_SIZE = 50;

export default function OvertimeReport() {
  const { teamId } = useGlobalFilters();
  const [month, setMonth] = useState(thisMonth);
  const [page, setPage] = usePage(`${month}|${teamId}`);
  const state = useApiData<MonthlyAttendanceResponse>(`/attendance/monthly?${qs({ month, page, pageSize: PAGE_SIZE }, teamId)}`);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <GlobalFilters date={false} />
      <PageHeader
        title="Overtime"
        description={`Completed time beyond the scheduled day, ${month}.`}
        about="Overtime = completed net time above the scheduled daily minutes, per local day (as on the timesheet). It is reported, not applied to payroll. Open shifts are not counted."
      />
      <FilterBar label="Report month">
        <MonthField value={month} onChange={setMonth} />
      </FilterBar>
      <Loadable state={state} label="employees" empty={(d) => d.items.length === 0}>
        {(d) => (
          <>
            <DayMatrix
              label="Overtime"
              rows={d.items}
              lead={[
                { header: "Overtime days", value: (r) => overtimeSummary(r).days },
                { header: "Overtime hours", value: (r) => <span className="whitespace-nowrap">{hm(overtimeSummary(r).minutes)}</span> },
              ]}
              cell={(day) => (day.overtimeMinutes > 0 ? { text: hm(day.overtimeMinutes), tint: "danger" } : { text: "—", tint: "muted" })}
            />
            {d.total > d.pageSize && <Pagination page={page} pageCount={Math.ceil(d.total / d.pageSize)} onPage={setPage} />}
          </>
        )}
      </Loadable>
    </div>
  );
}

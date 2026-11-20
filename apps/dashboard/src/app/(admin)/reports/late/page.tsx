"use client";

import { useState } from "react";
import type { LateArrivalsResponse } from "@workfolio/shared";
import { DataTable, FilterBar, PageHeader, Pagination } from "@/components/kit";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { EmployeeCell, Loadable, qs, useApiData, usePage } from "../_parts";

const PAGE_SIZE = 50;
const MAX_DAYS = 92;

export default function LateReport() {
  const { teamId } = useGlobalFilters();
  const [range, setRange] = useState<Range>(() => weekRange());
  const [page, setPage] = usePage(`${range.from}|${range.to}|${teamId}`);
  const state = useApiData<LateArrivalsResponse>(`/attendance/late?${qs({ ...range, page, pageSize: PAGE_SIZE }, teamId)}`);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <GlobalFilters date={false} />
      <PageHeader
        title="Late clock-ins"
        description={`Clock-ins after the expected start plus grace, ${range.from} to ${range.to}.`}
        about="Each employee's own local date and time, by the work schedule in force that day. Late by = minutes after the expected start (not after the grace period). Newest first; at most 92 days."
      />
      <FilterBar label="Date range">
        <RangePicker value={range} maxDays={MAX_DAYS} onChange={setRange} />
      </FilterBar>
      <Loadable state={state} label="late clock-ins" empty={(d) => d.items.length === 0}>
        {(d) => (
          <>
            <DataTable label="Late clock-ins" head={["Employee", "Date", "Due by", "Clocked in", "Late by"]} minWidth={560}>
              {d.items.map((r) => (
                <tr key={`${r.employee.id}-${r.date}`}>
                  <td><EmployeeCell employee={r.employee} /></td>
                  <td className="tabular-nums whitespace-nowrap">{r.date}</td>
                  <td className="tabular-nums">{r.dueLocal}</td>
                  <td className="tabular-nums">{r.firstClockInLocal}</td>
                  <td className="tabular-nums font-medium text-danger">{r.lateMinutes} min</td>
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

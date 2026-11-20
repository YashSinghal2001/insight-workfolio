"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { formatDuration, orgTimesheetFilename, TIMESHEET_CSV_FORMAT, type ExportFormat, type Paginated, type TimesheetSummaryRow } from "@workfolio/shared";
import { Button, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SkeletonRows, StatusBadge, SuccessNotice, Tabs } from "@/components/kit";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { downloadFile } from "../_components/download";
import { WeekGrid } from "./week-grid";

const PAGE_SIZE = 20;
const MAX_DAYS = 92;

const VIEWS = [{ id: "summary", label: "Summary" }, { id: "grid", label: "Week grid" }] as const;

export default function TimesheetsPage() {
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("summary");
  const [range, setRange] = useState<Range>(() => weekRange());
  const [query, setQuery] = useState({ q: "", page: 1 });
  const [data, setData] = useState<Paginated<TimesheetSummaryRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

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
  }, [range, query, retry]);

  function onSearch(e: FormEvent<HTMLFormElement>) {
    setData(null);
    setQuery({ q: String(new FormData(e.currentTarget).get("q") ?? "").trim(), page: 1 });
  }

  async function exportAll(format: ExportFormat) {
    setExporting(format);
    setExportError(null);
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to, format, includeInactive: String(includeInactive) });
      if (query.q) params.set("q", query.q);
      const rows = await downloadFile(`/attendance/timesheets/export?${params}`, orgTimesheetFilename(range.from, range.to, format));
      setOk(`Downloaded the ${format.toUpperCase()} draft${rows === null ? "" : ` (${rows} shift row(s))`}.`);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(null);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Timesheets"
        about="Completed shifts only, by the local date each shift started in the employee's time zone. Overtime is reported, not applied to payroll. Open shifts are not counted until they are clocked out or corrected."
      />

      <Tabs label="Timesheet view" idPrefix="ts-view" tabs={VIEWS} value={view} onChange={setView}>
        {view === "grid" ? (
          <WeekGrid />
        ) : (
          <div className="flex flex-col gap-6">
            <FilterBar label="Filter employees" onSubmit={onSearch}>
              <RangePicker value={range} maxDays={MAX_DAYS} onChange={(r) => (setData(null), setRange(r), setQuery((q) => ({ ...q, page: 1 })))} />
              <input name="q" type="search" placeholder="Filter employees" aria-label="Filter employees" maxLength={100} defaultValue={query.q} className={`${inputClass} flex-1 sm:w-auto`} />
              <button type="submit" className={secondaryButtonClass}>Filter</button>
            </FilterBar>

            <section aria-labelledby="ts-export" className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
              <h2 id="ts-export" className="font-medium">Export all employees</h2>
              <p className="text-xs text-muted">
                Draft format <span className="font-mono">{TIMESHEET_CSV_FORMAT}</span>: not approved for payroll or accounting; columns may change.
                One row per shift for {range.from} to {range.to} (at most {MAX_DAYS} days){query.q ? `, employees matching “${query.q}”` : ""}. Nothing is stored on the server.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="secondary" pending={exporting === "csv"} pendingLabel="Preparing…" disabled={!!exporting} onClick={() => void exportAll("csv")}>Export CSV</Button>
                <Button variant="secondary" pending={exporting === "xlsx"} pendingLabel="Preparing…" disabled={!!exporting} onClick={() => void exportAll("xlsx")}>Export XLSX</Button>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Include disabled and terminated employees
                </label>
              </div>
              {exportError && <Notice tone="error">{exportError}</Notice>}
              <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
            </section>

            {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
            {!data && !error && <SkeletonRows label="timesheets" />}
            {data?.items.length === 0 && <EmptyState title="No employees found." hint={query.q ? "No employee matches this filter." : undefined} />}
            {data && data.items.length > 0 && (
              <DataTable label="Timesheets" head={["Employee", "Shifts", "Worked", "Breaks", "Overtime", "Needs attention"]} minWidth={760}>
                {data.items.map(({ employee, totals, openShift, missingClockOut, pendingCorrections }) => (
                  <tr key={employee.id}>
                    <td>
                      <Link href={`/timesheets/${employee.id}`} className="font-medium text-brand hover:underline">{employee.fullName}</Link>
                      <div className="font-mono text-xs text-muted">{employee.employeeCode}</div>
                    </td>
                    <td className="tabular-nums">{totals.shifts}</td>
                    <td className="tabular-nums">{formatDuration(totals.netMs)}</td>
                    <td className="tabular-nums">{formatDuration(totals.breakMs)}</td>
                    <td className="tabular-nums">
                      {totals.overtimeMs ? <span className="text-warning">{formatDuration(totals.overtimeMs)}</span> : "—"}
                    </td>
                    <td className="text-xs">
                      {missingClockOut && <><StatusBadge tone="danger">Missing clock-out</StatusBadge>{" "}</>}
                      {[
                        openShift && !missingClockOut && "Shift open now",
                        totals.incompleteDays > 0 && `${totals.incompleteDays} incomplete day(s)`,
                        pendingCorrections > 0 && `${pendingCorrections} pending correction(s)`,
                      ].filter(Boolean).join(" · ") || (!missingClockOut && <span className="text-muted">—</span>)}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
            {data && pages > 1 && <Pagination page={query.page} pageCount={pages} onPage={(page) => setQuery((q) => ({ ...q, page }))} />}
          </div>
        )}
      </Tabs>
    </div>
  );
}

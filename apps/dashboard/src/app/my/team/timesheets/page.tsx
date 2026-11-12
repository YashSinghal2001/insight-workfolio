"use client";

import { useState } from "react";
import { formatDuration, orgTimesheetFilename, TIMESHEET_CSV_FORMAT, type ExportFormat, type Paginated, type TimesheetSummaryRow } from "@workfolio/shared";
import { Button, DataTable, EmptyState, PageHeader, SuccessNotice } from "@/components/kit";
import { useApi } from "@/components/my-ui";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { Notice } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { downloadFile } from "../../../(admin)/_components/download";
import { Loaded } from "../../_components/states";

const MAX_DAYS = 92;

/** Per-member totals for a range, with the same draft CSV/XLSX export as the admin timesheets (team only). */
export default function TeamTimesheetsPage() {
  const [range, setRange] = useState<Range>(() => weekRange());
  const { load, reload } = useApi<Paginated<TimesheetSummaryRow>>(`/attendance/timesheets?from=${range.from}&to=${range.to}&pageSize=100`);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function exportTeam(format: ExportFormat) {
    setExporting(format);
    setError(null);
    try {
      const rows = await downloadFile(`/attendance/timesheets/export?from=${range.from}&to=${range.to}&format=${format}`, orgTimesheetFilename(range.from, range.to, format));
      setOk(`Downloaded the ${format.toUpperCase()} draft${rows === null ? "" : ` (${rows} shift row(s))`}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(null);
    }
  }

  return (
    <>
      <PageHeader title="Team timesheets" description="Completed shifts of your team members, by the local date each shift started in the member's time zone. Read-only." />
      <div className="flex flex-wrap items-end gap-3">
        <RangePicker value={range} maxDays={MAX_DAYS} onChange={setRange} />
        <Button variant="secondary" pending={exporting === "csv"} pendingLabel="Preparing…" disabled={!!exporting} onClick={() => void exportTeam("csv")}>Export CSV</Button>
        <Button variant="secondary" pending={exporting === "xlsx"} pendingLabel="Preparing…" disabled={!!exporting} onClick={() => void exportTeam("xlsx")}>Export XLSX</Button>
      </div>
      <p className="text-xs text-muted">Draft format <span className="font-mono">{TIMESHEET_CSV_FORMAT}</span>: not approved for payroll. Nothing is stored on the server.</p>
      {error && <Notice tone="error">{error}</Notice>}
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
      <Loaded load={load} reload={reload} label="team timesheets">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="Your team has no members yet." />
          ) : (
            <DataTable label="Team timesheets" head={["Member", "Shifts", "Worked", "Breaks", "Overtime", "Needs attention"]} minWidth={720}>
              {page.items.map(({ employee, totals, openShift, missingClockOut, pendingCorrections }) => (
                <tr key={employee.id}>
                  <td>
                    <span className="font-medium">{employee.fullName}</span>
                    <div className="font-mono text-xs text-muted">{employee.employeeCode}</div>
                  </td>
                  <td className="tabular-nums">{totals.shifts}</td>
                  <td className="tabular-nums">{formatDuration(totals.netMs)}</td>
                  <td className="tabular-nums">{formatDuration(totals.breakMs)}</td>
                  <td className="tabular-nums">{totals.overtimeMs ? formatDuration(totals.overtimeMs) : "—"}</td>
                  <td className="text-xs">
                    {[openShift && (missingClockOut ? "Forgot to clock out (shift open since an earlier day)" : "Shift open now"), totals.incompleteDays > 0 && `${totals.incompleteDays} incomplete day(s)`, pendingCorrections > 0 && `${pendingCorrections} pending correction(s)`]
                      .filter(Boolean)
                      .join(" · ") || <span className="text-muted">—</span>}
                  </td>
                </tr>
              ))}
            </DataTable>
          )
        }
      </Loaded>
    </>
  );
}

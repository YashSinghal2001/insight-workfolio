"use client";

import { useEffect, useState } from "react";
import { DAILY_REPORT_TABS, dailyExportFilename, dailyTabRows, type DailyAttendanceResponse, type DailyReportTab, type MonthlyAttendanceResponse, type MonthlyAttendanceRow } from "@workfolio/shared";
import { DataTable, EmptyState, ErrorState, PageHeader, SkeletonRows, StatusBadge, Tabs, type Tone } from "@/components/kit";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { api, errorMessage } from "@/lib/api";
import { dailyReportRows, dailyTabCounts, fetchAllPages, hm } from "@/lib/reports";
import { EmployeeCell, qs, ServerExport } from "../_parts";

const TONE: Record<string, Tone> = { PRESENT: "success", LATE: "danger", ABSENT: "danger", ON_LEAVE: "info", HOLIDAY: "info" };
const LABEL: Record<string, string> = { PRESENT: "Present", LATE: "Late", ABSENT: "Absent", ON_LEAVE: "On leave", HOLIDAY: "Holiday", NOT_SCHEDULED: "Not scheduled", NO_POLICY: "No schedule", NOT_YET_DUE: "Not yet due" };

type Load<T> = { key: string; data: T | null; error: string | null };

export default function DailyAttendanceReport() {
  const { date, teamId } = useGlobalFilters();
  const [tab, setTab] = useState<DailyReportTab>("worked");
  const [retry, setRetry] = useState(0);
  const key = `${date}|${teamId}|${retry}`;
  const [daily, setDaily] = useState<Load<DailyAttendanceResponse["items"]>>({ key: "", data: null, error: null });
  const [monthly, setMonthly] = useState<Load<MonthlyAttendanceRow[]>>({ key: "", data: null, error: null });

  // Two independent reads: /daily is the report; /monthly only adds clock-out and worked time (failure shows "—").
  useEffect(() => {
    let live = true;
    fetchAllPages((page) => api<DailyAttendanceResponse>(`/attendance/daily?${qs({ date, page, pageSize: 100 }, teamId)}`)).then(
      (data) => live && setDaily({ key, data, error: null }),
      (e) => live && setDaily({ key, data: null, error: errorMessage(e) }),
    );
    fetchAllPages((page) => api<MonthlyAttendanceResponse>(`/attendance/monthly?${qs({ month: date.slice(0, 7), page, pageSize: 100 }, teamId)}`)).then(
      (data) => live && setMonthly({ key, data, error: null }),
      (e) => live && setMonthly({ key, data: null, error: errorMessage(e) }),
    );
    return () => void (live = false);
  }, [date, teamId, key]);

  const d = daily.key === key ? daily : null;
  const m = monthly.key === key ? monthly : null;
  const rows = d?.data ? dailyReportRows(d.data, m?.data ?? null) : null;
  const counts = rows ? dailyTabCounts(rows) : null;
  const shown = rows ? dailyTabRows(rows, tab) : [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <GlobalFilters />
      <PageHeader
        title="Daily attendance"
        description={`Who worked, came in late, was on leave or absent on ${date}.`}
        actions={
          <ServerExport
            files={(["csv", "xlsx"] as const).map((format) => ({
              label: `Export ${format.toUpperCase()}`,
              path: `/attendance/daily/export?${qs({ date, tab, format }, teamId)}`,
              filename: dailyExportFilename(date, tab, format),
            }))}
          />
        }
        about="Each employee's own local date and time zone, by the work schedule in force that day (as on the Attendance page). Clock-out and worked time count completed shifts only; an open shift shows no worked time."
      />
      <Tabs label="Daily attendance" idPrefix="daily" value={tab} onChange={setTab} tabs={DAILY_REPORT_TABS.map((t) => ({ id: t.id, label: counts ? `${t.label} (${counts[t.id]})` : t.label }))}>
        {d?.error ? (
          <ErrorState message={d.error} onRetry={() => setRetry((n) => n + 1)} />
        ) : !rows ? (
          <SkeletonRows label="daily attendance" />
        ) : shown.length === 0 ? (
          <EmptyState title="Nobody in this list for this date." />
        ) : (
          <div className="flex flex-col gap-2">
            {m?.error && <p className="text-xs text-muted" role="status">Clock-out and worked time are unavailable right now ({m.error}).</p>}
            <DataTable label={`Daily attendance: ${tab}`} head={["Employee", "Date", "Status", "Clock in", "Clock out", "Worked", "Late by"]} minWidth={720}>
              {shown.map((r) => (
                <tr key={r.employee.id}>
                  <td><EmployeeCell employee={r.employee} /></td>
                  <td className="tabular-nums whitespace-nowrap">{r.date}</td>
                  <td><StatusBadge tone={TONE[r.status] ?? "neutral"}>{LABEL[r.status] ?? r.status}</StatusBadge></td>
                  <td className="tabular-nums">{r.clockIn ?? "—"}</td>
                  <td className="tabular-nums">{r.clockOut ?? "—"}</td>
                  <td className="tabular-nums">{r.workedMinutes === null ? "—" : hm(r.workedMinutes)}</td>
                  <td className="tabular-nums">{r.lateMinutes === null ? "—" : `${r.lateMinutes} min`}</td>
                </tr>
              ))}
            </DataTable>
          </div>
        )}
      </Tabs>
    </div>
  );
}

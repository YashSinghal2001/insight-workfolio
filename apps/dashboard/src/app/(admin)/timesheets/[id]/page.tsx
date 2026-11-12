"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  formatDuration,
  missingClockOut,
  timesheetFilename,
  TIMESHEET_CSV_FORMAT,
  type AttendanceSession,
  type ExportFormat,
  type CorrectionRequest,
  type Paginated,
  type TimesheetResponse,
} from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { CorrectionCard } from "@/components/correction-card";
import { Button, ErrorState, PageHeader, Pagination, SkeletonRows, StatusBadge, SuccessNotice } from "@/components/kit";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { Card, formatInZone, Notice } from "@/components/ui";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { downloadFile } from "../../_components/download";

const SHIFT_LIMIT = 100;
const CORRECTION_LIMIT = 50;

export default function EmployeeTimesheetPage() {
  // useParams suspends for request-time params under cacheComponents.
  return (
    <Suspense fallback={<SkeletonRows label="timesheet" />}>
      <EmployeeTimesheet />
    </Suspense>
  );
}

const day = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const time = (iso: string | null, tz: string) =>
  iso ? new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: tz }).format(new Date(iso)) : "—";
const Tag = ({ children, tone = "" }: { children: React.ReactNode; tone?: string }) => (
  <span className={`ml-1 inline-block rounded border border-border px-1.5 text-[11px] ${tone}`}>{children}</span>
);

function EmployeeTimesheet() {
  const { id } = useParams<{ id: string }>();
  const { auth } = useAuth();
  const [range, setRange] = useState<Range>(() => weekRange());
  const [shiftPage, setShiftPage] = useState(1);
  const [sheet, setSheet] = useState<TimesheetResponse | null>(null);
  const [shifts, setShifts] = useState<Paginated<AttendanceSession> | null>(null);
  const [corrections, setCorrections] = useState<Paginated<CorrectionRequest> | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const q = `employeeId=${id}&from=${range.from}&to=${range.to}`;
      const [t, h, c] = await Promise.all([
        api<TimesheetResponse>(`/attendance/timesheet?${q}`),
        api<Paginated<AttendanceSession>>(`/attendance/history?${q}&page=${shiftPage}&pageSize=${SHIFT_LIMIT}`),
        api<Paginated<CorrectionRequest>>(`/attendance/corrections?employeeId=${id}&pageSize=${CORRECTION_LIMIT}`),
      ]);
      setSheet(t);
      setShifts(h);
      setCorrections(c);
      setError(null);
    } catch (err) {
      setError({ status: err instanceof ApiRequestError ? err.status : undefined, message: errorMessage(err) });
    }
  }, [id, range, shiftPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / range change
    load();
  }, [load]);

  if (error) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <PageHeader title="Timesheet" breadcrumbs={[{ label: "Timesheets", href: "/timesheets" }, { label: "Timesheet" }]} />
        <ErrorState
          title={error.status === 404 ? "Employee not found" : "Could not load this timesheet"}
          message={error.status === 404 ? "No employee has this ID. They may have been removed, or the link is wrong." : error.message}
          onRetry={error.status === 404 ? undefined : () => void load()}
        />
        <Link href="/timesheets" className="text-sm text-brand underline">Back to timesheets</Link>
      </div>
    );
  }
  if (!sheet || !shifts || !corrections || auth.status !== "authenticated") return <SkeletonRows label="timesheet" />;

  async function exportOne(format: ExportFormat) {
    setExporting(format);
    setExportError(null);
    try {
      const rows = await downloadFile(
        `/attendance/export?employeeId=${id}&from=${range.from}&to=${range.to}&format=${format}`,
        timesheetFilename(sheet!.employee.employeeCode, range.from, range.to, format),
      );
      setOk(`Downloaded the ${format.toUpperCase()} draft${rows === null ? "" : ` (${rows} shift row(s))`}.`);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(null);
    }
  }

  const tz = sheet.timeZone;
  const scheduled = formatDuration(sheet.policy.scheduledDailyMinutes * 60_000);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title={sheet.employee.fullName}
        breadcrumbs={[{ label: "Timesheets", href: "/timesheets" }, { label: sheet.employee.fullName }]}
        description={
          <>
            {sheet.employee.employeeCode} · times in {tz} · scheduled day {scheduled} · weeks start{" "}
            {["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][sheet.policy.weekStartsOn]} ·{" "}
            <Link href={`/employees/${id}`} className="text-brand underline">Employee profile</Link>
          </>
        }
        actions={
          <>
            <Button variant="secondary" pending={exporting === "csv"} pendingLabel="Preparing…" disabled={!!exporting} onClick={() => void exportOne("csv")}>Export CSV</Button>
            <Button variant="secondary" pending={exporting === "xlsx"} pendingLabel="Preparing…" disabled={!!exporting} onClick={() => void exportOne("xlsx")}>Export XLSX</Button>
          </>
        }
      />
      <p className="-mt-4 text-xs text-muted">
        Exports cover the selected range (at most 92 days) in draft format <span className="font-mono">{TIMESHEET_CSV_FORMAT}</span>, not approved for payroll.
      </p>
      {exportError && <Notice tone="error">{exportError}</Notice>}
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />

      <RangePicker value={range} maxDays={92} timeZone={tz} onChange={(r) => (setSheet(null), setShiftPage(1), setRange(r))} />

      {sheet.totals.incompleteDays > 0 && (
        <Notice tone="warning">
          {sheet.totals.incompleteDays} day(s) have a shift without a clock-out. Those hours are not counted until the employee clocks
          out or a correction is approved.
        </Notice>
      )}

      <Card title="Weekly totals">
        {sheet.weeks.length === 0 ? (
          <p className="text-sm text-muted">No shifts in this range.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-sm tabular-nums" aria-label="Weekly totals">
            <thead className="text-xs text-muted uppercase">
              <tr><th className="py-2 font-medium">Week of</th><th className="font-medium">Days</th><th className="font-medium">Worked</th><th className="font-medium">Breaks</th><th className="font-medium">Overtime</th></tr>
            </thead>
            <tbody>
              {sheet.weeks.map((w) => (
                <tr key={w.weekStart} className="border-t border-border">
                  <td className="py-2">{day(w.weekStart)}</td><td>{w.days}</td><td>{formatDuration(w.netMs)}</td><td>{formatDuration(w.breakMs)}</td>
                  <td>{w.overtimeMs ? formatDuration(w.overtimeMs) : "—"}</td>
                </tr>
              ))}
              <tr className="border-t border-border font-medium">
                <td className="py-2">Total</td><td>{sheet.days.length}</td><td>{formatDuration(sheet.totals.netMs)}</td>
                <td>{formatDuration(sheet.totals.breakMs)}</td><td>{sheet.totals.overtimeMs ? formatDuration(sheet.totals.overtimeMs) : "—"}</td>
              </tr>
            </tbody>
          </table>
          </div>
        )}
      </Card>

      <Card title="Daily timesheet">
        {sheet.days.length === 0 ? (
          <p className="text-sm text-muted">No shifts in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm tabular-nums">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  <th className="py-2 font-medium">Day</th><th className="font-medium">Shifts</th><th className="font-medium">First in</th>
                  <th className="font-medium">Last out</th><th className="font-medium">Elapsed</th><th className="font-medium">Breaks</th>
                  <th className="font-medium">Worked</th><th className="font-medium">Overtime</th>
                </tr>
              </thead>
              <tbody>
                {sheet.days.map((d) => (
                  <tr key={d.date} className="border-t border-border">
                    <td className="py-2">
                      {day(d.date)}
                      {d.incomplete && <Tag tone="text-amber-800 dark:text-amber-300">incomplete</Tag>}
                      {d.corrected && <Tag>corrected</Tag>}
                      {d.offlineShifts > 0 && <Tag>offline sync</Tag>}
                    </td>
                    <td>{d.shifts}</td><td>{time(d.firstClockIn, tz)}</td><td>{time(d.lastClockOut, tz)}</td>
                    <td>{formatDuration(d.grossMs)}</td><td>{formatDuration(d.breakMs)}</td><td>{formatDuration(d.netMs)}</td>
                    <td>{d.overtimeMs ? <span className="text-amber-800 dark:text-amber-300">{formatDuration(d.overtimeMs)}</span> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Shifts and breaks">
        {shifts.items.length === 0 ? (
          <p className="text-sm text-muted">No shifts in this range.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {shifts.items.map((s) => (
              <li key={s.id} className="py-2">
                <span className="font-medium">{formatInZone(s.clockInAt, tz)} → {s.clockOutAt ? time(s.clockOutAt, tz) : "open"}</span>
                {missingClockOut(s, tz) && <>{" "}<StatusBadge tone="danger">Missing clock-out</StatusBadge></>}
                {s.corrected && <Tag>corrected</Tag>}
                {s.clockInSource === "OFFLINE_SYNC" && <Tag>offline sync</Tag>}
                {s.clockInSource === "CORRECTION" && <Tag>added by correction</Tag>}
                <div className="text-xs text-muted">
                  {s.breaks.length ? `Breaks: ${s.breaks.map((b) => `${time(b.startedAt, tz)}–${b.endedAt ? time(b.endedAt, tz) : "open"}`).join(", ")}` : "No breaks"}
                </div>
              </li>
            ))}
          </ul>
        )}
        {shifts.total > shifts.pageSize && (
          <div className="mt-3"><Pagination label="Shift pages" page={shiftPage} pageCount={Math.ceil(shifts.total / shifts.pageSize)} onPage={setShiftPage} /></div>
        )}
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Correction history</h2>
        {corrections.total > corrections.items.length && (
          <p className="text-xs text-muted">Showing the {corrections.items.length} most recent of {corrections.total} requests. <Link href="/corrections" className="text-brand underline">All corrections</Link></p>
        )}
        {corrections.items.length === 0 ? (
          <p className="text-sm text-muted">No correction requests.</p>
        ) : (
          corrections.items.map((c) => (
            <CorrectionCard key={c.id} request={c} currentUserId={auth.me.user.id} onChanged={() => void load()} />
          ))
        )}
      </section>
    </div>
  );
}

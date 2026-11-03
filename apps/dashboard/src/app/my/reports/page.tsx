"use client";

import { useState, type FormEvent } from "react";
import {
  ACTIVITY_RANGE_MAX_DAYS,
  MAX_RANGE_DAYS,
  formatDuration,
  timesheetFilename,
  type CategorizedActivitySummary,
  type ExportFormat,
  type TimesheetResponse,
} from "@workfolio/shared";
import { Button, DataTable, EmptyState, PageHeader, StatCard, StatGrid } from "@/components/kit";
import { UpdatedAt, dayLabel, timeIn, useApi, useMe } from "@/components/my-ui";
import { CategoryBadge, CategoryTotals } from "../_components/categories";
import { Loaded } from "../_components/states";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { Card, Notice } from "@/components/ui";
import { apiResponse, errorMessage } from "@/lib/api";

const spanDays = (r: Range) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;

/** Own timesheet export as a file (raw response; the session refresh is handled by the API client). */
async function downloadExport(r: Range, format: ExportFormat, employeeCode: string): Promise<{ name: string; rows: number }> {
  const res = await apiResponse(`/attendance/export?from=${r.from}&to=${r.to}&format=${format}`);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? timesheetFilename(employeeCode, r.from, r.to, format);
  const rows = Number(res.headers.get("x-export-rows") ?? 0);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name, rows };
}

function ExportForm({ range, employeeCode, valid }: { range: Range; employeeCode: string; valid: boolean }) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus("Preparing…");
    try {
      const { name, rows } = await downloadExport(range, format, employeeCode);
      setStatus(`Downloaded ${name} (${rows} shift(s))`);
    } catch (err) {
      setStatus(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Export my timesheet" onSubmit={submit} className="flex flex-col gap-3 text-sm">
      <p className="text-muted">
        One row per shift from {dayLabel(range.from)} to {dayLabel(range.to)}, in your time zone, with the recorded clock-in, clock-out and break
        times and the calculated minutes. <strong>Draft format</strong>: the columns are not yet approved for payroll or accounting. Open shifts have
        no clock-out and no worked minutes. Up to {MAX_RANGE_DAYS} days.
      </p>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 font-medium">File type</legend>
        <label className="flex items-center gap-2"><input type="radio" name="format" value="csv" checked={format === "csv"} onChange={() => setFormat("csv")} /> CSV</label>
        <label className="flex items-center gap-2"><input type="radio" name="format" value="xlsx" checked={format === "xlsx"} onChange={() => setFormat("xlsx")} /> Excel (.xlsx, with a Summary sheet)</label>
      </fieldset>
      <div>
        <Button type="submit" pending={busy} pendingLabel="Preparing…" disabledReason={valid ? null : `Choose a range of at most ${MAX_RANGE_DAYS} days.`}>{format === "xlsx" ? "Download Excel file" : "Download CSV"}</Button>
      </div>
      {status && <p role="status">{status}</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}

/** Own attendance and activity totals for a date range, plus the draft timesheet export. */
export default function MyReportsPage() {
  const me = useMe();
  const [range, setRange] = useState<Range>(() => weekRange(0, me.timezone));
  const days = spanDays(range);
  const valid = days >= 1 && days <= MAX_RANGE_DAYS;
  const activityOk = valid && days <= ACTIVITY_RANGE_MAX_DAYS;
  const q = `from=${range.from}&to=${range.to}`;
  const sheet = useApi<TimesheetResponse>(valid ? `/attendance/timesheet?${q}` : null);
  const activity = useApi<CategorizedActivitySummary>(activityOk ? `/activity/summary?${q}` : null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My reports" description={`Your own records only, by local date in your time zone (${me.timezone}).`} />
      <div className="flex flex-col gap-2">
        <RangePicker value={range} onChange={setRange} timeZone={me.timezone} maxDays={MAX_RANGE_DAYS} />
        <p className="text-xs text-muted">
          Attendance and export: up to {MAX_RANGE_DAYS} days. Activity: up to {ACTIVITY_RANGE_MAX_DAYS} days.
        </p>
        {!valid && <Notice tone="warning">Choose a range of at most {MAX_RANGE_DAYS} days.</Notice>}
      </div>

      <Card title="Attendance" actions={sheet.load.state === "ready" ? <UpdatedAt at={sheet.load.at} /> : undefined}>
        {valid ? (
          <Loaded load={sheet.load} reload={sheet.reload} label="your timesheet">
            {(t) => (
              <div className="flex flex-col gap-4">
                <StatGrid>
                  <StatCard label="Worked (net)" value={formatDuration(t.totals.netMs)} hint="Completed shifts" />
                  <StatCard label="Breaks" value={formatDuration(t.totals.breakMs)} />
                  <StatCard label="Shifts" value={t.totals.shifts} />
                  <StatCard label="Overtime (reported)" value={formatDuration(t.totals.overtimeMs)} hint="Not applied to payroll" />
                </StatGrid>
                {t.totals.incompleteDays > 0 && <p className="text-xs text-muted">{t.totals.incompleteDays} day(s) have an open shift, not counted until it ends.</p>}
                {t.pendingCorrections > 0 && <p className="text-xs text-muted">{t.pendingCorrections} correction request(s) pending; totals change only once approved.</p>}
                {t.days.length === 0 ? (
                  <EmptyState title="No shifts in this period." />
                ) : (
                  <DataTable label="My timesheet summary" head={["Date", "Shifts", "First in", "Last out", "Breaks", "Worked (net)"]}>
                    {t.days.map((d) => (
                      <tr key={d.date}>
                        <td className="whitespace-nowrap">{dayLabel(d.date)}</td>
                        <td className="tabular-nums">{d.shifts}</td>
                        <td>{timeIn(d.firstClockIn, t.timeZone)}</td>
                        <td>{d.incomplete && !d.lastClockOut ? "Open" : timeIn(d.lastClockOut, t.timeZone)}</td>
                        <td className="tabular-nums">{formatDuration(d.breakMs)}</td>
                        <td className="tabular-nums">{formatDuration(d.netMs)}{d.incomplete ? " (shift open)" : ""}</td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </div>
            )}
          </Loaded>
        ) : (
          <p className="text-sm text-muted">Choose a shorter range to see attendance.</p>
        )}
      </Card>

      <Card title="Activity" actions={activity.load.state === "ready" ? <UpdatedAt at={activity.load.at} /> : undefined}>
        {activityOk ? (
          <Loaded load={activity.load} reload={activity.reload} label="your activity">
            {(a) => (
              <div className="flex flex-col gap-4">
                <StatGrid>
                  <StatCard label="Active" value={formatDuration(a.activeMs)} />
                  <StatCard label="Idle" value={formatDuration(a.idleMs)} />
                  <StatCard label="Clocked in" value={formatDuration(a.clockedInMs)} />
                  <StatCard label="No activity record" value={formatDuration(a.unobservedMs)} hint="Clocked in, nothing recorded" />
                </StatGrid>
                <CategoryTotals summary={a} />
                {a.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-muted">{a.warnings.map((w) => <li key={`${w.code}-${w.date ?? ""}`}>{w.message}</li>)}</ul>}
                {a.applications.length === 0 ? (
                  <EmptyState title="No application activity recorded in this period." />
                ) : (
                  <DataTable label="My activity by application" head={["Application", "Active time", ...(a.categoriesConfigured ? ["Label (organization)"] : [])]}>
                    {a.applications.map((app) => (
                      <tr key={app.applicationIdentifier ?? `name:${app.applicationName}`}>
                        <td>{app.applicationName}</td>
                        <td className="tabular-nums">{formatDuration(app.activeMs)}</td>
                        {a.categoriesConfigured && <td><CategoryBadge category={app.category} /></td>}
                      </tr>
                    ))}
                  </DataTable>
                )}
              </div>
            )}
          </Loaded>
        ) : (
          <p className="text-sm text-muted">Activity is shown for ranges of up to {ACTIVITY_RANGE_MAX_DAYS} days. Choose a shorter range to see it.</p>
        )}
      </Card>

      <Card title="Export my timesheet (draft)">
        <ExportForm key={`${range.from}-${range.to}`} range={range} employeeCode={me.employeeCode} valid={valid} />
      </Card>
    </div>
  );
}

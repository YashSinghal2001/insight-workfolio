"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  formatDuration,
  type AttendanceSession,
  type CorrectionRequest,
  type Paginated,
  type TimesheetResponse,
} from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { CorrectionCard } from "@/components/correction-card";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { Card, formatInZone, Notice } from "@/components/ui";
import { api, ApiRequestError, errorMessage } from "@/lib/api";

export default function EmployeeTimesheetPage() {
  // useParams suspends for request-time params under cacheComponents.
  return (
    <Suspense fallback={<p role="status" className="text-sm text-muted">Loading…</p>}>
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
  const [sheet, setSheet] = useState<TimesheetResponse | null>(null);
  const [shifts, setShifts] = useState<AttendanceSession[] | null>(null);
  const [corrections, setCorrections] = useState<CorrectionRequest[] | null>(null);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const q = `employeeId=${id}&from=${range.from}&to=${range.to}`;
      const [t, h, c] = await Promise.all([
        api<TimesheetResponse>(`/attendance/timesheet?${q}`),
        api<Paginated<AttendanceSession>>(`/attendance/history?${q}&pageSize=100`),
        api<Paginated<CorrectionRequest>>(`/attendance/corrections?employeeId=${id}&pageSize=50`),
      ]);
      setSheet(t);
      setShifts(h.items);
      setCorrections(c.items);
      setError(null);
    } catch (err) {
      setError({ status: err instanceof ApiRequestError ? err.status : undefined, message: errorMessage(err) });
    }
  }, [id, range]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / range change
    load();
  }, [load]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl">
        <Notice tone="error">{error.status === 404 || error.status === 400 ? "Employee not found." : error.message}</Notice>
        <Link href="/timesheets" className="mt-4 inline-block text-sm text-brand underline">Back to timesheets</Link>
      </div>
    );
  }
  if (!sheet || !shifts || !corrections || auth.status !== "authenticated") return <p role="status" className="text-sm text-muted">Loading…</p>;

  const tz = sheet.timeZone;
  const scheduled = formatDuration(sheet.policy.scheduledDailyMinutes * 60_000);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <Link href="/timesheets" className="text-sm text-muted hover:underline">← Timesheets</Link>
        <h1 className="mt-1 text-2xl font-semibold">{sheet.employee.fullName}</h1>
        <p className="mt-1 text-sm text-muted">
          {sheet.employee.employeeCode} · times in {tz} · scheduled day {scheduled} · weeks start{" "}
          {["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][sheet.policy.weekStartsOn]}
        </p>
      </div>

      <RangePicker value={range} onChange={(r) => (setSheet(null), setRange(r))} />

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
          <table className="w-full text-left text-sm tabular-nums">
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
        {shifts.length === 0 ? (
          <p className="text-sm text-muted">No shifts in this range.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {shifts.map((s) => (
              <li key={s.id} className="py-2">
                <span className="font-medium">{formatInZone(s.clockInAt, tz)} → {s.clockOutAt ? time(s.clockOutAt, tz) : "open"}</span>
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
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Correction history</h2>
        {corrections.length === 0 ? (
          <p className="text-sm text-muted">No correction requests.</p>
        ) : (
          corrections.map((c) => (
            <CorrectionCard key={c.id} request={c} currentUserId={auth.me.user.id} onChanged={() => void load()} />
          ))
        )}
      </section>
    </div>
  );
}

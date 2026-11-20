"use client";

import { useState } from "react";
import { formatDuration, monthRange, todayIn, type ExpectedScheduleResponse, type LeaveRequest, type Paginated, type TimesheetResponse } from "@workfolio/shared";
import { StatusBadge } from "@/components/kit";
import { secondaryButtonClass } from "@/components/ui";
import { useApi } from "@/components/my-ui";
import { CALENDAR_CODE, calendarMonth, shiftMonth, type CalendarDay } from "../_lib/attendance";
import { Loaded } from "./states";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LEGEND = (["PRESENT", "LATE", "ABSENT", "ON_LEAVE", "NOT_SCHEDULED", "OPEN"] as const).map((s) => CALENDAR_CODE[s]);
const monthLabel = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));

/** One month of the employee's own attendance (own timesheet, expected window and approved leave only). */
export function AttendanceCalendar({ tz }: { tz: string }) {
  const thisMonth = todayIn(tz).slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const { from, to } = monthRange(month);
  const sheet = useApi<TimesheetResponse>(`/attendance/timesheet?from=${from}&to=${to}`);
  const expected = useApi<ExpectedScheduleResponse>(`/attendance/expected?from=${from}&to=${to}`);
  // ponytail: first 100 approved requests; page by date if someone has more.
  const leave = useApi<Paginated<LeaveRequest>>("/leave?mine=true&status=APPROVED&pageSize=100");
  const fetchedAt = sheet.load.state === "ready" ? sheet.load.at : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button type="button" className={`${secondaryButtonClass} px-3 py-1`} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
        <h3 className="min-w-36 text-center text-sm font-medium" aria-live="polite">{monthLabel(month)}</h3>
        <button type="button" className={`${secondaryButtonClass} px-3 py-1`} onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth} aria-label="Next month">›</button>
      </div>
      <Loaded load={sheet.load} reload={sheet.reload} label="your timesheet for the month">
        {(t) => (
          <Loaded load={expected.load} reload={expected.reload} label="your work schedule">
            {(e) => (
              <Loaded load={leave.load} reload={leave.reload} label="your approved leave">
                {(l) => <CalendarGrid month={month} weeks={calendarMonth({ month, timeZone: tz, timesheet: t, expected: e, leave: l.items, now: fetchedAt })} />}
              </Loaded>
            )}
          </Loaded>
        )}
      </Loaded>
      <ul aria-label="Calendar legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {LEGEND.map((c) => (
          <li key={c.code} className="flex items-center gap-1"><StatusBadge tone={c.tone}>{c.code}</StatusBadge>{c.label}</li>
        ))}
        <li>Hours: completed shifts, net of breaks.</li>
      </ul>
    </div>
  );
}

export function CalendarGrid({ month, weeks }: { month: string; weeks: (CalendarDay | null)[][] }) {
  const worked = weeks.flat().reduce((ms, d) => ms + (d?.workedMs ?? 0), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-xs" data-testid="my-attendance-calendar">
        <caption className="mb-2 text-left text-sm">
          {monthLabel(month)}: {formatDuration(worked)} worked (completed shifts)
        </caption>
        <thead>
          <tr>{WEEKDAYS.map((d) => <th key={d} scope="col" className="py-1 font-medium text-muted">{d}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => (
            <tr key={i}>
              {w.map((d, j) => (d ? <DayCell key={d.date} d={d} /> : <td key={j} className="border border-border bg-surface-muted" />))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayCell({ d }: { d: CalendarDay }) {
  const c = CALENDAR_CODE[d.status];
  const label = [d.date, c.label, d.lateMinutes ? `late by ${d.lateMinutes} min` : null, d.workedMs ? `worked ${formatDuration(d.workedMs)}` : null].filter(Boolean).join(", ");
  return (
    <td aria-current={d.today ? "date" : undefined} className={`h-16 border border-border p-1 align-top ${d.today ? "ring-2 ring-focus ring-inset" : ""}`}>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" title={label} className="flex flex-col items-start gap-0.5">
        <span className="tabular-nums text-muted">{Number(d.date.slice(8))}</span>
        {c.code && <StatusBadge tone={c.tone}>{c.code}</StatusBadge>}
        {d.workedMs > 0 && <span className="tabular-nums">{formatDuration(d.workedMs)}</span>}
      </span>
    </td>
  );
}

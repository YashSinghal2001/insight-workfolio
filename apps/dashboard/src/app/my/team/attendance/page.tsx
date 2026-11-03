"use client";

import { useState } from "react";
import { attendanceTotals, formatDuration, localDate, type AttendanceOverviewRow, type AttendanceSummary, type Paginated } from "@workfolio/shared";
import { DataTable, EmptyState, PageHeader, StatCard, StatGrid, StatusBadge, type Tone } from "@/components/kit";
import { useApi } from "@/components/my-ui";
import { formatInZone, inputClass } from "@/components/ui";
import { Loaded } from "../../_components/states";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const STATE: Record<AttendanceOverviewRow["state"], { label: string; tone: Tone }> = {
  CLOCKED_IN: { label: "Clocked in", tone: "success" },
  ON_BREAK: { label: "On break", tone: "warning" },
  CLOCKED_OUT: { label: "Clocked out", tone: "neutral" },
};

/** Team attendance: day counts for a date (each member's own time zone) and everyone's live status. */
export default function TeamAttendancePage() {
  const [date, setDate] = useState(() => localDate(Date.now(), TZ));
  const summary = useApi<AttendanceSummary>(`/attendance/summary?date=${date}`);
  const live = useApi<Paginated<AttendanceOverviewRow>>("/attendance/overview?pageSize=100");
  const now = live.load.state === "ready" ? live.load.at : 0;
  return (
    <>
      <PageHeader title="Team attendance" description="Counts for one date, read in each member's own time zone, and the live status from their desktop apps. Read-only." />
      <label className="flex w-fit flex-col gap-1 text-sm">
        <span className="text-xs text-muted">Date</span>
        <input type="date" required value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className={inputClass} />
      </label>
      <Loaded load={summary.load} reload={summary.reload} label="team attendance summary">
        {(s) => (
          <StatGrid>
            <StatCard label="Working now" value={s.currentlyWorking} hint={`${s.onBreak} on break`} />
            <StatCard label="Clocked out" value={s.clockedOutToday} />
            <StatCard label="Not clocked in" value={s.notClockedInToday} hint={`of ${s.totalActiveEmployees} member(s)`} />
            <StatCard label="Net work" value={formatDuration(s.netWorkMsToday)} hint={`${formatDuration(s.breakMsToday)} breaks`} />
          </StatGrid>
        )}
      </Loaded>
      <Loaded load={live.load} reload={live.reload} label="live team attendance">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="Your team has no members yet." />
          ) : (
            <DataTable label="Live team attendance" head={["Member", "Status", "Clocked in", "Net working time", "Last sync"]} minWidth={720}>
              {page.items.map((r) => {
                const s = r.session;
                const t = s && attendanceTotals({ start: s.clockInAt, end: s.clockOutAt }, s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt })), now);
                return (
                  <tr key={r.employeeId}>
                    <td>
                      <span className="font-medium">{r.fullName}</span>
                      <div className="font-mono text-xs text-muted">{r.employeeCode}</div>
                    </td>
                    <td><StatusBadge tone={STATE[r.state].tone}>{STATE[r.state].label}</StatusBadge></td>
                    <td>{s && r.state !== "CLOCKED_OUT" ? formatInZone(s.clockInAt, r.timezone) : "—"}</td>
                    <td className="tabular-nums">{t ? (r.state === "CLOCKED_OUT" ? <span className="text-muted">Last shift {formatDuration(t.netMs)}</span> : formatDuration(t.netMs)) : "—"}</td>
                    <td>{r.lastEvent ? formatInZone(r.lastEvent.receivedAt, r.timezone) : <span className="text-muted">Never</span>}</td>
                  </tr>
                );
              })}
            </DataTable>
          )
        }
      </Loaded>
    </>
  );
}

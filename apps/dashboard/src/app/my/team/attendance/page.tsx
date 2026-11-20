"use client";

import { useState } from "react";
import {
  attendanceTotals,
  formatDuration,
  localDate,
  type AttendanceOverviewRow,
  type AttendanceSummary,
  type LateArrivalsResponse,
  type MissingClockOutsResponse,
  type OverviewFreshness,
  type Paginated,
  type TeamProductivityResponse,
} from "@workfolio/shared";
import { DataTable, EmptyState, PageHeader, StatCard, StatGrid, StatusBadge, type Tone } from "@/components/kit";
import { useApi } from "@/components/my-ui";
import { Card, formatInZone, inputClass } from "@/components/ui";
import { eventSourceLabel, lastSeenLabel } from "@/lib/attendance-ui";
import { LIVE_STATUS } from "../../_components/live-status";
import { Loaded } from "../../_components/states";
import { LateList, MissingList } from "../../_components/team-attendance";
import { lateRange, pickTeam } from "../../_lib/attendance";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const STATE: Record<AttendanceOverviewRow["state"], { label: string; tone: Tone }> = {
  CLOCKED_IN: { label: "Clocked in", tone: "success" },
  ON_BREAK: { label: "On break", tone: "warning" },
  CLOCKED_OUT: { label: "Clocked out", tone: "neutral" },
};

/**
 * Team attendance for one of the teams the head leads (picker when several): day counts for a date (each
 * member's own time zone), live status, late arrivals and missing clock-outs. Read-only.
 */
export default function TeamAttendancePage() {
  const [date, setDate] = useState(() => localDate(Date.now(), TZ));
  const [chosen, setChosen] = useState<string | null>(null);
  const [today] = useState(() => localDate(Date.now(), TZ));
  // Heads get only the active teams they head here. If it fails, sections load unfiltered (still server-scoped).
  const teams = useApi<TeamProductivityResponse>(`/teams/productivity?from=${today}&to=${today}`);
  const list = teams.load.state === "ready" ? teams.load.data.items.map((r) => r.team) : [];
  const teamId = teams.load.state === "ready" ? pickTeam(list, chosen) : null;
  const team = teams.load.state === "loading" ? null : teamId ? `teamId=${teamId}&` : "";
  const late = lateRange(date);
  const summary = useApi<AttendanceSummary>(team === null ? null : `/attendance/summary?${team}date=${date}`);
  const live = useApi<Paginated<AttendanceOverviewRow & OverviewFreshness>>(team === null ? null : `/attendance/overview?${team}pageSize=100`);
  const lateRows = useApi<LateArrivalsResponse>(team === null ? null : `/attendance/late?${team}from=${late.from}&to=${late.to}&pageSize=100`);
  const missing = useApi<MissingClockOutsResponse>(team === null ? null : `/attendance/missing-clock-outs${teamId ? `?teamId=${teamId}` : ""}`);
  const now = live.load.state === "ready" ? live.load.at : 0;
  return (
    <>
      <PageHeader title="Team attendance" description="Counts for one date, read in each member's own time zone, and the live status from their desktop apps. Read-only." />
      <div className="flex flex-wrap gap-4">
        <label className="flex w-fit flex-col gap-1 text-sm">
          <span className="text-xs text-muted">Date</span>
          <input type="date" required value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className={inputClass} />
        </label>
        {list.length > 1 && (
          <label className="flex w-fit flex-col gap-1 text-sm">
            <span className="text-xs text-muted">Team</span>
            <select value={teamId ?? ""} onChange={(e) => setChosen(e.target.value)} className={inputClass}>
              {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        {list.length === 1 && <p className="self-end text-sm text-muted">Team: {list[0].name}</p>}
      </div>
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
            <DataTable label="Live team attendance" head={["Member", "Attendance", "Now", "Clocked in", "Net working time", "Last seen"]} minWidth={800}>
              {page.items.map((r) => {
                const s = r.session;
                const t = s && attendanceTotals({ start: s.clockInAt, end: s.clockOutAt }, s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt })), now);
                return (
                  <tr key={r.employeeId}>
                    <td>
                      <span className="font-medium">{r.fullName}</span>
                      <div className="font-mono text-xs text-muted">{r.employeeCode}</div>
                    </td>
                    <td>
                      <StatusBadge tone={STATE[r.state].tone}>{STATE[r.state].label}</StatusBadge>
                      {r.missingClockOut && <div className="mt-1 text-xs text-muted">Forgot to clock out</div>}
                    </td>
                    <td><StatusBadge tone={LIVE_STATUS[r.liveStatus].tone}>{LIVE_STATUS[r.liveStatus].label}</StatusBadge></td>
                    <td>{s && r.state !== "CLOCKED_OUT" ? formatInZone(s.clockInAt, r.timezone) : "—"}</td>
                    <td className="tabular-nums">{t ? (r.state === "CLOCKED_OUT" ? <span className="text-muted">Last shift {formatDuration(t.netMs)}</span> : formatDuration(t.netMs)) : "—"}</td>
                    <td>
                      {/* Freshness is the device's last contact (online only when the API says so), never the last event. */}
                      <span title={r.lastSeenAt ? formatInZone(r.lastSeenAt, r.timezone) : undefined}>
                        <StatusBadge tone={r.online === true ? "success" : "neutral"}>{lastSeenLabel(r.online === true, r.lastSeenAt ?? null, now)}</StatusBadge>
                      </span>
                      {r.lastEvent && <div className="mt-1 text-xs text-muted">Last event {formatInZone(r.lastEvent.receivedAt, r.timezone)} · {eventSourceLabel(r.lastEvent.source)}</div>}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          )
        }
      </Loaded>
      <Card title={`Late arrivals, ${late.from} to ${late.to}`}>
        <Loaded load={lateRows.load} reload={lateRows.reload} label="late arrivals">
          {(p) => <LateList data={p} />}
        </Loaded>
      </Card>
      <Card title="Missing clock-outs">
        <Loaded load={missing.load} reload={missing.reload} label="missing clock-outs">
          {(m) => <MissingList data={m} />}
        </Loaded>
      </Card>
    </>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatDuration, localDate, type AttendanceSummary, type DailyAttendanceResponse, type WorkScheduleResponse } from "@workfolio/shared";
import { EmptyState, ErrorState, PageHeader, SkeletonRows, StatCard, StatGrid } from "@/components/kit";
import { buttonClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

type Schedule = { enabled: true; daily: DailyAttendanceResponse } | { enabled: false } | { error: string };

export default function OverviewPage() {
  const [summary, setSummary] = useState<AttendanceSummary | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<AttendanceSummary>("/attendance/summary").then((r) => (setSummary(r), setError(null)), (e) => setError(errorMessage(e)));
    // Late/absent only exist under an enabled schedule; without one they are never computed.
    api<WorkScheduleResponse>("/settings/schedule")
      .then(async (s) =>
        s.current.enabled
          ? setSchedule({ enabled: true, daily: await api<DailyAttendanceResponse>(`/attendance/daily?date=${localDate(Date.now(), TZ)}&pageSize=1`) })
          : setSchedule({ enabled: false }),
      )
      .catch((e) => setSchedule({ error: errorMessage(e) }));
  }, []);
  useEffect(load, [load]);

  const s = summary;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Overview"
        description="Today at a glance, from recorded attendance only. Day figures use each employee's own time zone."
        actions={s && <span className="text-xs text-muted">Updated {new Date(s.generatedAt).toLocaleTimeString("en-GB", { timeStyle: "short" })}</span>}
      />

      <Notice tone="info">
        Recorded while employees are clocked in and not on a break: attendance, the foreground application name and idle time.
        Screenshots of the main screen only if turned on in Settings and acknowledged by the employee (off by default). Website
        domains (never page addresses or content) only when website tracking is turned on, approved for production and acknowledged
        by the employee; see <Link href="/websites" className="underline">Websites</Link>. No keystrokes or window titles are collected.
      </Notice>

      {error && <ErrorState message={error} onRetry={load} />}
      {!s && !error && <SkeletonRows rows={4} label="overview" />}
      {s && s.totalActiveEmployees === 0 && (
        <EmptyState
          title="No employees enrolled"
          hint="Nothing is shown until real attendance is recorded."
          action={<Link href="/employees/new" className={buttonClass}>Add your first employee</Link>}
        />
      )}
      {s && s.totalActiveEmployees > 0 && (
        <>
          <section aria-labelledby="ov-now" className="flex flex-col gap-3">
            <h2 id="ov-now" className="text-lg font-semibold">Right now</h2>
            <StatGrid>
              <StatCard label="Active employees" value={s.totalActiveEmployees} hint="Account active, not terminated" href="/employees" />
              <StatCard label="Working now" value={s.currentlyWorking} hint="Clocked in, not on a break" href="/attendance" />
              <StatCard label="On a break" value={s.onBreak} href="/attendance" />
              <StatCard label="Clocked out today" value={s.clockedOutToday} hint="Worked today, no shift open now" href="/attendance" />
            </StatGrid>
          </section>
          <section aria-labelledby="ov-today" className="flex flex-col gap-3">
            <h2 id="ov-today" className="text-lg font-semibold">Today</h2>
            <StatGrid>
              <StatCard label="Not clocked in today" value={s.notClockedInToday} hint="Not the same as absent: leave, rest days and schedules are not considered here" />
              <StatCard label="Net work today" value={formatDuration(s.netWorkMsToday)} hint="All employees, breaks excluded; open shifts count to now" />
              <StatCard label="Breaks today" value={formatDuration(s.breakMsToday)} />
              <StatCard label="Screenshots stored today" value={s.screenshotsStoredToday} href="/screenshots" />
              {schedule && "enabled" in schedule && schedule.enabled ? (
                <>
                  <StatCard label="Late today" value={schedule.daily.summary.LATE} hint={`Work schedule, ${schedule.daily.date} (${TZ} date)`} href="/attendance?view=daily" />
                  <StatCard label="Absent today" value={schedule.daily.summary.ABSENT} hint={`${schedule.daily.summary.NOT_YET_DUE} not yet due · ${schedule.daily.summary.ON_LEAVE} on leave`} href="/attendance?view=daily" />
                </>
              ) : schedule && "error" in schedule ? (
                <StatCard label="Late / absent today" value={null} reason={`Could not load the work schedule: ${schedule.error}`} />
              ) : schedule ? (
                <StatCard label="Late / absent today" value={null} reason="Work schedule not configured" href="/settings/schedule" />
              ) : null}
            </StatGrid>
          </section>
          <section aria-labelledby="ov-queue" className="flex flex-col gap-3">
            <h2 id="ov-queue" className="text-lg font-semibold">Waiting for you and work in progress</h2>
            <StatGrid>
              <StatCard label="Pending leave requests" value={s.pendingLeaveCount} href="/leave" />
              <StatCard label="Pending corrections" value={s.pendingCorrectionCount} href="/corrections" />
              <StatCard label="Active projects" value={s.activeProjectCount} href="/projects" />
              <StatCard label="Open tasks" value={s.openTaskCount} hint="In active projects" href="/projects" />
            </StatGrid>
          </section>
        </>
      )}
    </div>
  );
}

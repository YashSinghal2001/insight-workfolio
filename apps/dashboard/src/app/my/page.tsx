"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  SCREENSHOT_MIME,
  attendanceTotals,
  formatDuration,
  todayIn,
  type ActivityStatusResponse,
  type CategorizedActivitySummary,
  type AttendanceCurrent,
  type LeaveRequest,
  type Paginated,
  type Project,
  type ScreenshotItem,
  type ScreenshotStatusResponse,
  type TimerState,
  type TimesheetResponse,
  type WebsiteUsageResponse,
} from "@workfolio/shared";
import { apiBlob } from "@/lib/api";
import { Card, Notice } from "@/components/ui";
import { EmptyState, PageHeader, StatCard } from "@/components/kit";
import { UpdatedAt, dayLabel, timeIn, useApi, useMe } from "@/components/my-ui";
import { CategoryTotals } from "./_components/categories";
import { DesktopDownloads } from "./_components/desktop-downloads";
import { LiveStatusLine } from "./_components/live-status";
import { Loaded } from "./_components/states";

const STATE_LABEL: Record<AttendanceCurrent["state"], string> = { CLOCKED_IN: "Clocked in", ON_BREAK: "On a break", CLOCKED_OUT: "Clocked out" };
const more = (href: string, label: string) => <Link href={href} className="text-sm text-brand hover:underline">{label}</Link>;

/** Personal overview: today's records only, read from the employee's own endpoints. No scores. */
export default function MyDashboard() {
  const me = useMe();
  const today = todayIn(me.timezone);
  const day = `from=${today}&to=${today}`;
  const current = useApi<AttendanceCurrent>("/attendance/current");
  const status = useApi<ActivityStatusResponse>("/activity/me");
  const sheet = useApi<TimesheetResponse>(`/attendance/timesheet?${day}`);
  const activity = useApi<CategorizedActivitySummary>(`/activity/summary?${day}`);
  const websites = useApi<WebsiteUsageResponse>(`/websites/me/usage?${day}`);
  const shots = useApi<ScreenshotStatusResponse>("/screenshots/me");
  const projects = useApi<Project[]>("/task-time/assignments");
  const timer = useApi<TimerState>("/task-time/current");
  const leave = useApi<Paginated<LeaveRequest>>("/leave?mine=true&status=PENDING&pageSize=100");

  return (
    <>
      <PageHeader
        title="My dashboard"
        description={`Welcome, ${me.fullName}. ${dayLabel(today)} (${me.timezone}). You clock in and out in the desktop app; records come from it and nothing here can change them.`}
        actions={current.load.state === "ready" ? <UpdatedAt at={current.load.at} /> : undefined}
      />

      <section aria-label="Status now" className="mb-4 flex flex-col gap-2">
        <Loaded load={status.load} reload={status.reload} label="your status" rows={1}>
          {(s) => <LiveStatusLine status={s} tz={me.timezone} />}
        </Loaded>
        {current.load.state === "ready" && current.load.data.missingClockOut && (
          <Notice tone="warning">
            Your shift from an earlier day is still open: it looks like you forgot to clock out. <Link href="/my/attendance#request-correction" className="underline">Request a correction</Link> to add the clock-out time.
          </Notice>
        )}
      </section>

      <section aria-label="Today" className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Loaded load={current.load} reload={current.reload} label="attendance">
          {(c) => {
            const open = c.session?.status === "OPEN" ? c.session : null;
            const t = open ? attendanceTotals({ start: open.clockInAt, end: null }, open.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt })), Date.parse(c.serverTime)) : null;
            return (
              <>
                <StatCard label="Attendance now" value={STATE_LABEL[c.state]} hint={open ? `Since ${timeIn(open.clockInAt, me.timezone)}` : undefined} />
                <StatCard label="Current shift (net of breaks)" value={t ? formatDuration(t.netMs) : null} reason="No open shift" hint={t ? `Breaks ${formatDuration(t.breakMs)}` : undefined} />
              </>
            );
          }}
        </Loaded>
        <Loaded load={sheet.load} label="today's timesheet">
          {(s) => {
            const d = s.days.find((x) => x.date === today);
            return (
              <>
                <StatCard label="Shifts today" value={d?.shifts ?? 0} hint={d ? `Completed shifts: ${formatDuration(d.netMs)} worked${d.incomplete ? "; one shift still open" : ""}` : "None recorded"} />
                <StatCard label="Breaks today (completed shifts)" value={formatDuration(d?.breakMs ?? 0)} hint="An open shift's breaks are in the current shift" />
              </>
            );
          }}
        </Loaded>
      </section>

      <DesktopDownloads />

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Application activity today" actions={more("/my/activity", "Details")}>
          <Loaded load={activity.load} reload={activity.reload} label="activity">
            {(a) =>
              a.activeMs + a.idleMs === 0 ? (
                <EmptyState title="No application activity recorded today." />
              ) : (
                <>
                  <p className="text-sm">Active {formatDuration(a.activeMs)} · Idle {formatDuration(a.idleMs)} · No record {formatDuration(a.unobservedMs)}</p>
                  <div className="mt-2"><CategoryTotals summary={a} compact /></div>
                  <ul aria-label="Top applications today" className="mt-2 text-sm">
                    {a.applications.slice(0, 5).map((x) => (
                      <li key={`${x.applicationIdentifier}-${x.applicationName}`} className="flex justify-between border-b border-border py-1">
                        <span>{x.applicationName}</span>
                        <span className="tabular-nums">{formatDuration(x.activeMs)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )
            }
          </Loaded>
        </Card>

        <Card title="Website activity today" actions={more("/my/websites", "Details")}>
          <Loaded load={websites.load} reload={websites.reload} label="website activity">
            {(w) =>
              w.byDomain.length === 0 ? (
                <EmptyState title="No website domains recorded today." />
              ) : (
                <ul aria-label="Top websites today" className="text-sm">
                  {w.byDomain.slice(0, 5).map((x) => (
                    <li key={x.domain} className="flex justify-between border-b border-border py-1">
                      <span>{x.domain}</span>
                      <span className="tabular-nums">{formatDuration(x.durationMs)}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </Loaded>
        </Card>

        <Card title="Projects and tasks" actions={more("/my/tasks", "My tasks")}>
          <Loaded load={timer.load} label="timer">
            {(t) => <p className="mb-2 text-sm">{t.running ? `Timer running: ${t.running.project.name} · ${t.running.task.title} since ${timeIn(t.running.startedAt, me.timezone)}` : "No timer running."}</p>}
          </Loaded>
          <Loaded load={projects.load} reload={projects.reload} label="projects">
            {(ps) =>
              ps.length === 0 ? (
                <EmptyState title="You are not assigned to any project." />
              ) : (
                <ul aria-label="My assigned projects" className="text-sm">
                  {ps.map((p) => (
                    <li key={p.id} className="flex justify-between border-b border-border py-1">
                      <span>{p.name}</span>
                      <span className="text-muted">{p.tasks.filter((t) => t.status === "OPEN").length} open of {p.tasks.length} tasks</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </Loaded>
        </Card>

        <Card title="Pending leave requests" actions={more("/my/leave", "My leave")}>
          <Loaded load={leave.load} reload={leave.reload} label="leave requests">
            {(l) => {
              const mine = l.items.slice(0, 5); // mine=true: the server returns only this profile's requests
              return mine.length === 0 ? (
                <EmptyState title="No pending leave requests." />
              ) : (
                <ul aria-label="My pending leave" className="text-sm">
                  {mine.map((r) => (
                    <li key={r.id} className="border-b border-border py-1">
                      {r.startDate === r.endDate ? dayLabel(r.startDate) : `${dayLabel(r.startDate)} – ${dayLabel(r.endDate)}`} · {r.portion.replace("_", " ").toLowerCase()}
                    </li>
                  ))}
                </ul>
              );
            }}
          </Loaded>
        </Card>

        <Card title="Recent screenshots" actions={more("/my/screenshots", "All screenshots")}>
          <Loaded load={shots.load} reload={shots.reload} label="screenshot settings">
            {(s) => (s.employeeSelfView ? <RecentShots timeZone={me.timezone} /> : <EmptyState title="Viewing your own screenshots is not enabled by your organization." />)}
          </Loaded>
        </Card>
      </div>
    </>
  );
}

/** Last few own screenshots (thumbnails through the authenticated API; each view is logged by the server). */
function RecentShots({ timeZone }: { timeZone: string }) {
  const list = useApi<{ items: ScreenshotItem[] }>("/screenshots?pageSize=4");
  return (
    <Loaded load={list.load} reload={list.reload} label="screenshots">
      {(l) =>
        l.items.length === 0 ? (
          <EmptyState title="No screenshots recorded." />
        ) : (
          <ul aria-label="Recent screenshots" className="grid grid-cols-2 gap-2">
            {l.items.map((s) => (
              <li key={s.id} className="text-xs text-muted">
                <Thumb id={s.id} available={s.uploadStatus === "STORED"} />
                {timeIn(s.capturedAt, timeZone)}
              </li>
            ))}
          </ul>
        )
      }
    </Loaded>
  );
}

function Thumb({ id, available }: { id: string; available: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!available) return;
    let url: string | null = null;
    let live = true;
    apiBlob(`/screenshots/${id}/content?variant=thumbnail`, SCREENSHOT_MIME).then(
      (b) => (live ? setSrc((url = URL.createObjectURL(b))) : undefined),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, available]);
  if (!available || failed) return <div className="flex aspect-video items-center justify-center rounded border border-border">Not available</div>;
  // eslint-disable-next-line @next/next/no-img-element -- short-lived blob URL from the authenticated API
  return src ? <img src={src} alt="Screenshot thumbnail" className="aspect-video w-full rounded border border-border object-cover" /> : <div className="aspect-video rounded border border-border" />;
}

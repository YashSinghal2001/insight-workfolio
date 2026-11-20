"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { SCREENSHOT_MIME, type OverviewResponse, type ScreenshotGalleryItem } from "@workfolio/shared";
import { BarChart, DonutChart, formatDurationMs, formatMinutes } from "@/components/charts";
import { DataTable, EmptyState, ErrorState, SkeletonRows, StatCard, StatusBadge, type DataColumn } from "@/components/kit";
import { apiBlob, errorMessage } from "@/lib/api";
import { appSlices, clock, dateRange, hhmm, longDay, kpiCards, REASON_LABEL, stateBadge, WORKLOAD_SERIES, workloadData } from "./overview-data";

/** One request feeds every widget; each still shows its own loading, error (with retry), hidden and empty state. */
export type OverviewLoad = { status: "loading" } | { status: "error"; message: string; retry: () => void } | { status: "ok"; data: OverviewResponse };

const link = "font-medium hover:underline focus-visible:underline";
const employeeLink = (e: { id: string; fullName: string }) => <Link href={`/employees/${e.id}`} className={link}>{e.fullName}</Link>;

export function Panel({ title, id, action, children, className = "" }: { title: string; id: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`flex min-w-0 flex-col rounded-lg border border-border bg-surface shadow-xs ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 id={id} className="font-medium">{title}</h2>
        {action}
      </div>
      <div className="min-w-0 p-3">{children}</div>
    </section>
  );
}

/** Loading / error / hidden (null: not for this role) / empty, then the content. */
function Body<T>({ load, select, label, empty, hidden = "Not available for your role.", children }: {
  load: OverviewLoad;
  select: (d: OverviewResponse) => T | null;
  label: string;
  empty: (v: T) => string | null;
  hidden?: ReactNode;
  children: (v: T) => ReactNode;
}) {
  if (load.status === "loading") return <SkeletonRows rows={3} label={label} />;
  if (load.status === "error") return <ErrorState title={`Could not load ${label}`} message={load.message} onRetry={load.retry} />;
  const v = select(load.data);
  if (v === null) return <p className="text-sm text-muted">{hidden}</p>;
  const e = empty(v);
  return e ? <p className="py-4 text-center text-sm text-muted">{e}</p> : <>{children(v)}</>;
}
const none = (text: string) => (v: unknown[]) => (v.length ? null : text);
const Count = ({ load, pick }: { load: OverviewLoad; pick: (d: OverviewResponse) => unknown[] | null }) =>
  load.status === "ok" && pick(load.data) ? <StatusBadge tone="neutral">{pick(load.data)!.length}</StatusBadge> : null;

export function KpiStrip({ load, isToday }: { load: OverviewLoad; isToday: boolean }) {
  if (load.status === "loading") return <SkeletonRows rows={2} label="key figures" />;
  if (load.status === "error") return <ErrorState title="Could not load the overview" message={load.message} onRetry={load.retry} />;
  if (load.data.kpis.totalMembers === 0) {
    return <EmptyState title="No employees here yet" hint="Nothing is shown until employees are enrolled (or the selected team has active members)." action={<Link href="/employees/new" className={link}>Add an employee</Link>} />;
  }
  return (
    <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      {kpiCards(load.data.kpis, isToday).map((c) => <StatCard key={c.label} {...c} />)}
    </div>
  );
}

export function WorkloadWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Workload, last 7 days" id="ov-workload">
      <Body load={load} label="workload" select={(d) => d.workload} empty={(w) => (w.days.some((d) => d.overworked + d.healthy + d.lessUtilised) ? null : "No completed work in these 7 days.")}>
        {(w) => (
          <>
            <BarChart label="Members per workload level, per day" series={WORKLOAD_SERIES} data={workloadData(w.days)} />
            <p className="mt-2 text-xs text-muted">
              Completed net work per member and day against the scheduled {formatMinutes(w.scheduledDailyMinutes)}: over {Math.round(w.thresholds.overworkedAbove * 100)} % is over worked, under{" "}
              {Math.round(w.thresholds.lessUtilisedBelow * 100)} % less utilised. Days without completed work are not counted.
            </p>
          </>
        )}
      </Body>
    </Panel>
  );
}

export function TopAppsWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Top apps" id="ov-apps" action={<Link href="/activity" className="text-xs text-muted hover:underline">Activity</Link>}>
      <Body load={load} label="top apps" select={(d) => d.topApps} empty={(t) => (t.totalActiveMs ? null : "No application activity recorded on this date.")}>
        {(t) => <DonutChart label="Active time per application" data={appSlices(t)} format={formatDurationMs} centerValue={formatDurationMs(t.totalActiveMs)} />}
      </Body>
    </Panel>
  );
}

export function LateWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Late clock-ins" id="ov-late" action={<Count load={load} pick={(d) => (d.kpis.late === null ? null : d.late)} />}>
      <Body load={load} label="late clock-ins" select={(d) => (d.kpis.late === null ? null : d.late)} hidden={NO_SCHEDULE} empty={none("Nobody clocked in late.")}>
        {(rows) => (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {rows.map((r) => (
              <li key={r.employee.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                {employeeLink(r.employee)}
                <span className="tabular-nums text-muted">in {hhmm(r.firstClockInLocal)} · <span className="text-danger">late by {formatMinutes(r.lateMinutes ?? 0)}</span></span>
              </li>
            ))}
          </ul>
        )}
      </Body>
    </Panel>
  );
}

export function AbsentWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Absent" id="ov-absent" action={<Count load={load} pick={(d) => (d.kpis.absent === null ? null : d.absent)} />}>
      <Body load={load} label="absences" select={(d) => (d.kpis.absent === null ? null : d.absent)} hidden={NO_SCHEDULE} empty={none("Nobody is absent.")}>
        {(rows) => (
          <ul className="flex flex-wrap gap-2 text-sm">
            {rows.map((r) => (
              <li key={r.employee.id}>
                <Link href={`/employees/${r.employee.id}`} className="inline-block rounded-full bg-danger-soft px-2.5 py-0.5 text-danger hover:underline">{r.employee.fullName}</Link>
              </li>
            ))}
          </ul>
        )}
      </Body>
    </Panel>
  );
}

/** Late/absent are null without an enabled schedule. */
const NO_SCHEDULE = <>Work schedule not configured: nobody is labelled late or absent. <Link href="/settings/schedule" className="underline">Set it up</Link></>;

export function MissingClockOutsWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Missing clock-outs" id="ov-missing" action={<Link href="/attendance" className="text-xs text-muted hover:underline">Attendance</Link>}>
      <Body load={load} label="missing clock-outs" select={(d) => d.missingClockOuts} empty={none("No open shift looks forgotten.")}>
        {(rows) => (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {rows.map((r) => (
              <li key={r.sessionId} className="flex flex-col gap-0.5 py-1.5">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  {employeeLink(r.employee)}
                  <span className="tabular-nums text-muted">since {r.clockInLocal.replace("T", " ")}</span>
                </span>
                <span className="text-xs text-danger">{r.reasons.map((x) => REASON_LABEL[x]).join(" · ")}</span>
              </li>
            ))}
          </ul>
        )}
      </Body>
    </Panel>
  );
}

/** One thumbnail through the authenticated content route (every load is access-logged by the API). */
function Thumb({ item }: { item: ScreenshotGalleryItem }) {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let url: string | undefined;
    let active = true;
    apiBlob(`/screenshots/${item.id}/content?variant=thumbnail`, SCREENSHOT_MIME).then(
      (blob) => {
        url = URL.createObjectURL(blob);
        if (active) setState({ url });
        else URL.revokeObjectURL(url);
      },
      (e) => active && setState({ error: errorMessage(e) }),
    );
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.id]);
  return (
    <li className="min-w-0">
      <Link href="/screenshots" className="block overflow-hidden rounded border border-border" aria-label={`Screenshot of ${item.employee.fullName} at ${clock(item.capturedAt, item.employee.timezone)}, open the gallery`}>
        <span className="flex aspect-video items-center justify-center bg-background text-xs text-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs only; next/image would proxy and cache the screenshot */}
          {state.url ? <img src={state.url} alt="" className="h-full w-full object-cover object-top" /> : state.error ? <span className="px-1 text-danger">{state.error}</span> : "Loading…"}
        </span>
      </Link>
      <p className="mt-1 truncate text-xs">{item.employee.fullName} <span className="text-muted tabular-nums">{clock(item.capturedAt, item.employee.timezone)}</span></p>
    </li>
  );
}

export function ScreenshotsWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Recent screenshots" id="ov-shots" action={<Link href="/screenshots" className="text-xs text-muted hover:underline">Gallery</Link>}>
      <Body load={load} label="recent screenshots" select={(d) => d.recentScreenshots} empty={none("No stored screenshots in the 7 days up to this date.")}>
        {(items) => <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{items.map((i) => <Thumb key={i.id} item={i} />)}</ul>}
      </Body>
    </Panel>
  );
}

type HoursRow = OverviewResponse["workHours"][number];
const HOURS_COLUMNS: DataColumn<HoursRow>[] = [
  { header: "Member", cell: (r) => employeeLink(r.employee), sortValue: (r) => r.employee.fullName.toLowerCase() },
  { header: "Worked", cell: (r) => <span className={`tabular-nums ${r.workedMinutes ? "text-success" : "text-muted"}`}>{formatMinutes(r.workedMinutes)}</span>, sortValue: (r) => r.workedMinutes },
  { header: "First in", cell: (r) => <span className="tabular-nums">{clock(r.firstClockInAt, r.employee.timezone)}</span>, sortValue: (r) => r.firstClockInAt },
  { header: "Status", cell: (r) => { const b = stateBadge(r.state, r.missingClockOut); return <StatusBadge tone={b.tone}>{b.label}</StatusBadge>; }, sortValue: (r) => stateBadge(r.state, r.missingClockOut).label },
  {
    header: "Device",
    cell: (r) => <span title={r.lastSeenAt ? `Last seen ${new Date(r.lastSeenAt).toLocaleString("en-GB")}` : "Never seen"}><StatusBadge tone={r.online ? "success" : "neutral"}>{r.online ? "Online" : "Offline"}</StatusBadge></span>,
    sortValue: (r) => r.lastSeenAt,
  },
];

export function WorkHoursWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Work hours" id="ov-hours" action={<Link href="/timesheets" className="text-xs text-muted hover:underline">Timesheets</Link>}>
      <Body load={load} label="work hours" select={(d) => d.workHours} empty={none("No members to show.")}>
        {(rows) => <DataTable label="Work hours" columns={HOURS_COLUMNS} rows={rows} rowKey={(r) => r.employee.id} minWidth={560} defaultSort={{ column: 1, direction: "desc" }} stickyHeader />}
      </Body>
    </Panel>
  );
}

export function HolidaysWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Upcoming holidays" id="ov-holidays" action={<Link href="/holidays" className="text-xs text-muted hover:underline">Holidays</Link>}>
      <Body load={load} label="holidays" select={(d) => d.upcomingHolidays} empty={none("No holidays in the next 30 days.")}>
        {(rows) => (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {rows.map((h) => <li key={h.id} className="flex justify-between gap-2 py-1.5"><span className="min-w-0 truncate">{h.name}</span><span className="shrink-0 tabular-nums text-muted">{longDay(h.date)}</span></li>)}
          </ul>
        )}
      </Body>
    </Panel>
  );
}

export function LeavesWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Upcoming leave" id="ov-leave" action={<Link href="/leave" className="text-xs text-muted hover:underline">Leave</Link>}>
      <Body load={load} label="upcoming leave" select={(d) => d.upcomingLeaves} empty={none("No one has approved leave in the next 14 days.")}>
        {(rows) => (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {rows.map((l) => (
              <li key={l.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                {employeeLink(l.employee)}
                <span className="text-muted">{dateRange(l.startDate, l.endDate)} · {l.leaveType}{l.portion !== "FULL_DAY" ? " (part day)" : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Body>
    </Panel>
  );
}

export function ApprovalsWidget({ load }: { load: OverviewLoad }) {
  return (
    <Panel title="Waiting for approval" id="ov-approvals">
      <Body load={load} label="pending approvals" select={(d) => d.pendingApprovals} empty={() => null}>
        {(p) => (
          <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
            <StatCard label="Pending leave requests" value={p.leave} href="/leave" tone={p.leave ? "warning" : undefined} />
            <StatCard label="Pending corrections" value={p.corrections} href="/corrections" tone={p.corrections ? "warning" : undefined} />
          </div>
        )}
      </Body>
    </Panel>
  );
}

"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatDuration, type ActivityOverviewResponse, type DailyAttendanceResponse, type Paginated, type TimesheetSummaryRow } from "@workfolio/shared";
import { EmptyState, ErrorState, PageHeader, SkeletonRows, StatusBadge, type Tone } from "@/components/kit";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { inputClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { todayLocal } from "@/lib/global-filters";
import { CHIPS, countByChip, describeMember, matches, NO_EXTRAS, STATE_META, type Chip, type MemberCard, type MemberExtras, type MemberRow } from "@/lib/live-team";

const REFRESH_MS = 30_000;
const PAGE = 100;

/** Every page of a paginated read (pageSize 100, the API maximum). */
async function all<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const get = (page: number) => api<Paginated<T>>(`${path}?${new URLSearchParams({ ...params, page: String(page), pageSize: String(PAGE) })}`);
  const first = await get(1);
  const rest = await Promise.all(Array.from({ length: Math.ceil(first.total / PAGE) - 1 }, (_, i) => get(i + 2)));
  return [first, ...rest].flatMap((p) => p.items);
}

interface Data {
  rows: MemberRow[];
  extras: Map<string, MemberExtras>;
  /** The optional reads that failed (cards still render without them). */
  missing: string[];
  at: number;
  teamId: string | null;
}

async function load(teamId: string | null): Promise<Data> {
  const team: Record<string, string> = teamId ? { teamId } : {};
  const today = todayLocal();
  const [rows, daily, timesheets, activity] = await Promise.all([
    all<MemberRow>("/attendance/overview", team),
    all<DailyAttendanceResponse["items"][number]>("/attendance/daily", { ...team, date: today }).catch(() => null),
    all<TimesheetSummaryRow>("/attendance/timesheets", { ...team, from: today, to: today }).catch(() => null),
    all<ActivityOverviewResponse["items"][number]>("/activity/overview", { from: today, to: today }).catch(() => null),
  ]);
  const extras = new Map<string, MemberExtras>();
  const get = (id: string) => extras.get(id) ?? extras.set(id, { ...NO_EXTRAS }).get(id)!;
  for (const d of daily ?? []) Object.assign(get(d.employee.id), { onLeave: d.status === "ON_LEAVE", scheduled: d.scheduled });
  for (const t of timesheets ?? []) get(t.employee.id).closed = { date: today, netMs: t.totals.netMs };
  // No observed time (activity off, no consent, no data): no percentage rather than 0 %.
  for (const a of activity ?? []) get(a.employee.id).activeShare = a.clockedInMs > 0 && a.activeMs + a.idleMs > 0 ? a.activeMs / a.clockedInMs : null;
  const missing = [daily ? null : "leave and schedule", timesheets ? null : "worked today", activity ? null : "active time"].filter((x): x is string => !!x);
  return { rows, extras, missing, at: Date.now(), teamId };
}

export default function LiveTeamPage() {
  return (
    <Suspense fallback={<SkeletonRows label="live team" />}>
      <LiveTeam />
    </Suspense>
  );
}

const CHIP_LABEL: Record<Chip, string> = { ALL: "All", ...Object.fromEntries(Object.entries(STATE_META).map(([k, v]) => [k, v.label])) } as Record<Chip, string>;
const EMPTY: Record<Chip, string> = {
  ALL: "No employees in this view.",
  WORKING: "Nobody is working right now.",
  ON_BREAK: "Nobody is on a break.",
  STOPPED: "Nobody has stopped work today.",
  ON_LEAVE: "Nobody is on approved leave today.",
  APP_NOT_INSTALLED: "Everyone has the desktop app installed.",
  NOT_STARTED: "Everyone has started work today.",
  OFFLINE: "No clocked-in employee is out of contact.",
};

function LiveTeam() {
  const { teamId } = useGlobalFilters();
  const [loaded, setData] = useState<Data | null>(null);
  // Another team's cards are never shown while the new team loads.
  const data = loaded?.teamId === teamId ? loaded : null;
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [chip, setChip] = useState<Chip>("ALL");
  const [q, setQ] = useState("");

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = () =>
      load(teamId).then(
        (d) => active && (setData(d), setError(null)),
        (e) => active && setError(errorMessage(e)),
      );
    // Refresh every 30 s while the tab is visible; catch up as soon as it is shown again.
    const sync = () => {
      clearInterval(timer);
      if (document.visibilityState === "hidden") return;
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [teamId, retry]);

  const members = useMemo(
    () => (data?.rows ?? []).map((row) => ({ row, card: describeMember(row, data!.extras.get(row.employeeId) ?? NO_EXTRAS, data!.at) })),
    [data],
  );
  const counts = countByChip(members.map((m) => m.card.state));
  const shown = members.filter((m) => matches({ ...m.row, state: m.card.state }, chip, q));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <GlobalFilters date={false} />
      <PageHeader
        title="Live team"
        description="One card per employee, refreshed every 30 seconds."
        about="Status comes from attendance (clock-in, breaks, clock-out) and the last contact from each employee's desktop app. A clocked-in employee whose app has not been in contact for 30 minutes is shown as Offline, never as Working. Times are in each employee's own time zone. Active time is the share of clocked-in time the desktop app observed as active, shown only where activity monitoring is on and acknowledged."
      />
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="live team" />}
      {data && (
        <>
          <div className="flex flex-col gap-3">
            <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
              {CHIPS.filter((c) => c !== "OFFLINE" || counts.OFFLINE > 0).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={chip === c}
                  onClick={() => setChip(c)}
                  className={`rounded-full border px-3 py-1 text-sm font-medium focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none ${
                    chip === c ? "border-brand bg-brand text-white" : "border-border bg-surface hover:bg-surface-muted"
                  }`}
                >
                  {CHIP_LABEL[c]} <span className="tabular-nums">{counts[c]}</span>
                </button>
              ))}
            </div>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or employee code"
              aria-label="Search team members"
              maxLength={100}
              className={`${inputClass} sm:max-w-xs`}
            />
            {data.missing.length > 0 && <p className="text-xs text-muted">Not available right now: {data.missing.join(", ")}.</p>}
          </div>
          {shown.length === 0 ? (
            <EmptyState title={q ? "Nobody matches your search." : EMPTY[chip]} />
          ) : (
            <ul aria-label="Team members" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {shown.map((m) => <MemberCardView key={m.row.employeeId} row={m.row} m={m.card} />)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

const TINT: Record<Tone, string> = {
  success: "border-success/40 bg-success-soft",
  warning: "border-warning/40 bg-warning-soft",
  danger: "border-danger/40 bg-danger-soft",
  info: "border-info/40 bg-info-soft",
  neutral: "border-border bg-surface",
};

function MemberCardView({ row, m }: { row: MemberRow; m: MemberCard }) {
  const meta = STATE_META[m.state];
  const pct = m.scheduledMs && m.workedMs !== null ? Math.min(100, Math.round((m.workedMs / m.scheduledMs) * 100)) : null;
  return (
    <li className="min-w-0">
      <Link
        href={`/employees/${row.employeeId}`}
        className={`flex h-full flex-col gap-3 rounded-lg border p-4 shadow-xs hover:border-border-strong focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none ${TINT[meta.tone]}`}
      >
        <div className="flex items-start gap-3">
          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted font-semibold">
            {row.fullName.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{row.fullName}</div>
            <div className="truncate font-mono text-xs text-muted">{row.employeeCode}</div>
          </div>
          <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
        </div>
        <div className="text-sm">
          <div>{m.statusLine}</div>
          <div className="text-xs text-muted">{m.presence}</div>
          {m.missingClockOut && <div className="mt-1"><StatusBadge tone="danger">Clock-out missing from an earlier day</StatusBadge></div>}
        </div>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div><dt className="text-muted">Clock-in</dt><dd className="tabular-nums">{m.clockIn ?? "—"}</dd></div>
          <div><dt className="text-muted">Worked today</dt><dd className="tabular-nums">{m.workedMs === null ? "—" : formatDuration(m.workedMs)}</dd></div>
          <div><dt className="text-muted">Active</dt><dd className="tabular-nums">{m.activeShare === null ? "—" : `${Math.round(m.activeShare * 100)} %`}</dd></div>
        </dl>
        {pct !== null && (
          <div
            role="progressbar"
            aria-label={`Worked today against the ${formatDuration(m.scheduledMs!)} schedule`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-1.5 overflow-hidden rounded-full bg-surface-muted"
          >
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
        )}
      </Link>
    </li>
  );
}

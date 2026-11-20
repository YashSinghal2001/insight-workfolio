"use client";

import { Suspense, useEffect, useState } from "react";
import type { TeamTimelineResponse } from "@workfolio/shared";
import { GANTT_COLORS, GANTT_TYPES, Legend } from "@/components/charts";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/kit";
import { secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { groupByZone, TIMELINE_LABELS } from "@/lib/timeline";
import { TimelineGroup } from "./timeline-rows";

const PAGE_SIZE = 50;

export default function TimelinePage() {
  return (
    <Suspense fallback={<SkeletonRows label="timeline" />}>
      <Timeline />
    </Suspense>
  );
}

function Timeline() {
  const { date, teamId } = useGlobalFilters();
  // The page number belongs to one date + team; another filter starts at page 1.
  const filter = `${date}|${teamId ?? ""}`;
  const [paging, setPaging] = useState({ filter, page: 1 });
  const page = paging.filter === filter ? paging.page : 1;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; data?: TeamTimelineResponse; error?: string } | null>(null);
  const key = `${filter}|${page}|${retry}`;
  // Another day's or team's rows are never shown while the new ones load.
  const current = state?.key === key ? state : null;

  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ date, page: String(page), pageSize: String(PAGE_SIZE), ...(teamId ? { teamId } : {}) });
    api<TeamTimelineResponse>(`/activity/team-timeline?${q}`).then(
      (data) => live && setState({ key, data }),
      (e) => live && setState({ key, error: errorMessage(e) }),
    );
    return () => void (live = false);
  }, [date, teamId, page, key]);

  const data = current?.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <GlobalFilters />
      <PageHeader
        title="Timeline"
        description={`Each employee's day (${date}) from attendance and desktop activity.`}
        about={
          <>
            One bar per employee for the chosen date, read in each employee&apos;s own time zone (hour marks are in that zone, named
            above each group). Not clocked in, breaks, idle time (no keyboard or mouse input for the idle threshold) and application time
            coloured by the labels in Settings › App labels; applications without a label count as Neutral. A blank stretch is clocked-in
            time with no activity data (monitoring off, not acknowledged, or not synced yet). Hover a segment for its times and
            application; select a row to open the employee. Viewing this page is recorded in the audit log for each employee shown.
          </>
        }
      />
      <Legend label="Timeline legend" items={[...GANTT_TYPES.map((t) => ({ label: TIMELINE_LABELS[t], color: GANTT_COLORS[t] })), { label: "Blank: clocked in without activity data, or not yet", color: "var(--surface-muted)" }]} />

      {current?.error && <ErrorState message={current.error} onRetry={() => setRetry((n) => n + 1)} />}
      {!current && <SkeletonRows label="timeline" rows={6} />}
      {data &&
        (data.items.length === 0 ? (
          <EmptyState title="No employees in this view." hint={teamId ? "This team has no active members." : undefined} />
        ) : (
          <section aria-label="Employee timelines" className="overflow-x-auto rounded-lg border border-border bg-surface p-3">
            <div className="flex flex-col gap-5">
              {groupByZone(data.items).map((g) => <TimelineGroup key={g.zone} zone={g.zone} rows={g.rows} />)}
            </div>
          </section>
        ))}
      {data && data.total > data.pageSize && (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPaging({ filter, page: page - 1 })} className={secondaryButtonClass}>Previous</button>
          <span className="tabular-nums text-muted">Page {page} of {pages} · {data.total} employees</span>
          <button type="button" disabled={page >= pages} onClick={() => setPaging({ filter, page: page + 1 })} className={secondaryButtonClass}>Next</button>
        </div>
      )}
    </div>
  );
}

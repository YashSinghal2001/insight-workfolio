"use client";

import { useEffect, useState } from "react";
import { formatDurationShort, type AttendanceTimelineResponse, type AttendanceTimelineType } from "@workfolio/shared";
import { DataTable, EmptyState, ErrorState, Pagination, SkeletonRows, StatusBadge, type Tone } from "@/components/kit";
import { Card, inputClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 100;
const TYPE: Record<AttendanceTimelineType, { label: string; tone: Tone }> = {
  CLOCK_IN: { label: "Clock-in", tone: "success" },
  CLOCK_OUT: { label: "Clock-out", tone: "neutral" },
  BREAK: { label: "Break", tone: "info" },
  ACTIVE: { label: "Active", tone: "success" },
  IDLE: { label: "Idle", tone: "warning" },
};
const clock = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "medium", timeZone }).format(new Date(iso));

/**
 * One employee's local day as stored (GET /attendance/timeline): clock-in, clock-out, breaks, active and
 * idle periods in the server's order. Rows are records; gaps between them are not filled or estimated.
 * Without a chosen date the server uses the employee's own today.
 */
export function DayTimeline({ employeeId }: { employeeId: string }) {
  const [query, setQuery] = useState({ date: "", page: 1 });
  const [data, setData] = useState<AttendanceTimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ employeeId, page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (query.date) params.set("date", query.date);
    api<AttendanceTimelineResponse>(`/attendance/timeline?${params}`).then(
      (r) => live && (setData(r), setError(null)),
      (e) => live && (setData(null), setError(errorMessage(e))),
    );
    return () => {
      live = false;
    };
  }, [employeeId, query, retry]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const tz = data?.timezone;

  return (
    <Card title="Day timeline">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted">Day</span>
            <input
              type="date"
              aria-label="Timeline day"
              value={query.date || data?.date || ""}
              onChange={(e) => e.target.value && (setData(null), setQuery({ date: e.target.value, page: 1 }))}
              className={inputClass}
            />
          </label>
          <p className="text-xs text-muted">
            {tz ? <>Times and the day are in the employee&apos;s time zone, <strong>{tz}</strong>. </> : null}
            Stored records only, in order; time with no record is not filled in.
          </p>
        </div>
        {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
        {!data && !error && <SkeletonRows label="day timeline" />}
        {data && data.items.length === 0 && <EmptyState title={`Nothing recorded for ${data.employee.fullName} on ${data.date}.`} />}
        {data && tz && data.items.length > 0 && (
          <DataTable label="Day timeline" head={["From", "To", "Duration", "Event", "Application"]} minWidth={640}>
            {data.items.map((i) => {
              const instant = i.type === "CLOCK_IN" || i.type === "CLOCK_OUT";
              return (
                <tr key={i.id}>
                  <td className="tabular-nums whitespace-nowrap">{clock(i.at, tz)}</td>
                  <td className="tabular-nums whitespace-nowrap">{i.endAt ? clock(i.endAt, tz) : instant ? "—" : <span className="text-muted">ongoing</span>}</td>
                  <td className="tabular-nums">{i.endAt ? formatDurationShort(Date.parse(i.endAt) - Date.parse(i.at)) : "—"}</td>
                  <td><StatusBadge tone={TYPE[i.type].tone}>{TYPE[i.type].label}</StatusBadge></td>
                  <td>{i.applicationName ?? <span className="text-muted">—</span>}</td>
                </tr>
              );
            })}
          </DataTable>
        )}
        {data && pages > 1 && <Pagination label="Day timeline pages" page={query.page} pageCount={pages} onPage={(page) => setQuery((q) => ({ ...q, page }))} />}
      </div>
    </Card>
  );
}

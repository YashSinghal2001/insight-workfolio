"use client";

import { useEffect, useState } from "react";
import { addDays, toZonedLocal, type AttendanceSession, type ExpectedScheduleResponse, type ExpectedWorkDay, type Paginated } from "@workfolio/shared";
import { api } from "@/lib/api";

type Seg = { date: string; from: number; to: number };
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** [start, end) split into per-local-day segments, in minutes of each day (0–1440). */
function daySegments(start: string, end: string, tz: string): Seg[] {
  const [s, e] = [toZonedLocal(start, tz), toZonedLocal(end, tz)];
  const out: Seg[] = [];
  for (let d = s.slice(0, 10); d <= e.slice(0, 10); d = addDays(d, 1)) {
    const from = d === s.slice(0, 10) ? minutes(s.slice(11)) : 0;
    const to = d === e.slice(0, 10) ? minutes(e.slice(11)) : 1440;
    if (to > from) out.push({ date: d, from, to });
  }
  return out;
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const bar = (seg: Seg, cls: string, title: string) => (
  <span key={`${title}-${seg.from}`} title={title} className={`absolute inset-y-0 ${cls}`} style={{ left: `${(seg.from / 1440) * 100}%`, width: `${((seg.to - seg.from) / 1440) * 100}%` }} />
);

/**
 * W24: clocked-in time with breaks overlaid, one 24-hour bar per local day, next to the activity
 * timeline, plus the expected start (and grace period) from the employee's effective schedule. The
 * schedule has no end time, so only the start is marked; non-workdays and holidays have none.
 * Reads the attendance history and schedule (their own permission checks); shows nothing if not allowed.
 * ponytail: first 100 shifts of the range (history page cap); enough for the 31-day activity range.
 */
export function BreaksOverlay({ employeeId, from, to, tz }: { employeeId?: string; from: string; to: string; tz: string }) {
  const [sessions, setSessions] = useState<AttendanceSession[] | null>(null);
  const [expected, setExpected] = useState<ExpectedWorkDay[]>([]);
  useEffect(() => {
    let active = true;
    const who = employeeId ? `&employeeId=${employeeId}` : "";
    api<Paginated<AttendanceSession>>(`/attendance/history?from=${from}&to=${to}&pageSize=100${who}`).then(
      (p) => active && setSessions(p.items),
      () => active && setSessions(null),
    );
    api<ExpectedScheduleResponse>(`/attendance/expected?from=${from}&to=${to}${who}`).then(
      (r) => active && setExpected(r.days),
      () => active && setExpected([]),
    );
    return () => {
      active = false;
    };
  }, [employeeId, from, to]);
  if (!sessions?.length && !expected.length) return null;

  const now = new Date().toISOString();
  type Day = { worked: Seg[]; breaks: Seg[]; expected: Seg[] };
  const days = new Map<string, Day>();
  const add = (kind: keyof Day, segs: Seg[]) =>
    segs.filter((g) => g.date >= from && g.date <= to).forEach((g) => (days.get(g.date) ?? days.set(g.date, { worked: [], breaks: [], expected: [] }).get(g.date)!)[kind].push(g));
  for (const s of sessions ?? []) {
    add("worked", daySegments(s.clockInAt, s.clockOutAt ?? now, tz));
    for (const b of s.breaks) add("breaks", daySegments(b.startedAt, b.endedAt ?? s.clockOutAt ?? now, tz));
  }
  // Start marker widened to the grace period (start → late); at least a visible sliver when grace is 0.
  for (const e of expected) add("expected", daySegments(e.startAt, e.dueAt > e.startAt ? e.dueAt : new Date(Date.parse(e.startAt) + 60_000).toISOString(), tz).slice(0, 1));
  const rows = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="mb-4 flex flex-col gap-2 text-xs">
      <p className="text-muted">
        Clocked-in time <span className="inline-block h-2 w-3 rounded-sm bg-brand/40 align-middle" /> and breaks{" "}
        <span className="inline-block h-2 w-3 rounded-sm bg-amber-500 align-middle" /> per day (00:00–24:00, {tz}); expected start{" "}
        <span className="inline-block h-2 w-1 bg-emerald-600 align-middle" /> from the work schedule.
      </p>
      {rows.map(([date, d]) => (
        <div key={date} className="grid grid-cols-[6rem_1fr] items-center gap-2">
          <span className="tabular-nums text-muted">{date}</span>
          <div>
            <div className="relative h-3 overflow-hidden rounded bg-border/40" aria-hidden="true">
              {d.worked.map((g) => bar(g, "bg-brand/40", `Clocked in ${hhmm(g.from)}–${hhmm(g.to)}`))}
              {d.breaks.map((g) => bar(g, "bg-amber-500", `Break ${hhmm(g.from)}–${hhmm(g.to)}`))}
              {d.expected.map((g) => bar(g, "border-l-2 border-emerald-600 bg-emerald-600/30", `Expected start ${hhmm(g.from)} (shaded: grace period)`))}
            </div>
            <p className="mt-0.5 tabular-nums text-muted">
              {d.breaks.length ? `Breaks: ${d.breaks.map((g) => `${hhmm(g.from)}–${hhmm(g.to)}`).join(", ")}` : "No breaks"}
              {d.expected.map((g) => <span key={g.from} data-testid="expected-start">{` · Expected start ${hhmm(g.from)}`}</span>)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

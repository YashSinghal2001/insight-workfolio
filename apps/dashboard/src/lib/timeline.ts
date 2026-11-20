import type { TeamTimelineRow, TimelineSegment, TimelineSegmentType } from "@workfolio/shared";
import { formatDurationMs } from "./charts";

/** Legend and tooltip names (UNTRACKED is time not clocked in). */
export const TIMELINE_LABELS: Record<TimelineSegmentType, string> = {
  PRODUCTIVE: "Productive",
  UNPRODUCTIVE: "Unproductive",
  NEUTRAL: "Neutral",
  IDLE: "Idle",
  BREAK: "Break",
  UNTRACKED: "Not clocked in",
};
const ORDER: TimelineSegmentType[] = ["PRODUCTIVE", "UNPRODUCTIVE", "NEUTRAL", "IDLE", "BREAK"];

/** Rows grouped by the employee's zone (hour ticks are per zone), groups and rows in their original order. */
export function groupByZone(rows: TeamTimelineRow[]): { zone: string; rows: TeamTimelineRow[] }[] {
  const groups = new Map<string, TeamTimelineRow[]>();
  for (const r of rows) groups.set(r.employee.timezone, [...(groups.get(r.employee.timezone) ?? []), r]);
  return [...groups].map(([zone, list]) => ({ zone, rows: list }));
}

/** Milliseconds per segment type. */
export function segmentTotals(segments: TimelineSegment[]): Record<TimelineSegmentType, number> {
  const t = { PRODUCTIVE: 0, UNPRODUCTIVE: 0, NEUTRAL: 0, IDLE: 0, BREAK: 0, UNTRACKED: 0 };
  for (const s of segments) t[s.type] += Math.max(0, Date.parse(s.end) - Date.parse(s.start));
  return t;
}

/** Text summary of a day (the bar's colours are never the only signal). Not-clocked-in time is left out. */
export function rowSummary(segments: TimelineSegment[]): string {
  const t = segmentTotals(segments);
  const parts = ORDER.filter((k) => t[k] > 0).map((k) => `${TIMELINE_LABELS[k]} ${formatDurationMs(t[k])}`);
  return parts.length ? parts.join(" · ") : segments.length ? "Not clocked in" : "No data";
}

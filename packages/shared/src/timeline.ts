import { z } from "zod";
import type { ApplicationCategory } from "./activity.js";
import type { EmployeeRef, Paginated } from "./api.js";

// ---- GET /activity/team-timeline (W3-TIMELINE) -------------------------------------------

/** One local date (read in each employee's own zone) and an optional team. */
export const teamTimelineQuerySchema = z.strictObject({
  date: z.iso.date(),
  teamId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type TeamTimelineQuery = z.infer<typeof teamTimelineQuerySchema>;

export const TIMELINE_SEGMENT_TYPES = ["PRODUCTIVE", "UNPRODUCTIVE", "NEUTRAL", "IDLE", "BREAK", "UNTRACKED"] as const;
export type TimelineSegmentType = (typeof TIMELINE_SEGMENT_TYPES)[number];

/** UTC instants. `label`: the application name for app time, null otherwise. */
export interface TimelineSegment {
  type: TimelineSegmentType;
  start: string;
  end: string;
  label: string | null;
}

export interface TeamTimelineRow {
  employee: EmployeeRef;
  /** The employee's local day [00:00, next 00:00) as UTC instants. */
  dayStart: string;
  dayEnd: string;
  /** Chronological, non-overlapping. Clocked-in time without activity data has no segment. Nothing after `now`. */
  segments: TimelineSegment[];
}

export interface TeamTimelineResponse extends Paginated<TeamTimelineRow> {
  date: string;
  generatedAt: string;
}

// ---- Segment building (pure) ----------------------------------------------------------

type Span = [number, number];

export interface TimelineInput {
  dayStart: number;
  dayEnd: number;
  now: number;
  /** ISO instants; an open session or break runs to `now`. */
  sessions: { clockInAt: string; clockOutAt: string | null; breaks: { startedAt: string; endedAt: string | null }[] }[];
  /** Activity intervals with their label (null for IDLE). */
  intervals: { kind: "ACTIVE" | "IDLE"; startedAt: string; endedAt: string; category: ApplicationCategory | null; applicationName: string | null }[];
}

const clipTo = (spans: Span[], [a, b]: Span): Span[] => spans.map(([s, e]): Span => [Math.max(s, a), Math.min(e, b)]).filter(([s, e]) => e > s);
const intersect = (a: Span[], b: Span[]): Span[] => a.flatMap((x) => clipTo(b, x));
function subtract(a: Span[], b: Span[]): Span[] {
  let out = a;
  for (const [bs, be] of b) out = out.flatMap(([s, e]): Span[] => (be <= s || bs >= e ? [[s, e]] : ([[s, bs], [be, e]] as Span[]).filter(([x, y]) => y > x)));
  return out;
}

/**
 * The day's Gantt segments: not clocked in → UNTRACKED; break → BREAK; activity inside clocked-in, non-break time →
 * IDLE or its application label (UNCLASSIFIED → NEUTRAL, labelled "unlabelled"). Clocked in without activity data →
 * no segment. Cut at `now`; touching segments of the same type and label are merged.
 */
export function buildTimelineSegments({ dayStart, dayEnd, now, sessions, intervals }: TimelineInput): TimelineSegment[] {
  const window: Span = [dayStart, Math.min(dayEnd, now)];
  if (!(window[1] > window[0])) return [];
  const end = (iso: string | null) => (iso ? Date.parse(iso) : now);
  const clocked = clipTo(sessions.map((s): Span => [Date.parse(s.clockInAt), end(s.clockOutAt)]), window);
  const breaks = intersect(
    clipTo(sessions.flatMap((s) => s.breaks.map((b): Span => [Date.parse(b.startedAt), end(b.endedAt)])), window),
    clocked,
  );
  const work = subtract(clocked, breaks);
  const out: { type: TimelineSegmentType; start: number; end: number; label: string | null }[] = [
    ...subtract([window], clocked).map(([start, e]) => ({ type: "UNTRACKED" as const, start, end: e, label: null })),
    ...breaks.map(([start, e]) => ({ type: "BREAK" as const, start, end: e, label: null })),
  ];
  for (const i of intervals) {
    const type: TimelineSegmentType = i.kind === "IDLE" ? "IDLE" : i.category === "PRODUCTIVE" || i.category === "UNPRODUCTIVE" ? i.category : "NEUTRAL";
    const label = i.kind === "IDLE" ? null : `${i.applicationName ?? "Unknown app"}${i.category === "UNCLASSIFIED" || i.category === null ? " · unlabelled" : ""}`;
    for (const [start, e] of clipTo(work, [Date.parse(i.startedAt), Date.parse(i.endedAt)])) out.push({ type, start, end: e, label });
  }
  out.sort((a, b) => a.start - b.start);
  const merged: typeof out = [];
  for (const s of out) {
    const prev = merged.at(-1);
    if (prev && prev.end === s.start && prev.type === s.type && prev.label === s.label) prev.end = s.end;
    else merged.push({ ...s });
  }
  return merged.map((s) => ({ type: s.type, start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), label: s.label }));
}

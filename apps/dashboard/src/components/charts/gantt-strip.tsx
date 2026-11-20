import { clockFormat, formatDurationMs, hourTicks, layoutGantt, toMs, truncate, type GanttInput, type TimeInput } from "@/lib/charts";
import { ChartEmpty, DEFAULT_EMPTY, SrTable } from "./frame";
import { Legend } from "./legend";

export const GANTT_TYPES = ["PRODUCTIVE", "UNPRODUCTIVE", "NEUTRAL", "IDLE", "BREAK", "UNTRACKED"] as const;
export type GanttType = (typeof GANTT_TYPES)[number];

/** Semantic defaults (contract §6: amber = break, grey = idle/offline). */
export const GANTT_COLORS: Record<GanttType, string> = {
  PRODUCTIVE: "var(--success)",
  UNPRODUCTIVE: "var(--danger)",
  NEUTRAL: "var(--info)",
  IDLE: "var(--muted)",
  BREAK: "var(--warning)",
  UNTRACKED: "var(--border-strong)",
};
export const GANTT_LABELS: Record<GanttType, string> = {
  PRODUCTIVE: "Productive",
  UNPRODUCTIVE: "Unproductive",
  NEUTRAL: "Neutral",
  IDLE: "Idle",
  BREAK: "Break",
  UNTRACKED: "Untracked",
};

export interface GanttRow {
  label: string;
  segments: GanttInput<GanttType>[];
}
export interface GanttStripProps {
  label: string;
  rows: GanttRow[];
  /** Window shown (ISO string, epoch ms or Date). Segments are clipped to it. */
  start: TimeInput;
  end: TimeInput;
  /** IANA zone for hour ticks and times (default UTC). */
  timeZone?: string;
  colors?: Partial<Record<GanttType, string>>;
  typeLabels?: Partial<Record<GanttType, string>>;
  empty?: string;
}

const edge = (pct: number) => (pct < 4 ? "translateX(0)" : pct > 96 ? "translateX(-100%)" : "translateX(-50%)");

/**
 * Rows of typed time segments over [start,end] (Timeline page). Segments are clipped, de-overlapped and merged
 * by `layoutGantt` (deterministic); hour ticks are whole local hours in `timeZone`. Each segment has a
 * `<title>` tooltip; a hidden table lists every segment. Props as `GanttStripProps`.
 */
export function GanttStrip({ label, rows, start, end, timeZone = "UTC", colors, typeLabels, empty = DEFAULT_EMPTY }: GanttStripProps) {
  const w0 = toMs(start);
  const w1 = toMs(end);
  const laid = rows.map((r) => ({ label: r.label, segments: layoutGantt(r.segments, w0, w1) }));
  if (!(w1 > w0) || laid.every((r) => r.segments.length === 0)) return <ChartEmpty label={label} message={empty} />;

  const color = (t: GanttType) => colors?.[t] ?? GANTT_COLORS[t];
  const name = (t: GanttType) => typeLabels?.[t] ?? GANTT_LABELS[t];
  const clock = clockFormat(timeZone);
  const at = (ms: number) => clock.format(ms);
  const pct = (ms: number) => ((ms - w0) / (w1 - w0)) * 100;
  const ticks = hourTicks(w0, w1, timeZone);
  const present = GANTT_TYPES.filter((t) => laid.some((r) => r.segments.some((s) => s.type === t)));
  const totals = present.map((t) => `${name(t)} ${formatDurationMs(laid.reduce((a, r) => a + r.segments.filter((s) => s.type === t).reduce((b, s) => b + s.end - s.start, 0), 0))}`);
  const summary = `${label}: timeline of ${laid.length} ${laid.length === 1 ? "row" : "rows"}, ${at(w0)}–${at(w1)} (${timeZone}); ${totals.join(", ")}.`;
  const tip = (s: { type: GanttType; start: number; end: number; label?: string }) =>
    `${name(s.type)} ${at(s.start)}–${at(s.end)} (${formatDurationMs(s.end - s.start)})${s.label ? ` · ${s.label}` : ""}`;

  return (
    <figure className="flex flex-col gap-2">
      <div role="img" aria-label={summary} className="grid grid-cols-[minmax(0,8rem)_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
        <span />
        <div className="relative h-4 text-muted">
          {ticks.map((t) => (
            <span key={t.at} className="absolute top-0 tabular-nums" style={{ left: `${pct(t.at)}%`, transform: edge(pct(t.at)) }}>{t.label}</span>
          ))}
        </div>
        {laid.map((r, ri) => {
          const short = truncate(r.label, 24);
          return [
            <span key={`l${ri}`} className="truncate text-muted" title={short === r.label ? undefined : r.label}>{short}</span>,
            <svg key={`s${ri}`} viewBox="0 0 1000 10" preserveAspectRatio="none" width="100%" className="block h-4">
              <rect width={1000} height={10} fill="var(--surface-muted)" />
              {ticks.map((t) => (
                <line key={t.at} x1={pct(t.at) * 10} x2={pct(t.at) * 10} y1={0} y2={10} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              ))}
              {r.segments.map((s, si) => (
                <rect key={si} data-segment={s.type} x={pct(s.start) * 10} width={(pct(s.end) - pct(s.start)) * 10} height={10} fill={color(s.type)}>
                  <title>{`${r.label}: ${tip(s)}`}</title>
                </rect>
              ))}
            </svg>,
          ];
        })}
      </div>
      <Legend items={present.map((t) => ({ label: name(t), color: color(t) }))} label={`${label} legend`} />
      <SrTable
        caption={`${label} (${timeZone})`}
        head={["Row", "Type", "From", "To", "Duration", "Detail"]}
        rows={laid.flatMap((r) => r.segments.map((s) => [r.label, name(s.type), at(s.start), at(s.end), formatDurationMs(s.end - s.start), s.label ?? ""]))}
      />
    </figure>
  );
}

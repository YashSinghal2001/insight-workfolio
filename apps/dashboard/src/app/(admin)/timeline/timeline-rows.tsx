import Link from "next/link";
import type { TeamTimelineRow } from "@workfolio/shared";
import { GANTT_COLORS } from "@/components/charts";
import { clockFormat, formatDurationMs, hourTicks, truncate } from "@/lib/charts";
import { rowSummary, TIMELINE_LABELS } from "@/lib/timeline";

const edge = (pct: number) => (pct < 4 ? "translateX(0)" : pct > 96 ? "translateX(-100%)" : "translateX(-50%)");

/**
 * One zone's employees as Gantt rows over their local day (all rows of a zone share the day's bounds), hour ticks in
 * that zone. Each row links to the employee's profile and carries a text summary; segments have tooltips.
 * Same visual language as GanttStrip (colours), which has no per-row links.
 */
export function TimelineGroup({ zone, rows }: { zone: string; rows: TeamTimelineRow[] }) {
  const w0 = Date.parse(rows[0]!.dayStart);
  const w1 = Date.parse(rows[0]!.dayEnd);
  const pct = (ms: number) => ((ms - w0) / (w1 - w0)) * 100;
  const ticks = hourTicks(w0, w1, zone);
  const clock = clockFormat(zone);
  return (
    <section aria-label={`Employees in ${zone}`} className="flex min-w-[36rem] flex-col gap-1.5">
      <div className="grid grid-cols-[minmax(0,11rem)_1fr] items-end gap-x-3 text-xs">
        <span className="font-medium text-muted">{zone}</span>
        <div className="relative h-4 text-muted" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t.at} className="absolute top-0 tabular-nums" style={{ left: `${pct(t.at)}%`, transform: edge(pct(t.at)) }}>{t.label}</span>
          ))}
        </div>
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => {
          const summary = rowSummary(r.segments);
          return (
            <li key={r.employee.id}>
              <Link
                href={`/employees/${r.employee.id}`}
                aria-label={`${r.employee.fullName} (${r.employee.employeeCode}): ${summary}. Open profile`}
                className="grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-x-3 rounded-md px-1 py-1 text-xs hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground" title={r.employee.fullName}>{truncate(r.employee.fullName, 28)}</span>
                  <span className="truncate text-muted">{r.employee.employeeCode}</span>
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <svg viewBox="0 0 1000 10" preserveAspectRatio="none" width="100%" className="block h-4" aria-hidden="true">
                    <rect width={1000} height={10} fill="var(--surface-muted)" />
                    {ticks.map((t) => (
                      <line key={t.at} x1={pct(t.at) * 10} x2={pct(t.at) * 10} y1={0} y2={10} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    ))}
                    {r.segments.map((s, i) => {
                      const a = Date.parse(s.start);
                      const b = Date.parse(s.end);
                      return (
                        <rect key={i} data-segment={s.type} x={pct(a) * 10} width={(pct(b) - pct(a)) * 10} height={10} fill={GANTT_COLORS[s.type]}>
                          <title>{`${TIMELINE_LABELS[s.type]} ${clock.format(a)}–${clock.format(b)} (${formatDurationMs(b - a)})${s.label ? ` · ${s.label}` : ""}`}</title>
                        </rect>
                      );
                    })}
                  </svg>
                  <span className="truncate text-muted">{summary}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

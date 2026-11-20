import { categorical, formatCompact, linearScale, niceTicks, safe, truncate } from "@/lib/charts";
import { ALL_ZERO, ChartEmpty, DEFAULT_EMPTY, SrTable } from "./frame";
import { Legend } from "./legend";

export interface BarSeries {
  label: string;
  /** CSS colour (`var(--success)` for semantic series); default: categorical slot by series index. */
  color?: string;
}
export interface BarCategory {
  label: string;
  /** One value per series, same order as `series`. Missing, NaN or negative → 0. */
  values: number[];
}
export interface BarChartProps {
  /** Accessible name; also the table caption. */
  label: string;
  series: BarSeries[];
  data: BarCategory[];
  format?: (value: number) => string;
  /** viewBox height (width is fixed at 600 and scales to 100 %). */
  height?: number;
  empty?: string;
}

const W = 600;
const M = { top: 8, right: 8, bottom: 28, left: 44 };

/** Top-rounded (4px), square-at-baseline bar. */
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  const n = (v: number) => Math.round(v * 100) / 100;
  return `M ${n(x)} ${n(y + h)} V ${n(y + r)} Q ${n(x)} ${n(y)} ${n(x + r)} ${n(y)} H ${n(x + w - r)} Q ${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + r)} V ${n(y + h)} Z`;
}

/**
 * Vertical bar chart, one group of bars per category (e.g. workload "Over worked / Healthy / Less utilised"
 * per day). Props: `label`, `series`, `data`, optional `format`, `height`, `empty`.
 * Legend shown for ≥ 2 series; every bar has a `<title>` tooltip; values also in a hidden table.
 */
export function BarChart({ label, series, data, format = formatCompact, height = 240, empty = DEFAULT_EMPTY }: BarChartProps) {
  if (data.length === 0 || series.length === 0) return <ChartEmpty label={label} message={empty} />;
  const rows = data.map((c) => ({ label: c.label, values: series.map((_, i) => safe(c.values[i])) }));
  const max = Math.max(...rows.flatMap((r) => r.values));
  if (max === 0) return <ChartEmpty label={label} message={ALL_ZERO} />;

  const colors = series.map((s, i) => s.color ?? categorical(i));
  const ticks = niceTicks(max);
  const plotH = height - M.top - M.bottom;
  const y = linearScale([0, ticks.at(-1)!], [M.top + plotH, M.top]);
  const band = (W - M.left - M.right) / rows.length;
  const gap = 2;
  const barW = Math.min(24, (band * 0.8 - gap * (series.length - 1)) / series.length);
  const groupW = barW * series.length + gap * (series.length - 1);
  const maxChars = Math.max(3, Math.floor(band / 7));

  let top = { v: -1, s: "", c: "" };
  for (const r of rows) r.values.forEach((v, i) => v > top.v && (top = { v, s: series[i].label, c: r.label }));
  const summary = `${label}: bar chart of ${rows.length} ${rows.length === 1 ? "category" : "categories"}${series.length > 1 ? ` by ${series.map((s) => s.label).join(", ")}` : ""}; highest ${format(top.v)}${series.length > 1 ? ` (${top.s})` : ""} on ${top.c}.`;

  return (
    <figure className="flex flex-col gap-2">
      <svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${height}`} width="100%" className="block h-auto overflow-visible">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--border-strong)" : "var(--border)"} strokeWidth={1} />
            <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular-nums">{format(t)}</text>
          </g>
        ))}
        {rows.map((r, ci) => {
          const x0 = M.left + ci * band + (band - groupW) / 2;
          const short = truncate(r.label, maxChars);
          return (
            <g key={`${r.label}-${ci}`}>
              {r.values.map((v, si) =>
                v > 0 ? (
                  <path key={si} data-bar="" d={barPath(x0 + si * (barW + gap), y(v), barW, y(0) - y(v))} fill={colors[si]}>
                    <title>{`${r.label} · ${series[si].label}: ${format(v)}`}</title>
                  </path>
                ) : null,
              )}
              <text x={M.left + ci * band + band / 2} y={height - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
                {short !== r.label && <title>{r.label}</title>}
                {short}
              </text>
            </g>
          );
        })}
      </svg>
      {series.length > 1 && <Legend items={series.map((s, i) => ({ label: s.label, color: colors[i] }))} label={`${label} legend`} />}
      <SrTable caption={label} head={["Category", ...series.map((s) => s.label)]} rows={rows.map((r) => [r.label, ...r.values.map(format)])} />
    </figure>
  );
}

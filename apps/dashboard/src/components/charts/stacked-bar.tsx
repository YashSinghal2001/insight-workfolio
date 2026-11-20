import { categorical, formatCompact, formatPercent, safe, stack, sum, truncate } from "@/lib/charts";
import { ALL_ZERO, ChartEmpty, DEFAULT_EMPTY, SrTable } from "./frame";
import { Legend } from "./legend";

export interface StackedSeries {
  label: string;
  /** CSS colour; default: categorical slot by series index. */
  color?: string;
}
export interface StackedRow {
  label: string;
  /** One value per series. Missing, NaN or negative → 0. */
  values: number[];
}
export interface StackedBarProps {
  label: string;
  series: StackedSeries[];
  rows: StackedRow[];
  /** "absolute": bar length ∝ row total (longest = full width); "percent": every row is 100 %. */
  mode?: "absolute" | "percent";
  format?: (value: number) => string;
  empty?: string;
}

/**
 * Horizontal stacked bars, one per row, segments in series order with a 2px surface gap.
 * Props: `label`, `series`, `rows`, `mode`, `format`, `empty`. Row names and totals are HTML text
 * (legible at any width); each segment has a `<title>` tooltip; values also in a hidden table.
 */
export function StackedBar({ label, series, rows, mode = "absolute", format = formatCompact, empty = DEFAULT_EMPTY }: StackedBarProps) {
  if (rows.length === 0 || series.length === 0) return <ChartEmpty label={label} message={empty} />;
  const clean = rows.map((r) => ({ label: r.label, values: series.map((_, i) => safe(r.values[i])) }));
  const totals = clean.map((r) => sum(r.values));
  const maxTotal = Math.max(...totals);
  if (maxTotal === 0) return <ChartEmpty label={label} message={ALL_ZERO} />;
  const colors = series.map((s, i) => s.color ?? categorical(i));
  const share = (v: number, t: number) => (t ? formatPercent(v / t) : "0%");
  const summary = `${label}: ${mode === "percent" ? "100% " : ""}stacked bars for ${clean.length} ${clean.length === 1 ? "row" : "rows"} by ${series.map((s) => s.label).join(", ")}; largest total ${format(maxTotal)}.`;

  return (
    <figure className="flex flex-col gap-2">
      <div role="img" aria-label={summary} className="flex flex-col gap-2">
        {clean.map((r, ri) => {
          const parts = stack(r.values, mode === "percent" ? totals[ri] : maxTotal);
          const short = truncate(r.label, 24);
          return (
            <div key={`${r.label}-${ri}`} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-xs">
              <span className="truncate text-muted" title={short === r.label ? undefined : r.label}>{short}</span>
              <svg viewBox="0 0 100 10" preserveAspectRatio="none" width="100%" className="block h-3">
                <rect width={100} height={10} fill="var(--surface-muted)" />
                {parts.map((p, si) =>
                  p.value > 0 ? (
                    <rect key={si} data-segment="" x={p.x0 * 100} width={(p.x1 - p.x0) * 100} height={10} fill={colors[si]} stroke="var(--surface)" strokeWidth={2} vectorEffect="non-scaling-stroke">
                      <title>{`${r.label} · ${series[si].label}: ${format(p.value)} (${share(p.value, totals[ri])})`}</title>
                    </rect>
                  ) : null,
                )}
              </svg>
              <span className="tabular-nums text-foreground">{format(totals[ri])}</span>
            </div>
          );
        })}
      </div>
      <Legend items={series.map((s, i) => ({ label: s.label, color: colors[i] }))} label={`${label} legend`} />
      <SrTable
        caption={label}
        head={["Row", ...series.map((s) => s.label), "Total"]}
        rows={clean.map((r, ri) => [r.label, ...r.values.map((v) => `${format(v)} (${share(v, totals[ri])})`), format(totals[ri])])}
      />
    </figure>
  );
}

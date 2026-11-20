import { categorical, formatCompact, linearScale, safe } from "@/lib/charts";
import { ChartEmpty, DEFAULT_EMPTY } from "./frame";

export interface SparklineProps {
  label: string;
  /** Points in order; NaN/negative → 0. One point draws a flat line. */
  values: number[];
  /** Fill a 10 % wash under the line. */
  area?: boolean;
  color?: string;
  format?: (value: number) => string;
  /** Rendered height in px (width is 100 %). */
  height?: number;
  empty?: string;
}

/**
 * Small trend line on a zero baseline (no axes). Props as `SparklineProps`. The accessible name gives
 * first, last, min and max; `<desc>` lists every value.
 */
export function Sparkline({ label, values, area = false, color = categorical(0), format = formatCompact, height = 24, empty = DEFAULT_EMPTY }: SparklineProps) {
  if (values.length === 0) return <ChartEmpty label={label} message={empty} />;
  const v = values.map(safe);
  const pts = v.length === 1 ? [v[0], v[0]] : v;
  const x = linearScale([0, pts.length - 1], [0, 100]);
  const y = linearScale([0, Math.max(...v)], [23, 1]);
  const line = pts.map((p, i) => `${i ? "L" : "M"} ${Math.round(x(i) * 100) / 100} ${Math.round(y(p) * 100) / 100}`).join(" ");
  const summary = `${label}: ${v.length} ${v.length === 1 ? "point" : "points"}, from ${format(v[0])} to ${format(v.at(-1)!)}, min ${format(Math.min(...v))}, max ${format(Math.max(...v))}.`;
  return (
    <svg role="img" aria-label={summary} viewBox="0 0 100 24" preserveAspectRatio="none" width="100%" height={height} className="block">
      <desc>{v.map(format).join(", ")}</desc>
      {area && <path data-area="" d={`${line} L 100 24 L 0 24 Z`} fill={color} fillOpacity={0.1} />}
      <path data-line="" d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

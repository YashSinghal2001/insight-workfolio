import { arcPath, donutSlices, formatCompact, formatPercent, MAX_CATEGORIES, sum, truncate, type DonutDatum } from "@/lib/charts";
import { ChartEmpty, DEFAULT_EMPTY, SrTable } from "./frame";
import { Legend } from "./legend";

export interface DonutChartProps {
  label: string;
  /** Slices; NaN/negative/zero values are dropped. Sorted largest first. */
  data: DonutDatum[];
  /** Slices before folding the rest into "Other" (≤ 8, default 8). */
  maxSlices?: number;
  otherLabel?: string;
  /** Centre text: small caption and big value (default "Total" and the formatted total). */
  centerLabel?: string;
  centerValue?: string;
  format?: (value: number) => string;
  empty?: string;
}

/**
 * Donut (e.g. top apps): up to 8 slices + "Other", 2px surface gaps, centre label/value, legend with value
 * and percent. Props as `DonutChartProps`. Every slice has a `<title>` tooltip; values also in a hidden table.
 */
export function DonutChart({ label, data, maxSlices = MAX_CATEGORIES, otherLabel = "Other", centerLabel = "Total", centerValue, format = formatCompact, empty = DEFAULT_EMPTY }: DonutChartProps) {
  const slices = donutSlices(data, maxSlices, otherLabel);
  if (slices.length === 0) return <ChartEmpty label={label} message={empty} />;
  const total = sum(slices.map((s) => s.value));
  const summary = `${label}: donut of ${slices.length} ${slices.length === 1 ? "slice" : "slices"}, total ${format(total)}; ${slices
    .slice(0, 3)
    .map((s) => `${s.label} ${formatPercent(s.share)}`)
    .join(", ")}${slices.length > 3 ? ", …" : ""}.`;

  return (
    <figure className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <svg role="img" aria-label={summary} viewBox="0 0 200 200" width="100%" className="block h-auto max-w-48 shrink-0">
        {slices.map((s, i) => (
          <path key={`${s.label}-${i}`} data-slice="" d={arcPath(100, 100, 92, 62, s.start, s.end)} fill={s.color} fillRule="evenodd" stroke="var(--surface)" strokeWidth={2}>
            <title>{`${s.label}: ${format(s.value)} (${formatPercent(s.share)})`}</title>
          </path>
        ))}
        <text x={100} y={94} textAnchor="middle" fontSize={12} fill="var(--muted)">{truncate(centerLabel, 18)}</text>
        <text x={100} y={118} textAnchor="middle" fontSize={22} fontWeight={600} fill="var(--foreground)">{truncate(centerValue ?? format(total), 10)}</text>
      </svg>
      <div className="w-full min-w-0 sm:flex-1">
        <Legend layout="list" label={`${label} legend`} items={slices.map((s) => ({ label: s.label, color: s.color, value: `${format(s.value)} · ${formatPercent(s.share)}` }))} />
      </div>
      <SrTable caption={label} head={["Item", "Value", "Share"]} rows={slices.map((s) => [s.label, format(s.value), formatPercent(s.share)])} />
    </figure>
  );
}

"use client";

import { formatDurationShort, type CategorizedActivityDay } from "@workfolio/shared";

const SEGMENTS = [
  { key: "productiveMs", label: "Productive", color: "bg-emerald-500" },
  { key: "neutralMs", label: "Neutral", color: "bg-sky-500" },
  { key: "unproductiveMs", label: "Unproductive", color: "bg-amber-500" },
  { key: "unclassifiedMs", label: "Unclassified", color: "bg-zinc-400" },
] as const;

const dayName = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
export const shareText = (share: number | null) => (share === null ? "—" : `${Math.round(share * 100)}%`);

/**
 * Per-day productive share as CSS bars (no chart library). Each bar is the day's clocked-in time,
 * scaled to the longest day; the coloured parts are active time by label, the rest is idle or
 * unobserved. The bars are decorative; screen readers get the same numbers as a table.
 * Render only when application labels are configured.
 */
export function ProductivityTrend({ days }: { days: CategorizedActivityDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.clockedInMs));
  const pct = (ms: number) => `${(ms / max) * 100}%`;
  return (
    <section aria-labelledby="trend-title" className="relative flex flex-col gap-3" data-testid="productivity-trend">
      <h2 id="trend-title" className="text-lg font-semibold">Productivity by day</h2>
      <p className="text-xs text-muted">
        Productive share = productive active time ÷ clocked-in time. Bar length is clocked-in time (longest day = full width); the uncoloured part is idle or unobserved.
      </p>
      <ul aria-hidden="true" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {SEGMENTS.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.color}`} />{s.label}</li>
        ))}
      </ul>
      <ol aria-hidden="true" className="flex flex-col gap-2 text-sm">
        {days.map((d) => (
          <li key={d.date} data-day={d.date} data-share={d.productiveShare ?? ""} className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-1 sm:grid-cols-[6.5rem_1fr_11rem]">
            <span className="text-xs text-muted">{dayName(d.date)}</span>
            <div className="flex h-3 min-w-0 overflow-hidden rounded bg-border/60">
              <div className="flex h-3" style={{ width: pct(d.clockedInMs) }}>
                {SEGMENTS.map((s) => (d[s.key] > 0 ? <div key={s.key} className={`h-3 ${s.color}`} style={{ width: `${(d[s.key] / Math.max(1, d.clockedInMs)) * 100}%` }} /> : null))}
              </div>
            </div>
            <span className="col-start-2 text-xs tabular-nums sm:col-start-auto" data-testid="trend-value">
              {d.clockedInMs ? `${shareText(d.productiveShare)} · ${formatDurationShort(d.productiveMs)} of ${formatDurationShort(d.clockedInMs)}` : "Not clocked in"}
            </span>
          </li>
        ))}
      </ol>
      {/* sr-only on a wrapper: a table ignores width/overflow and would widen the page. */}
      <div className="sr-only">
      <table aria-label="Productivity by day">
        <thead>
          <tr><th scope="col">Day</th><th scope="col">Productive share</th><th scope="col">Clocked in</th>{SEGMENTS.map((s) => <th key={s.key} scope="col">{s.label}</th>)}</tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{dayName(d.date)}</th>
              <td>{shareText(d.productiveShare)}</td>
              <td>{formatDurationShort(d.clockedInMs)}</td>
              {SEGMENTS.map((s) => <td key={s.key}>{formatDurationShort(d[s.key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

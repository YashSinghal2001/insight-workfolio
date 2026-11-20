// Shared chart pieces: the explicit empty state and the visually hidden data table.
import type { ReactNode } from "react";

export const DEFAULT_EMPTY = "No data to show.";
export const ALL_ZERO = "Nothing to chart: every value is 0.";

/** A visible message in place of a chart (never a blank box). */
export function ChartEmpty({ label, message }: { label: string; message: string }) {
  return (
    <div data-chart-empty="" className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
      <span className="sr-only">{label}: </span>
      {message}
    </div>
  );
}

/** The same numbers as the chart, for screen readers. First cell of each row is its header. */
export function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    // sr-only on a wrapper: a table ignores width/overflow and would widen the page.
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([first, ...rest], i) => (
            <tr key={i}>
              <th scope="row">{first}</th>
              {rest.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

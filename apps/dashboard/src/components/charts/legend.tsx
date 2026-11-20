import { truncate } from "@/lib/charts";

export interface LegendItem {
  label: string;
  /** CSS colour of the swatch (a `var(--…)`). */
  color: string;
  /** Optional text after the name, e.g. "2h 05m · 42%". */
  value?: string;
}

/**
 * Series key in text ink with a colour swatch, so identity is never colour alone.
 * Props: `items`; `label` (accessible name, default "Legend"); `layout` "inline" (wrapping row, default)
 * or "list" (one item per line, value right-aligned); `maxLabel` characters before "…" (full text in `title`).
 */
export function Legend({ items, label = "Legend", layout = "inline", maxLabel = 40 }: { items: LegendItem[]; label?: string; layout?: "inline" | "list"; maxLabel?: number }) {
  if (items.length === 0) return null;
  const list = layout === "list";
  return (
    <ul aria-label={label} className={list ? "flex min-w-0 flex-col gap-1.5 text-sm" : "flex flex-wrap gap-x-4 gap-y-1 text-xs"}>
      {items.map((item, i) => {
        const text = truncate(item.label, maxLabel);
        return (
          <li key={`${item.label}-${i}`} data-legend-item="" className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: item.color }} />
            <span className="min-w-0 truncate text-foreground" title={text === item.label ? undefined : item.label}>{text}</span>
            {item.value !== undefined && <span className={`tabular-nums text-muted${list ? " ml-auto pl-3" : ""}`}>{item.value}</span>}
          </li>
        );
      })}
    </ul>
  );
}

"use client";

import { addDays, localDate, weekStart } from "@workfolio/shared";
import { secondaryButtonClass } from "@/components/ui";

export interface Range {
  from: string;
  to: string;
}

/** Monday-start week containing today (browser's date), offset by whole weeks. */
export function weekRange(offset = 0): Range {
  const from = addDays(weekStart(localDate(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)), offset * 7);
  return { from, to: addDays(from, 6) };
}

/** Local-date range (each employee's own time zone is applied by the API). Max 92 days. */
export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const input = "rounded-md border border-border bg-background px-2 py-1.5 text-sm";
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">From</span>
        <input type="date" value={value.from} max={value.to} className={input} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">To</span>
        <input type="date" value={value.to} min={value.from} className={input} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
      </label>
      <button type="button" className={secondaryButtonClass} onClick={() => onChange(weekRange(0))}>This week</button>
      <button type="button" className={secondaryButtonClass} onClick={() => onChange(weekRange(-1))}>Last week</button>
    </div>
  );
}

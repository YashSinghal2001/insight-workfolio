"use client";

import { useState } from "react";
import { addDays, localDate, weekStart } from "@workfolio/shared";
import { secondaryButtonClass } from "@/components/ui";

export interface Range {
  from: string;
  to: string;
}

/**
 * Monday-start week containing today, offset by whole weeks. Pass the employee's profile time zone
 * on employee pages; without it the browser's time zone is used (admin pages, labelled as such).
 */
export function weekRange(offset = 0, timeZone?: string): Range {
  const from = addDays(weekStart(localDate(Date.now(), timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)), offset * 7);
  return { from, to: addDays(from, 6) };
}

/** Inclusive number of days in a YYYY-MM-DD range. */
export function rangeDays({ from, to }: Range): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Local-date range (each employee's own time zone is applied by the API).
 * `maxDays` mirrors the API's limit for the page (31 for activity, screenshots and websites; 92 for
 * timesheets, projects and audit): a longer range is never emitted. The other end is moved to fit
 * and a note says so, instead of letting the API answer 400.
 */
export function RangePicker({ value, onChange, maxDays, timeZone }: { value: Range; onChange: (r: Range) => void; maxDays?: number; timeZone?: string }) {
  const [note, setNote] = useState<string | null>(null);
  const input = "rounded-md border border-border bg-background px-2 py-1.5 text-sm";
  const emit = (next: Range, moved: "from" | "to") => {
    if (maxDays && rangeDays(next) > maxDays) {
      next = moved === "from" ? { from: next.from, to: addDays(next.from, maxDays - 1) } : { from: addDays(next.to, -(maxDays - 1)), to: next.to };
      setNote(`Ranges are limited to ${maxDays} days here; the ${moved === "from" ? "end" : "start"} date was adjusted.`);
    } else setNote(null);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">From</span>
          <input type="date" value={value.from} max={value.to} className={input} onChange={(e) => e.target.value && emit({ ...value, from: e.target.value }, "from")} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">To</span>
          <input type="date" value={value.to} min={value.from} className={input} onChange={(e) => e.target.value && emit({ ...value, to: e.target.value }, "to")} />
        </label>
        <button type="button" className={secondaryButtonClass} onClick={() => { setNote(null); onChange(weekRange(0, timeZone)); }}>This week</button>
        <button type="button" className={secondaryButtonClass} onClick={() => { setNote(null); onChange(weekRange(-1, timeZone)); }}>Last week</button>
      </div>
      {note && <p className="text-xs text-muted" role="status">{note}</p>}
    </div>
  );
}

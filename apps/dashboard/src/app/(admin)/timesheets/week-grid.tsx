"use client";

import { useEffect, useState } from "react";
import { addDays, type MonthlyAttendanceDay, type MonthlyAttendanceResponse } from "@workfolio/shared";
import { DataTable, EmptyState, ErrorState, FilterBar, Pagination, SkeletonRows } from "@/components/kit";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { weekRange } from "@/components/range-picker";
import { secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { hm, inOutCell, loadWeekGrid, missedDay, weekDates, type WeekGridRow } from "@/lib/reports";
import { EmployeeCell, qs, TINT, usePage } from "../reports/_parts";

const PAGE_SIZE = 50;
const FIELDS = ["IN", "OUT", "WORK", "BREAK"] as const;
type Field = (typeof FIELDS)[number];
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function DayCell({ day, show }: { day: MonthlyAttendanceDay | null; show: Set<Field> }) {
  if (!day) return <span className="text-muted">—</span>;
  if (!day.firstInLocal) return <span className={missedDay(day) ? "font-medium" : "text-muted"}>{missedDay(day) ? "Absent" : inOutCell(day)}</span>;
  const lines: [Field, string][] = [
    ["IN", day.firstInLocal],
    ["OUT", day.lastOutLocal ?? (day.status === "OPEN" ? "open" : "—")],
    ["WORK", hm(day.workedMinutes)],
    ["BREAK", hm(day.breakMinutes)],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
      {lines.filter(([f]) => show.has(f)).map(([f, v]) => (
        <div key={f} className="contents">
          <dt className="text-muted">{f}</dt>
          <dd className="tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

type Load = { key: string; rows: WeekGridRow[] | null; error: string | null };

/** Employees × 7 days (IN / OUT / WORK / BREAK), from every page of the monthly attendance reads the week touches (paged here). */
export function WeekGrid() {
  const { teamId } = useGlobalFilters();
  const [from, setFrom] = useState(() => weekRange().from);
  const [show, setShow] = useState<Set<Field>>(() => new Set(FIELDS));
  const [retry, setRetry] = useState(0);
  const [page, setPage] = usePage(`${from}|${teamId}`);
  const key = `${from}|${teamId}|${retry}`;
  const [load, setLoad] = useState<Load>({ key: "", rows: null, error: null });

  useEffect(() => {
    let live = true;
    loadWeekGrid((month, p) => api<MonthlyAttendanceResponse>(`/attendance/monthly?${qs({ month, page: p, pageSize: 100 }, teamId)}`), from).then(
      (rows) => live && setLoad({ key, rows, error: null }),
      (e) => live && setLoad({ key, rows: null, error: errorMessage(e) }),
    );
    return () => void (live = false);
  }, [from, teamId, key]);

  const current = load.key === key ? load : null;
  const dates = weekDates(from);
  const toggle = (f: Field) => setShow((s) => { const n = new Set(s); if (n.has(f)) n.delete(f); else n.add(f); return n; });

  return (
    <div className="flex flex-col gap-4">
      <GlobalFilters date={false} />
      <FilterBar label="Week grid options">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Week">
          <button type="button" aria-label="Previous week" className={secondaryButtonClass} onClick={() => setFrom(addDays(from, -7))}>◀</button>
          <span className="px-2 text-sm tabular-nums whitespace-nowrap" aria-live="polite">{from} – {dates[6]}</span>
          <button type="button" aria-label="Next week" className={secondaryButtonClass} onClick={() => setFrom(addDays(from, 7))}>▶</button>
          <button type="button" className={secondaryButtonClass} disabled={from === weekRange().from} onClick={() => setFrom(weekRange().from)}>This week</button>
        </div>
        <fieldset className="flex flex-wrap items-center gap-3 text-sm">
          <legend className="sr-only">Columns</legend>
          <span className="text-xs text-muted">Show</span>
          {FIELDS.map((f) => (
            <label key={f} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={show.has(f)} onChange={() => toggle(f)} /> {f}
            </label>
          ))}
        </fieldset>
      </FilterBar>
      {current?.error ? (
        <ErrorState message={current.error} onRetry={() => setRetry((n) => n + 1)} />
      ) : !current?.rows ? (
        <SkeletonRows label="week grid" />
      ) : current.rows.length === 0 ? (
        <EmptyState title="No employees found." />
      ) : (
        <>
          <DataTable label="Week grid" stickyHeader minWidth={200 + 7 * 120 + 140} head={["Employee", ...dates.map(dayLabel), "Total"]}>
            {current.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((r) => (
              <tr key={r.employee.id} className="align-top">
                <td className="sticky left-0 z-[1] bg-surface"><EmployeeCell employee={r.employee} /></td>
                {r.cells.map((c, i) => (
                  <td key={dates[i]} className={missedDay(c) ? TINT.danger : undefined}><DayCell day={c} show={show} /></td>
                ))}
                <td className="text-xs">
                  <div className="tabular-nums">{r.totals.workedDays} day(s)</div>
                  {show.has("WORK") && <div className="tabular-nums">WORK {hm(r.totals.workMinutes)}</div>}
                  {show.has("BREAK") && <div className="tabular-nums text-muted">BREAK {hm(r.totals.breakMinutes)}</div>}
                </td>
              </tr>
            ))}
          </DataTable>
          {current.rows.length > PAGE_SIZE && <Pagination page={page} pageCount={Math.ceil(current.rows.length / PAGE_SIZE)} onPage={setPage} />}
          <p className="text-xs text-muted">
            Local times in each employee&apos;s zone; a shift belongs to the day it started. WORK and BREAK count completed shifts only.
            Red = a scheduled day with nothing worked (absent). LV leave, H holiday, WO not a workday, — no schedule or not listed.
          </p>
        </>
      )}
    </div>
  );
}

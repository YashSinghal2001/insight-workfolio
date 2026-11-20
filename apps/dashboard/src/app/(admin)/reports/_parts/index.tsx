"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { type EmployeeRef, type MonthlyAttendanceDay, type MonthlyAttendanceRow } from "@workfolio/shared";
import { Button, DataTable, EmptyState, ErrorState, SkeletonRows } from "@/components/kit";
import { inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { todayLocal } from "@/lib/global-filters";
import { downloadFile } from "../../_components/download";

/** GET `path` (null = wait); a new path clears the old data; retry() refetches. */
export function useApiData<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null }>({ path: null, data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path).then(
      (data) => live && setState({ path, data, error: null }),
      (e) => live && setState({ path, data: null, error: errorMessage(e) }),
    );
    return () => void (live = false);
  }, [path, attempt]);
  const current = state.path === path;
  return { data: current ? state.data : null, error: current ? state.error : null, retry: () => (setState((s) => ({ ...s, path: null })), setAttempt((n) => n + 1)) };
}

/** Query string with `teamId` only when a team is chosen. */
export const qs = (params: Record<string, string | number>, teamId: string | null) => {
  const p = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  if (teamId) p.set("teamId", teamId);
  return p.toString();
};

export const thisMonth = () => todayLocal().slice(0, 7);

export function MonthField({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted">Month</span>
      <input type="month" required value={value} onChange={(e) => e.target.value && onChange(e.target.value)} className={`${inputClass} w-auto`} />
    </label>
  );
}

export function EmployeeCell({ employee }: { employee: EmployeeRef }) {
  return (
    <>
      <Link href={`/timesheets/${employee.id}`} className="font-medium whitespace-nowrap text-brand hover:underline">{employee.fullName}</Link>
      <div className="font-mono text-xs text-muted">{employee.employeeCode}</div>
    </>
  );
}

/** Loading / error / empty around a report body. */
export function Loadable<T>({ state, label, empty, children }: { state: { data: T | null; error: string | null; retry: () => void }; label: string; empty: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (state.error) return <ErrorState message={state.error} onRetry={state.retry} />;
  if (!state.data) return <SkeletonRows label={label} />;
  if (empty(state.data)) return <EmptyState title={`No ${label} for this selection.`} />;
  return <>{children(state.data)}</>;
}

/** Server-built file(s) through the authenticated API. */
export function ServerExport({ files }: { files: { label: string; path: string; filename: string }[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(f: (typeof files)[number]) {
    setBusy(f.label);
    setError(null);
    try {
      await downloadFile(f.path, f.filename);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {files.map((f) => (
          <Button key={f.label} variant="secondary" pending={busy === f.label} pendingLabel="Preparing…" disabled={!!busy} onClick={() => void run(f)}>{f.label}</Button>
        ))}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

/** Page number that falls back to 1 whenever `filters` (a key of the other inputs) changes. */
export function usePage(filters: string): [number, (page: number) => void] {
  const [s, set] = useState({ filters, page: 1 });
  return [s.filters === filters ? s.page : 1, (page) => set({ filters, page })];
}

/** Tint classes for matrix cells; each cell also carries text, so colour is never the only signal. */
export const TINT = { danger: "bg-danger-soft text-danger font-medium", warning: "bg-warning-soft", muted: "text-muted", none: "" } as const;

/**
 * Employee × day matrix of a month (scrolls inside its card). `lead` columns come after the employee; `cell` renders one
 * day as text plus a tint.
 */
export function DayMatrix({ label, rows, lead, cell }: {
  label: string;
  rows: MonthlyAttendanceRow[];
  lead: { header: string; value: (r: MonthlyAttendanceRow) => ReactNode }[];
  cell: (d: MonthlyAttendanceDay) => { text: string; tint: keyof typeof TINT; title?: string };
}) {
  const days = rows[0]?.days.map((d) => d.date) ?? [];
  return (
    <DataTable
      label={label}
      stickyHeader
      minWidth={200 + lead.length * 90 + days.length * 92}
      head={["Employee", ...lead.map((l) => l.header), ...days.map((d) => <abbr key={d} title={d} className="no-underline">{Number(d.slice(8))}</abbr>)]}
    >
      {rows.map((r) => (
        <tr key={r.employee.id}>
          <td className="sticky left-0 z-[1] bg-surface"><EmployeeCell employee={r.employee} /></td>
          {lead.map((l) => <td key={l.header} className="tabular-nums">{l.value(r)}</td>)}
          {r.days.map((d) => {
            const c = cell(d);
            return <td key={d.date} title={c.title ?? d.date} className={`text-xs tabular-nums whitespace-nowrap ${TINT[c.tint]}`}>{c.text}</td>;
          })}
        </tr>
      ))}
    </DataTable>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { Employee, Paginated } from "@workfolio/shared";
import { inputClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 300;
const optionLabel = (e: Employee) => `${e.fullName} (${e.employeeCode})`;

/**
 * Searchable employee picker: a search box (server search, `GET /employees?q=`, 20 results) and a
 * native <select> of the matches. The chosen employee stays in the list while other searches run.
 * Browser suites drive the <select> directly, so it stays a plain select with the employee ids.
 */
export function EmployeePicker({
  value,
  onChange,
  label = "Employee",
  allLabel,
  format = optionLabel,
  exclude,
  autoSelect = false,
  selectLabel,
  className = "",
}: {
  value: string;
  onChange: (id: string, employee: Employee | null) => void;
  label?: string;
  /** Adds an empty-value first option (e.g. "All employees"). */
  allLabel?: string;
  format?: (e: Employee) => string;
  /** Ids not offered (e.g. already assigned). */
  exclude?: readonly string[];
  /** Picks the first match when nothing is chosen (only without allLabel). */
  autoSelect?: boolean;
  /** aria-label of the select; defaults to the visible label. */
  selectLabel?: string;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Employee[] | null>(null);
  const [total, setTotal] = useState(0);
  const [chosen, setChosen] = useState<Employee | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () => {
        const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
        if (q.trim()) params.set("q", q.trim());
        api<Paginated<Employee>>(`/employees?${params}`).then(
          (r) => {
            if (!live) return;
            setItems(r.items);
            setTotal(r.total);
            setError(null);
          },
          (e) => live && setError(errorMessage(e)),
        );
      },
      q ? DEBOUNCE_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  // Auto-select runs once results arrive and nothing is chosen.
  useEffect(() => {
    if (autoSelect && !allLabel && !value && items?.[0]) onChange(items[0].id, items[0]);
  }, [autoSelect, allLabel, value, items, onChange]);

  // A preset value (e.g. from ?employeeId=) outside the first results: fetch that one employee.
  const known = !value || chosen?.id === value || !!items?.some((e) => e.id === value);
  useEffect(() => {
    if (known || !items) return;
    let live = true;
    api<Employee>(`/employees/${value}`).then((e) => live && setChosen(e), () => undefined);
    return () => {
      live = false;
    };
  }, [known, items, value]);

  const hidden = new Set(exclude);
  const options = (items ?? []).filter((e) => !hidden.has(e.id));
  const selected = value ? (options.find((e) => e.id === value) ?? (chosen?.id === value ? chosen : null)) : null;
  const list = selected && !options.some((e) => e.id === selected.id) ? [selected, ...options] : options;

  return (
    <div className={`flex min-w-0 flex-col gap-1 text-sm ${className}`}>
      <span className="text-xs text-muted">{label}</span>
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
          placeholder="Search name or code"
          aria-label={`Search ${label.toLowerCase()}`}
          maxLength={100}
          className={`${inputClass} w-44 max-w-full`}
        />
        <select
          aria-label={selectLabel ?? label}
          value={value}
          disabled={!items}
          onChange={(e) => {
            const emp = list.find((x) => x.id === e.target.value) ?? null;
            setChosen(emp);
            onChange(e.target.value, emp);
          }}
          className={`${inputClass} w-auto max-w-full min-w-0`}
        >
          {allLabel !== undefined && <option value="">{allLabel}</option>}
          {allLabel === undefined && !value && <option value="">{items ? (list.length ? "Choose an employee…" : "No matches") : "Loading…"}</option>}
          {list.map((e) => <option key={e.id} value={e.id}>{format(e)}</option>)}
        </select>
      </div>
      {error ? (
        <span role="alert" className="text-xs text-danger">{error}</span>
      ) : (
        items && total > PAGE_SIZE && <span className="text-xs text-muted">Showing {PAGE_SIZE} of {total}; type to search.</span>
      )}
    </div>
  );
}

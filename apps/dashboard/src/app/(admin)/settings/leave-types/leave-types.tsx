"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DEFAULT_LEAVE_TYPE_ID, leaveTypeSchema, type LeaveType } from "@workfolio/shared";
import { Button, DataTable, ErrorState, SkeletonRows, StatusBadge, SuccessNotice } from "@/components/kit";
import { Card, Field, inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

type Draft = { name: string; paid: boolean; days: string; hours: string };
const EMPTY: Draft = { name: "", paid: true, days: "", hours: "" };
const toDraft = (t: LeaveType): Draft => ({ name: t.name, paid: t.paid, days: t.yearlyAllowanceDays?.toString() ?? "", hours: t.shortHoursPerMonth?.toString() ?? "" });
/** Blank = no limit. */
const toBody = (d: Draft) => ({ name: d.name, paid: d.paid, yearlyAllowanceDays: d.days.trim() === "" ? null : Number(d.days), shortHoursPerMonth: d.hours.trim() === "" ? null : Number(d.hours) });
const limit = (v: number | null, unit: string) => (v === null ? "No limit" : `${v} ${unit}`);

/** Admin: leave types (W36) with a yearly allowance and an optional monthly short-leave quota (W35). */
export function LeaveTypes() {
  const [types, setTypes] = useState<LeaveType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<LeaveType | null>(null);

  const load = useCallback(() => {
    api<LeaveType[]>("/leave/types").then((r) => (setTypes(r), setError(null)), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  async function toggle(t: LeaveType) {
    try {
      await api(`/leave/types/${t.id}`, { method: "PATCH", body: { active: !t.active } });
      setOk(`${t.name} is now ${t.active ? "inactive (employees can no longer choose it)" : "active"}.`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
      <p className="text-sm text-muted">
        A balance is the yearly allowance minus approved days in the calendar year; approval is refused when it would go past it. Short leave counts
        against the monthly hours quota instead of days. Leave blank for no limit. Changing an allowance applies to the whole year, including leave already
        approved. Types are deactivated, never deleted.
      </p>
      {error && <ErrorState message={error} onRetry={load} />}
      {!types && !error && <SkeletonRows label="leave types" />}
      {types && (
        <DataTable label="Leave types" head={["Name", "Paid", "Yearly allowance", "Short leave per month", "Status", "Actions"]}>
          {types.map((t) => (
            <tr key={t.id}>
              <td className="font-medium">{t.name}{t.id === DEFAULT_LEAVE_TYPE_ID && <span className="block text-xs text-muted">Default (requests that name no type)</span>}</td>
              <td>{t.paid ? "Paid" : "Unpaid"}</td>
              <td className="tabular-nums">{limit(t.yearlyAllowanceDays, "days")}</td>
              <td className="tabular-nums">{limit(t.shortHoursPerMonth, "hours")}</td>
              <td><StatusBadge tone={t.active ? "success" : "neutral"}>{t.active ? "Active" : "Inactive"}</StatusBadge></td>
              <td className="flex gap-2">
                <Button variant="secondary" className="px-3 py-1" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>Edit</Button>
                {t.id !== DEFAULT_LEAVE_TYPE_ID && (
                  <Button variant="secondary" className="px-3 py-1" onClick={() => void toggle(t)}>{t.active ? "Deactivate" : "Activate"}</Button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <Card title={editing ? `Edit ${editing.name}` : "New leave type"}>
        <TypeForm
          key={editing?.id ?? "new"}
          type={editing}
          onSaved={(t) => (setOk(`Saved ${t.name}.`), setEditing(null), load())}
          onCancel={editing ? () => setEditing(null) : undefined}
        />
      </Card>
    </div>
  );
}

function TypeForm({ type, onSaved, onCancel }: { type: LeaveType | null; onSaved: (t: LeaveType) => void; onCancel?: () => void }) {
  const [d, setD] = useState<Draft>(type ? toDraft(type) : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = leaveTypeSchema.safeParse(toBody(d));
    if (!parsed.success) return setError(`${parsed.error.issues[0]?.path.join(".") || "Form"}: ${parsed.error.issues[0]?.message ?? "check the values"}`);
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<LeaveType>(type ? `/leave/types/${type.id}` : "/leave/types", { method: type ? "PATCH" : "POST", body: parsed.data }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label={type ? "Edit leave type" : "New leave type"} onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input required maxLength={60} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} className={inputClass} placeholder="e.g. Annual leave" />
        </Field>
        <Field label="Pay">
          <select value={d.paid ? "paid" : "unpaid"} onChange={(e) => setD({ ...d, paid: e.target.value === "paid" })} className={inputClass}>
            <option value="paid">Paid</option>
            <option value="unpaid">Unpaid</option>
          </select>
        </Field>
        <Field label="Yearly allowance (days)" hint="Steps of 0.5. Blank = no limit.">
          <input type="number" min={0} max={366} step={0.5} value={d.days} onChange={(e) => setD({ ...d, days: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Short leave per month (hours)" hint="Steps of 0.5. Blank = no limit.">
          <input type="number" min={0} max={744} step={0.5} value={d.hours} onChange={(e) => setD({ ...d, hours: e.target.value })} className={inputClass} />
        </Field>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" pending={busy} pendingLabel="Saving…">{type ? "Save changes" : "Add leave type"}</Button>
        {onCancel && <Button variant="secondary" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

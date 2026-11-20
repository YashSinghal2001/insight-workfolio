"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { HOLIDAY_IMPORT_MAX_ROWS, holidaySchema, parseHolidayCsv, type Holiday, type HolidayImportResult } from "@workfolio/shared";
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, PageHeader, SkeletonRows, SuccessNotice } from "@/components/kit";
import { Card, Field, inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { xlsxToHolidayCsv } from "@/lib/xlsx-holidays";

const thisYear = new Date().getFullYear();
const dayLabel = (d: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

/** Admin: organisation-wide holidays (W38) and CSV / Excel import (W39). */
export default function HolidaysPage() {
  const [year, setYear] = useState(thisYear);
  const [items, setItems] = useState<Holiday[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Holiday | null>(null);

  const load = useCallback(() => {
    api<Holiday[]>(`/holidays?year=${year}`).then((r) => (setItems(r), setError(null)), (e) => setError(errorMessage(e)));
  }, [year]);
  useEffect(load, [load]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader
        title="Holidays"
        about={
          <>
            Office and public holidays for the whole organisation. A holiday date is read in each employee&apos;s own time zone. It is shown as Holiday
            (never Absent) in the <Link href="/attendance?view=daily" className="underline">daily attendance</Link> view, and leave on a holiday uses no
            leave balance.
          </>
        }
      />
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />

      <Card title="Add a holiday">
        <AddHoliday onAdded={(h) => (setOk(`Added ${h.name} on ${dayLabel(h.date)}.`), load())} />
      </Card>

      <Card title="Import from a CSV or Excel file">
        <ImportHolidays onImported={(r) => (setOk(`Imported ${r.created} ${r.created === 1 ? "holiday" : "holidays"}${r.skipped.length ? `; skipped ${r.skipped.length} date(s) that already had one` : ""}.`), load())} />
      </Card>

      <Card
        title={`Holidays in ${year}`}
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Year</span>
            <input type="number" min={2000} max={2100} value={year} onChange={(e) => e.target.valueAsNumber && (setItems(null), setYear(e.target.valueAsNumber))} className={`${inputClass} w-24`} />
          </label>
        }
      >
        {error && <ErrorState message={error} onRetry={load} />}
        {!items && !error && <SkeletonRows label="holidays" />}
        {items?.length === 0 && <EmptyState title={`No holidays in ${year}.`} hint="Add one above or import a CSV or Excel file." />}
        {items && items.length > 0 && (
          <DataTable label="Holidays" head={["Date", "Name", "Added by", "Action"]}>
            {items.map((h) => (
              <tr key={h.id}>
                <td className="whitespace-nowrap tabular-nums">{dayLabel(h.date)}</td>
                <td>{h.name}</td>
                <td className="text-xs text-muted">{h.createdBy.email}</td>
                <td>
                  <Button variant="secondary" className="px-3 py-1" onClick={() => setRemoving(h)} aria-label={`Remove ${h.name}`}>Remove</Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>

      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? "this holiday"}?`}
        description={removing ? <>{dayLabel(removing.date)} becomes an ordinary day again: an employee without a clock-in on a workday can then show as Absent.</> : null}
        confirmLabel="Remove holiday"
        tone="danger"
        onConfirm={async () => {
          try {
            await api(`/holidays/${removing!.id}`, { method: "DELETE" });
          } catch (err) {
            throw new Error(errorMessage(err));
          }
          setOk(`Removed ${removing!.name}.`);
          load();
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

function AddHoliday({ onAdded }: { onAdded: (h: Holiday) => void }) {
  const [form, setForm] = useState({ date: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = holidaySchema.safeParse(form);
    if (!parsed.success) return setError("Give a date and a name (up to 120 characters).");
    setBusy(true);
    setError(null);
    try {
      onAdded(await api<Holiday>("/holidays", { method: "POST", body: parsed.data }));
      setForm({ date: "", name: "" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Add a holiday" onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <Field label="Date">
          <input type="date" required value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={inputClass} />
        </Field>
        <Field label="Name">
          <input required maxLength={120} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputClass} placeholder="e.g. Independence Day" />
        </Field>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <Button type="submit" pending={busy} pendingLabel="Adding…">Add holiday</Button>
      </div>
    </form>
  );
}

function ImportHolidays({ onImported }: { onImported: (r: HolidayImportResult) => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);

  async function choose(file: File | undefined) {
    setCsv(null);
    setErrors([]);
    if (!file) return;
    let text = await file.text();
    if (/\.xlsx?$/i.test(file.name)) {
      // Excel is converted in the browser to the same CSV payload; the server validates it as usual.
      try {
        const sheet = await xlsxToHolidayCsv(new Uint8Array(await file.arrayBuffer()));
        if (sheet.errors.length) return setErrors(sheet.errors);
        text = sheet.csv;
      } catch (err) {
        return setErrors([err instanceof Error ? err.message : "This file could not be read."]);
      }
    }
    const parsed = parseHolidayCsv(text); // the server checks again
    setErrors(parsed.errors);
    setCount(parsed.rows.length);
    if (!parsed.errors.length) setCsv(text);
  }

  async function upload() {
    if (!csv) return;
    setBusy(true);
    try {
      onImported(await api<HolidayImportResult>("/holidays/import", { method: "POST", body: { csv } }));
      setCsv(null);
    } catch (err) {
      setErrors([errorMessage(err)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted">
        A CSV file with one holiday per line: <code>date,name</code>, dates as YYYY-MM-DD (for example <code>2026-12-25,Christmas Day</code>). A header
        row is optional; put a name that contains a comma in double quotes. An Excel <code>.xlsx</code> file works too: the first sheet, dates in column A (date cells, YYYY-MM-DD or day/month/year text) and names
        in column B; it is converted in your browser. Old <code>.xls</code> files must be saved as <code>.xlsx</code> or CSV first. At most {HOLIDAY_IMPORT_MAX_ROWS} rows.
        Nothing is imported if any line is invalid; dates that already have a holiday are skipped.
      </p>
      <Field label="CSV or Excel file">
        <input type="file" accept=".csv,.xlsx,.xls,text/csv" onChange={(e) => void choose(e.target.files?.[0])} className="text-sm" />
      </Field>
      {errors.length > 0 && (
        <Notice tone="error">
          <ul>{errors.slice(0, 10).map((m) => <li key={m}>{m}</li>)}</ul>
        </Notice>
      )}
      <div>
        <Button onClick={() => void upload()} pending={busy} pendingLabel="Importing…" disabledReason={csv ? null : "Choose a valid CSV or Excel file first"}>
          {csv ? `Import ${count} ${count === 1 ? "holiday" : "holidays"}` : "Import"}
        </Button>
      </div>
    </div>
  );
}

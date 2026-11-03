"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { WorkScheduleInput, WorkScheduleResponse } from "@workfolio/shared";
import { Button, DataTable, ErrorState, FormField, PageHeader, SkeletonRows, StatusBadge, SuccessNotice } from "@/components/kit";
import { Card, inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayNames = (workdays: string) => [...workdays].map((d) => DAYS[Number(d) - 1]!.slice(0, 3)).join(", ") || "none";
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—");

/** Organisation-wide work schedule: the basis for late and absent in the daily attendance view. */
export default function WorkSchedulePage() {
  const [data, setData] = useState<WorkScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<WorkScheduleResponse>("/settings/schedule").then((d) => (setData(d), setError(null)), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Work schedule"
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Work schedule" }]}
        description={
          <>
            One schedule for the whole organisation, used only to mark employees late or absent in the{" "}
            <Link href="/attendance?view=daily" className="underline">daily attendance view</Link>. It never changes recorded attendance or timesheets.
            The start time is read in each employee&apos;s own time zone. Holidays (see Holidays) are never late or absent; a person&apos;s own start time or workdays can be set on their employee page.
          </>
        }
      />
      {error && <ErrorState message={error} onRetry={load} />}
      {!data && !error && <SkeletonRows label="work schedule" />}
      {data && <ScheduleForm data={data} onSaved={load} />}
      {data && (
        <Card title="History">
          {data.history.length === 0 ? (
            <p className="text-sm text-muted">Never changed: the schedule is off and the defaults shown above are proposals only.</p>
          ) : (
            <DataTable label="Work schedule history" head={["From", "Status", "Start", "Grace", "Workdays", "By", "Reason"]} minWidth={760}>
              {data.history.map((h, i) => (
                <tr key={h.seq ?? i} className="align-top">
                  <td className="whitespace-nowrap">{when(h.effectiveAt)}</td>
                  <td>{h.enabled ? <StatusBadge tone="success">On</StatusBadge> : <StatusBadge tone="neutral">Off</StatusBadge>}</td>
                  <td className="tabular-nums">{h.expectedStart}</td>
                  <td className="tabular-nums">{h.graceMinutes} min</td>
                  <td>{dayNames(h.workdays)}</td>
                  <td>{h.changedBy?.email ?? "—"}</td>
                  <td className="max-w-xs">{h.reason ?? "—"}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>
      )}
    </div>
  );
}

function ScheduleForm({ data, onSaved }: { data: WorkScheduleResponse; onSaved: () => void }) {
  const c = data.current;
  const [days, setDays] = useState(() => new Set(c.workdays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = new FormData(form);
    const body: WorkScheduleInput = {
      enabled: f.get("enabled") === "on",
      expectedStart: String(f.get("expectedStart")),
      graceMinutes: Number(f.get("graceMinutes")),
      workdays: [...days].sort().join(""),
      reason: String(f.get("reason")).trim(),
    };
    setSaving(true);
    setError(null);
    try {
      await api("/settings/schedule", { method: "PUT", body });
      setOk("Saved. The new schedule applies from each employee's next local day; today keeps the version in force when it started.");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Schedule">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        Currently {c.enabled ? <StatusBadge tone="success">On</StatusBadge> : <StatusBadge tone="neutral">Off</StatusBadge>}
        <span className="text-xs text-muted">
          {c.seq === null ? "Never configured: off by default; the values below are proposals pending business approval." : `Since ${when(c.effectiveAt)} by ${c.changedBy?.email ?? "—"}.`}
        </span>
      </div>
      <form key={c.seq ?? "defaults"} onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="enabled" defaultChecked={c.enabled} className="mt-1" />
          <span>
            <span className="font-medium">Use this schedule for late and absent</span>
            <span className="block text-xs text-muted">Off: nobody is labelled late or absent.</span>
          </span>
        </label>
        <FormField label="Expected start (24-hour)" hint="Local time in each employee's own time zone." required>
          {(p) => <input {...p} name="expectedStart" type="time" defaultValue={c.expectedStart} className={inputClass} />}
        </FormField>
        <FormField label="Grace period (minutes)" hint="0–240. A clock-in after start + grace counts as late; absence is decided after it." required>
          {(p) => <input {...p} name="graceMinutes" type="number" min={0} max={240} step={1} defaultValue={c.graceMinutes} className={inputClass} />}
        </FormField>
        <fieldset className="flex flex-col gap-2 text-sm sm:col-span-2">
          <legend className="font-medium">Workdays</legend>
          <div className="flex flex-wrap gap-3">
            {DAYS.map((d, i) => {
              const digit = String(i + 1);
              return (
                <label key={d} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={days.has(digit)}
                    onChange={(e) => setDays((s) => { const n = new Set(s); if (e.target.checked) n.add(digit); else n.delete(digit); return n; })}
                  />
                  {d}
                </label>
              );
            })}
          </div>
          <span className="text-xs text-muted">Other days show as &quot;Not a workday&quot;.</span>
        </fieldset>
        <div className="sm:col-span-2">
          <FormField label="Reason for the change" hint="3–500 characters. Kept in the history and the audit log." required>
            {(p) => <textarea {...p} name="reason" minLength={3} maxLength={500} rows={2} className={inputClass} />}
          </FormField>
        </div>
        <p className="text-xs text-muted sm:col-span-2">
          Changes apply from each employee&apos;s next local day, never to a day already started, so earlier days keep the status they had.
        </p>
        <div className="flex flex-col gap-3 sm:col-span-2">
          <div>
            <Button type="submit" pending={saving} pendingLabel="Saving…" disabledReason={days.size === 0 ? "Choose at least one workday." : null}>
              Save schedule
            </Button>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
        </div>
      </form>
    </Card>
  );
}

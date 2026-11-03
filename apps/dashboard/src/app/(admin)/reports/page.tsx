"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { EligibleRecipient, ReportDeliveryStatus, ReportFrequency, ReportProviderInfo, ReportRun, ReportSchedule, RunNowResponse } from "@workfolio/shared";
import { Badge, buttonClass, Card, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/kit";
import { weekRange } from "@/components/range-picker";
import { api, errorMessage } from "@/lib/api";
import { ActivityOverview } from "../_components/activity-overview";
import { EmployeePicker } from "../_components/employee-picker";


const DELIVERY: Record<ReportDeliveryStatus, string> = {
  PENDING: "Waiting",
  SENDING: "Sending",
  RETRYING: "Will retry",
  SENT: "Sent",
  MOCKED: "Mock only: not emailed",
  NOT_CONFIGURED: "Not emailed: no provider",
  SKIPPED: "Skipped",
  FAILED: "Failed",
};
const RUN: Record<ReportRun["status"], string> = {
  NO_RECIPIENTS: "No recipients",
  IN_PROGRESS: "In progress",
  FAILED: "Failed",
  NOT_EMAILED: "Not emailed",
  DELIVERED: "Delivered",
};
const small = `${secondaryButtonClass} !px-2 !py-1 text-xs`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");

function ScheduleCard({ schedule, runs, onChanged }: { schedule: ReportSchedule; runs: ReportRun[]; onChanged: () => void }) {
  const [eligible, setEligible] = useState<EligibleRecipient[]>([]);
  const [recipient, setRecipient] = useState("");
  const [preview, setPreview] = useState<{ text: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/reports/schedules/${schedule.id}`;

  useEffect(() => {
    api<EligibleRecipient[]>(`${base}/eligible-recipients`).then(setEligible, (err) => setError(errorMessage(err)));
  }, [base, schedule.recipients.length]);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const candidates = eligible.filter((u) => !schedule.recipients.some((r) => r.id === u.id));
  return (
    <article className="rounded-lg border border-border bg-surface p-4 text-sm" aria-label={schedule.name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">{schedule.name}</span>{" "}
          <span className="text-muted">
            {schedule.frequency.toLowerCase()} · {schedule.employee ? `${schedule.employee.fullName} only` : "all employees"} · {schedule.timeZone}
            {schedule.includeProjects ? " · with project time" : ""}
          </span>{" "}
          <Badge ok={schedule.active}>{schedule.active ? "Active" : "Paused"}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className={small} onClick={() => void run(async () => setPreview(await api<{ text: string }>(`${base}/preview`)))}>Preview</button>
          <button
            type="button"
            disabled={busy}
            className={small}
            onClick={() =>
              void run(async () => {
                const r = await api<RunNowResponse>(`${base}/run`, { method: "POST" });
                setMessage(`${r.duplicate ? "Already run for" : "Ran for"} ${r.run.period.from} – ${r.run.period.to}: ${RUN[r.run.status].toLowerCase()}.`);
                onChanged();
              })
            }
          >
            Run now
          </button>
          <button type="button" disabled={busy} className={small} onClick={() => void run(async () => (await api(base, { method: "PATCH", body: { active: !schedule.active } }), onChanged()))}>
            {schedule.active ? "Pause" : "Activate"}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
      {message && <p role="status" className="mt-2 text-xs">{message}</p>}

      <section aria-label="Recipients" className="mt-3">
        <h4 className="mb-1 text-xs font-medium text-muted uppercase">Recipients</h4>
        <ul className="flex flex-col gap-1">
          {schedule.recipients.length === 0 && <li className="text-muted">No recipients: runs are recorded but nobody receives them.</li>}
          {schedule.recipients.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span>{r.email} <span className="text-xs text-muted">{r.role.toLowerCase()}</span></span>
              <button type="button" disabled={busy} className={small} onClick={() => void run(async () => (await api(`${base}/recipients/${r.id}`, { method: "DELETE" }), onChanged()))}>Remove</button>
            </li>
          ))}
        </ul>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(async () => (await api(`${base}/recipients`, { method: "POST", body: { userId: recipient } }), setRecipient(""), onChanged()));
          }}
        >
          <select aria-label={`Add a recipient to ${schedule.name}`} value={recipient} onChange={(e) => setRecipient(e.target.value)} className={inputClass}>
            <option value="">Choose a recipient…</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.email} ({u.role.toLowerCase()})</option>)}
          </select>
          <button type="submit" disabled={busy || !recipient} className={secondaryButtonClass}>Add</button>
        </form>
        <p className="mt-1 text-xs text-muted">
          Only active administrators{schedule.employee ? `, or ${schedule.employee.fullName} for this report about them,` : ""} can receive it. Checked again at every send.
        </p>
      </section>

      {preview && (
        <section aria-label="Preview" className="mt-3">
          <h4 className="mb-1 text-xs font-medium text-muted uppercase">Preview (not sent)</h4>
          <pre className="max-h-80 overflow-auto rounded-md border border-border bg-background p-3 text-xs whitespace-pre-wrap">{preview.text}</pre>
        </section>
      )}

      <section aria-label="Runs" className="mt-3">
        <h4 className="mb-1 text-xs font-medium text-muted uppercase">Runs</h4>
        {runs.length === 0 && <p className="text-muted">No runs yet.</p>}
        <ul className="flex flex-col gap-2">
          {runs.map((r) => (
            <li key={r.id} className="rounded-md border border-border p-2">
              <div className="flex flex-wrap justify-between gap-2">
                <span>{r.period.from} – {r.period.to} · {r.triggeredBy ? `run by ${r.triggeredBy.email}` : "scheduled"} · {when(r.createdAt)}</span>
                <span className="font-medium" data-run-status={r.status}>{RUN[r.status]}</span>
              </div>
              <ul className="mt-1 text-xs">
                {r.deliveries.map((d) => (
                  <li key={d.id} data-delivery-status={d.status}>
                    {d.recipient.email}: {DELIVERY[d.status]}
                    {d.status === "RETRYING" && d.nextAttemptAt ? ` at ${when(d.nextAttemptAt)}` : ""} · {d.attempts.length} attempt(s)
                    {d.lastError ? ` · ${d.lastError}` : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

export default function ReportsPage() {
  const [provider, setProvider] = useState<ReportProviderInfo | null>(null);
  const [schedules, setSchedules] = useState<ReportSchedule[] | null>(null);
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [overviewRange] = useState(() => weekRange());
  const [form, setForm] = useState({ name: "", frequency: "WEEKLY" as ReportFrequency, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, employeeId: "", includeProjects: true });

  const load = useCallback(async () => {
    try {
      const [p, s, r] = await Promise.all([
        api<ReportProviderInfo>("/reports/provider"),
        api<ReportSchedule[]>("/reports/schedules"),
        api<ReportRun[]>("/reports/runs"),
      ]);
      setProvider(p);
      setSchedules(s);
      setRuns(r);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await api("/reports/schedules", { method: "POST", body: { name: form.name, frequency: form.frequency, timeZone: form.timeZone, includeProjects: form.includeProjects, ...(form.employeeId ? { employeeId: form.employeeId } : {}) } });
      setForm({ ...form, name: "", employeeId: "" });
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Email reports"
        description="Scheduled summaries of attendance (worked hours, breaks, open shifts) and, optionally, project task time, for the last complete day, week or month. They never include screenshots, application activity, leave details, websites or productivity scores."
      />

      {provider?.provider === "none" && (
        <Notice tone="warning">No email provider is configured. Reports are generated and recorded, but nothing is emailed. A provider needs approval and server configuration (docs/email-reports.md).</Notice>
      )}
      {provider?.provider === "mock" && (
        <Notice tone="warning">Mock provider (development only): messages stay in the API&apos;s memory. Nothing is emailed.</Notice>
      )}
      {provider && <p className="text-xs text-muted">{provider.schedulerSeconds ? `The scheduler checks for due reports every ${provider.schedulerSeconds} seconds.` : "The scheduler is off; use Run now."}</p>}

      <Card title="New report">
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Name</span>
            <input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Frequency</span>
            <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as ReportFrequency })} className={inputClass}>
              <option value="DAILY">Daily (yesterday)</option>
              <option value="WEEKLY">Weekly (last week)</option>
              <option value="MONTHLY">Monthly (last month)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Period time zone</span>
            <input required value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} className={inputClass} />
          </label>
          <EmployeePicker
            label="Employees"
            allLabel="All current employees"
            format={(e) => `${e.fullName} (${e.employeeCode}) only`}
            value={form.employeeId}
            onChange={(employeeId) => setForm((f) => ({ ...f, employeeId }))}
          />
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={form.includeProjects} onChange={(e) => setForm({ ...form, includeProjects: e.target.checked })} /> Include project task time
          </label>
          {formError && <p role="alert" className="text-sm text-red-700 sm:col-span-2 dark:text-red-300">{formError}</p>}
          <div><button type="submit" className={buttonClass}>Create report</button></div>
        </form>
      </Card>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!schedules && !error && <SkeletonRows label="reports" />}
      {schedules?.length === 0 && <EmptyState title="No reports yet." hint="Create one above. Runs are recorded even when nothing is emailed." />}
      {schedules?.map((s) => <ScheduleCard key={s.id} schedule={s} runs={runs.filter((r) => r.scheduleId === s.id)} onChanged={() => void load()} />)}

      <section aria-labelledby="activity-overview-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="activity-overview-title" className="text-lg font-semibold">Activity overview (this week)</h2>
          <Link href="/activity" className="text-sm text-brand hover:underline">Open Activity for other ranges</Link>
        </div>
        <p className="text-xs text-muted">Read-only, on this page only: it is not part of the email reports above, which never include application activity.</p>
        <ActivityOverview range={overviewRange} />
      </section>
    </div>
  );
}

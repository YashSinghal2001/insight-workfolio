"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  REPORT_KIND_LABELS,
  REPORT_KINDS,
  type EligibleRecipient,
  type ReportDeliveryStatus,
  type ReportFrequency,
  type ReportKind,
  type ReportProviderInfo,
  type ReportRun,
  type ReportSchedule,
  type RunNowResponse,
  type Team,
} from "@workfolio/shared";
import { inputClass, Notice } from "@/components/ui";
import { Button, DataTable, EmptyState, ErrorState, FormField, PageHeader, SkeletonRows, StatusBadge, type Tone } from "@/components/kit";
import { api, errorMessage } from "@/lib/api";
import { EmployeePicker } from "../../_components/employee-picker";

const FREQUENCY: Record<ReportFrequency, string> = { DAILY: "Daily (yesterday)", WEEKLY: "Weekly (last week)", MONTHLY: "Monthly (last month, on the 1st)" };
const RUN: Record<ReportRun["status"], [string, Tone]> = {
  NO_RECIPIENTS: ["No recipients", "neutral"],
  IN_PROGRESS: ["In progress", "info"],
  FAILED: ["Failed", "danger"],
  NOT_EMAILED: ["Not emailed", "warning"],
  DELIVERED: ["Delivered", "success"],
};
const DELIVERY: Partial<Record<ReportDeliveryStatus, string>> = { MOCKED: "mock only", NOT_CONFIGURED: "no provider", SKIPPED: "skipped", FAILED: "failed", SENT: "sent", RETRYING: "will retry" };

type Scope = "ORG" | "TEAM" | "EMPLOYEE";
interface Form {
  kind: ReportKind;
  name: string;
  frequency: ReportFrequency;
  sendAtLocalTime: string;
  timeZone: string;
  scope: Scope;
  teamId: string;
  employeeId: string;
  includeProjects: boolean;
}
const blank = (): Form => ({ kind: "WORKED_HOURS", name: "", frequency: "DAILY", sendAtLocalTime: "", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, scope: "ORG", teamId: "", employeeId: "", includeProjects: true });
const fromSchedule = (s: ReportSchedule): Form => ({
  kind: s.kind, name: s.name, frequency: s.frequency, sendAtLocalTime: s.sendAtLocalTime ?? "", timeZone: s.timeZone,
  scope: s.team ? "TEAM" : s.employee ? "EMPLOYEE" : "ORG", teamId: s.team?.id ?? "", employeeId: s.employee?.id ?? "", includeProjects: s.includeProjects,
});
const scopeLabel = (s: ReportSchedule) => (s.team ? `Team ${s.team.name}` : s.employee ? `${s.employee.fullName} (${s.employee.employeeCode})` : "Organisation");

function Recipients({ schedule, onChanged }: { schedule: ReportSchedule; onChanged: () => void }) {
  const [eligible, setEligible] = useState<EligibleRecipient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/reports/schedules/${schedule.id}`;
  useEffect(() => {
    api<EligibleRecipient[]>(`${base}/eligible-recipients`).then(setEligible, (err) => setError(errorMessage(err)));
  }, [base, schedule.team?.id, schedule.employee?.id]);

  async function toggle(id: string, on: boolean) {
    setBusy(true);
    setError(null);
    try {
      await (on ? api(`${base}/recipients`, { method: "POST", body: { userId: id } }) : api(`${base}/recipients/${id}`, { method: "DELETE" }));
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const current = new Set(schedule.recipients.map((r) => r.id));
  // Former recipients who are no longer eligible stay listed so they can be removed.
  const options = [...(eligible ?? []), ...schedule.recipients.filter((r) => !eligible?.some((e) => e.id === r.id))];
  return (
    <fieldset className="flex flex-col gap-1 text-sm sm:col-span-2" aria-label="Recipients">
      <legend className="font-medium">Send report to</legend>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {!eligible && !error && <SkeletonRows rows={1} label="recipients" />}
      {eligible && options.length === 0 && <p className="text-muted">No eligible accounts.</p>}
      {eligible && options.map((u) => (
        <label key={u.id} className="flex items-center gap-2 break-all">
          <input type="checkbox" disabled={busy} checked={current.has(u.id)} onChange={(e) => void toggle(u.id, e.target.checked)} />
          {u.email} <span className="text-xs text-muted">{u.role.toLowerCase()}</span>
        </label>
      ))}
      <span className="text-xs text-muted">User accounts only: active administrators, the employee for their own report, or the head of the report&apos;s team. Checked again at every send.</span>
    </fieldset>
  );
}

function Editor({ schedule, teams, onSaved, onClose }: { schedule: ReportSchedule | null; teams: Team[] | null; onSaved: (s: ReportSchedule) => void; onClose: () => void }) {
  const [form, setForm] = useState<Form>(() => (schedule ? fromSchedule(schedule) : blank()));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const body = {
      kind: form.kind, name: form.name, frequency: form.frequency, timeZone: form.timeZone,
      sendAtLocalTime: form.sendAtLocalTime || null, includeProjects: form.includeProjects,
      ...(schedule
        ? { teamId: form.scope === "TEAM" ? form.teamId : null, employeeId: form.scope === "EMPLOYEE" ? form.employeeId : null }
        : { ...(form.scope === "TEAM" ? { teamId: form.teamId } : {}), ...(form.scope === "EMPLOYEE" ? { employeeId: form.employeeId } : {}) }),
    };
    try {
      onSaved(await api<ReportSchedule>(schedule ? `/reports/schedules/${schedule.id}` : "/reports/schedules", { method: schedule ? "PATCH" : "POST", body }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label={schedule ? `Edit ${schedule.name}` : "New scheduled report"} className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 text-lg font-semibold">{schedule ? `Edit “${schedule.name}”` : "New scheduled report"}</h2>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <FormField label="Report type" required>
          {(p) => (
            <select {...p} value={form.kind} onChange={(e) => set({ kind: e.target.value as ReportKind })} className={inputClass}>
              {REPORT_KINDS.map((k) => <option key={k} value={k}>{REPORT_KIND_LABELS[k]}</option>)}
            </select>
          )}
        </FormField>
        <FormField label="Title" required>
          {(p) => <input {...p} maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} className={inputClass} />}
        </FormField>
        <FormField label="Frequency" required>
          {(p) => (
            <select {...p} value={form.frequency} onChange={(e) => set({ frequency: e.target.value as ReportFrequency })} className={inputClass}>
              {Object.entries(FREQUENCY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          )}
        </FormField>
        <FormField label="Send email at" hint="Local time on the day after the period. Empty: as soon as the period ends.">
          {(p) => <input {...p} type="time" value={form.sendAtLocalTime} onChange={(e) => set({ sendAtLocalTime: e.target.value })} className={inputClass} />}
        </FormField>
        <FormField label="Time zone" required hint="Defines the period and the send time, e.g. Asia/Kolkata.">
          {(p) => <input {...p} value={form.timeZone} onChange={(e) => set({ timeZone: e.target.value })} className={inputClass} />}
        </FormField>
        <FormField label="Report of" required>
          {(p) => (
            <select {...p} value={form.scope} onChange={(e) => set({ scope: e.target.value as Scope })} className={inputClass}>
              <option value="ORG">Organisation</option>
              <option value="TEAM">One team</option>
              <option value="EMPLOYEE">One employee</option>
            </select>
          )}
        </FormField>
        {form.scope === "TEAM" && (
          <FormField label="Team" required error={teams && !teams.length ? "No teams yet: create one under Teams." : null}>
            {(p) => (
              <select {...p} value={form.teamId} onChange={(e) => set({ teamId: e.target.value })} className={inputClass}>
                <option value="">{teams ? "Choose a team…" : "Loading teams…"}</option>
                {teams?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.active ? "" : " (inactive)"}</option>)}
              </select>
            )}
          </FormField>
        )}
        {form.scope === "EMPLOYEE" && <EmployeePicker label="Employee" value={form.employeeId} onChange={(employeeId) => set({ employeeId })} />}
        {form.kind === "WORKED_HOURS" && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={form.includeProjects} onChange={(e) => set({ includeProjects: e.target.checked })} /> Include project task time
          </label>
        )}
        {schedule ? <Recipients schedule={schedule} onChanged={() => onSaved(schedule)} /> : <p className="text-xs text-muted sm:col-span-2">Choose recipients after saving.</p>}
        {error && <p role="alert" className="text-sm text-danger sm:col-span-2">{error}</p>}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" pending={pending} disabledReason={(form.scope === "TEAM" && !form.teamId) || (form.scope === "EMPLOYEE" && !form.employeeId) ? "Choose the team or employee" : null}>
            {schedule ? "Save changes" : "Create report"}
          </Button>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </form>
    </section>
  );
}

export default function ScheduledReportsPage() {
  const [provider, setProvider] = useState<ReportProviderInfo | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ReportSchedule[] | null>(null);
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [editing, setEditing] = useState<ReportSchedule | "new" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api<ReportSchedule[]>("/reports/schedules"), api<ReportRun[]>("/reports/runs")]);
      setSchedules(s);
      setRuns(r);
      setError(null);
      return s;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, []);

  useEffect(() => {
    api<ReportProviderInfo>("/reports/provider").then(setProvider, (err) => setProviderError(errorMessage(err)));
    api<Team[]>("/teams").then(setTeams, () => setTeams([]));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  async function act(s: ReportSchedule, label: string, fn: () => Promise<string>) {
    setBusy(`${s.id}:${label}`);
    setMessage(null);
    try {
      setMessage(await fn());
    } catch (err) {
      setMessage(`${s.name}: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
      await load();
    }
  }

  const lastRun = (id: string) => runs.find((r) => r.scheduleId === id);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Scheduled reports"
        breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: "Scheduled" }]}
        description="Worked hours, late clock-in and absent reports, emailed on a schedule to user accounts. They never include screenshots, application activity, leave details, websites or productivity scores."
        actions={<Button onClick={() => setEditing("new")}>New report</Button>}
      />

      {providerError && <ErrorState title="Email provider status unavailable" message={providerError} />}
      {provider && !provider.delivers && (
        <Notice tone="warning">
          {provider.provider === "mock" ? "Mock provider (development only): messages stay in the API's memory." : "No email provider is configured: reports are generated and recorded."} Nothing is emailed.
        </Notice>
      )}
      {provider?.provider === "graph-delegated" && <Notice tone="info">Reports are emailed through Microsoft Graph from the connected Microsoft account.</Notice>}
      {provider && <p className="text-xs text-muted">{provider.schedulerSeconds ? `The scheduler checks for due reports every ${provider.schedulerSeconds} seconds.` : "The scheduler is off; use Run now."}</p>}

      {editing && (
        <Editor
          key={editing === "new" ? "new" : editing.id}
          schedule={editing === "new" ? null : editing}
          teams={teams}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            const list = await load();
            setEditing(list?.find((x) => x.id === saved.id) ?? saved);
          }}
        />
      )}

      <div aria-live="polite">{message && <p role="status" data-report-message className="text-sm">{message}</p>}</div>
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!schedules && !error && <SkeletonRows label="scheduled reports" />}
      {schedules?.length === 0 && <EmptyState title="No scheduled reports yet." hint="Create one: runs are recorded even when nothing is emailed." action={<Button onClick={() => setEditing("new")}>New report</Button>} />}
      {!!schedules?.length && (
        <DataTable label="Scheduled reports" head={["Name", "Type", "Frequency", "Send at", "Report of", "Recipients", "Last run", "Actions"]} minWidth={960}>
          {schedules.map((s) => {
            const run = lastRun(s.id);
            return (
              <tr key={s.id} data-schedule={s.name}>
                <td className="font-medium">{s.name} {!s.active && <StatusBadge tone="neutral">Paused</StatusBadge>}</td>
                <td>{REPORT_KIND_LABELS[s.kind]}</td>
                <td>{s.frequency.toLowerCase()}</td>
                <td>{s.sendAtLocalTime ?? "after period"} <span className="text-xs text-muted">{s.timeZone}</span></td>
                <td>{scopeLabel(s)}</td>
                <td>{s.recipients.length ? s.recipients.map((r) => r.email).join(", ") : <span className="text-muted">none</span>}</td>
                <td>
                  {run ? (
                    <span className="flex flex-col gap-0.5">
                      <span data-run-status={run.status}><StatusBadge tone={RUN[run.status][1]}>{RUN[run.status][0]}</StatusBadge></span>
                      <span className="text-xs text-muted">{run.period.from === run.period.to ? run.period.from : `${run.period.from} – ${run.period.to}`}{run.deliveries.map((d) => DELIVERY[d.status]).filter(Boolean).length ? ` · ${[...new Set(run.deliveries.map((d) => DELIVERY[d.status]).filter(Boolean))].join(", ")}` : ""}</span>
                    </span>
                  ) : <span className="text-muted">never</span>}
                </td>
                <td>
                  <span className="flex flex-wrap gap-1">
                    <Button variant="secondary" className="!px-2 !py-1 text-xs" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>Edit</Button>
                    <Button variant="secondary" className="!px-2 !py-1 text-xs" aria-label={`Run ${s.name} now`} pending={busy === `${s.id}:run`} onClick={() => void act(s, "run", async () => {
                      const r = await api<RunNowResponse>(`/reports/schedules/${s.id}/run`, { method: "POST" });
                      return `${s.name}: ${r.duplicate ? "already run for" : "ran for"} ${r.run.period.from} – ${r.run.period.to}: ${RUN[r.run.status][0].toLowerCase()}.`;
                    })}>Run now</Button>
                    <Button variant="secondary" className="!px-2 !py-1 text-xs" aria-label={`${s.active ? "Pause" : "Activate"} ${s.name}`} pending={busy === `${s.id}:active`} onClick={() => void act(s, "active", async () => {
                      await api(`/reports/schedules/${s.id}`, { method: "PATCH", body: { active: !s.active } });
                      return `${s.name}: ${s.active ? "paused" : "activated"}.`;
                    })}>{s.active ? "Pause" : "Activate"}</Button>
                  </span>
                </td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </div>
  );
}

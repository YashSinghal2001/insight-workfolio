"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ALERT_RULE_KIND_LABEL, ALERT_RULE_KINDS, createAlertRuleSchema, IDLE_SHARE_MIN_TRACKED_MINUTES, type Alert, type AlertRule, type AlertRuleKind } from "@workfolio/shared";
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, PageHeader, SkeletonRows, StatusBadge, SuccessNotice, Tabs } from "@/components/kit";
import { Card, Field, inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

type View = "open" | "acknowledged" | "all";
const VIEWS = [{ id: "open", label: "Open" }, { id: "acknowledged", label: "Acknowledged" }, { id: "all", label: "All" }] as const;
const dayLabel = (d: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
const param = (r: AlertRule) => (r.kind === "NOT_CLOCKED_IN_BY" ? `by ${r.atTime}` : r.kind === "IDLE_SHARE_ABOVE" ? `above ${r.threshold}%` : r.kind === "NO_ACTIVITY_FOR" ? `${r.threshold} min` : "—");

/** Admin: alert rules and the alerts they raise (F06). In-app only; nothing is emailed. */
export default function AlertsPage() {
  const [view, setView] = useState<View>("open");
  const [items, setItems] = useState<Alert[] | null>(null);
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AlertRule | null>(null);

  const load = useCallback(() => {
    Promise.all([api<Alert[]>(`/alerts?status=${view}`), api<AlertRule[]>("/alerts/rules")]).then(
      ([a, r]) => (setItems(a), setRules(r), setError(null)),
      (e) => setError(errorMessage(e)),
    );
  }, [view]);
  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      setOk(message);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Alerts"
        description={
          <>
            Rules checked every minute against attendance and activity. At most one alert per rule, employee and day. Nobody is alerted on a{" "}
            <Link href="/holidays" className="underline">holiday</Link> or a day with approved leave. Attendance rules need an enabled{" "}
            <Link href="/settings/schedule" className="underline">work schedule</Link>. Alerts are shown here only; nothing is emailed.
          </>
        }
      />
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
      {error && <ErrorState message={error} onRetry={load} />}

      <Card title="Alerts">
        <Tabs label="Alert status" tabs={VIEWS} value={view} onChange={(v) => (setItems(null), setView(v))} idPrefix="alerts-view">
          {!items && !error && <SkeletonRows label="alerts" />}
          {items?.length === 0 && <EmptyState title="No alerts." hint={view === "open" ? "New alerts appear here when a rule matches." : undefined} />}
          {items && items.length > 0 && (
            <DataTable label="Alerts" head={["Day", "Employee", "Rule", "Detail", "Status"]} minWidth={720}>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap tabular-nums">{dayLabel(a.date)}</td>
                  <td>
                    {a.employee.fullName} <span className="text-xs text-muted">{a.employee.employeeCode}</span>
                  </td>
                  <td>{a.rule.name}</td>
                  <td className="text-sm">{a.detail}</td>
                  <td>
                    {a.acknowledgedAt ? (
                      <StatusBadge tone="neutral">Acknowledged by {a.acknowledgedBy?.email}</StatusBadge>
                    ) : (
                      <Button variant="secondary" className="px-3 py-1" onClick={() => void run(() => api(`/alerts/${a.id}/acknowledge`, { method: "POST" }), "Alert acknowledged.")} aria-label={`Acknowledge ${a.rule.name} for ${a.employee.fullName}`}>
                        Acknowledge
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Tabs>
      </Card>

      <Card title="Add a rule">
        <AddRule onAdded={(r) => (setOk(`Added rule ${r.name}.`), load())} />
      </Card>

      <Card title="Rules">
        {!rules && !error && <SkeletonRows label="rules" />}
        {rules?.length === 0 && <EmptyState title="No rules yet." hint="Add one above." />}
        {rules && rules.length > 0 && (
          <DataTable label="Alert rules" head={["Name", "Kind", "Setting", "Status", "Actions"]} minWidth={720}>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="text-sm">{ALERT_RULE_KIND_LABEL[r.kind]}</td>
                <td className="whitespace-nowrap">{param(r)}</td>
                <td>
                  <StatusBadge tone={r.active ? "success" : "neutral"}>{r.active ? "Active" : "Paused"}</StatusBadge>
                </td>
                <td className="flex gap-2">
                  <Button variant="secondary" className="px-3 py-1" onClick={() => void run(() => api(`/alerts/rules/${r.id}`, { method: "PATCH", body: { active: !r.active } }), `${r.active ? "Paused" : "Resumed"} ${r.name}.`)}>
                    {r.active ? "Pause" : "Resume"}
                  </Button>
                  <Button variant="secondary" className="px-3 py-1" onClick={() => setRemoving(r)} aria-label={`Delete ${r.name}`}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>

      <ConfirmDialog
        open={!!removing}
        title={`Delete ${removing?.name ?? "this rule"}?`}
        description="The rule and all of its alerts are deleted. Pause it instead to keep its alerts."
        confirmLabel="Delete rule"
        tone="danger"
        onConfirm={async () => {
          try {
            await api(`/alerts/rules/${removing!.id}`, { method: "DELETE" });
          } catch (err) {
            throw new Error(errorMessage(err));
          }
          setOk(`Deleted ${removing!.name}.`);
          load();
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

function AddRule({ onAdded }: { onAdded: (r: AlertRule) => void }) {
  const [form, setForm] = useState<{ kind: AlertRuleKind; name: string; atTime: string; threshold: string }>({ kind: "LATE_CLOCK_IN", name: "", atTime: "10:00", threshold: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = createAlertRuleSchema.safeParse({
      kind: form.kind,
      name: form.name,
      ...(form.kind === "NOT_CLOCKED_IN_BY" ? { atTime: form.atTime } : {}),
      ...(form.kind === "IDLE_SHARE_ABOVE" || form.kind === "NO_ACTIVITY_FOR" ? { threshold: Number(form.threshold) } : {}),
    });
    if (!parsed.success) return setError("Check the name and the setting for this kind of rule.");
    setBusy(true);
    setError(null);
    try {
      onAdded(await api<AlertRule>("/alerts/rules", { method: "POST", body: parsed.data }));
      setForm((f) => ({ ...f, name: "", threshold: "" }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Add a rule" onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Kind">
          <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as AlertRuleKind }))} className={inputClass}>
            {ALERT_RULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {ALERT_RULE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input required maxLength={120} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputClass} placeholder="e.g. Late arrivals" />
        </Field>
        {form.kind === "NOT_CLOCKED_IN_BY" && (
          <Field label="Time (employee's local time)">
            <input type="time" required value={form.atTime} onChange={(e) => setForm((f) => ({ ...f, atTime: e.target.value }))} className={inputClass} />
          </Field>
        )}
        {form.kind === "IDLE_SHARE_ABOVE" && (
          <Field label="Idle share above (%)" hint={`Days with under ${IDLE_SHARE_MIN_TRACKED_MINUTES} min tracked are ignored.`}>
            <input type="number" required min={1} max={99} value={form.threshold} onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value }))} className={inputClass} />
          </Field>
        )}
        {form.kind === "NO_ACTIVITY_FOR" && (
          <Field label="Minutes without active input" hint="5 to 720, while clocked in and not on a break.">
            <input type="number" required min={5} max={720} value={form.threshold} onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value }))} className={inputClass} />
          </Field>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <Button type="submit" pending={busy} pendingLabel="Adding…">
          Add rule
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  formatDuration,
  WEBSITE_RULE_CATEGORIES,
  type WebsiteCategory,
  type WebsiteCategoryRule,
  type WebsiteNotificationStatus,
  type WebsiteAuditEntry,
  type WebsitePolicyResponse,
  type WebsiteReport,
} from "@workfolio/shared";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { Badge, buttonClass, Card, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { ConfirmDialog, ErrorState, PageHeader, SkeletonRows } from "@/components/kit";
import { api, errorMessage } from "@/lib/api";
import { EmployeePicker } from "../_components/employee-picker";

type PolicyResponse = WebsitePolicyResponse;
type AuditItem = WebsiteAuditEntry;
const LABEL: Record<WebsiteCategory, string> = { PRODUCTIVE: "Productive", NEUTRAL: "Neutral", UNPRODUCTIVE: "Unproductive", UNCLASSIFIED: "Unclassified" };
const th = "px-4 py-2 font-medium";
const td = "px-4 py-2";
const small = `${secondaryButtonClass} !px-2 !py-1 text-xs`;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

function PolicyCard({ data, acknowledged, onChanged }: { data: PolicyResponse; acknowledged: WebsiteReport["acknowledged"] | null; onChanged: () => void }) {
  const p = data.current;
  const [form, setForm] = useState({ enabled: p.enabled, retentionDays: String(p.retentionDays), noticeVersion: p.noticeVersion, reason: "" });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmRetention, setConfirmRetention] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api("/websites/policy", { method: "PUT", body: { enabled: form.enabled, retentionDays: Number(form.retentionDays), noticeVersion: form.noticeVersion, reason: form.reason } });
      setForm({ ...form, reason: "" });
      setMessage("Saved. The change is recorded with your account and reason.");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card title="Policy">
      <div className="flex flex-col gap-3 text-sm">
        <div>
          Website tracking: <Badge ok={p.enabled}>{p.enabled ? "On" : "Off"}</Badge>{" "}
          {data.history[0] && <span className="text-muted">policy version {data.history[0].seq} · </span>}
          {p.changedBy && <span className="text-muted">since {when(p.effectiveAt!)} by {p.changedBy.email}: {p.reason}</span>}
        </div>
        {!p.enabled && <Notice tone="warning">Website tracking is off. Nothing is recorded, and extensions report that they are not recording.</Notice>}
        {!p.productionApproved && (
          <Notice tone="warning">Production collection is blocked: the server operator has not confirmed HR/Legal approval (WEBSITE_TRACKING_APPROVED). Turning the policy on here is not that approval.</Notice>
        )}
        <Notice tone="warning">
          The website notice ({p.noticeVersion}) is a draft. HR/Legal must approve a notice, and the activity notice and desktop app texts must be checked
          to describe website tracking accurately, before real use.
          {acknowledged && ` ${acknowledged.count} of ${acknowledged.of} current employees have acknowledged the website notice; nothing is recorded for the others.`}
        </Notice>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Website tracking on</label>
          <label className="flex flex-col gap-1"><span className="font-medium">Keep records for (days)</span>
            <input type="number" min={1} max={365} required value={form.retentionDays} onChange={(e) => setForm({ ...form, retentionDays: e.target.value })} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1"><span className="font-medium">Notice version employees must acknowledge</span>
            <input required value={form.noticeVersion} onChange={(e) => setForm({ ...form, noticeVersion: e.target.value })} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1"><span className="font-medium">Reason for this change (kept in the history)</span>
            <input required minLength={3} maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={inputClass} />
          </label>
          {error && <p role="alert" className="text-red-700 sm:col-span-2 dark:text-red-300">{error}</p>}
          {message && <p role="status" className="sm:col-span-2">{message}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" className={buttonClass}>Save policy</button>
            <button type="button" className={secondaryButtonClass} onClick={() => setConfirmRetention(true)}>
              Run retention now
            </button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmRetention}
          title="Run website retention now?"
          tone="danger"
          confirmLabel="Delete now"
          description={`Website records older than ${p.retentionDays} days are permanently deleted. This cannot be undone.`}
          onConfirm={async () => {
            try {
              const r = await api<{ deleted: number }>("/websites/retention/run", { method: "POST", body: { confirm: true } });
              setMessage(`Retention ran: ${r.deleted} record(s) older than ${p.retentionDays} days deleted.`);
            } catch (err) {
              throw new Error(errorMessage(err));
            }
            onChanged();
          }}
          onClose={() => setConfirmRetention(false)}
        />
        <details>
          <summary className="cursor-pointer text-xs text-muted">Policy history</summary>
          <ol className="mt-1 text-xs">
            {data.history.map((h) => <li key={h.seq}>{when(h.effectiveAt)} · {h.changedBy} · {h.enabled ? "on" : "off"}, {h.retentionDays} days, {h.noticeVersion}: {h.reason}</li>)}
          </ol>
        </details>
      </div>
    </Card>
  );
}

function Rules({ rules, onChanged }: { rules: WebsiteCategoryRule[]; onChanged: () => void }) {
  const [form, setForm] = useState({ domain: "", match: "SUBDOMAINS", category: "UNCLASSIFIED" });
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WebsiteCategoryRule | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Card title="Domain categories">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-muted">
          Your own grouping of domains. An exact rule for a domain wins; otherwise the most specific &quot;domain and subdomains&quot; rule; otherwise Unclassified. Nothing is classified automatically, and
          categories are not scores.
        </p>
        <ConfirmDialog
          open={!!removing}
          title={`Remove the rule for ${removing?.domain ?? ""}?`}
          tone="danger"
          confirmLabel="Remove rule"
          description="Matching domains fall back to a less specific rule or Unclassified, also in past reports."
          onConfirm={async () => {
            try {
              await api(`/websites/categories/${removing!.id}`, { method: "DELETE" });
            } catch (err) {
              throw new Error(errorMessage(err));
            }
            onChanged();
          }}
          onClose={() => setRemoving(null)}
        />
        <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left" aria-label="Category rules">
          <thead className="border-b border-border text-xs text-muted uppercase"><tr><th className={th}>Domain</th><th className={th}>Applies to</th><th className={th}>Category</th><th className={th} /></tr></thead>
          <tbody>
            {rules.length === 0 && <tr><td colSpan={4} className={`${td} text-muted`}>No rules: every domain is Unclassified.</td></tr>}
            {rules.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className={`${td} font-mono`}>{r.domain}</td>
                <td className={td}>{r.match === "EXACT" ? "this domain only" : "domain and subdomains"}</td>
                <td className={td}>
                  <select aria-label={`Category for ${r.domain}`} value={r.category} className={inputClass} onChange={(e) => void run(() => api(`/websites/categories/${r.id}`, { method: "PATCH", body: { category: e.target.value } }))}>
                    {WEBSITE_RULE_CATEGORIES.map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}
                  </select>
                </td>
                <td className={td}><button type="button" className={small} onClick={() => setRemoving(r)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <form
          className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => (await api("/websites/categories", { method: "POST", body: form }), setForm({ ...form, domain: "" })));
          }}
        >
          <input aria-label="Domain" placeholder="example.com" required value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} className={inputClass} />
          <select aria-label="Applies to" value={form.match} onChange={(e) => setForm({ ...form, match: e.target.value })} className={inputClass}>
            <option value="SUBDOMAINS">Domain and subdomains</option>
            <option value="EXACT">This domain only</option>
          </select>
          <select aria-label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputClass}>
            {WEBSITE_RULE_CATEGORIES.map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}
          </select>
          <button type="submit" className={secondaryButtonClass}>Add rule</button>
        </form>
        {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      </div>
    </Card>
  );
}

type Section<T> = { data: T } | { error: string } | null;
const settle = <T,>(p: Promise<T>, set: (s: Section<T>) => void) => p.then((data) => set({ data }), (e) => set({ error: errorMessage(e) }));
const ok = <T,>(s: Section<T>) => (s && "data" in s ? s.data : null);
const failed = (s: Section<unknown>) => (s && "error" in s ? s.error : null);

export default function WebsitesPage() {
  const [policyS, setPolicyS] = useState<Section<PolicyResponse>>(null);
  const [rulesS, setRulesS] = useState<Section<WebsiteCategoryRule[]>>(null);
  const [auditS, setAuditS] = useState<Section<AuditItem[]>>(null);
  const [reportS, setReportS] = useState<Section<WebsiteReport>>(null);
  const [notesS, setNotesS] = useState<Section<WebsiteNotificationStatus>>(null);
  const [range, setRange] = useState<Range>(() => weekRange(0));
  const [category, setCategory] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [domain, setDomain] = useState("");

  // Each section loads on its own, so one failing call does not blank the others.
  const loadFixed = useCallback(() => {
    settle(api<PolicyResponse>("/websites/policy"), setPolicyS);
    settle(api<WebsiteCategoryRule[]>("/websites/categories"), setRulesS);
    settle(api<AuditItem[]>("/websites/audit"), setAuditS);
    settle(api<WebsiteNotificationStatus>("/websites/notifications"), setNotesS);
  }, []);
  const loadReport = useCallback(() => {
    const q = new URLSearchParams({ from: range.from, to: range.to });
    if (category) q.set("category", category);
    if (employeeId) q.set("employeeId", employeeId);
    if (domain.trim()) q.set("domain", domain.trim());
    settle(api<WebsiteReport>(`/websites/report?${q}`), setReportS);
  }, [range, category, employeeId, domain]);
  const load = useCallback(() => (loadFixed(), loadReport()), [loadFixed, loadReport]);

  useEffect(loadFixed, [loadFixed]);
  useEffect(loadReport, [loadReport]);

  const policy = ok(policyS);
  const rules = ok(rulesS);
  const audit = ok(auditS);
  const report = ok(reportS);
  const notes = ok(notesS);
  const error = failed(reportS);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Website usage"
        description="Domain names and time only, recorded by a browser extension each employee connects themselves, while they are clocked in and not on a break. No page addresses, searches, titles, content, history or private windows. Recorded time is not a measure of productivity, and nothing here ranks or scores employees."
      />
      {failed(policyS) && <ErrorState title="Could not load the website policy" message={failed(policyS)!} onRetry={loadFixed} />}
      {!policyS && <SkeletonRows label="website policy" />}
      {policy && <PolicyCard data={policy} acknowledged={report?.acknowledged ?? null} onChanged={load} />}

      <Card title="Recorded website time">
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-end gap-3">
              <RangePicker value={range} maxDays={31} onChange={setRange} />
              <label className="flex flex-col gap-1"><span className="text-xs text-muted">Category</span>
                <select aria-label="Category filter" value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                  <option value="">All</option>
                  {WEBSITE_RULE_CATEGORIES.map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1"><span className="text-xs text-muted">Domain (and subdomains)</span>
                <input aria-label="Domain filter" placeholder="example.com" defaultValue={domain} onBlur={(e) => setDomain(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setDomain((e.target as HTMLInputElement).value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              </label>
              <EmployeePicker value={employeeId} onChange={(id) => setEmployeeId(id)} allLabel="All employees" selectLabel="Employee filter" />
            </div>
            {error && <ErrorState title="Could not load recorded website time" message={error} onRetry={loadReport} />}
            {!reportS && <SkeletonRows label="website time" />}
            {report && (
              <>
                <div className="grid gap-3 sm:grid-cols-4" aria-label="Overview">
                  <div className="rounded-md border border-border p-3"><div className="text-xs text-muted">Tracking</div><div className="font-medium">{policy ? (policy.current.enabled ? "On" : "Off") : "—"}</div></div>
                  <div className="rounded-md border border-border p-3"><div className="text-xs text-muted">Recorded time</div><div className="font-medium tabular-nums">{formatDuration(report.totalMs)}</div></div>
                  <div className="rounded-md border border-border p-3"><div className="text-xs text-muted">Employees with activity</div><div className="font-medium tabular-nums" data-testid="web-employees">{report.employeesWithActivity}</div></div>
                  <div className="rounded-md border border-border p-3"><div className="text-xs text-muted">Unclassified</div><div className="font-medium tabular-nums">{formatDuration(report.unclassifiedMs)}</div></div>
                </div>
                <p data-testid="web-totals" className="text-xs text-muted">Total recorded: {formatDuration(report.totalMs)} · Unclassified: {formatDuration(report.unclassifiedMs)} · Recorded duration is browser time on a domain, not productivity. Categories come from your rules at report time and are not part of the recording (max 31 days per report).</p>
                <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left" aria-label="Time by domain">
                  <thead className="border-b border-border text-xs text-muted uppercase"><tr><th className={th}>Domain</th><th className={th}>Category (your rules)</th><th className={th}>Recorded time</th><th className={th}>Employees</th><th className={th}>Intervals</th></tr></thead>
                  <tbody>
                    {report.byDomain.length === 0 && <tr><td colSpan={5} className={`${td} text-muted`}>No website time recorded for these filters.</td></tr>}
                    {report.byDomain.map((d) => (
                      <tr key={d.domain} className="border-b border-border last:border-0"><td className={`${td} font-mono`}>{d.domain}</td><td className={td}>{LABEL[d.category]}</td><td className={`${td} tabular-nums`}>{formatDuration(d.durationMs)}</td><td className={`${td} tabular-nums`}>{d.employees}</td><td className={`${td} tabular-nums`}>{d.intervals}</td></tr>
                    ))}
                  </tbody>
                </table></div>
                <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left" aria-label="Employee daily detail">
                  <thead className="border-b border-border text-xs text-muted uppercase"><tr><th className={th}>Date</th><th className={th}>Employee</th><th className={th}>Domain</th><th className={th}>Recorded time</th><th className={th}>Category</th></tr></thead>
                  <tbody>
                    {report.rows.length === 0 && <tr><td colSpan={5} className={`${td} text-muted`}>Nothing for these filters.</td></tr>}
                    {report.rows.slice(0, 500).map((r) => (
                      <tr key={`${r.date}-${r.employee.id}-${r.domain}`} className="border-b border-border last:border-0"><td className={td}>{r.date}</td><td className={td}>{r.employee.fullName} <span className="font-mono text-xs text-muted">{r.employee.employeeCode}</span></td><td className={`${td} font-mono`}>{r.domain}</td><td className={`${td} tabular-nums`}>{formatDuration(r.durationMs)}</td><td className={td}>{LABEL[r.category]}</td></tr>
                    ))}
                  </tbody>
                </table></div>
                <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left" aria-label="Time by employee">
                  <thead className="border-b border-border text-xs text-muted uppercase"><tr><th className={th}>Employee</th><th className={th}>Recorded time</th><th className={th}>Domains</th></tr></thead>
                  <tbody>
                    {report.byEmployee.length === 0 && <tr><td colSpan={3} className={`${td} text-muted`}>No employees with website time for these filters.</td></tr>}
                    {report.byEmployee.map((r) => (
                      <tr key={r.employee.id} className="border-b border-border last:border-0"><td className={td}>{r.employee.fullName} <span className="font-mono text-xs text-muted">{r.employee.employeeCode}</span></td><td className={`${td} tabular-nums`}>{formatDuration(r.durationMs)}</td><td className={`${td} tabular-nums`}>{r.domains}</td></tr>
                    ))}
                  </tbody>
                </table></div>
              </>
            )}
          </div>
        </Card>

      {failed(notesS) && <ErrorState title="Could not load who acknowledged the website notice" message={failed(notesS)!} onRetry={loadFixed} />}
      {notes && (
        <Card title="Employee notification">
          <p className="mb-2 text-xs text-muted">Who has acknowledged the website notice in force ({notes.noticeVersion}). Nothing is recorded for employees who have not, or who connected no browser.</p>
          <div className="overflow-x-auto"><table className="w-full min-w-[480px] text-left text-sm" aria-label="Notification status">
            <thead className="border-b border-border text-xs text-muted uppercase"><tr><th className={th}>Employee</th><th className={th}>Notice</th><th className={th}>Connected browsers</th></tr></thead>
            <tbody>
              {notes.employees.map((x) => (
                <tr key={x.employee.id} className="border-b border-border last:border-0"><td className={td}>{x.employee.fullName} <span className="font-mono text-xs text-muted">{x.employee.employeeCode}</span></td><td className={td}>{x.acknowledgedAt ? `acknowledged ${when(x.acknowledgedAt)}` : "not acknowledged"}</td><td className={`${td} tabular-nums`}>{x.connectedBrowsers}</td></tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}

      {failed(rulesS) && <ErrorState title="Could not load domain categories" message={failed(rulesS)!} onRetry={loadFixed} />}
      {rules && <Rules rules={rules} onChanged={load} />}
      {failed(auditS) && <ErrorState title="Could not load the website audit log" message={failed(auditS)!} onRetry={loadFixed} />}
      {audit && (
        <Card title="Audit log">
          <ol className="text-xs" aria-label="Website audit log">
            {audit.length === 0 && <li className="text-muted">No changes yet.</li>}
            {audit.map((a, i) => <li key={i}>{when(a.at)} · {a.by ?? "scheduler"} · {a.action.toLowerCase().replaceAll("_", " ")} {Object.keys(a.details).length ? JSON.stringify(a.details) : ""}</li>)}
          </ol>
        </Card>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  SCREENSHOT_LIMITS,
  SETTINGS_LIMITS,
  type ScreenshotRetentionPreview,
  type ScreenshotSettingsInput,
  type ScreenshotSettingsResponse,
  type MonitoringNotice,
  type MonitoringSettingsInput,
  type MonitoringSettingsResponse,
  type RetentionPreview,
} from "@workfolio/shared";
import { Badge, buttonClass, Card, Field, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—");
const range = (k: keyof typeof SETTINGS_LIMITS) => `${SETTINGS_LIMITS[k].min}–${SETTINGS_LIMITS[k].max}`;

export default function SettingsPage() {
  const [data, setData] = useState<MonitoringSettingsResponse | null>(null);
  const [retention, setRetention] = useState<RetentionPreview | null>(null);
  const [shots, setShots] = useState<{ settings: ScreenshotSettingsResponse; retention: ScreenshotRetentionPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      api<MonitoringSettingsResponse>("/settings/monitoring"),
      api<RetentionPreview>("/activity/retention"),
      api<ScreenshotSettingsResponse>("/settings/screenshots"),
      api<ScreenshotRetentionPreview>("/screenshots/retention"),
    ]).then(
      ([s, r, ss, sr]) => (setData(s), setRetention(r), setShots({ settings: ss, retention: sr }), setError(null)),
      (e) => setError(errorMessage(e)),
    );
  }, []);
  useEffect(load, [load]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Activity monitoring settings apply to every desktop within about a minute. Every change is kept with who made it and why.
          These are configurable defaults pending HR/Legal review, not a statement of legal compliance.
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p role="status" className="text-sm text-muted">Loading…</p>}
      {data && <PolicyForm data={data} onSaved={load} />}
      {data && <Notices notices={data.notices} onPublished={load} />}
      {retention && <Retention preview={retention} onRan={load} />}
      {data && shots && <Screenshots data={shots.settings} retention={shots.retention} notices={data.notices} onSaved={load} />}
      {data && <History data={data} />}
    </div>
  );
}

function PolicyForm({ data, onSaved }: { data: MonitoringSettingsResponse; onSaved: () => void }) {
  const e = data.effective;
  const [status, setStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const body: MonitoringSettingsInput = {
      enabled: f.get("enabled") === "on",
      sampleSeconds: Number(f.get("sampleSeconds")),
      idleThresholdSeconds: Number(f.get("idleThresholdSeconds")),
      retentionDays: Number(f.get("retentionDays")),
      retentionApproved: f.get("retentionApproved") === "on",
      noticeVersion: String(f.get("noticeVersion")),
      reason: String(f.get("reason")),
    };
    setSaving(true);
    try {
      await api("/settings/monitoring", { method: "PUT", body });
      setStatus({ tone: "success", text: "Saved. Desktops pick up the change within about a minute." });
      onSaved();
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Activity monitoring">
      <form key={e.effectiveAt ?? "defaults"} onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="enabled" defaultChecked={e.enabled} />
          <span className="font-medium">Monitoring enabled</span>
          <span className="text-xs text-muted">Off: desktops stop collecting and the server refuses activity recorded while off.</span>
        </label>
        <Field label="Sampling interval (seconds)" hint={`${range("sampleSeconds")}. How often the foreground app is checked.`}>
          <input name="sampleSeconds" type="number" required min={SETTINGS_LIMITS.sampleSeconds.min} max={SETTINGS_LIMITS.sampleSeconds.max} defaultValue={e.sampleSeconds} className={inputClass} />
        </Field>
        <Field label="Idle threshold (seconds)" hint={`${range("idleThresholdSeconds")}, at least two sampling intervals. No input this long counts as idle.`}>
          <input name="idleThresholdSeconds" type="number" required min={SETTINGS_LIMITS.idleThresholdSeconds.min} max={SETTINGS_LIMITS.idleThresholdSeconds.max} defaultValue={e.idleThresholdSeconds} className={inputClass} />
        </Field>
        <Field label="Activity retention (days)" hint={`${range("retentionDays")}. Proposed default 30 days.`}>
          <input name="retentionDays" type="number" required min={SETTINGS_LIMITS.retentionDays.min} max={SETTINGS_LIMITS.retentionDays.max} defaultValue={e.retentionDays} className={inputClass} />
        </Field>
        <Field label="Required notice" hint="Employees must acknowledge this version before anything is recorded.">
          <select name="noticeVersion" defaultValue={e.noticeVersion} className={inputClass}>
            {data.notices.map((n) => <option key={n.version} value={n.version}>{n.version}: {n.title}{n.draft ? " (draft)" : ""}</option>)}
          </select>
        </Field>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="retentionApproved" defaultChecked={e.retentionApproved} className="mt-1" />
          <span>
            <span className="font-medium">Retention period approved by HR/Legal</span>
            <span className="block text-xs text-muted">Until this is checked nothing is deleted automatically. Once checked, activity older than the retention period is purged every 6 hours (attendance and corrections are never purged).</span>
          </span>
        </label>
        <div className="sm:col-span-2">
          <Field label="Reason for the change" hint="Kept in the history below.">
            <textarea name="reason" required maxLength={1000} rows={2} className={inputClass} />
          </Field>
        </div>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" disabled={saving} className={buttonClass}>{saving ? "Saving…" : "Save settings"}</button>
          <span className="text-xs text-muted">
            In effect since {e.effectiveAt ? `${when(e.effectiveAt)} by ${e.changedBy?.email}` : "installation (built-in defaults)"}
          </span>
        </div>
        {status && <div className="sm:col-span-2"><Notice tone={status.tone}>{status.text}</Notice></div>}
      </form>
    </Card>
  );
}

function Notices({ notices, onPublished }: { notices: MonitoringNotice[]; onPublished: () => void }) {
  const [status, setStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const f = new FormData(form);
    const body = {
      version: String(f.get("version")),
      title: String(f.get("title")),
      points: String(f.get("points")).split("\n").map((p) => p.trim()).filter(Boolean),
      draft: f.get("draft") === "on",
    };
    try {
      await api("/settings/monitoring/notices", { method: "POST", body });
      setStatus({ tone: "success", text: `Published ${body.version}. Select it as the required notice above to ask employees to acknowledge it.` });
      form.reset();
      onPublished();
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }

  return (
    <Card title="Monitoring notices">
      <p className="mb-3 text-sm text-muted">Notices cannot be edited: changing the wording means publishing a new version, which every employee acknowledges again.</p>
      <ul className="mb-4 flex flex-col gap-3">
        {notices.map((n) => (
          <li key={n.version} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{n.version}</span>
              <span className="font-medium">{n.title}</span>
              {n.draft && <Badge ok={false}>Draft</Badge>}
              <span className="text-xs text-muted">published {when(n.createdAt)}</span>
            </div>
            <ul className="mt-2 list-disc pl-5 text-muted">{n.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </li>
        ))}
      </ul>
      <details>
        <summary className="cursor-pointer text-sm font-medium">Publish a new notice version</summary>
        <form onSubmit={submit} className="mt-3 grid gap-3">
          <Field label="Version" hint="Letters, digits, dots, dashes; e.g. 2026-11-v2">
            <input name="version" required pattern="[\w.\-]{1,64}" className={inputClass} />
          </Field>
          <Field label="Title"><input name="title" required maxLength={200} className={inputClass} /></Field>
          <Field label="Points" hint="One per line (1–20). Describe exactly what is and is not recorded.">
            <textarea name="points" required rows={5} className={inputClass} />
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="draft" defaultChecked /> Draft (not yet reviewed by HR/Legal)</label>
          <div><button type="submit" className={secondaryButtonClass}>Publish notice</button></div>
          {status && <Notice tone={status.tone}>{status.text}</Notice>}
        </form>
      </details>
    </Card>
  );
}

function Retention({ preview, onRan }: { preview: RetentionPreview; onRan: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  async function run() {
    try {
      const r = await api<RetentionPreview>("/activity/retention/run", { method: "POST", body: { confirm: true } });
      setStatus({ tone: "success", text: `Deleted ${r.runs[0]?.deleted ?? 0} activity interval(s).` });
      setConfirmed(false);
      onRan();
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }

  return (
    <Card title="Activity retention (dry run)">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <dt className="text-muted">Retention</dt><dd>{preview.retentionDays} days · {preview.approved ? <Badge ok>Approved</Badge> : <Badge ok={false}>Not approved: nothing is deleted</Badge>}</dd>
        <dt className="text-muted">Would delete activity that ended before</dt><dd>{when(preview.cutoff)}</dd>
        <dt className="text-muted">Intervals that would be deleted now</dt><dd className="tabular-nums">{preview.eligibleIntervals} of {preview.totalIntervals} ({preview.eligibleEmployees} employee(s))</dd>
        <dt className="text-muted">Oldest stored activity</dt><dd>{when(preview.oldestEndedAt)}</dd>
      </dl>
      <p className="mt-3 text-xs text-muted">
        Only activity intervals are purged. Attendance, corrections, consent records and settings history are kept. Unsynced activity
        stays on the employee&apos;s computer and is never deleted there. A purge cannot be undone except from a database backup.
      </p>
      {preview.approved && preview.eligibleIntervals > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Permanently delete {preview.eligibleIntervals} interval(s) now
          </label>
          <button type="button" disabled={!confirmed} onClick={run} className={secondaryButtonClass}>Run purge</button>
        </div>
      )}
      {status && <div className="mt-3"><Notice tone={status.tone}>{status.text}</Notice></div>}
      {preview.runs.length > 0 && (
        <table className="mt-4 w-full text-left text-sm tabular-nums">
          <caption className="mb-1 text-left text-xs text-muted uppercase">Purge history</caption>
          <thead className="text-xs text-muted uppercase"><tr><th className="py-1 font-medium">When</th><th className="font-medium">Cut-off</th><th className="font-medium">Deleted</th><th className="font-medium">By</th></tr></thead>
          <tbody>
            {preview.runs.map((r, i) => (
              <tr key={i} className="border-t border-border"><td className="py-1">{when(r.ranAt)}</td><td>{when(r.cutoff)}</td><td>{r.deleted}</td><td>{r.triggeredBy?.email ?? "Scheduled job"}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function History({ data }: { data: MonitoringSettingsResponse }) {
  return (
    <Card title="Settings history">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm tabular-nums">
          <thead className="text-xs text-muted uppercase">
            <tr>
              <th className="py-2 font-medium">From</th><th className="font-medium">Monitoring</th><th className="font-medium">Sample / idle</th>
              <th className="font-medium">Retention</th><th className="font-medium">Notice</th><th className="font-medium">By</th><th className="font-medium">Reason</th>
            </tr>
          </thead>
          <tbody>
            {data.history.map((h, i) => (
              <tr key={i} className="border-t border-border align-top">
                <td className="py-2">{h.effectiveAt ? when(h.effectiveAt) : "Defaults"}</td>
                <td>{h.enabled ? "On" : "Off"}</td>
                <td>{h.sampleSeconds} s / {h.idleThresholdSeconds} s</td>
                <td>{h.retentionDays} d{h.retentionApproved ? " (approved)" : ""}</td>
                <td className="font-mono text-xs">{h.noticeVersion}</td>
                <td>{h.changedBy?.email ?? "—"}</td>
                <td className="max-w-xs">{h.reason ?? "Built-in defaults (pending approval)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const DELETION_MODE = {
  LOCAL_DEV: "Development storage: files removed from the API server's disk",
  RECYCLE_BIN: "SharePoint recycle bin: still recoverable there until emptied (up to 93 days) — not a permanent deletion",
  PERMANENT: "Permanent delete (bypasses the recycle bin); tenant retention policies may still keep a copy",
} as const;

const shotRange = (k: "intervalSeconds" | "webpQuality" | "maxDimension" | "retentionDays") => `${SCREENSHOT_LIMITS[k].min}–${SCREENSHOT_LIMITS[k].max}`;

function Screenshots({ data, retention, notices, onSaved }: {
  data: ScreenshotSettingsResponse; retention: ScreenshotRetentionPreview; notices: MonitoringNotice[]; onSaved: () => void;
}) {
  const e = data.effective;
  const [status, setStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const body: ScreenshotSettingsInput = {
      enabled: f.get("enabled") === "on",
      intervalSeconds: Number(f.get("intervalSeconds")),
      webpQuality: Number(f.get("webpQuality")),
      maxDimension: Number(f.get("maxDimension")),
      captureScope: "PRIMARY_DISPLAY",
      retentionDays: Number(f.get("retentionDays")),
      retentionApproved: f.get("retentionApproved") === "on",
      noticeVersion: String(f.get("noticeVersion")),
      employeeSelfView: f.get("employeeSelfView") === "on",
      reason: String(f.get("reason")),
    };
    try {
      await api("/settings/screenshots", { method: "PUT", body });
      setStatus({ tone: "success", text: "Saved. Desktops pick up the change within about a minute." });
      onSaved();
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }

  async function purge() {
    try {
      const r = await api<ScreenshotRetentionPreview>("/screenshots/retention/run", { method: "POST", body: { confirm: true } });
      setStatus({ tone: r.failed ? "error" : "success", text: r.failed ? `${r.failed} screenshot(s) could not be deleted from storage; retried on the next run.` : "Expired screenshots deleted from storage." });
      setConfirmed(false);
      onSaved();
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }

  return (
    <Card title="Screenshots">
      {data.storageProvider === "LOCAL_DEV" && (
        <div className="mb-4"><Notice tone="error">Development storage: screenshots are stored on the API server&apos;s disk, not in Microsoft 365. Not for production.</Notice></div>
      )}
      <p className="mb-4 text-sm text-muted">
        Screenshots capture the employee&apos;s whole main screen and may contain personal or sensitive information; nothing is blurred.
        They are taken only while clocked in and not on a break, after the employee acknowledged the screenshot notice and allowed screen recording in macOS.
      </p>
      <form key={e.effectiveAt ?? "defaults"} onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="enabled" defaultChecked={e.enabled} />
          <span className="font-medium">Screenshots enabled</span>
          <span className="text-xs text-muted">Off by default. Off: desktops stop capturing and the server refuses screenshots taken while off.</span>
        </label>
        <Field label="Interval (seconds)" hint={`${shotRange("intervalSeconds")}. Proposed default 300.`}>
          <input name="intervalSeconds" type="number" required min={SCREENSHOT_LIMITS.intervalSeconds.min} max={SCREENSHOT_LIMITS.intervalSeconds.max} defaultValue={e.intervalSeconds} className={inputClass} />
        </Field>
        <Field label="Screenshot retention (days)" hint={`${shotRange("retentionDays")}. Proposed default 30.`}>
          <input name="retentionDays" type="number" required min={SCREENSHOT_LIMITS.retentionDays.min} max={SCREENSHOT_LIMITS.retentionDays.max} defaultValue={e.retentionDays} className={inputClass} />
        </Field>
        <Field label="WebP quality" hint={`${shotRange("webpQuality")}. About 70 keeps text readable.`}>
          <input name="webpQuality" type="number" required min={SCREENSHOT_LIMITS.webpQuality.min} max={SCREENSHOT_LIMITS.webpQuality.max} defaultValue={e.webpQuality} className={inputClass} />
        </Field>
        <Field label="Maximum resolution (px, longest edge)" hint={`${shotRange("maxDimension")}. Larger screens are scaled down.`}>
          <input name="maxDimension" type="number" required min={SCREENSHOT_LIMITS.maxDimension.min} max={SCREENSHOT_LIMITS.maxDimension.max} defaultValue={e.maxDimension} className={inputClass} />
        </Field>
        <Field label="Capture scope" hint="Other monitors are never captured.">
          <input value="Primary display only" readOnly className={inputClass} />
        </Field>
        <Field label="Required screenshot notice" hint="Separate from the activity notice; acknowledged before any capture.">
          <select name="noticeVersion" defaultValue={e.noticeVersion} className={inputClass}>
            {notices.map((n) => <option key={n.version} value={n.version}>{n.version}: {n.title}{n.draft ? " (draft)" : ""}</option>)}
          </select>
        </Field>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="employeeSelfView" defaultChecked={e.employeeSelfView} className="mt-1" />
          <span>
            <span className="font-medium">Employees may view their own screenshots</span>
            <span className="block text-xs text-muted">Admins can always view them; every view is logged. Off: employees cannot list or open their screenshots.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="retentionApproved" defaultChecked={e.retentionApproved} className="mt-1" />
          <span>
            <span className="font-medium">Screenshot retention approved by HR/Legal</span>
            <span className="block text-xs text-muted">Until checked, nothing is deleted. Once checked, screenshots older than the retention period are deleted from storage every 6 hours; their metadata is kept, marked deleted.</span>
          </span>
        </label>
        <div className="sm:col-span-2">
          <Field label="Reason for the change"><textarea name="reason" required maxLength={1000} rows={2} className={inputClass} /></Field>
        </div>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" className={buttonClass}>Save screenshot settings</button>
          <span className="text-xs text-muted">In effect since {e.effectiveAt ? `${when(e.effectiveAt)} by ${e.changedBy?.email}` : "installation (built-in defaults: off)"}</span>
        </div>
      </form>
      <dl className="mt-6 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <dt className="text-muted">Retention (dry run)</dt><dd>{retention.retentionDays} days · {retention.approved ? <Badge ok>Approved</Badge> : <Badge ok={false}>Not approved: nothing is deleted</Badge>}</dd>
        <dt className="text-muted">Would delete screenshots captured before</dt><dd>{when(retention.cutoff)}</dd>
        <dt className="text-muted">Screenshots that would be deleted now</dt><dd className="tabular-nums">{retention.eligible} (stored: {retention.storedTotal}, deleted so far: {retention.deletedTotal})</dd>
        <dt className="text-muted">How storage deletes</dt><dd>{DELETION_MODE[retention.deletionMode]}</dd>
      </dl>
      {retention.runs.length > 0 && (
        <table className="mt-4 w-full text-left text-sm tabular-nums">
          <caption className="mb-1 text-left text-xs text-muted uppercase">Screenshot purge history</caption>
          <thead className="text-xs text-muted uppercase"><tr><th className="py-1 font-medium">When</th><th className="font-medium">Deleted</th><th className="font-medium">Failed (retried)</th><th className="font-medium">Mode</th><th className="font-medium">By</th></tr></thead>
          <tbody>
            {retention.runs.map((r, i) => (
              <tr key={i} className="border-t border-border"><td className="py-1">{when(r.ranAt)}</td><td>{r.deleted}</td><td>{r.failed}</td><td>{r.deletionMode}</td><td>{r.triggeredBy?.email ?? "Scheduled job"}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {retention.approved && retention.eligible > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(ev) => setConfirmed(ev.target.checked)} />
            Permanently delete {retention.eligible} screenshot(s) from storage now
          </label>
          <button type="button" disabled={!confirmed} onClick={purge} className={secondaryButtonClass}>Run purge</button>
        </div>
      )}
      {status && <div className="mt-3"><Notice tone={status.tone}>{status.text}</Notice></div>}
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium">Screenshot settings history</summary>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {data.history.map((h, i) => (
            <li key={i} className="border-t border-border pt-1">
              {h.effectiveAt ? when(h.effectiveAt) : "Defaults"}: {h.enabled ? "on" : "off"}, every {h.intervalSeconds} s, quality {h.webpQuality}, {h.maxDimension} px,
              {" "}{h.retentionDays} d{h.retentionApproved ? " (approved)" : ""}, self-view {h.employeeSelfView ? "on" : "off"}, notice <span className="font-mono text-xs">{h.noticeVersion}</span>
              {" "}· {h.changedBy?.email ?? "—"} · {h.reason ?? "Built-in defaults"}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  can,
  compareVersions,
  UPDATE_POLICIES,
  UPDATE_TARGET_LABEL,
  UPDATE_TARGETS,
  type DesktopRelease,
  type DeviceUpdateStatus,
  type ReleaseStatus,
  type UpdatePolicy,
  type UpdateTarget,
} from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { OS_LABEL } from "@/components/devices";
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, FormField, PageHeader, SkeletonRows, StatCard, StatGrid, StatusBadge, SuccessNotice } from "@/components/kit";
import { Card, formatInZone, inputClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const STATUS_TONE = { DRAFT: "neutral", TESTING: "info", PUBLISHED: "success", DISABLED: "danger" } as const;
const STATUS_LABEL: Record<ReleaseStatus, string> = { DRAFT: "Draft", TESTING: "Testing", PUBLISHED: "Published", DISABLED: "Disabled" };
const POLICY_LABEL: Record<UpdatePolicy, string> = { OPTIONAL: "Optional", RECOMMENDED: "Recommended", MANDATORY: "Mandatory" };
const STATE_LABEL: Record<DeviceUpdateStatus["state"], string> = {
  UP_TO_DATE: "Up to date",
  AVAILABLE: "Update available",
  POSTPONED: "Postponed",
  DOWNLOADING: "Downloading",
  INSTALLING: "Installing",
  FAILED: "Failed",
};
type DeviceRow = Omit<DeviceUpdateStatus, "installedVersion" | "state" | "lastCheckAt"> & { installedVersion: string | null; state: DeviceUpdateStatus["state"] | null; lastCheckAt: string | null };
interface ReleaseEvent { action: string; actor: string | null; reason: string | null; metadata: Record<string, unknown>; at: string }

interface Draft {
  id: string | null;
  version: string;
  notes: string;
  policy: UpdatePolicy;
  postponeHours: number;
  rolloutPercent: number;
  minimumVersion: string;
  artifacts: Record<UpdateTarget, { url: string; signature: string }>;
}
const emptyArtifacts = () => Object.fromEntries(UPDATE_TARGETS.map((t) => [t, { url: "", signature: "" }])) as Draft["artifacts"];
const blank = (): Draft => ({ id: null, version: "", notes: "", policy: "OPTIONAL", postponeHours: 24, rolloutPercent: 100, minimumVersion: "", artifacts: emptyArtifacts() });
const draftOf = (r: DesktopRelease): Draft => ({
  id: r.id,
  version: r.version,
  notes: r.notes,
  policy: r.policy,
  postponeHours: r.postponeHours,
  rolloutPercent: r.rolloutPercent,
  minimumVersion: r.minimumVersion ?? "",
  artifacts: { ...emptyArtifacts(), ...Object.fromEntries(r.artifacts.map((a) => [a.target, { url: a.url, signature: a.signature }])) },
});
const latestOf = (rs: DesktopRelease[], s: ReleaseStatus) => rs.filter((r) => r.status === s).sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;

/**
 * Desktop app releases (docs/desktop/AUTO-UPDATE-RELEASE-GUIDE.md). Admin (IT) drafts, tests and disables;
 * publishing and changing a published release's rollout, policy or minimum version is Super Admin only
 * (updates:publish, enforced by the API). Employees never reach this page.
 */
export default function DesktopUpdatesPage() {
  const { auth } = useAuth();
  const me = auth.status === "authenticated" ? auth.me.user : null;
  const allowed = !!me && can(me, "updates:manage");
  const publisher = !!me && can(me, "updates:publish");
  const [releases, setReleases] = useState<DesktopRelease[] | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ release: DesktopRelease; to: ReleaseStatus } | null>(null);
  const [history, setHistory] = useState<{ release: DesktopRelease; events: ReleaseEvent[] } | null>(null);

  const load = useCallback(async () => {
    if (!allowed) return;
    try {
      const [r, d] = await Promise.all([api<DesktopRelease[]>("/desktop-updates/releases"), api<DeviceRow[]>("/desktop-updates/devices")]);
      setReleases(r);
      setDevices(d);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [allowed]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void load();
  }, [load]);

  const summary = useMemo(() => {
    const rs = releases ?? [];
    const latest = latestOf(rs, "PUBLISHED");
    const minimums = rs.filter((r) => r.status === "PUBLISHED").flatMap((r) => [r.minimumVersion, r.policy === "MANDATORY" ? r.version : null]).filter((v): v is string => !!v);
    const minimum = minimums.sort((a, b) => compareVersions(b, a))[0] ?? null;
    const current = latest ? devices.filter((d) => d.installedVersion && compareVersions(d.installedVersion, latest.version) >= 0).length : 0;
    return { latest, testing: latestOf(rs, "TESTING"), minimum, current, failed: devices.filter((d) => d.state === "FAILED").length };
  }, [releases, devices]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setFormError(null);
    const body = {
      notes: draft.notes,
      policy: draft.policy,
      postponeHours: draft.postponeHours,
      rolloutPercent: draft.rolloutPercent,
      minimumVersion: draft.minimumVersion.trim() || null,
      artifacts: UPDATE_TARGETS.filter((t) => draft.artifacts[t].url.trim()).map((t) => ({ target: t, url: draft.artifacts[t].url.trim(), signature: draft.artifacts[t].signature.trim() })),
    };
    const editing = releases?.find((r) => r.id === draft.id);
    try {
      if (!editing) await api("/desktop-updates/releases", { method: "POST", body: { version: draft.version.trim(), ...body } });
      else {
        // A published release's packages are fixed (the API refuses changes): send them only for other statuses.
        const { artifacts, ...rest } = body;
        await api(`/desktop-updates/releases/${editing.id}`, { method: "PATCH", body: editing.status === "PUBLISHED" ? rest : { ...rest, artifacts } });
      }
      setOk(editing ? `Release ${editing.version} saved.` : `Draft ${draft.version} created.`);
      setDraft(null);
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function showHistory(r: DesktopRelease) {
    try {
      setHistory({ release: r, events: await api<ReleaseEvent[]>(`/desktop-updates/releases/${r.id}/history`) });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!allowed) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Desktop app updates" />
        <EmptyState title="Only administrators manage desktop app releases." />
      </div>
    );
  }

  const editingPublished = !!draft?.id && releases?.find((r) => r.id === draft.id)?.status === "PUBLISHED";
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Desktop app updates"
        description="Releases reach employees' Windows and macOS apps only after a Super Admin publishes them. The server downloads every package and checks its signature before a release can be tested or published."
        actions={<Button onClick={() => { setDraft(blank()); setFormError(null); }}>New release</Button>}
      />
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !releases ? (
        <SkeletonRows label="releases" />
      ) : (
        <>
          <StatGrid>
            <StatCard label="Current approved version" value={summary.latest?.version} reason="Nothing published yet" hint={summary.latest && `${POLICY_LABEL[summary.latest.policy]} · ${summary.latest.rolloutPercent}% rollout`} />
            <StatCard label="In testing" value={summary.testing?.version} reason="None" hint="Offered to administrators' own devices" />
            <StatCard label="Minimum supported version" value={summary.minimum} reason="Not set: every version may keep running" />
            <StatCard label="Devices on the current version" value={summary.latest ? `${summary.current} / ${devices.length}` : null} reason="—" hint={summary.failed ? `${summary.failed} reported a failed update` : undefined} />
          </StatGrid>

          {draft && (
            <Card title={draft.id ? `Edit release ${draft.version}` : "New release"}>
              <form className="flex flex-col gap-4" onSubmit={save} aria-label="Release">
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="Version" required hint="MAJOR.MINOR.PATCH, the version the packages were built and signed with.">
                    {(p) => <input {...p} className={inputClass} value={draft.version} disabled={!!draft.id} onChange={(e) => setDraft({ ...draft, version: e.target.value })} placeholder="0.3.0" />}
                  </FormField>
                  <FormField label="Update policy" hint="Mandatory: every older installation must update before clocking in.">
                    {(p) => (
                      <select {...p} className={inputClass} value={draft.policy} disabled={editingPublished && !publisher} onChange={(e) => setDraft({ ...draft, policy: e.target.value as UpdatePolicy })}>
                        {UPDATE_POLICIES.map((x) => <option key={x} value={x}>{POLICY_LABEL[x]}</option>)}
                      </select>
                    )}
                  </FormField>
                  <FormField label="Rollout percentage" hint="Share of installations offered this release (stable per device). Mandatory updates ignore it for unsupported versions.">
                    {(p) => <input {...p} type="number" min={0} max={100} className={inputClass} value={draft.rolloutPercent} disabled={editingPublished && !publisher} onChange={(e) => setDraft({ ...draft, rolloutPercent: Number(e.target.value) })} />}
                  </FormField>
                  <FormField label="Minimum supported version" hint="Optional. Installations below it must update; leave empty for none.">
                    {(p) => <input {...p} className={inputClass} value={draft.minimumVersion} disabled={editingPublished && !publisher} onChange={(e) => setDraft({ ...draft, minimumVersion: e.target.value })} placeholder="0.2.0" />}
                  </FormField>
                  {draft.policy === "RECOMMENDED" && (
                    <FormField label="Postpone period (hours)" hint="How long Later hides a recommended update.">
                      {(p) => <input {...p} type="number" min={1} max={720} className={inputClass} value={draft.postponeHours} disabled={editingPublished && !publisher} onChange={(e) => setDraft({ ...draft, postponeHours: Number(e.target.value) })} />}
                    </FormField>
                  )}
                </div>
                <FormField label="Release notes" hint="Shown to employees in the app.">
                  {(p) => <textarea {...p} rows={5} className={inputClass} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />}
                </FormField>
                <fieldset className="flex flex-col gap-4" disabled={editingPublished}>
                  <legend className="text-sm font-medium">Signed update packages {editingPublished && <span className="text-muted">(fixed once published)</span>}</legend>
                  <p className="text-xs text-muted">
                    For each platform: the https URL of the updater package (Windows: the NSIS <code>-setup.exe</code>; macOS: the <code>.app.tar.gz</code>) and the full content of its <code>.sig</code> file, both from the release build. Leave a platform empty if this release does not include it.
                  </p>
                  {UPDATE_TARGETS.map((t) => (
                    <div key={t} className="grid gap-2 sm:grid-cols-2">
                      <FormField label={`${UPDATE_TARGET_LABEL[t]} package URL`}>
                        {(p) => <input {...p} className={inputClass} value={draft.artifacts[t].url} onChange={(e) => setDraft({ ...draft, artifacts: { ...draft.artifacts, [t]: { ...draft.artifacts[t], url: e.target.value } } })} placeholder="https://…" />}
                      </FormField>
                      <FormField label={`${UPDATE_TARGET_LABEL[t]} signature`}>
                        {(p) => <textarea {...p} rows={2} className={`${inputClass} font-mono text-xs`} value={draft.artifacts[t].signature} onChange={(e) => setDraft({ ...draft, artifacts: { ...draft.artifacts, [t]: { ...draft.artifacts[t], signature: e.target.value } } })} />}
                      </FormField>
                    </div>
                  ))}
                </fieldset>
                {formError && <p role="alert" className="text-sm font-medium text-danger">{formError}</p>}
                <div className="flex gap-2">
                  <Button type="submit" pending={saving}>{draft.id ? "Save" : "Create draft"}</Button>
                  <Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
                </div>
              </form>
            </Card>
          )}

          <Card title="Releases">
            {releases.length === 0 ? (
              <EmptyState title="No releases yet." hint="Create a draft from a signed release build, test it on your own device, then ask a Super Admin to publish it." />
            ) : (
              <DataTable label="Releases" head={["Version", "Status", "Policy", "Rollout", "Platforms", "Released", ""]} minWidth={860}>
                {releases.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono">{r.version}{r.minimumVersion && <span className="block text-xs text-muted">min {r.minimumVersion}</span>}</td>
                    <td><StatusBadge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusBadge></td>
                    <td>{POLICY_LABEL[r.policy]}</td>
                    <td>{r.rolloutPercent}%</td>
                    <td className="text-xs">
                      {r.artifacts.length === 0 ? <span className="text-muted">None</span> : r.artifacts.map((a) => (
                        <span key={a.target} className="block">{UPDATE_TARGET_LABEL[a.target]} {a.verifiedAt ? "✓ verified" : <span className="text-muted">(not verified)</span>}</span>
                      ))}
                    </td>
                    <td className="text-xs">{r.publishedAt ? formatInZone(r.publishedAt, TZ) : <span className="text-muted">Created {formatInZone(r.createdAt, TZ)}</span>}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        <Button variant="ghost" onClick={() => { setDraft(draftOf(r)); setFormError(null); }}>Edit</Button>
                        {(r.status === "DRAFT" || r.status === "DISABLED" || r.status === "TESTING") && (
                          <Button variant="ghost" onClick={() => setPending({ release: r, to: "TESTING" })}>{r.status === "TESTING" ? "Re-verify" : "Test"}</Button>
                        )}
                        {r.status !== "PUBLISHED" && publisher && <Button variant="ghost" onClick={() => setPending({ release: r, to: "PUBLISHED" })}>Publish</Button>}
                        {r.status !== "DISABLED" && <Button variant="ghost" onClick={() => setPending({ release: r, to: "DISABLED" })}>Disable</Button>}
                        <Button variant="ghost" onClick={() => void showHistory(r)}>History</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
            {!publisher && <p className="mt-3 text-xs text-muted">Publishing, and changing a published release&apos;s rollout, policy or minimum version, is reserved to a Super Admin.</p>}
          </Card>

          {history && (
            <Card title={`History of ${history.release.version}`} actions={<Button variant="ghost" onClick={() => setHistory(null)}>Close</Button>}>
              <DataTable label="Release history" head={["When", "What", "Who", "Reason", "Details"]}>
                {history.events.map((e, i) => (
                  <tr key={i}>
                    <td className="text-xs whitespace-nowrap">{formatInZone(e.at, TZ)}</td>
                    <td>{e.action.replace("RELEASE_", "").toLowerCase()}</td>
                    <td className="text-xs">{e.actor ?? "—"}</td>
                    <td className="text-xs">{e.reason ?? "—"}</td>
                    <td className="font-mono text-xs">{Object.entries(e.metadata).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</td>
                  </tr>
                ))}
              </DataTable>
            </Card>
          )}

          <Card title="Employee devices">
            {devices.length === 0 ? (
              <EmptyState title="No registered devices." />
            ) : (
              <DataTable label="Device update status" head={["Employee", "Device", "Installed", "Available", "Status", "Last check", "Last update"]} minWidth={860}>
                {devices.map((d) => (
                  <tr key={d.deviceId}>
                    <td>{d.employeeName} <span className="font-mono text-xs text-muted">{d.employeeCode}</span></td>
                    <td>{d.deviceName} <span className="text-xs text-muted">{OS_LABEL[d.platform] ?? d.platform}</span></td>
                    <td className="font-mono">{d.installedVersion ?? <span className="text-muted" title="This app version does not report updates">unknown</span>}</td>
                    <td className="font-mono">{d.availableVersion ?? "—"}</td>
                    <td>
                      {d.state ? <StatusBadge tone={d.state === "FAILED" ? "danger" : d.state === "UP_TO_DATE" ? "success" : "warning"}>{STATE_LABEL[d.state]}</StatusBadge> : <span className="text-xs text-muted">Not reported</span>}
                      {d.failureReason && <span className="block text-xs text-danger">{d.failureReason}</span>}
                    </td>
                    <td className="text-xs">{d.lastCheckAt ? formatInZone(d.lastCheckAt, TZ) : "—"}</td>
                    <td className="text-xs">{d.lastUpdatedAt ? `${formatInZone(d.lastUpdatedAt, TZ)} (from ${d.lastUpdatedFrom})` : "—"}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Card>
        </>
      )}

      <ConfirmDialog
        open={!!pending}
        title={pending ? `${pending.to === "PUBLISHED" ? "Publish" : pending.to === "TESTING" ? "Test" : "Disable"} ${pending.release.version}?` : ""}
        description={
          pending?.to === "PUBLISHED"
            ? `The server downloads and verifies every package, then offers ${pending.release.version} to ${pending.release.rolloutPercent}% of installations (${POLICY_LABEL[pending.release.policy].toLowerCase()} update).`
            : pending?.to === "TESTING"
              ? "The server downloads and verifies every package, then offers this release to devices registered by administrators only."
              : "No device is offered this release any more. Devices that already installed it keep it."
        }
        confirmLabel={pending?.to === "PUBLISHED" ? "Publish" : pending?.to === "TESTING" ? "Verify and test" : "Disable"}
        tone={pending?.to === "DISABLED" ? "danger" : "default"}
        reason={{ label: "Reason (recorded in the release history)", minLength: pending?.to === "DISABLED" ? 3 : 0, maxLength: 300 }}
        onConfirm={async (reason) => {
          const p = pending!;
          await api(`/desktop-updates/releases/${p.release.id}/status`, { method: "POST", body: { status: p.to, reason: reason || undefined } });
          setOk(`${p.release.version}: ${STATUS_LABEL[p.to].toLowerCase()}.`);
          await load();
        }}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

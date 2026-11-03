"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Device, Employee, ScreenshotBlurOverridesResponse, SetupToken } from "@workfolio/shared";
import { EmployeeForm, SetupLinkNotice } from "@/components/employee-form";
import { TrackingOverrides } from "@/components/tracking-overrides";
import { ConfirmDialog, ErrorState, PageHeader, SkeletonRows, StatusBadge, SuccessNotice } from "@/components/kit";
import { Card, Field, formatInZone, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, ApiRequestError, errorMessage } from "@/lib/api";

export default function EmployeePage() {
  // useParams suspends for request-time params under cacheComponents.
  return (
    <Suspense fallback={<SkeletonRows label="employee" />}>
      <EmployeeDetail />
    </Suspense>
  );
}

type Confirm = { kind: "status" } | { kind: "setup" } | { kind: "revoke"; device: Device };

function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [loadError, setLoadError] = useState<{ status?: number; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupToken | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, d] = await Promise.all([api<Employee>(`/employees/${id}`), api<Device[]>(`/employees/${id}/devices`)]);
      setEmployee(e);
      setDevices(d);
      setLoadError(null);
    } catch (err) {
      setLoadError({ status: err instanceof ApiRequestError ? err.status : undefined, message: errorMessage(err) });
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  if (loadError) {
    const missing = loadError.status === 404 || loadError.status === 400;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <PageHeader title="Employee" breadcrumbs={[{ label: "Employees", href: "/employees" }, { label: "Employee" }]} />
        <ErrorState
          title={missing ? "Employee not found" : "Could not load this employee"}
          message={missing ? "No employee has this ID. The link may be wrong." : loadError.message}
          onRetry={missing ? undefined : () => void load()}
        />
        <Link href="/employees" className="text-sm text-brand underline">Back to employees</Link>
      </div>
    );
  }
  if (!employee) return <SkeletonRows label="employee" />;

  const disabled = employee.accountStatus === "DISABLED";
  /** Runs a confirmed action; errors are shown inside the dialog (thrown with the API message). */
  const act = (fn: () => Promise<void>, done: string) => async () => {
    try {
      await fn();
      setNotice(done);
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        title={employee.fullName}
        breadcrumbs={[{ label: "Employees", href: "/employees" }, { label: employee.fullName }]}
        description={`${employee.employeeCode} · created ${formatInZone(employee.createdAt, employee.timezone)}`}
        actions={
          <StatusBadge tone={disabled ? "danger" : employee.passwordSet ? "success" : "warning"}>
            {disabled ? "Disabled" : employee.passwordSet ? "Active" : "Pending setup"}
          </StatusBadge>
        }
      />

      <nav aria-label={`Records of ${employee.fullName}`} className="flex flex-wrap gap-2 text-sm">
        <Link href={`/timesheets/${employee.id}`} className={secondaryButtonClass}>Timesheet</Link>
        <Link href={`/activity?employeeId=${employee.id}`} className={secondaryButtonClass}>Activity</Link>
        <Link href={`/screenshots?employeeId=${employee.id}`} className={secondaryButtonClass}>Screenshots</Link>
      </nav>

      <SuccessNotice message={notice} onDismiss={() => setNotice(null)} />
      {setup && <SetupLinkNotice setup={setup} email={employee.email} />}

      <Card title="Details">
        <EmployeeForm
          key={employee.updatedAt}
          initial={employee}
          submitLabel="Save changes"
          onSubmit={async (values) => {
            try {
              setEmployee(await api<Employee>(`/employees/${id}`, { method: "PATCH", body: values }));
              setNotice("Changes saved.");
              return null;
            } catch (err) {
              return errorMessage(err);
            }
          }}
        />
      </Card>

      <Card title="Account access">
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted">
              {disabled ? "Sign-in is blocked for this account." : "Disabling blocks sign-in and ends all active sessions immediately."}
            </p>
            <button type="button" className={secondaryButtonClass} onClick={() => setConfirm({ kind: "status" })}>
              {disabled ? "Enable account" : "Disable account"}
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-muted">
              {employee.passwordSet ? "Issue a new setup link to let the employee choose a new password." : "The employee has not set a password yet."}
            </p>
            <button type="button" className={secondaryButtonClass} onClick={() => setConfirm({ kind: "setup" })}>New setup link</button>
          </div>
        </div>
      </Card>

      <Card title="Registered devices">
        {devices?.length ? (
          <ul className="divide-y divide-border text-sm">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="font-medium">{d.deviceName} <span className="text-muted">({d.platform})</span></span>
                <span className="flex flex-wrap items-center gap-3 text-muted">
                  {d.revokedAt ? `Revoked ${formatInZone(d.revokedAt, employee.timezone)}` : `Last seen ${formatInZone(d.lastSeenAt, employee.timezone)}`}
                  {!d.revokedAt && (
                    <button type="button" className={secondaryButtonClass} onClick={() => setConfirm({ kind: "revoke", device: d })}>Revoke</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No devices registered. A device appears after the employee signs in on the desktop app and registers it. One active device per employee.</p>
        )}
      </Card>

      <ScreenshotBlur employeeId={employee.id} timezone={employee.timezone} />
      <TrackingOverrides employeeId={employee.id} timezone={employee.timezone} />

      {disabled && <Notice tone="info">This account is disabled. Its recorded attendance, activity and screenshots are kept.</Notice>}

      <ConfirmDialog
        open={confirm?.kind === "status"}
        title={disabled ? `Enable ${employee.fullName}'s account?` : `Disable ${employee.fullName}'s account?`}
        tone={disabled ? "default" : "danger"}
        confirmLabel={disabled ? "Enable account" : "Disable account"}
        description={disabled ? "The employee can sign in again with their existing password." : "Sign-in is blocked and every active session (web and desktop) ends immediately. Recorded data is kept."}
        onConfirm={act(async () => {
          setEmployee(await api<Employee>(`/employees/${id}/status`, { method: "PATCH", body: { status: disabled ? "ACTIVE" : "DISABLED" } }));
        }, disabled ? "Account enabled." : "Account disabled and signed out everywhere.")}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === "setup"}
        title="Issue a new setup link?"
        confirmLabel="Issue link"
        description="Any earlier setup link stops working. The new link is shown once, here; deliver it over a trusted company channel."
        onConfirm={act(async () => setSetup(await api<SetupToken>(`/employees/${id}/setup-token`, { method: "POST" })), "New setup link issued; earlier links no longer work.")}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === "revoke"}
        title={`Revoke ${confirm?.kind === "revoke" ? confirm.device.deviceName : "this device"}?`}
        tone="danger"
        confirmLabel="Revoke device"
        description="The device can no longer record attendance or upload activity. The employee can register a new device by signing in on it again."
        onConfirm={act(async () => {
          if (confirm?.kind !== "revoke") return;
          await api(`/devices/${confirm.device.id}/revoke`, { method: "POST" });
          setDevices(await api<Device[]>(`/employees/${id}/devices`));
        }, "Device revoked. It can no longer record attendance; the employee can register a new device.")}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

const BLUR_CHOICE = { org: "Use organisation setting", on: "Always blur", off: "Never blur" } as const;
type BlurChoice = keyof typeof BLUR_CHOICE;
const choiceOf = (b: boolean | null): BlurChoice => (b === null ? "org" : b ? "on" : "off");

/** Per-person whole-image blur override (append-only history; applies to new captures only). */
function ScreenshotBlur({ employeeId, timezone }: { employeeId: string; timezone: string }) {
  const [data, setData] = useState<ScreenshotBlurOverridesResponse | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<ScreenshotBlurOverridesResponse>(`/settings/screenshots/blur-overrides?employeeId=${employeeId}`));
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }, [employeeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const choice = String(f.get("blurChoice")) as BlurChoice;
    try {
      setData(await api<ScreenshotBlurOverridesResponse>(`/settings/screenshots/blur-overrides/${employeeId}`, {
        method: "PUT",
        body: { blur: choice === "org" ? null : choice === "on", reason: String(f.get("blurReason")) },
      }));
      setStatus({ tone: "success", text: "Saved. Applies to screenshots taken from now on; the desktop picks it up within about a minute." });
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }

  return (
    <Card title="Screenshot blur for this person">
      {data ? (
        <form key={data.history[0]?.effectiveAt ?? "none"} onSubmit={submit} className="flex flex-col gap-3 text-sm">
          <p className="text-muted">
            Organisation setting: {data.organisationBlur ? "blur on" : "blur off"}. In force for this person now:{" "}
            <span className="font-medium text-foreground">{data.effective ? "screenshots blurred" : "screenshots not blurred"}</span>.
            Blur is applied on the employee&apos;s computer before upload, to new captures only; earlier screenshots are unchanged.
          </p>
          <Field label="Blur">
            <select name="blurChoice" defaultValue={choiceOf(data.override)} className={inputClass}>
              {Object.entries(BLUR_CHOICE).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
          <Field label="Reason for the change" hint="3 to 500 characters; shown in the audit log.">
            <textarea name="blurReason" required minLength={3} maxLength={500} rows={2} className={inputClass} />
          </Field>
          <div><button type="submit" className={secondaryButtonClass}>Save blur setting</button></div>
          {data.history.length > 0 && (
            <details>
              <summary className="cursor-pointer font-medium">Blur history</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {data.history.map((h, i) => (
                  <li key={i} className="border-t border-border pt-1">
                    {formatInZone(h.effectiveAt, timezone)}: {BLUR_CHOICE[choiceOf(h.blur)]} · {h.changedBy.email} · {h.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </form>
      ) : !status && <SkeletonRows label="blur setting" />}
      {status && <div className="mt-3"><Notice tone={status.tone}>{status.text}</Notice></div>}
    </Card>
  );
}

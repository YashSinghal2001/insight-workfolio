"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Device, Employee, SetupToken } from "@workfolio/shared";
import { EmployeeForm, SetupLinkNotice } from "@/components/employee-form";
import { Badge, Card, formatInZone, Notice, secondaryButtonClass } from "@/components/ui";
import { api, ApiRequestError, errorMessage } from "@/lib/api";

export default function EmployeePage() {
  // useParams suspends for request-time params under cacheComponents.
  return (
    <Suspense fallback={<p role="status" className="text-sm text-muted">Loading…</p>}>
      <EmployeeDetail />
    </Suspense>
  );
}

function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupToken | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, d] = await Promise.all([api<Employee>(`/employees/${id}`), api<Device[]>(`/employees/${id}/devices`)]);
      setEmployee(e);
      setDevices(d);
    } catch (err) {
      setError({ status: err instanceof ApiRequestError ? err.status : undefined, message: errorMessage(err) });
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl">
        <Notice tone="error">{error.status === 404 || error.status === 400 ? "Employee not found." : error.message}</Notice>
        <Link href="/employees" className="mt-4 inline-block text-sm text-brand underline">Back to employees</Link>
      </div>
    );
  }
  if (!employee) return <p role="status" className="text-sm text-muted">Loading…</p>;

  const disabled = employee.accountStatus === "DISABLED";

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice(done);
    } catch (err) {
      setNotice(null);
      setError({ message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <Link href="/employees" className="text-sm text-muted hover:underline">← Employees</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{employee.fullName}</h1>
          <Badge ok={!disabled && employee.passwordSet}>
            {disabled ? "Disabled" : employee.passwordSet ? "Active" : "Pending setup"}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          {employee.employeeCode} · created {formatInZone(employee.createdAt, employee.timezone)}
        </p>
      </div>

      {notice && <Notice tone="success">{notice}</Notice>}
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
              {disabled
                ? "Sign-in is blocked for this account."
                : "Disabling blocks sign-in and ends all active sessions immediately."}
            </p>
            <button
              type="button"
              disabled={busy}
              className={secondaryButtonClass}
              onClick={() =>
                run(async () => {
                  const status = disabled ? "ACTIVE" : "DISABLED";
                  setEmployee(await api<Employee>(`/employees/${id}/status`, { method: "PATCH", body: { status } }));
                }, disabled ? "Account enabled." : "Account disabled and signed out everywhere.")
              }
            >
              {disabled ? "Enable account" : "Disable account"}
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-muted">
              {employee.passwordSet
                ? "Issue a new setup link to let the employee choose a new password."
                : "The employee has not set a password yet."}
            </p>
            <button
              type="button"
              disabled={busy}
              className={secondaryButtonClass}
              onClick={() => run(async () => setSetup(await api<SetupToken>(`/employees/${id}/setup-token`, { method: "POST" })), "New setup link issued; earlier links no longer work.")}
            >
              New setup link
            </button>
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
                    <button
                      type="button"
                      disabled={busy}
                      className={secondaryButtonClass}
                      onClick={() =>
                        run(async () => {
                          await api(`/devices/${d.id}/revoke`, { method: "POST" });
                          setDevices(await api<Device[]>(`/employees/${id}/devices`));
                        }, "Device revoked. It can no longer record attendance; the employee can register a new device.")
                      }
                    >
                      Revoke
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No devices registered. A device appears after the employee signs in on the desktop app and registers it. One active device per employee.</p>
        )}
      </Card>
    </div>
  );
}

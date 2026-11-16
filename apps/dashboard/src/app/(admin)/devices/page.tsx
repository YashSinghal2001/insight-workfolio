"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { DeviceListItem } from "@workfolio/shared";
import { activeDevice, AdminDeviceTable, OS_LABEL } from "@/components/devices";
import { EmptyState, ErrorState, PageHeader, SkeletonRows, StatusBadge, SuccessNotice } from "@/components/kit";
import { Card, inputClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Admin: every employee's registered devices, which one holds the sign-in, and device actions. */
export default function DevicesPage() {
  const [devices, setDevices] = useState<DeviceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      setDevices(await api<DeviceListItem[]>("/devices"));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void load();
  }, [load]);

  const employees = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const groups = new Map<string, DeviceListItem[]>();
    for (const d of devices ?? []) {
      if (q && ![d.employeeName, d.email, d.employeeCode, d.deviceName].some((v) => v.toLowerCase().includes(q))) continue;
      groups.set(d.employeeId, [...(groups.get(d.employeeId) ?? []), d]);
    }
    return [...groups.values()];
  }, [devices, filter]);

  const tz = zone();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Devices"
        description="Employees may register several Windows and macOS devices; each account is signed in on at most one at a time. Revoking a device affects only that device."
      />
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !devices ? (
        <SkeletonRows label="devices" />
      ) : (
        <>
          <label className="flex max-w-sm flex-col gap-1 text-sm">
            <span className="font-medium">Find an employee or device</span>
            <input className={inputClass} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name, email, code or device" />
          </label>
          {employees.length === 0 ? (
            <EmptyState title={devices.length ? "No match." : "No devices registered yet."} hint="A device appears after an employee signs in on the desktop app and registers it." />
          ) : (
            employees.map((list) => {
              const e = list[0]!;
              const active = activeDevice(list);
              return (
                <Card key={e.employeeId} title={e.employeeName}>
                  <div className="flex flex-col gap-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                      <Link href={`/employees/${e.employeeId}`} className="text-brand underline">{e.email}</Link>
                      <span className="font-mono">{e.employeeCode}</span>
                      <span>· {list.length} registered</span>
                      {active ? (
                        <StatusBadge tone="success">Signed in on {active.deviceName} ({OS_LABEL[active.platform] ?? active.platform})</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">Not signed in</StatusBadge>
                      )}
                    </p>
                    <AdminDeviceTable
                      devices={list}
                      timeZone={tz}
                      onChanged={async (message) => {
                        await load();
                        setOk(message);
                      }}
                    />
                  </div>
                </Card>
              );
            })
          )}
        </>
      )}
    </div>
  );
}

"use client";

import { Fragment, useState } from "react";
import type { Device, DeviceHistoryEvent } from "@workfolio/shared";
import { ConfirmDialog, DataTable, StatusBadge } from "@/components/kit";
import { formatInZone, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

export const OS_LABEL: Record<string, string> = { macos: "macOS", windows: "Windows" };
const os = (p: string) => OS_LABEL[p] ?? p;
const when = (iso: string | null, tz: string) => (iso ? formatInZone(iso, tz) : "Never");

/** Registration and sign-in are separate: only one device per account is ever "Active". */
export function DeviceStatusBadge({ device }: { device: Device }) {
  if (device.status === "ACTIVE") return <StatusBadge tone="success">Active · signed in</StatusBadge>;
  if (device.status === "INACTIVE") return <StatusBadge tone="neutral">Registered · signed out</StatusBadge>;
  if (device.reregistrationApprovedAt) return <StatusBadge tone="info">Revoked · re-registration approved</StatusBadge>;
  return <StatusBadge tone="danger">Revoked</StatusBadge>;
}

export const activeDevice = (devices: Device[]) => devices.find((d) => d.status === "ACTIVE") ?? null;

const HISTORY_LABEL: Record<string, string> = {
  DEVICE_REGISTERED: "Registered",
  DEVICE_REVOKED: "Revoked",
  DEVICE_REREGISTRATION_APPROVED: "Re-registration approved",
  DEVICE_REREGISTERED: "Registered again",
  DEVICE_SESSION_STARTED: "Signed in",
  DEVICE_SESSION_ENDED: "Signed out / sign-in ended",
  DEVICE_SESSION_TAKEOVER: "Sign-in switched to this device",
  DEVICE_SESSION_REJECTED: "Sign-in refused",
};

type Action = "revoke" | "end" | "approve";
const ACTION: Record<Action, { title: (d: Device) => string; label: string; danger?: boolean; description: string; path: string; done: string }> = {
  revoke: {
    title: (d) => `Revoke ${d.deviceName}?`,
    label: "Revoke device",
    danger: true,
    description: "Its sign-in ends at once and it can no longer record attendance or upload activity. The employee's other devices are not affected. Its history is kept; it can be registered again only after you approve it.",
    path: "revoke",
    done: "Device revoked. Other devices are unaffected.",
  },
  end: {
    title: (d) => `End the sign-in on ${d.deviceName}?`,
    label: "End sign-in",
    description: "The device is signed out (it stays registered). The employee can then sign in on any of their registered devices.",
    path: "end-session",
    done: "Sign-in ended; the device stays registered.",
  },
  approve: {
    title: (d) => `Allow ${d.deviceName} to be registered again?`,
    label: "Approve re-registration",
    description: "Nothing is reactivated now and no old sign-in is restored. The employee must sign in on that computer with their password and register it again.",
    path: "allow-reregistration",
    done: "Re-registration approved. The employee must register the device again from the desktop app.",
  },
};

/**
 * Admin table of one employee's devices with revoke / end sign-in / approve re-registration and the
 * per-device history. The API enforces who may do what (e.g. a Super Admin's devices); errors show in the dialog.
 */
export function AdminDeviceTable({ devices, timeZone, onChanged }: { devices: Device[]; timeZone: string; onChanged: (message: string) => void }) {
  const [confirm, setConfirm] = useState<{ action: Action; device: Device } | null>(null);
  const [history, setHistory] = useState<{ id: string; events: DeviceHistoryEvent[] | null; error?: string } | null>(null);

  async function toggleHistory(id: string) {
    if (history?.id === id) return setHistory(null);
    setHistory({ id, events: null });
    try {
      setHistory({ id, events: await api<DeviceHistoryEvent[]>(`/devices/${id}/history`) });
    } catch (err) {
      setHistory({ id, events: [], error: errorMessage(err) });
    }
  }

  const a = confirm ? ACTION[confirm.action] : null;
  return (
    <>
      <DataTable label="Devices" head={["Device", "OS", "Status", "Registered", "Last seen", "Last sign-in", "Actions"]}>
        {devices.map((d) => (
          <Fragment key={d.id}>
            <tr>
              <td className="font-medium">{d.deviceName}</td>
              <td>{os(d.platform)}</td>
              <td><DeviceStatusBadge device={d} /></td>
              <td className="whitespace-nowrap">{formatInZone(d.registeredAt, timeZone)}</td>
              <td className="whitespace-nowrap">{when(d.lastSeenAt, timeZone)}</td>
              <td className="whitespace-nowrap">{when(d.lastLoginAt, timeZone)}</td>
              <td>
                <span className="flex flex-wrap gap-2">
                  {d.status === "ACTIVE" && <button type="button" className={secondaryButtonClass} onClick={() => setConfirm({ action: "end", device: d })}>End sign-in</button>}
                  {d.status !== "REVOKED" && <button type="button" className={secondaryButtonClass} onClick={() => setConfirm({ action: "revoke", device: d })}>Revoke</button>}
                  {d.status === "REVOKED" && !d.reregistrationApprovedAt && <button type="button" className={secondaryButtonClass} onClick={() => setConfirm({ action: "approve", device: d })}>Approve re-registration</button>}
                  <button type="button" className={secondaryButtonClass} aria-expanded={history?.id === d.id} onClick={() => void toggleHistory(d.id)}>History</button>
                </span>
              </td>
            </tr>
            {history?.id === d.id && (
              <tr>
                <td colSpan={7} className="bg-surface-muted text-xs">
                  {history.error ? (
                    <span role="alert">Could not load the history: {history.error}</span>
                  ) : history.events === null ? (
                    <span role="status">Loading history…</span>
                  ) : history.events.length === 0 ? (
                    "No recorded events."
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {history.events.map((e) => (
                        <li key={e.id}>
                          {formatInZone(e.createdAt, timeZone)} · {HISTORY_LABEL[e.action] ?? e.action}
                          {e.actorEmail ? ` · by ${e.actorEmail}` : ""}
                          {e.reason ? ` · reason: ${e.reason}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </DataTable>
      <ConfirmDialog
        open={!!confirm}
        title={confirm && a ? a.title(confirm.device) : ""}
        tone={a?.danger ? "danger" : "default"}
        confirmLabel={a?.label ?? ""}
        description={a?.description}
        reason={confirm?.action === "revoke" ? { label: "Reason (kept in the audit log)", minLength: 3, maxLength: 500, placeholder: "e.g. laptop lost, replaced, reimaged" } : undefined}
        onConfirm={async (reason) => {
          if (!confirm || !a) return;
          await api(`/devices/${confirm.device.id}/${a.path}`, { method: "POST", body: confirm.action === "revoke" ? { reason } : undefined });
          setHistory(null);
          onChanged(a.done);
        }}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

/** The employee's own devices: which one holds the sign-in, and signing that one out remotely. */
export function MyDeviceTable({ devices, timeZone, onChanged }: { devices: Device[]; timeZone: string; onChanged: () => void }) {
  const [confirm, setConfirm] = useState<Device | null>(null);
  return (
    <>
      <DataTable label="My devices" head={["Device", "OS", "Status", "Registered", "Last seen", ""]}>
        {devices.map((d) => (
          <tr key={d.id}>
            <td className="font-medium">{d.deviceName}</td>
            <td>{os(d.platform)}</td>
            <td><DeviceStatusBadge device={d} /></td>
            <td className="whitespace-nowrap">{formatInZone(d.registeredAt, timeZone)}</td>
            <td className="whitespace-nowrap">{when(d.lastSeenAt, timeZone)}</td>
            <td>{d.status === "ACTIVE" && <button type="button" className={secondaryButtonClass} onClick={() => setConfirm(d)}>Sign out this device</button>}</td>
          </tr>
        ))}
      </DataTable>
      <ConfirmDialog
        open={!!confirm}
        title={`Sign out ${confirm?.deviceName ?? "this device"}?`}
        confirmLabel="Sign out device"
        description="Use this when that computer is off, unreachable or you are switching computers. Unsynced records stay on it and upload when you next sign in there. The device stays registered."
        onConfirm={async () => {
          if (!confirm) return;
          await api(`/devices/mine/${confirm.id}/end-session`, { method: "POST" });
          onChanged();
        }}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

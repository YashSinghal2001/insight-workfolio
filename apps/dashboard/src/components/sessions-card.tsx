"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RevokeSessionsResponse, SessionClient, SessionInfo } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { DataTable, StatusBadge } from "@/components/kit";
import { Loaded, useApi } from "@/components/my-ui";
import { Card, formatInZone, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const CLIENT: Record<SessionClient, string> = { WEB: "Web", DESKTOP: "Desktop app" };
const small = `${secondaryButtonClass} px-3 py-1`;
const danger = `${small} border-red-300 text-red-700 dark:border-red-900 dark:text-red-300`;

/** What is waiting for an inline confirmation: one session's revoke, or one of the bulk actions. */
type Pending = { kind: "one"; id: string } | { kind: "others" } | { kind: "all" } | null;

/** The signed-in account's own sessions, with revoke / sign out others / sign out everywhere. */
export function SessionsCard({ timeZone }: { timeZone?: string }) {
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sessions = useApi<SessionInfo[]>("/auth/sessions");
  const { logout } = useAuth();
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: "success", text: await action() });
      setPending(null);
      await sessions.reload();
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const revokeOne = (id: string) =>
    run(async () => {
      await api(`/auth/sessions/${id}`, { method: "DELETE" });
      return "Session signed out.";
    });
  const revokeOthers = () =>
    run(async () => {
      const { revoked } = await api<RevokeSessionsResponse>("/auth/sessions/revoke-others", { method: "POST" });
      return revoked === 0 ? "There were no other sessions." : `Signed out ${revoked} other session${revoked === 1 ? "" : "s"}.`;
    });
  async function signOutEverywhere() {
    setBusy(true);
    setMessage(null);
    try {
      await api<RevokeSessionsResponse>("/auth/sessions/revoke-all", { method: "POST" });
      await logout();
      router.replace("/login");
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
      setBusy(false);
    }
  }

  const confirm = (text: string, onConfirm: () => void, label: string) => (
    <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={text}>
      <span className="text-xs">{text}</span>
      <button type="button" className={danger} disabled={busy} onClick={onConfirm}>{label}</button>
      <button type="button" className={small} disabled={busy} onClick={() => setPending(null)}>Cancel</button>
    </span>
  );

  return (
    <Card title="Sessions">
      <div className="flex flex-col gap-4 text-sm">
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <Loaded load={sessions.load} reload={sessions.reload} label="your sessions">
          {(list) => (
            <DataTable label="My sessions" head={["Client", "Signed in", "Last renewed", "Expires", <span key="a" className="sr-only">Actions</span>]}>
              {list.map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap">
                    {s.client ? CLIENT[s.client] : "Unknown"} {s.current && <StatusBadge tone="info">This session</StatusBadge>}
                  </td>
                  <td className="whitespace-nowrap">{formatInZone(s.createdAt, tz)}</td>
                  <td className="whitespace-nowrap">{s.refreshedAt ? formatInZone(s.refreshedAt, tz) : "Not yet"}</td>
                  <td className="whitespace-nowrap">{formatInZone(s.expiresAt, tz)}</td>
                  <td className="text-right">
                    {s.current ? null : pending?.kind === "one" && pending.id === s.id ? (
                      confirm("Sign out this session?", () => void revokeOne(s.id), "Revoke")
                    ) : (
                      <button type="button" className={small} disabled={busy} onClick={() => setPending({ kind: "one", id: s.id })}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Loaded>
        <div className="flex flex-wrap items-center gap-3">
          {pending?.kind === "others" ? (
            confirm("Sign out all your other sessions?", () => void revokeOthers(), "Sign out others")
          ) : (
            <button type="button" className={small} disabled={busy} onClick={() => setPending({ kind: "others" })}>Sign out other sessions</button>
          )}
          {pending?.kind === "all" ? (
            confirm("Sign out everywhere, including here?", () => void signOutEverywhere(), "Sign out everywhere")
          ) : (
            <button type="button" className={danger} disabled={busy} onClick={() => setPending({ kind: "all" })}>Sign out everywhere</button>
          )}
        </div>
        <p className="text-xs text-muted">Signing out a session ends it immediately, including the desktop app. Times shown in {tz}.</p>
      </div>
    </Card>
  );
}

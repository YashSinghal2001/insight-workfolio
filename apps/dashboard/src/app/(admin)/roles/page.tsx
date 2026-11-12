"use client";

import { useCallback, useEffect, useState } from "react";
import { can, PLATFORM_ROLE_LABEL, PLATFORM_ROLES, type PlatformRole, type RoleChange, type RoleUser } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { DataTable, EmptyState, ErrorState, PageHeader, SkeletonRows, SuccessNotice } from "@/components/kit";
import { Card, inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Role identities. Super Admin only: the API refuses /roles/* to everyone else, so nothing is requested or offered. */
export default function RolesPage() {
  const { auth } = useAuth();
  const [users, setUsers] = useState<RoleUser[] | null>(null);
  const [history, setHistory] = useState<RoleChange[]>([]);
  const [draft, setDraft] = useState<Record<string, { role: PlatformRole; reason: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const me = auth.status === "authenticated" ? auth.me.user : null;
  const superAdmin = me?.platformRole === "SUPER_ADMIN";
  const allowed = !!me && can(me, "roles:manage");
  // Only a Super Admin may grant or remove Super Admin; the API enforces this too.
  const offered = PLATFORM_ROLES.filter((r) => superAdmin || r !== "SUPER_ADMIN");

  const load = useCallback(async () => {
    if (!allowed) return;
    try {
      const [u, h] = await Promise.all([api<RoleUser[]>("/roles/users"), api<RoleChange[]>("/roles/history")]);
      setUsers(u);
      setHistory(h);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [allowed]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  async function save(u: RoleUser) {
    const d = draft[u.id]!;
    setError(null);
    setMessage(null);
    try {
      await api(`/roles/users/${u.id}`, { method: "PATCH", body: { platformRole: d.role, reason: d.reason } });
      setMessage(`${u.email} is now ${PLATFORM_ROLE_LABEL[d.role]}.`);
      setDraft({ ...draft, [u.id]: undefined! });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!allowed) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <PageHeader title="Roles" />
        <EmptyState title="Only a Super Admin can view or change roles." hint="Ask a Super Admin if an account's role needs to change." />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Roles"
        description="Only a Super Admin can view or change roles. An Admin (IT) has the same monitoring access but cannot manage roles, delete screenshots or timelapses, run retention purges or connect storage. Nobody can change their own role, and the last active administrator or Super Admin cannot be removed. Every change needs a reason and is kept below."
      />
      {error && <ErrorState message={error} onRetry={() => (setError(null), void load())} />}
      <SuccessNotice message={message} onDismiss={() => setMessage(null)} />
      {!users && !error && <SkeletonRows label="accounts" />}
      {users && (
        <Card title="Accounts">
          <DataTable label="Accounts and roles" head={["Account", "Role", "Change to", "Reason", ""]} minWidth={720}>
            {users.map((u) => {
              const d = draft[u.id];
              const self = u.id === me?.id;
              const locked = !superAdmin && u.platformRole === "SUPER_ADMIN";
              return (
                <tr key={u.id} className="align-top">
                  <td>{u.email}{u.employee && <span className="ml-1 text-xs text-muted">{u.employee.fullName} ({u.employee.employeeCode})</span>}{u.status === "DISABLED" && <span className="ml-1 text-xs text-muted">disabled</span>}</td>
                  <td className="font-medium">{PLATFORM_ROLE_LABEL[u.platformRole]}</td>
                  <td>
                    {self ? (
                      <span className="text-xs text-muted">your own role cannot be changed here</span>
                    ) : locked ? (
                      <span className="text-xs text-muted">Only a Super Admin can change a Super Admin account</span>
                    ) : (
                      <select aria-label={`New role for ${u.email}`} value={d?.role ?? u.platformRole} className={inputClass} onChange={(e) => setDraft({ ...draft, [u.id]: { role: e.target.value as PlatformRole, reason: d?.reason ?? "" } })}>
                        {offered.map((r) => <option key={r} value={r}>{PLATFORM_ROLE_LABEL[r]}</option>)}
                      </select>
                    )}
                  </td>
                  <td>{!self && !locked && d && d.role !== u.platformRole && <input aria-label={`Reason for ${u.email}`} value={d.reason} minLength={3} maxLength={500} onChange={(e) => setDraft({ ...draft, [u.id]: { ...d, reason: e.target.value } })} className={inputClass} />}</td>
                  <td>
                    {!self && !locked && d && d.role !== u.platformRole && (
                      <span className="flex flex-col gap-1">
                        <button type="button" disabled={d.reason.trim().length < 3} className={secondaryButtonClass} onClick={() => void save(u)}>Save</button>
                        {d.reason.trim().length < 3 && <span className="text-xs text-muted">Give a reason (3+ characters).</span>}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </Card>
      )}
      <Card title="Role history">
        <ol className="text-xs" aria-label="Role history">
          {history.length === 0 && <li className="text-muted">No role changes yet.</li>}
          {history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString("en-GB")} ({TZ}) · {h.by.email} changed {h.target.email}: {PLATFORM_ROLE_LABEL[h.from]} → {PLATFORM_ROLE_LABEL[h.to]} ({h.reason})</li>)}
        </ol>
      </Card>
    </div>
  );
}

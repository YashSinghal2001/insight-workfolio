"use client";

import { useEffect, useState } from "react";
import { addDays, can, AUDIT_RANGE_MAX_DAYS, AUDIT_SOURCES, localDate, type AuditEvent, type AuditSource, type Paginated, type RoleUser } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { DataTable, EmptyState, ErrorState, PageHeader, Pagination, SkeletonRows } from "@/components/kit";
import { RangePicker, type Range } from "@/components/range-picker";
import { Card, Field, formatInZone, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 50;
const SOURCE_LABEL: Record<AuditSource, string> = {
  ACCOUNT: "Account",
  ROLE: "Role",
  WEBSITE: "Website",
  PROJECT: "Project",
  SCREENSHOT_ACCESS: "Screenshot access",
  SCREENSHOT_DELETION: "Screenshot deletion",
  TIMELAPSE_ACCESS: "Timelapse access",
  SETTINGS: "Settings",
};
/** Readable names for actions whose code alone is unclear; the code is always shown too. */
const ACTION_LABEL: Record<string, string> = {
  WORK_SCHEDULE_CHANGED: "Work schedule changed",
  APP_CATEGORY_RULE_ADDED: "Application label added",
  APP_CATEGORY_RULE_CHANGED: "Application label changed",
  APP_CATEGORY_RULE_REMOVED: "Application label removed",
  SCREENSHOT_DELETED_BY_RETENTION: "Screenshot deleted by scheduled retention",
  EMPLOYEE_ACTIVITY_SUMMARY_VIEWED: "Employee activity summary viewed",
  EMPLOYEE_ATTENDANCE_VIEWED: "Employee attendance viewed",
  EMPLOYEE_ATTENDANCE_EXPORTED: "Employee attendance exported",
  EMPLOYEE_SCREENSHOTS_VIEWED: "Employee screenshots viewed",
  EMPLOYEE_ACTIVITY_TIMELINE_VIEWED: "Employee activity timeline viewed",
  EMPLOYEE_ATTENDANCE_TIMELINE_VIEWED: "Employee attendance timeline viewed",
};
const SOURCE_TONE: Record<AuditSource, string> = {
  ACCOUNT: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  ROLE: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  WEBSITE: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  PROJECT: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  SCREENSHOT_ACCESS: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  SCREENSHOT_DELETION: "bg-red-500/15 text-red-700 dark:text-red-300",
  TIMELAPSE_ACCESS: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
  SETTINGS: "bg-gray-500/15 text-gray-700 dark:text-gray-300",
};
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const lastWeek = (): Range => {
  const to = localDate(Date.now(), zone());
  return { from: addDays(to, -6), to };
};

/** Read-only, unified audit log (account, role, website, project, screenshot/timelapse access, settings). */
export default function AuditPage() {
  const [range, setRange] = useState<Range>(lastWeek);
  const [source, setSource] = useState<AuditSource | "">("");
  const [action, setAction] = useState("");
  const [actorId, setActorId] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<RoleUser[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [data, setData] = useState<Paginated<AuditEvent> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const tz = zone();

  // The account list is /roles/users, which only a Super Admin may read; others get no Actor/Target filter.
  const { auth } = useAuth();
  const canListAccounts = auth.status === "authenticated" && can(auth.me.user, "roles:manage");
  useEffect(() => {
    if (canListAccounts) api<RoleUser[]>("/roles/users").then(setUsers, (e) => (setUsers([]), setUsersError(errorMessage(e))));
  }, [canListAccounts]);

  useEffect(() => {
    const params = new URLSearchParams({ from: range.from, to: range.to, timeZone: tz, page: String(page), pageSize: String(PAGE_SIZE) });
    if (source) params.set("source", source);
    if (action.trim()) params.set("action", action.trim());
    if (actorId) params.set("actorId", actorId);
    if (targetUserId) params.set("targetUserId", targetUserId);
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    setLoading(true);
    setError(null);
    api<Paginated<AuditEvent>>(`/audit?${params}`)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && (setError(errorMessage(err)), setData(null)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range, source, action, actorId, targetUserId, page, tz, retry]);

  // Any filter change goes back to page 1.
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const userSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <Field label={label}>
      <select value={value} className={inputClass} disabled={!!usersError || !canListAccounts} onChange={(e) => onChange(e.target.value)}>
        <option value="">Anyone</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
      </select>
    </Field>
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Audit log"
        description={
          <>
            A read-only view of recorded events: account and session changes, role changes, website rules, projects, screenshot and timelapse access, screenshot deletions,
            and settings versions (including work schedule and application label changes).
            Nothing here can be edited or deleted. Only recorded events are shown: account auditing started with this release (migration 0015), so earlier account actions
            were not recorded. Times are in your time zone ({tz}).
          </>
        }
      />

      <Card title="Filters">
        <div className="flex flex-col gap-4">
          <RangePicker value={range} onChange={filter(setRange)} maxDays={AUDIT_RANGE_MAX_DAYS} timeZone={tz} />
          {!canListAccounts && <p className="text-xs text-muted">The Actor and Target filters need the account list, which only a Super Admin can read. The other filters work as usual.</p>}
          {usersError && <Notice tone="warning">The account list could not be loaded ({usersError}), so the Actor and Target filters are unavailable.</Notice>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Source">
              <select value={source} className={inputClass} onChange={(e) => filter(setSource)(e.target.value as AuditSource | "")}>
                <option value="">All sources</option>
                {AUDIT_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
              </select>
            </Field>
            <Field label="Action" hint="Exact name, e.g. ROLE_CHANGED or VIEW">
              <input value={action} className={inputClass} onChange={(e) => filter(setAction)(e.target.value)} />
            </Field>
            {userSelect("Actor", actorId, filter(setActorId))}
            {userSelect("Target", targetUserId, filter(setTargetUserId))}
          </div>
          <button type="button" className={`${secondaryButtonClass} self-start`} onClick={() => { setRange(lastWeek()); setSource(""); setAction(""); setActorId(""); setTargetUserId(""); setPage(1); }}>
            Reset filters
          </button>
        </div>
      </Card>

      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {loading && !data && <SkeletonRows label="audit events" />}
      {!loading && data && data.items.length === 0 && <EmptyState title="No recorded events match these filters." hint="Try a wider date range or reset the filters." />}
      {data && data.items.length > 0 && (
        <section aria-label="Events" className="flex flex-col gap-3">
          <p className="text-sm text-muted" aria-live="polite">{loading ? "Updating…" : `${data.total} event${data.total === 1 ? "" : "s"}`}</p>
          <DataTable label="Audit events" head={["Time", "Source", "Action", "Actor", "Target", "Resource", "Reason", "Details"]} minWidth={960}>
            {data.items.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="whitespace-nowrap">{formatInZone(e.at, tz)}</td>
                <td><span className={`inline-block rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap ${SOURCE_TONE[e.source] ?? SOURCE_TONE.SETTINGS}`}>{SOURCE_LABEL[e.source] ?? e.source}</span></td>
                <td className="text-xs">
                  {ACTION_LABEL[e.action] && <span className="block">{ACTION_LABEL[e.action]}</span>}
                  <span className="font-mono">{e.action}</span>
                </td>
                <td>{e.actor ? e.actor.email : <span className="text-muted">{e.action === "SCREENSHOT_DELETED_BY_RETENTION" ? "System (retention)" : "System"}</span>}</td>
                <td>{e.target?.email ?? <span className="text-muted">—</span>}</td>
                <td className="text-xs">{e.resource ? <>{e.resource.type}{e.resource.id && <span className="block font-mono text-muted break-all">{e.resource.id}</span>}</> : "—"}</td>
                <td>{e.reason ?? <span className="text-muted">—</span>}</td>
                <td className="text-xs">
                  {Object.keys(e.details).length === 0 ? <span className="text-muted">—</span> : (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-2">
                      {Object.entries(e.details).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-all">{String(v)}</dd></div>)}
                    </dl>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
          <Pagination page={data.page} pageCount={pages} onPage={setPage} />
        </section>
      )}
    </div>
  );
}

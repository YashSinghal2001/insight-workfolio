"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { PLATFORM_ROLE_LABEL, PLATFORM_ROLES, type Employee, type Paginated, type Team } from "@workfolio/shared";
import { INVITATION_LABEL } from "@/components/employee-form";
import { DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SkeletonRows, StatusBadge } from "@/components/kit";
import { buttonClass, inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 20;
const PLATFORM_LABEL: Record<string, string> = { macos: "macOS", windows: "Windows" };
interface Query { q: string; teamId: string; role: string; platform: string; appVersion: string; page: number }
const EMPTY: Query = { q: "", teamId: "", role: "", platform: "", appVersion: "", page: 1 };

export default function EmployeesPage() {
  const [query, setQuery] = useState<Query>(EMPTY);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [data, setData] = useState<Paginated<Employee> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(PAGE_SIZE) });
    for (const k of ["q", "teamId", "role", "platform", "appVersion"] as const) if (query[k]) params.set(k, query[k]);
    api<Paginated<Employee>>(`/employees?${params}`).then(
      (r) => active && (setData(r), setError(null)),
      (e) => active && setError(errorMessage(e)),
    );
    return () => {
      active = false;
    };
  }, [query, retry]);

  // Team choices; without them (an API error) the team filter is simply not offered.
  useEffect(() => {
    api<Team[]>("/teams").then(setTeams, () => setTeams(null));
  }, []);

  function onSearch(e: FormEvent<HTMLFormElement>) {
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? "").trim();
    setData(null);
    setQuery({ q: get("q"), teamId: get("teamId"), role: get("role"), platform: get("platform"), appVersion: get("appVersion"), page: 1 });
  }
  const filtered = Object.entries(query).some(([k, v]) => k !== "page" && v);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader title="Employees" description={data ? `${data.total} total` : undefined} actions={<Link href="/employees/new" className={buttonClass}>Add employee</Link>} />

      <FilterBar label="Search employees" onSubmit={onSearch}>
        <input name="q" type="search" placeholder="Search name, email or employee code" aria-label="Search employees" maxLength={100} className={`${inputClass} w-full sm:w-auto sm:flex-1`} />
        {teams && (
          <select name="teamId" aria-label="Team" defaultValue="" className={`${inputClass} w-full sm:w-auto`}>
            <option value="">All teams</option>
            {teams.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <select name="role" aria-label="Role" defaultValue="" className={`${inputClass} w-full sm:w-auto`}>
          <option value="">All roles</option>
          {PLATFORM_ROLES.map((r) => <option key={r} value={r}>{PLATFORM_ROLE_LABEL[r]}</option>)}
        </select>
        <select name="platform" aria-label="Platform" defaultValue="" className={`${inputClass} w-full sm:w-auto`}>
          <option value="">All platforms</option>
          <option value="macos">macOS</option>
          <option value="windows">Windows</option>
        </select>
        <input name="appVersion" aria-label="App version" placeholder="App version, e.g. 0.3.0" pattern="\d+\.\d+\.\d+" title="MAJOR.MINOR.PATCH, for example 0.3.0" maxLength={20} className={`${inputClass} w-full sm:w-44`} />
        <button type="submit" className={secondaryButtonClass}>Apply</button>
      </FilterBar>

      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="employees" />}
      {data?.items.length === 0 && (
        <EmptyState
          title={filtered ? "No employees match these filters." : "No employees enrolled yet."}
          action={!filtered && <Link href="/employees/new" className={buttonClass}>Add employee</Link>}
        />
      )}
      {data && data.items.length > 0 && (
        <DataTable label="Employees" head={["Name", "Code", "Email", "Team", "Role", "App version", "Employment", "Account"]} minWidth={960}>
          {data.items.map((e) => (
            <tr key={e.id}>
              <td><Link href={`/employees/${e.id}`} className="font-medium text-brand hover:underline">{e.fullName}</Link></td>
              <td className="font-mono text-xs">{e.employeeCode}</td>
              <td className="break-all">{e.email}</td>
              <td>{e.teams?.length ? e.teams.map((t) => t.name).join(", ") : <span className="text-muted">—</span>}</td>
              <td>{e.platformRole ? PLATFORM_ROLE_LABEL[e.platformRole] : "—"}</td>
              <td className="tabular-nums">
                {e.appVersion ?? <span className="text-muted">—</span>}
                {e.platforms?.length > 0 && <span className="block text-xs text-muted">{e.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(", ")}</span>}
              </td>
              <td className="capitalize">{e.employmentStatus.replace("_", " ").toLowerCase()}</td>
              <td>
                <StatusBadge tone={e.accountStatus === "DISABLED" ? "danger" : e.passwordSet ? "success" : "warning"}>
                  {e.accountStatus === "DISABLED" ? "Disabled" : e.passwordSet ? "Active" : "Pending setup"}
                </StatusBadge>
                {!e.passwordSet && e.invitation && e.accountStatus !== "DISABLED" && (
                  <span className="ml-1">
                    <StatusBadge tone={INVITATION_LABEL[e.invitation.status].tone}>{INVITATION_LABEL[e.invitation.status].label}</StatusBadge>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      {data && pages > 1 && <Pagination page={query.page} pageCount={pages} onPage={(page) => setQuery((q) => ({ ...q, page }))} />}
    </div>
  );
}

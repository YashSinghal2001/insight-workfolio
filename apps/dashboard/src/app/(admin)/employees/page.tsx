"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { Employee, Paginated } from "@workfolio/shared";
import { INVITATION_LABEL } from "@/components/employee-form";
import { DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SkeletonRows, StatusBadge } from "@/components/kit";
import { buttonClass, inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 20;

export default function EmployeesPage() {
  const [query, setQuery] = useState({ q: "", page: 1 });
  const [data, setData] = useState<Paginated<Employee> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(PAGE_SIZE) });
    if (query.q) params.set("q", query.q);
    api<Paginated<Employee>>(`/employees?${params}`).then(
      (r) => active && (setData(r), setError(null)),
      (e) => active && setError(errorMessage(e)),
    );
    return () => {
      active = false;
    };
  }, [query, retry]);

  function onSearch(e: FormEvent<HTMLFormElement>) {
    setData(null);
    setQuery({ q: String(new FormData(e.currentTarget).get("q") ?? "").trim(), page: 1 });
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader title="Employees" description={data ? `${data.total} total` : undefined} actions={<Link href="/employees/new" className={buttonClass}>Add employee</Link>} />

      <FilterBar label="Search employees" onSubmit={onSearch}>
        <input name="q" type="search" placeholder="Search name, email or employee code" aria-label="Search employees" maxLength={100} className={`${inputClass} flex-1 sm:w-auto`} />
        <button type="submit" className={secondaryButtonClass}>Search</button>
      </FilterBar>

      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="employees" />}
      {data?.items.length === 0 && (
        <EmptyState
          title={query.q ? "No employees match your search." : "No employees enrolled yet."}
          action={!query.q && <Link href="/employees/new" className={buttonClass}>Add employee</Link>}
        />
      )}
      {data && data.items.length > 0 && (
        <DataTable label="Employees" head={["Name", "Code", "Email", "Employment", "Account"]} minWidth={640}>
          {data.items.map((e) => (
            <tr key={e.id}>
              <td><Link href={`/employees/${e.id}`} className="font-medium text-brand hover:underline">{e.fullName}</Link></td>
              <td className="font-mono text-xs">{e.employeeCode}</td>
              <td className="break-all">{e.email}</td>
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

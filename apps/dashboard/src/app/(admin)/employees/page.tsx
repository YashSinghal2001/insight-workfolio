"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { Employee, Paginated } from "@workfolio/shared";
import { Badge, buttonClass, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 20;

export default function EmployeesPage() {
  const [query, setQuery] = useState({ q: "", page: 1 });
  const [data, setData] = useState<Paginated<Employee> | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, [query]);

  function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setData(null);
    setQuery({ q: String(new FormData(e.currentTarget).get("q") ?? "").trim(), page: 1 });
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Employees</h1>
          <p className="mt-1 text-sm text-muted">{data ? `${data.total} total` : " "}</p>
        </div>
        <Link href="/employees/new" className={buttonClass}>Add employee</Link>
      </div>

      <form role="search" onSubmit={onSearch} className="flex gap-2">
        <input name="q" type="search" placeholder="Search name, email or employee code" aria-label="Search employees" maxLength={100} className={inputClass} />
        <button type="submit" className={secondaryButtonClass}>Search</button>
      </form>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Name</th>
              <th scope="col" className="px-4 py-3 font-medium">Code</th>
              <th scope="col" className="px-4 py-3 font-medium">Email</th>
              <th scope="col" className="px-4 py-3 font-medium">Employment</th>
              <th scope="col" className="px-4 py-3 font-medium">Account</th>
            </tr>
          </thead>
          <tbody>
            {!data && !error && (
              <tr><td colSpan={5} role="status" className="px-4 py-8 text-center text-muted">Loading…</td></tr>
            )}
            {data?.items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">
                {query.q ? "No employees match your search." : "No employees enrolled yet."}
              </td></tr>
            )}
            {data?.items.map((e) => (
              <tr key={e.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3">
                  <Link href={`/employees/${e.id}`} className="font-medium text-brand hover:underline">{e.fullName}</Link>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{e.employeeCode}</td>
                <td className="px-4 py-3">{e.email}</td>
                <td className="px-4 py-3 capitalize">{e.employmentStatus.replace("_", " ").toLowerCase()}</td>
                <td className="px-4 py-3">
                  <Badge ok={e.accountStatus === "ACTIVE" && e.passwordSet}>
                    {e.accountStatus === "DISABLED" ? "Disabled" : e.passwordSet ? "Active" : "Pending setup"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && pages > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          <button type="button" disabled={query.page <= 1} onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))} className={secondaryButtonClass}>
            Previous
          </button>
          <span className="text-muted">Page {query.page} of {pages}</span>
          <button type="button" disabled={query.page >= pages} onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))} className={secondaryButtonClass}>
            Next
          </button>
        </nav>
      )}
    </div>
  );
}

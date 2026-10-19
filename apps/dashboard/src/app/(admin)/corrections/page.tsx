"use client";

import { useCallback, useEffect, useState } from "react";
import type { CorrectionRequest, CorrectionStatus, Paginated } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { CorrectionCard } from "@/components/correction-card";
import { Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const FILTERS: { label: string; status?: CorrectionStatus }[] = [
  { label: "Pending", status: "PENDING" },
  { label: "Approved", status: "APPROVED" },
  { label: "Rejected", status: "REJECTED" },
  { label: "All" },
];
const PAGE_SIZE = 20;

export default function CorrectionsPage() {
  const { auth } = useAuth();
  const [filter, setFilter] = useState<CorrectionStatus | undefined>("PENDING");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<CorrectionRequest> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (filter) params.set("status", filter);
    try {
      setData(await api<Paginated<CorrectionRequest>>(`/attendance/corrections?${params}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [filter, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / filter change
    load();
  }, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Corrections</h1>
        <p className="mt-1 text-sm text-muted">
          Employees request changes to their attendance. Approving applies the change and records the before and after values;
          the original device events are never altered. You cannot review your own requests.
        </p>
      </div>

      <div role="tablist" aria-label="Status" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            role="tab"
            aria-selected={filter === f.status}
            className={`${secondaryButtonClass} ${filter === f.status ? "border-brand text-brand" : ""}`}
            onClick={() => (setData(null), setPage(1), setFilter(f.status))}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p role="status" className="text-sm text-muted">Loading…</p>}
      {data?.items.length === 0 && <p className="text-sm text-muted">{filter === "PENDING" ? "No requests waiting for review." : "No requests."}</p>}
      {data && auth.status === "authenticated" &&
        data.items.map((r) => <CorrectionCard key={r.id} request={r} currentUserId={auth.me.user.id} onChanged={() => void load()} />)}

      {data && pages > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={secondaryButtonClass}>Previous</button>
          <span className="text-muted">Page {page} of {pages}</span>
          <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className={secondaryButtonClass}>Next</button>
        </nav>
      )}
    </div>
  );
}

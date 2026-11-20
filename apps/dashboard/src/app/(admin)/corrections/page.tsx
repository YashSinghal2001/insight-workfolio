"use client";

import { useCallback, useEffect, useState } from "react";
import type { CorrectionRequest, CorrectionStatus, Paginated } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { CorrectionCard } from "@/components/correction-card";
import { EmptyState, ErrorState, PageHeader, Pagination, SkeletonRows, Tabs } from "@/components/kit";
import { api, errorMessage } from "@/lib/api";

const FILTERS = [
  { id: "PENDING", label: "Pending" },
  { id: "APPROVED", label: "Approved" },
  { id: "REJECTED", label: "Rejected" },
  { id: "ALL", label: "All" },
] as const satisfies readonly { id: CorrectionStatus | "ALL"; label: string }[];
type Filter = (typeof FILTERS)[number]["id"];
const PAGE_SIZE = 20;

export default function CorrectionsPage() {
  const { auth } = useAuth();
  const [filter, setFilter] = useState<Filter>("PENDING");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<CorrectionRequest> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (filter !== "ALL") params.set("status", filter);
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
      <PageHeader
        title="Corrections"
        about="Employees request changes to their attendance. Approving applies the change and records the before and after values; the original device events are never altered. You cannot review your own requests."
      />
      <Tabs label="Status" tabs={FILTERS} value={filter} idPrefix="corr" onChange={(f) => (setData(null), setPage(1), setFilter(f))}>
        <div className="flex flex-col gap-4">
          {error && <ErrorState message={error} onRetry={() => void load()} />}
          {!data && !error && <SkeletonRows label="correction requests" />}
          {data?.items.length === 0 && <EmptyState title={filter === "PENDING" ? "No requests waiting for review." : "No requests."} />}
          {data && auth.status === "authenticated" &&
            data.items.map((r) => <CorrectionCard key={r.id} request={r} currentUserId={auth.me.user.id} onChanged={() => void load()} />)}
          {data && pages > 1 && <Pagination page={page} pageCount={pages} onPage={setPage} />}
        </div>
      </Tabs>
    </div>
  );
}

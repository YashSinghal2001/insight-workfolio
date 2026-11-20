"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { leaveWhen, type LeaveRequest, type LeaveStatus, type Paginated } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { ConfirmDialog, EmptyState, ErrorState, PageHeader, Pagination, SkeletonRows, StatusBadge, Tabs, type Tone } from "@/components/kit";
import { buttonClass, formatInZone, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { LeaveSummary } from "../_components/leave-summary";
import { LeaveBalances } from "./leave-balances";
import { LeaveTypes } from "./leave-types";

const FILTERS = [
  { id: "PENDING", label: "Pending" },
  { id: "APPROVED", label: "Approved" },
  { id: "REJECTED", label: "Rejected" },
  { id: "CANCELLED", label: "Cancelled" },
  { id: "ALL", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];
const VIEWS = [
  { id: "requests", label: "Requests" },
  { id: "summary", label: "Summary" },
  { id: "balances", label: "Balances" },
  { id: "types", label: "Leave types" },
] as const;
const STATUS: Record<LeaveStatus, Tone> = { PENDING: "warning", APPROVED: "success", REJECTED: "danger", CANCELLED: "neutral" };
const ACTION = { SUBMITTED: "Requested", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled" } as const;
const PAGE_SIZE = 20;

/** One leave request with its history. Pending requests from someone else can be approved or rejected; the note is optional. */
function LeaveCard({ request, currentUserId, onChanged }: { request: LeaveRequest; currentUserId: string; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const tz = request.employee.timezone;

  const send = (action: "approve" | "reject") => api<LeaveRequest>(`/leave/${request.id}/${action}`, { method: "POST", body: note.trim() ? { note } : {} });
  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await send("approve");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-lg border border-border bg-surface p-4 text-sm" aria-label={`${request.employee.fullName}: ${leaveWhen(request)}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={`/timesheets/${request.employee.id}`} className="font-medium text-brand hover:underline">{request.employee.fullName}</Link>{" "}
          <span className="font-mono text-xs text-muted">{request.employee.employeeCode}</span>
          <span className="ml-2 font-medium">{leaveWhen(request)}</span>
        </div>
        <StatusBadge tone={STATUS[request.status]}>{request.status.charAt(0) + request.status.slice(1).toLowerCase()}</StatusBadge>
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted">Leave type</dt>
        <dd>{request.leaveType.name} ({request.leaveType.paid ? "paid" : "unpaid"})</dd>
        <dt className="text-muted">Employee&apos;s reason</dt>
        <dd>{request.reason ?? <span className="text-muted">None given</span>}</dd>
        <dt className="text-muted">History</dt>
        <dd>
          <ol>
            {request.history.map((h) => (
              <li key={h.action}>
                {ACTION[h.action]} {formatInZone(h.at, tz)} by {h.by.email}{h.note ? `: ${h.note}` : ""}
              </li>
            ))}
          </ol>
        </dd>
      </dl>
      <p className="mt-2 text-xs text-muted">Dates are in the employee&apos;s time zone ({tz}).</p>

      {request.status === "PENDING" &&
        (request.requestedBy.id === currentUserId ? (
          <p className="mt-3 text-xs text-muted">This is your own request; another administrator must decide it.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Note to the employee (optional; kept with the decision)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className={inputClass} />
            </label>
            {error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={busy} className={buttonClass} onClick={() => void approve()}>Approve</button>
              <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => setRejecting(true)}>Reject</button>
            </div>
            <ConfirmDialog
              open={rejecting}
              title={`Reject ${request.employee.fullName}'s leave request?`}
              tone="danger"
              confirmLabel="Reject request"
              description={<>{leaveWhen(request)}. {note.trim() ? <>Your note will be kept with the decision: “{note.trim()}”.</> : "No note will be sent; you can cancel and add one first."} A decision cannot be undone here.</>}
              onConfirm={async () => {
                try {
                  await send("reject");
                } catch (err) {
                  throw new Error(errorMessage(err));
                }
                onChanged();
              }}
              onClose={() => setRejecting(false)}
            />
          </div>
        ))}
    </article>
  );
}

export default function LeavePage() {
  const { auth } = useAuth();
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("requests");
  const [filter, setFilter] = useState<Filter>("PENDING");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<LeaveRequest> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (filter !== "ALL") params.set("status", filter);
    try {
      setData(await api<Paginated<LeaveRequest>>(`/leave?${params}`));
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
        title="Leave"
        about="Employees request leave from the desktop app or the web panel (My leave). Approving or rejecting records your decision only: attendance and timesheets are not changed, and approved leave shows in the daily attendance view. You cannot decide your own requests."
      />
      <Notice tone="info">Approval is refused when it would exceed the employee&apos;s balance for the leave type (yearly days, or monthly hours for short leave). Requests from the desktop app use the General type.</Notice>

      <Tabs label="Leave views" tabs={VIEWS} value={view} idPrefix="leave-view" onChange={setView}>
      {view === "summary" ? (
        <LeaveSummary />
      ) : view === "balances" ? (
        <LeaveBalances />
      ) : view === "types" ? (
        <LeaveTypes />
      ) : (
      <Tabs label="Status" tabs={FILTERS} value={filter} idPrefix="leave" onChange={(f) => (setData(null), setPage(1), setFilter(f))}>
        <div className="flex flex-col gap-4">
          {error && <ErrorState message={error} onRetry={() => void load()} />}
          {!data && !error && <SkeletonRows label="leave requests" />}
          {data?.items.length === 0 && <EmptyState title={filter === "PENDING" ? "No leave requests waiting for a decision." : "No leave requests."} />}
          {data && auth.status === "authenticated" &&
            data.items.map((r) => <LeaveCard key={r.id} request={r} currentUserId={auth.me.user.id} onChanged={() => void load()} />)}
          {data && pages > 1 && <Pagination page={page} pageCount={pages} onPage={setPage} />}
        </div>
      </Tabs>
      )}
      </Tabs>
    </div>
  );
}

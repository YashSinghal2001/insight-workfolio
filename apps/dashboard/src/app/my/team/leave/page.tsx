"use client";

import { useState } from "react";
import { leaveWhen, type LeaveRequest, type LeaveStatus, type Paginated } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { ConfirmDialog, EmptyState, PageHeader, StatusBadge, Tabs, type Tone } from "@/components/kit";
import { useApi } from "@/components/my-ui";
import { buttonClass, formatInZone, inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { Loaded } from "../../_components/states";

const FILTERS = [
  { id: "PENDING", label: "Pending" },
  { id: "APPROVED", label: "Approved" },
  { id: "REJECTED", label: "Rejected" },
  { id: "ALL", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];
const STATUS: Record<LeaveStatus, Tone> = { PENDING: "warning", APPROVED: "success", REJECTED: "danger", CANCELLED: "neutral" };

/** One request; a pending request of a member (never the head's own) can be approved or rejected. */
function Request({ request, myUserId, onChanged }: { request: LeaveRequest; myUserId: string; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const send = (action: "approve" | "reject") => api<LeaveRequest>(`/leave/${request.id}/${action}`, { method: "POST", body: note.trim() ? { note } : {} });
  const tz = request.employee.timezone;

  return (
    <article className="rounded-lg border border-border bg-surface p-4 text-sm" aria-label={`${request.employee.fullName}: ${leaveWhen(request)}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">{request.employee.fullName}</span> <span className="font-mono text-xs text-muted">{request.employee.employeeCode}</span>
          <span className="ml-2 font-medium">{leaveWhen(request)}</span>
        </div>
        <StatusBadge tone={STATUS[request.status]}>{request.status.charAt(0) + request.status.slice(1).toLowerCase()}</StatusBadge>
      </div>
      <p className="mt-2">{request.leaveType.name} ({request.leaveType.paid ? "paid" : "unpaid"}) · {request.reason ?? <span className="text-muted">No reason given</span>}</p>
      <p className="mt-1 text-xs text-muted">
        Requested {formatInZone(request.requestedAt, tz)}
        {request.decidedBy && request.decidedAt ? ` · ${request.status.toLowerCase()} ${formatInZone(request.decidedAt, tz)} by ${request.decidedBy.email}` : ""}
        {request.decisionNote ? `: ${request.decisionNote}` : ""}
      </p>
      {request.status === "PENDING" &&
        (request.requestedBy.id === myUserId ? (
          <p className="mt-3 text-xs text-muted">This is your own request; an administrator decides it.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Note to the member (optional; kept with the decision)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className={inputClass} />
            </label>
            {error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                className={buttonClass}
                onClick={async () => {
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
                }}
              >
                Approve
              </button>
              <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => setRejecting(true)}>Reject</button>
            </div>
            <ConfirmDialog
              open={rejecting}
              title={`Reject ${request.employee.fullName}'s leave request?`}
              tone="danger"
              confirmLabel="Reject request"
              description={<>{leaveWhen(request)}. A decision cannot be undone here.</>}
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

/** Leave requests of the head's team members; approve/reject is checked again by the API (team only, never own). */
export default function TeamLeavePage() {
  const { auth } = useAuth();
  const [filter, setFilter] = useState<Filter>("PENDING");
  const { load, reload } = useApi<Paginated<LeaveRequest>>(`/leave?pageSize=100${filter === "ALL" ? "" : `&status=${filter}`}`);
  const myUserId = auth.status === "authenticated" ? auth.me.user.id : "";
  return (
    <>
      <PageHeader
        title="Team leave"
        description="Leave requests of your team members. Approving or rejecting records your decision only; approval is refused when it would exceed the member's balance. You cannot decide your own requests."
      />
      <Tabs label="Status" tabs={FILTERS} value={filter} idPrefix="team-leave" onChange={setFilter}>
        <div className="flex flex-col gap-4">
          <Loaded load={load} reload={reload} label="team leave requests">
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState title={filter === "PENDING" ? "No leave requests waiting for a decision." : "No leave requests."} />
              ) : (
                page.items.map((r) => <Request key={r.id} request={r} myUserId={myUserId} onChanged={() => void reload()} />)
              )
            }
          </Loaded>
        </div>
      </Tabs>
    </>
  );
}

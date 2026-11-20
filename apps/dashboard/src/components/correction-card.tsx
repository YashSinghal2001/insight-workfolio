"use client";

import { useState } from "react";
import Link from "next/link";
import type { CorrectionRequest, CorrectionValues } from "@workfolio/shared";
import { Button, StatusBadge, type Tone } from "@/components/kit";
import { formatInZone, inputClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const TYPE = {
  MISSING_CLOCK_IN: "Missing shift",
  MISSING_CLOCK_OUT: "Missing clock-out",
  ATTENDANCE_TIME: "Wrong clock-in/out time",
  BREAK_TIME: "Wrong break time",
} as const;

const STATUS: Record<CorrectionRequest["status"], { label: string; tone: Tone }> = {
  PENDING: { label: "Pending", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
};

const label = (key: string) => key.replace(/At$/, "").replace(/([A-Z])/g, " $1").toLowerCase();

function ValuesList({ values, tz }: { values: CorrectionValues | null; tz: string }) {
  if (!values) return <span className="text-muted">No shift (added by this correction)</span>;
  return (
    <ul className="text-xs">
      <li>Clock-in: {formatInZone(values.clockInAt, tz)}</li>
      <li>Clock-out: {values.clockOutAt ? formatInZone(values.clockOutAt, tz) : "open"}</li>
      {values.breaks.map((b, i) => (
        <li key={i}>Break: {formatInZone(b.startedAt, tz)} → {b.endedAt ? formatInZone(b.endedAt, tz) : "open"}</li>
      ))}
    </ul>
  );
}

/**
 * One correction request with its full audit trail. Pending requests from someone else can be
 * approved or rejected here; both need a reason. The requester (an employee, or an admin filing for one)
 * sees the controls disabled: the API refuses self-review.
 */
export function CorrectionCard({ request, currentUserId, onChanged }: { request: CorrectionRequest; currentUserId: string; onChanged: (r: CorrectionRequest) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tz = request.employee.timezone;
  const own = request.requestedBy.id === currentUserId;

  async function review(action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      onChanged(await api<CorrectionRequest>(`/attendance/corrections/${request.id}/${action}`, { method: "POST", body: { reason } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-lg border border-border bg-surface p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={`/timesheets/${request.employee.id}`} className="font-medium text-brand hover:underline">{request.employee.fullName}</Link>{" "}
          <span className="font-mono text-xs text-muted">{request.employee.employeeCode}</span>
          <span className="ml-2 font-medium">{TYPE[request.type]}</span>
        </div>
        <StatusBadge tone={STATUS[request.status].tone}>{STATUS[request.status].label}</StatusBadge>
      </div>

      <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted">Requested change</dt>
        <dd>{Object.entries(request.proposed).map(([k, v]) => <div key={k}>{label(k)}: {formatInZone(v, tz)}</div>)}</dd>
        <dt className="text-muted">Reason given</dt>
        <dd>{request.reason}</dd>
        <dt className="text-muted">Requested</dt>
        <dd>
          {formatInZone(request.requestedAt, tz)}
          <div className="text-xs text-muted">Filed by {own ? "you" : request.requestedBy.email} for {request.employee.fullName}</div>
        </dd>
        {request.reviewedBy && (
          <>
            <dt className="text-muted">Reviewed</dt>
            <dd>{formatInZone(request.reviewedAt, tz)} by {request.reviewedBy.email}: {request.reviewReason}</dd>
          </>
        )}
      </dl>

      {request.applied && (
        <div className="mt-3 grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
          <div><div className="mb-1 text-xs font-medium text-muted uppercase">Before</div><ValuesList values={request.applied.original} tz={tz} /></div>
          <div><div className="mb-1 text-xs font-medium text-muted uppercase">After</div><ValuesList values={request.applied.corrected} tz={tz} /></div>
        </div>
      )}

      {request.status === "PENDING" && (
        <div className="mt-3 flex flex-col gap-2">
          {!own && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Reason for your decision (kept in the audit trail)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className={inputClass} />
              {reason.trim().length < 3 && <span className="text-xs text-muted">Enter at least 3 characters to approve or reject.</span>}
            </label>
          )}
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          <div className="flex flex-wrap items-start gap-2">
            <Button
              disabledReason={own ? "You filed this request, so a different administrator must review it." : null}
              disabled={reason.trim().length < 3}
              pending={busy}
              onClick={() => review("approve")}
            >
              Approve and apply
            </Button>
            <Button variant="secondary" disabled={own || busy || reason.trim().length < 3} onClick={() => review("reject")}>Reject</Button>
          </div>
        </div>
      )}
    </article>
  );
}

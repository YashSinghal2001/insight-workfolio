"use client";

import { useState } from "react";
import Link from "next/link";
import type { CorrectionRequest } from "@workfolio/shared";
import { buttonClass, formatInZone, inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const TYPE = {
  MISSING_CLOCK_IN: "Missing shift",
  MISSING_CLOCK_OUT: "Missing clock-out",
  ATTENDANCE_TIME: "Wrong clock-in/out time",
  BREAK_TIME: "Wrong break time",
} as const;

const STATUS = {
  PENDING: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  APPROVED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  REJECTED: "bg-red-500/15 text-red-700 dark:text-red-300",
} as const;

const label = (key: string) => key.replace(/At$/, "").replace(/([A-Z])/g, " $1").toLowerCase();

type Values = { clockInAt?: string | null; clockOutAt?: string | null; breaks?: { startedAt: string; endedAt: string | null }[] } | null;

function ValuesList({ values, tz }: { values: Values; tz: string }) {
  if (!values) return <span className="text-muted">No shift (added by this correction)</span>;
  return (
    <ul className="text-xs">
      <li>Clock-in: {formatInZone(values.clockInAt ?? null, tz)}</li>
      <li>Clock-out: {values.clockOutAt ? formatInZone(values.clockOutAt, tz) : "open"}</li>
      {values.breaks?.map((b, i) => (
        <li key={i}>Break: {formatInZone(b.startedAt, tz)} → {b.endedAt ? formatInZone(b.endedAt, tz) : "open"}</li>
      ))}
    </ul>
  );
}

/**
 * One correction request with its full audit trail. Pending requests from someone else can be
 * approved or rejected here; both need a reason.
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
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS[request.status]}`}>{request.status.toLowerCase()}</span>
      </div>

      <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted">Requested change</dt>
        <dd>{Object.entries(request.proposed).map(([k, v]) => <div key={k}>{label(k)}: {formatInZone(v, tz)}</div>)}</dd>
        <dt className="text-muted">Employee&apos;s reason</dt>
        <dd>{request.reason}</dd>
        <dt className="text-muted">Requested</dt>
        <dd>{formatInZone(request.requestedAt, tz)} by {request.requestedBy.email}</dd>
        {request.reviewedBy && (
          <>
            <dt className="text-muted">Reviewed</dt>
            <dd>{formatInZone(request.reviewedAt, tz)} by {request.reviewedBy.email}: {request.reviewReason}</dd>
          </>
        )}
      </dl>

      {request.applied && (
        <div className="mt-3 grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
          <div><div className="mb-1 text-xs font-medium text-muted uppercase">Before</div><ValuesList values={request.applied.original as Values} tz={tz} /></div>
          <div><div className="mb-1 text-xs font-medium text-muted uppercase">After</div><ValuesList values={request.applied.corrected as Values} tz={tz} /></div>
        </div>
      )}

      {request.status === "PENDING" &&
        (own ? (
          <p className="mt-3 text-xs text-muted">This is your own request; another administrator must review it.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Reason for your decision (kept in the audit trail)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className={inputClass} />
            </label>
            {error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={busy || reason.trim().length < 3} className={buttonClass} onClick={() => review("approve")}>Approve and apply</button>
              <button type="button" disabled={busy || reason.trim().length < 3} className={secondaryButtonClass} onClick={() => review("reject")}>Reject</button>
            </div>
          </div>
        ))}
    </article>
  );
}

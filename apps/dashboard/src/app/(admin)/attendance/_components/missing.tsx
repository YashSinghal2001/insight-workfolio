"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  createCorrectionSchema,
  formatDuration,
  toZonedLocal,
  zonedToUtc,
  type AttendanceAnomaly,
  type CorrectionRequest,
  type MissingClockOutsResponse,
} from "@workfolio/shared";
import { Button, EmptyState, ErrorState, FormField, SkeletonRows, StatusBadge, SuccessNotice } from "@/components/kit";
import { formatInZone, inputClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ago, reasonText } from "@/lib/attendance-ui";

/** Open shifts that look forgotten. Flag only: the fix is a correction request another admin approves. */
export function MissingTab({ teamId }: { teamId: string | null }) {
  const [data, setData] = useState<MissingClockOutsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<MissingClockOutsResponse>(`/attendance/missing-clock-outs${teamId ? `?teamId=${teamId}` : ""}`).then(
      (r) => active && (setData(r), setError(null)),
      (e) => active && (setError(errorMessage(e)), setData(null)),
    );
    return () => void (active = false);
  }, [teamId, retry]);

  const now = data ? Date.parse(data.generatedAt) : 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted">
        Shifts still open that look forgotten. Nothing is closed automatically and shifts cannot be closed here: request a correction, and a
        different administrator approves it on <Link href="/corrections" className="text-brand underline">Corrections</Link>.
      </p>
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!data && !error && <SkeletonRows label="missing clock-outs" />}
      {data?.items.length === 0 && <EmptyState title="No missing clock-outs." hint="Every open shift looks current." />}
      {data && data.items.length > 0 && (
        <ul aria-label="Missing clock-outs" className="flex flex-col gap-3">
          {data.items.map((a) => (
            <li key={a.sessionId} className="rounded-lg border border-border bg-surface p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <Link href={`/employees/${a.employee.id}`} className="font-medium text-brand hover:underline">{a.employee.fullName}</Link>{" "}
                  <span className="font-mono text-xs text-muted">{a.employee.employeeCode}</span>
                  {a.employmentStatus !== "ACTIVE" && <span className="ml-2"><StatusBadge tone="neutral">{a.employmentStatus === "TERMINATED" ? "Terminated" : "On leave"}</StatusBadge></span>}
                  {a.accountStatus === "DISABLED" && <span className="ml-2"><StatusBadge tone="neutral">Account disabled</StatusBadge></span>}
                </div>
                {a.pendingCorrectionId ? (
                  <Link href="/corrections" className="text-xs"><StatusBadge tone="info">Correction pending review</StatusBadge></Link>
                ) : (
                  open !== a.sessionId && <Button variant="secondary" onClick={() => (setOpen(a.sessionId), setOk(null))}>Request correction</Button>
                )}
              </div>
              <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted">Clocked in</dt>
                <dd>{formatInZone(a.clockInAt, a.employee.timezone)}</dd>
                <dt className="text-muted">Open for</dt>
                <dd className="tabular-nums">{formatDuration(a.openForMinutes * 60_000)}</dd>
                <dt className="text-muted">Last device contact</dt>
                <dd>{a.lastDeviceSeenAt ? <>{ago(now - Date.parse(a.lastDeviceSeenAt))} <span className="text-xs text-muted">({formatInZone(a.lastDeviceSeenAt, a.employee.timezone)})</span></> : "Never"}</dd>
                {a.openBreakSince && (
                  <>
                    <dt className="text-muted">Break open since</dt>
                    <dd>{formatInZone(a.openBreakSince, a.employee.timezone)}</dd>
                  </>
                )}
                <dt className="text-muted">Why flagged</dt>
                <dd>
                  <ul className="flex flex-col gap-1">
                    {a.reasons.map((r) => {
                      const t = reasonText(r, data.thresholds);
                      return (
                        <li key={r}>
                          <StatusBadge tone="danger">{t.label}</StatusBadge> <span className="text-xs text-muted">{t.explain}</span>
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </dl>
              {open === a.sessionId && (
                <CorrectionRequestForm
                  anomaly={a}
                  onCancel={() => setOpen(null)}
                  onCreated={() => {
                    setOpen(null);
                    setOk(`Correction requested for ${a.employee.fullName}. A different administrator must approve it on Corrections before anything changes.`);
                    setRetry((n) => n + 1);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** MISSING_CLOCK_OUT correction filed by the admin for the employee (POST /attendance/corrections with employeeId). */
function CorrectionRequestForm({ anomaly: a, onCancel, onCreated }: { anomaly: AttendanceAnomaly; onCancel: () => void; onCreated: (r: CorrectionRequest) => void }) {
  const tz = a.employee.timezone;
  const [max] = useState(() => toZonedLocal(Date.now(), tz));
  const suggested = a.lastDeviceSeenAt && a.lastDeviceSeenAt > a.clockInAt ? toZonedLocal(a.lastDeviceSeenAt, tz) : "";
  const [clockOut, setClockOut] = useState(suggested);
  const [breakEnd, setBreakEnd] = useState(suggested);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let body;
    try {
      body = {
        type: "MISSING_CLOCK_OUT" as const,
        sessionId: a.sessionId,
        employeeId: a.employee.id,
        clockOutAt: zonedToUtc(clockOut, tz),
        ...(a.openBreakSince ? { breakEndedAt: zonedToUtc(breakEnd, tz) } : {}),
        reason,
      };
    } catch {
      return setError("Enter a valid date and time.");
    }
    const parsed = createCorrectionSchema.safeParse(body);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check the form.");
    setBusy(true);
    try {
      onCreated(await api<CorrectionRequest>("/attendance/corrections", { method: "POST", body }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label={`Request correction for ${a.employee.fullName}`} className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-surface-muted p-3">
      <p className="text-xs text-muted">
        This files a correction request on {a.employee.fullName}&apos;s behalf. Nothing changes until a <strong>different administrator</strong> approves
        it; you cannot approve your own request. Times are in the employee&apos;s time zone ({tz}).
      </p>
      <FormField label="Clock-out time" required hint={suggested ? "Suggested: the last time their device was in contact." : undefined}>
        {(p) => <input {...p} type="datetime-local" value={clockOut} min={toZonedLocal(a.clockInAt, tz)} max={max} onChange={(e) => setClockOut(e.target.value)} className={inputClass} />}
      </FormField>
      {a.openBreakSince && (
        <FormField label="Break ended at" required hint="The open break must be closed too, no later than the clock-out.">
          {(p) => <input {...p} type="datetime-local" value={breakEnd} min={toZonedLocal(a.openBreakSince!, tz)} max={max} onChange={(e) => setBreakEnd(e.target.value)} className={inputClass} />}
        </FormField>
      )}
      <FormField label="Reason (kept in the audit trail)" required>
        {(p) => <textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={1000} rows={2} className={inputClass} />}
      </FormField>
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={busy} pendingLabel="Sending…">Send for approval</Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

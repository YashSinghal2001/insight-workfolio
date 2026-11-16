"use client";

import { useState, type FormEvent } from "react";
import { DEFAULT_TIMEZONE, EMPLOYMENT_STATUSES, type Employee, type Invitation, type InvitationStatus, type SetupToken } from "@workfolio/shared";
import { StatusBadge, type Tone } from "./kit";
import { buttonClass, Field, formatInZone, inputClass, Notice, secondaryButtonClass } from "./ui";

const TIMEZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export type EmployeeFormValues = Record<"email" | "fullName" | "employeeCode" | "timezone" | "employmentStatus", string>;

/** Shared by create and edit. Server-side validation is authoritative; errors are shown verbatim. */
export function EmployeeForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: Employee;
  submitLabel: string;
  onSubmit: (values: EmployeeFormValues) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setError(await onSubmit(Object.fromEntries(new FormData(e.currentTarget)) as EmployeeFormValues));
    setPending(false);
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      {error && (
        <div className="sm:col-span-2">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <Field label="Full name">
        <input name="fullName" required maxLength={120} defaultValue={initial?.fullName} className={inputClass} />
      </Field>
      <Field label="Work email">
        <input name="email" type="email" required maxLength={254} defaultValue={initial?.email} className={inputClass} />
      </Field>
      <Field label="Employee code" hint="Unique. Letters, digits and dashes.">
        <input name="employeeCode" required pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,31}" defaultValue={initial?.employeeCode} className={`${inputClass} uppercase`} />
      </Field>
      <Field label="Timezone" hint="IANA name. Times are stored in UTC and shown in this zone.">
        <input name="timezone" list="timezones" required defaultValue={initial?.timezone ?? DEFAULT_TIMEZONE} className={inputClass} />
        <datalist id="timezones">
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
      </Field>
      {initial && (
        <Field label="Employment status">
          <select name="employmentStatus" defaultValue={initial.employmentStatus} className={inputClass}>
            {EMPLOYMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Shown once after the API issues a setup token. The token is never stored by the dashboard. */
export function SetupLinkNotice({ setup, email }: { setup: SetupToken; email: string }) {
  const link = `${window.location.origin}/setup-password#token=${setup.token}`;
  const [copied, setCopied] = useState(false);
  return (
    <Notice tone="success">
      <p className="font-medium">One-time setup link for {email}</p>
      <p className="mt-1">
        Deliver it in person or over a trusted company channel; it is shown only once and expires{" "}
        {new Date(setup.expiresAt).toLocaleString()}. Don&apos;t send it by personal email or SMS.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input readOnly value={link} aria-label="Setup link" onFocus={(e) => e.currentTarget.select()} className={`${inputClass} min-w-0 flex-1 font-mono text-xs`} />
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </Notice>
  );
}

export const INVITATION_LABEL: Record<InvitationStatus, { tone: Tone; label: string }> = {
  PENDING: { tone: "warning", label: "Invitation pending" },
  SENT: { tone: "info", label: "Invitation sent" },
  FAILED: { tone: "danger", label: "Invitation failed" },
  ACCEPTED: { tone: "success", label: "Invitation accepted" },
  EXPIRED: { tone: "neutral", label: "Invitation expired" },
};

/** The latest invitation email. "Sent" means the provider accepted it; delivery to the inbox is not confirmed. */
export function InvitationSummary({ invitation: i, timezone }: { invitation: Invitation; timezone: string }) {
  const s = INVITATION_LABEL[i.status];
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="invitation-status" data-status={i.status}>
      <p className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
        <span>
          to <span className="font-medium">{i.recipient}</span>
          {i.sentAt ? ` · ${formatInZone(i.sentAt, timezone)}` : ""}
        </span>
      </p>
      <p className="text-xs text-muted">
        {i.provider === "mock" ? "Mock provider (development): nothing was emailed. " : ""}
        {i.status === "SENT" && "Accepted by Microsoft 365 for delivery; delivery to the inbox is not confirmed. "}
        {i.status === "FAILED" && `Not sent after ${i.attempts} attempt${i.attempts === 1 ? "" : "s"}${i.lastError ? `: ${i.lastError}` : ""}. `}
        {i.status === "PENDING" && "Being sent, or the send was interrupted. "}
        {i.status !== "ACCEPTED" && `Link ${i.status === "EXPIRED" ? "expired or replaced" : `expires ${formatInZone(i.expiresAt, timezone)}`}.`}
      </p>
    </div>
  );
}

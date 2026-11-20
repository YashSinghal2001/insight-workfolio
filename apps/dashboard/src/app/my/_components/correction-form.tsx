"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createCorrectionSchema,
  localDate,
  toZonedLocal,
  zonedToUtc,
  type AttendanceSession,
  type CorrectionRequest,
  type CorrectionType,
} from "@workfolio/shared";
import { Button, FormField } from "@/components/kit";
import { inputClass, Notice } from "@/components/ui";
import { dayLabel, timeIn } from "@/components/my-ui";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { errorText } from "./states";

export const CORRECTION_TYPE_LABEL: Record<CorrectionType, string> = {
  MISSING_CLOCK_IN: "Missing shift",
  MISSING_CLOCK_OUT: "Missing clock-out",
  ATTENDANCE_TIME: "Wrong clock-in/out time",
  BREAK_TIME: "Wrong break time",
};
const TYPE_HINT: Record<CorrectionType, string> = {
  MISSING_CLOCK_IN: "A whole shift was not recorded (for example the desktop app was not running).",
  MISSING_CLOCK_OUT: "A shift is still open because you forgot to clock out.",
  ATTENDANCE_TIME: "A finished shift has the wrong clock-in or clock-out time.",
  BREAK_TIME: "A finished break has the wrong start or end time.",
};
type Times = "clockInAt" | "clockOutAt" | "breakEndedAt" | "startedAt" | "endedAt";
const EMPTY: Record<Times, string> = { clockInAt: "", clockOutAt: "", breakEndedAt: "", startedAt: "", endedAt: "" };

/**
 * Request an attendance correction for the signed-in employee (POST /attendance/corrections; the server
 * scopes it to the caller's own profile). Times are entered in the employee's time zone and sent as UTC;
 * the shared schema is checked before sending and the server re-checks against the records.
 */
export function CorrectionForm({
  sessions,
  tz,
  onCreated,
  initial,
}: {
  sessions: AttendanceSession[];
  tz: string;
  onCreated: (r: CorrectionRequest) => void;
  /** Pre-filled request (e.g. from the missing clock-out banner); the form scrolls into view on mount. */
  initial?: { type: CorrectionType; sessionId: string };
}) {
  const [type, setType] = useState<CorrectionType>(initial?.type ?? "ATTENDANCE_TIME");
  const [sessionId, setSessionId] = useState(initial?.sessionId ?? "");
  const formRef = useRef<HTMLFormElement>(null);
  const prefilled = !!initial;
  useEffect(() => {
    if (prefilled) formRef.current?.scrollIntoView({ block: "start" });
  }, [prefilled]);
  const [breakId, setBreakId] = useState("");
  const [times, setTimes] = useState(EMPTY);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const local = (iso: string | null) => (iso ? toZonedLocal(iso, tz) : "");
  const [now] = useState(() => toZonedLocal(Date.now(), tz));
  const eligible = sessions.filter((s) =>
    type === "MISSING_CLOCK_OUT" ? !s.clockOutAt : type === "BREAK_TIME" ? s.breaks.some((b) => b.endedAt) : type === "ATTENDANCE_TIME",
  );
  const session = eligible.find((s) => s.id === sessionId) ?? null;
  const openBreak = session?.breaks.find((b) => !b.endedAt) ?? null;
  const brk = session?.breaks.find((b) => b.id === breakId && b.endedAt) ?? null;
  const needsSession = type !== "MISSING_CLOCK_IN";

  const reset = (patch: Partial<typeof EMPTY> = {}) => {
    setTimes({ ...EMPTY, ...patch });
    setErrors({});
    setFormError(null);
  };
  const pickType = (t: CorrectionType) => {
    setType(t);
    setSessionId("");
    setBreakId("");
    reset();
  };
  const pickSession = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    setSessionId(id);
    setBreakId("");
    // Start from the recorded values so only what is wrong needs changing.
    reset(s && type === "ATTENDANCE_TIME" ? { clockInAt: local(s.clockInAt), clockOutAt: local(s.clockOutAt) } : {});
  };
  const pickBreak = (id: string) => {
    const b = session?.breaks.find((x) => x.id === id);
    setBreakId(id);
    reset(b ? { startedAt: local(b.startedAt), endedAt: local(b.endedAt) } : {});
  };
  const setTime = (k: Times, v: string) => setTimes((t) => ({ ...t, [k]: v }));

  function body(): Record<string, unknown> {
    const utc = (k: Times) => (times[k] ? zonedToUtc(times[k], tz) : undefined);
    const base = { type, reason };
    if (type === "MISSING_CLOCK_IN") return { ...base, clockInAt: utc("clockInAt"), clockOutAt: utc("clockOutAt") };
    if (type === "MISSING_CLOCK_OUT") return { ...base, sessionId, clockOutAt: utc("clockOutAt"), ...(openBreak ? { breakEndedAt: utc("breakEndedAt") } : {}) };
    if (type === "BREAK_TIME") return { ...base, sessionId, breakId, startedAt: utc("startedAt"), endedAt: utc("endedAt") };
    // Only send what changed; an open shift cannot get a clock-out this way.
    const changed = (k: "clockInAt" | "clockOutAt") => (times[k] && times[k] !== local(session?.[k] ?? null) ? utc(k) : undefined);
    return { ...base, sessionId, clockInAt: changed("clockInAt"), clockOutAt: session?.clockOutAt ? changed("clockOutAt") : undefined };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const raw = Object.fromEntries(Object.entries(body()).filter(([, v]) => v !== undefined));
    const parsed = createCorrectionSchema.safeParse(raw);
    const next: Record<string, string> = {};
    let general: string | null = null;
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        const msg = issue.code === "invalid_type" || /expected/i.test(issue.message) ? "Required" : issue.message;
        if (key && key !== "type") next[key] ??= msg;
        else general ??= issue.message;
      }
    } else if (Object.entries(raw).some(([k, v]) => k.endsWith("At") && typeof v === "string" && v > new Date(Date.now() + 60_000).toISOString())) {
      general = "Corrected times cannot be in the future.";
    }
    setErrors(next);
    if (!parsed.success || general) {
      setFormError(general ?? "Check the highlighted fields.");
      return;
    }
    setBusy(true);
    try {
      const created = await api<CorrectionRequest>("/attendance/corrections", { method: "POST", body: parsed.data });
      setSessionId("");
      setBreakId("");
      setReason("");
      reset();
      onCreated(created);
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? errorText(err.message, err.status) : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const shiftLabel = (s: AttendanceSession) => `${dayLabel(localDate(s.clockInAt, tz))}, ${timeIn(s.clockInAt, tz)}–${s.clockOutAt ? timeIn(s.clockOutAt, tz) : "still open"}`;
  const timeField = (k: Times, label: string, required: boolean, hint?: string) => (
    <FormField label={label} required={required} error={errors[k]} hint={hint}>
      {(p) => <input {...p} type="datetime-local" value={times[k]} max={now} onChange={(e) => setTime(k, e.target.value)} className={inputClass} />}
    </FormField>
  );
  const noShift =
    needsSession && eligible.length === 0
      ? type === "MISSING_CLOCK_OUT"
        ? "No open shift in the period chosen above."
        : type === "BREAK_TIME"
          ? "No finished break in the period chosen above. Choose another period."
          : "No shift in the period chosen above. Choose another period."
      : null;

  return (
    <form ref={formRef} aria-label="Request a correction" onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Nothing changes until an administrator approves the request. Times are in your time zone ({tz}). Shifts listed are from the period chosen for the timesheet above.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="What is wrong?" required hint={TYPE_HINT[type]}>
          {(p) => (
            <select {...p} value={type} onChange={(e) => pickType(e.target.value as CorrectionType)} className={inputClass}>
              {(Object.keys(CORRECTION_TYPE_LABEL) as CorrectionType[]).map((t) => <option key={t} value={t}>{CORRECTION_TYPE_LABEL[t]}</option>)}
            </select>
          )}
        </FormField>
        {needsSession && (
          <FormField label="Shift" required error={errors.sessionId && "Choose a shift"}>
            {(p) => (
              <select {...p} value={sessionId} disabled={eligible.length === 0} onChange={(e) => pickSession(e.target.value)} className={inputClass}>
                <option value="">{eligible.length ? "Choose a shift…" : "No matching shift"}</option>
                {eligible.map((s) => <option key={s.id} value={s.id}>{shiftLabel(s)}</option>)}
              </select>
            )}
          </FormField>
        )}
        {type === "BREAK_TIME" && session && (
          <FormField label="Break" required error={errors.breakId && "Choose a break"}>
            {(p) => (
              <select {...p} value={breakId} onChange={(e) => pickBreak(e.target.value)} className={inputClass}>
                <option value="">Choose a break…</option>
                {session.breaks.filter((b) => b.endedAt).map((b) => <option key={b.id} value={b.id}>{timeIn(b.startedAt, tz)}–{timeIn(b.endedAt, tz)}</option>)}
              </select>
            )}
          </FormField>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {type === "MISSING_CLOCK_IN" && (
          <>
            {timeField("clockInAt", "Clock-in", true)}
            {timeField("clockOutAt", "Clock-out", true)}
          </>
        )}
        {type === "MISSING_CLOCK_OUT" && session && (
          <>
            {timeField("clockOutAt", "Clock-out", true)}
            {openBreak && timeField("breakEndedAt", "Break end", true, `Your break from ${timeIn(openBreak.startedAt, tz)} is still open; give its end too.`)}
          </>
        )}
        {type === "BREAK_TIME" && brk && (
          <>
            {timeField("startedAt", "Break start", true)}
            {timeField("endedAt", "Break end", true)}
          </>
        )}
        {type === "ATTENDANCE_TIME" && session && (
          <>
            {timeField("clockInAt", "Correct clock-in", false, "Change it only if it is wrong.")}
            {session.clockOutAt
              ? timeField("clockOutAt", "Correct clock-out", false, "Change it only if it is wrong.")
              : <p className="text-xs text-muted sm:self-end">This shift is still open; use “Missing clock-out” to add its end.</p>}
          </>
        )}
      </div>

      <FormField label="Reason" required error={errors.reason} hint="3 to 1000 characters. Administrators read it.">
        {(p) => <textarea {...p} value={reason} maxLength={1000} rows={2} onChange={(e) => setReason(e.target.value)} className={inputClass} />}
      </FormField>

      {formError && <Notice tone="error">{formError}</Notice>}
      <div>
        <Button type="submit" pending={busy} pendingLabel="Sending…" disabledReason={noShift}>Send correction request</Button>
      </div>
    </form>
  );
}

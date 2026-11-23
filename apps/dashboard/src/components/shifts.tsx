"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DEFAULT_SHIFT_GRACE_MINUTES, SHIFT_GRACE_MAX_MINUTES, type EmployeeShift, type EmployeeShiftResponse, type ShiftInput, type ShiftStatus } from "@workfolio/shared";
import { ConfirmDialog, SkeletonRows, StatusBadge, type Tone } from "./kit";
import { dangerButtonClass, Field, formatInZone, inputClass, Notice, secondaryButtonClass } from "./ui";
import { api, errorMessage } from "@/lib/api";

const DAYS = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["7", "Sun"]] as const;
const TIMEZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export const workdaysLabel = (w: string) => (w === "1234567" ? "Every day" : w === "12345" ? "Mon–Fri" : DAYS.filter(([d]) => w.includes(d)).map(([, l]) => l).join(", "));

/** "10:00–18:30 · Mon–Fri · Asia/Kolkata" (+ "overnight"). */
export const shiftLabel = (s: Pick<EmployeeShift, "startTime" | "endTime" | "workdays" | "timezone" | "overnight">) =>
  `${s.startTime}–${s.endTime}${s.overnight ? " (overnight)" : ""} · ${workdaysLabel(s.workdays)} · ${s.timezone}`;

export const SHIFT_STATUS: Record<ShiftStatus, { label: string; tone: Tone }> = {
  NO_SHIFT: { label: "No shift", tone: "neutral" },
  NOT_CLOCKED_IN: { label: "Not clocked in", tone: "neutral" },
  WITHIN_SHIFT: { label: "Within shift", tone: "success" },
  GRACE_PERIOD: { label: "Beyond shift end (grace)", tone: "warning" },
  AUTO_CLOCK_OUT_PENDING: { label: "Auto clock-out due", tone: "danger" },
  BEYOND_SHIFT: { label: "Beyond shift end", tone: "warning" },
  OFF_DAY: { label: "Working on a day off", tone: "info" },
  AUTO_CLOCKED_OUT: { label: "Auto clocked out", tone: "info" },
  MANUAL_CLOCK_OUT: { label: "Clocked out", tone: "neutral" },
};

/** Reads the fields rendered by ShiftFields (names `shift*`). */
export function shiftFromForm(f: FormData): ShiftInput {
  return {
    startTime: String(f.get("shiftStart")),
    endTime: String(f.get("shiftEnd")),
    timezone: String(f.get("shiftTimezone") || "") || undefined,
    graceMinutes: Number(f.get("shiftGrace")),
    autoClockOut: f.get("shiftAuto") === "on",
    workdays: f.getAll("shiftDay").join(""),
  };
}

/** Shift inputs (24-hour native time pickers). End earlier than start = overnight. The server validates. */
export function ShiftFields({ initial, defaultTimezone }: { initial?: EmployeeShift | null; defaultTimezone: string }) {
  const days = initial?.workdays ?? "12345";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Shift start" hint="In the shift's time zone (shown in your browser's clock format, stored as 24-hour).">
        <input name="shiftStart" type="time" required defaultValue={initial?.startTime ?? "10:00"} className={inputClass} />
      </Field>
      <Field label="Shift end" hint="Earlier than the start = overnight (ends the next day).">
        <input name="shiftEnd" type="time" required defaultValue={initial?.endTime ?? "18:30"} className={inputClass} />
      </Field>
      <fieldset className="flex flex-col gap-1 text-sm sm:col-span-2">
        <legend className="font-medium">Working days</legend>
        <div className="flex flex-wrap gap-3">
          {DAYS.map(([d, l]) => (
            <label key={d} className="inline-flex items-center gap-1.5">
              <input type="checkbox" name="shiftDay" value={d} defaultChecked={days.includes(d)} /> {l}
            </label>
          ))}
        </div>
        <span className="text-xs text-muted">Days the shift starts on. Work on other days is never clocked out automatically.</span>
      </fieldset>
      <Field label="Shift time zone" hint={`Defaults to the employee's time zone (${defaultTimezone}).`}>
        <input name="shiftTimezone" list="shift-timezones" defaultValue={initial?.timezone ?? ""} placeholder={defaultTimezone} className={inputClass} />
        <datalist id="shift-timezones">
          {TIMEZONES.map((tz) => <option key={tz} value={tz} />)}
        </datalist>
      </Field>
      <Field label="Grace period (minutes)" hint={`After the shift end, before the automatic clock-out. 0–${SHIFT_GRACE_MAX_MINUTES}.`}>
        <input name="shiftGrace" type="number" min={0} max={SHIFT_GRACE_MAX_MINUTES} required defaultValue={initial?.graceMinutes ?? DEFAULT_SHIFT_GRACE_MINUTES} className={inputClass} />
      </Field>
      <label className="inline-flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="shiftAuto" defaultChecked={initial?.autoClockOut ?? true} />
        <span><span className="font-medium">Automatic clock-out</span> — clock the employee out at shift end + grace if they have not clocked out. Their app stays signed in.</span>
      </label>
    </div>
  );
}

/** Read-only summary used on profile overviews. */
export function ShiftSummary({ shift }: { shift: EmployeeShift | null }) {
  if (!shift) return <p className="text-sm text-muted">No shift assigned: the employee is never clocked out automatically.</p>;
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]" data-testid="shift-summary">
      <dt className="text-muted">Shift</dt>
      <dd className="font-medium">{shift.startTime}–{shift.endTime}{shift.overnight ? " (overnight)" : ""}</dd>
      <dt className="text-muted">Working days</dt>
      <dd>{workdaysLabel(shift.workdays)}</dd>
      <dt className="text-muted">Time zone</dt>
      <dd>{shift.timezone}</dd>
      <dt className="text-muted">Grace period</dt>
      <dd>{shift.graceMinutes} min</dd>
      <dt className="text-muted">Automatic clock-out</dt>
      <dd>{shift.autoClockOut ? <StatusBadge tone="success">Enabled</StatusBadge> : <StatusBadge tone="neutral">Disabled</StatusBadge>}</dd>
    </dl>
  );
}

/** Admin: the employee's shift (assign / edit / remove) and automatic clock-out history. */
export function ShiftCard({ employeeId, timezone, editable }: { employeeId: string; timezone: string; editable: boolean }) {
  const [data, setData] = useState<EmployeeShiftResponse | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const path = `/employees/${employeeId}/shift`;

  const load = useCallback(async () => {
    try {
      setData(await api<EmployeeShiftResponse>(path));
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }, [path]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    try {
      setData(await api<EmployeeShiftResponse>(path, { method: "PUT", body: shiftFromForm(new FormData(ev.currentTarget)) }));
      setEditing(false);
      setStatus({ tone: "success", text: "Shift saved. It applies to the current open session too." });
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }

  const shift = data?.shift ?? null;
  return (
    <section aria-label="Shift" className="rounded-lg border border-border bg-surface shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="font-medium">Shift &amp; automatic clock-out</h3>
        {editable && data && !editing && (
          <div className="flex gap-2">
            <button type="button" className={secondaryButtonClass} onClick={() => (setEditing(true), setStatus(null))}>{shift ? "Edit shift" : "Assign shift"}</button>
            {shift && <button type="button" className={dangerButtonClass} onClick={() => setConfirmRemove(true)}>Remove</button>}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3 p-3">
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        {!data && !status && <SkeletonRows label="shift" />}
        {data && editing ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <ShiftFields initial={shift} defaultTimezone={timezone} />
            <div className="flex gap-2">
              <button type="submit" className={secondaryButtonClass}>Save shift</button>
              <button type="button" className={secondaryButtonClass} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          data && <ShiftSummary shift={shift} />
        )}
        {shift?.updatedBy && <p className="text-xs text-muted">Last changed {formatInZone(shift.updatedAt, timezone)} by {shift.updatedBy.email}.</p>}
        {data && data.history.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">Automatic clock-outs ({data.history.length})</summary>
            <ul className="mt-2 flex flex-col gap-1 text-sm" aria-label="Automatic clock-out history">
              {data.history.map((h) => (
                <li key={h.attendanceSessionId} className="border-t border-border pt-1">
                  Clocked out {formatInZone(h.clockOutAt, timezone)} · shift ended {formatInZone(h.scheduledShiftEndAt, timezone)}
                  {h.breakEnded ? " · open break ended" : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove this shift?"
        tone="danger"
        confirmLabel="Remove shift"
        description="The employee will no longer be clocked out automatically. Past automatic clock-outs are kept."
        onConfirm={async () => {
          try {
            setData(await api<EmployeeShiftResponse>(path, { method: "DELETE" }));
            setStatus({ tone: "success", text: "Shift removed." });
          } catch (err) {
            throw new Error(errorMessage(err));
          }
        }}
        onClose={() => setConfirmRemove(false)}
      />
    </section>
  );
}

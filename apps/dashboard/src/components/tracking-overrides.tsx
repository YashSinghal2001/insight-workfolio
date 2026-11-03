"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SETTINGS_LIMITS, type EmployeeTrackingOverridesResponse } from "@workfolio/shared";
import { SkeletonRows } from "@/components/kit";
import { Card, Field, formatInZone, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const days = (w: string) => [...w].map((d) => DAYS[Number(d) - 1]).join(", ");
const orOrg = (v: string | number | null, unit = "") => (v === null ? "organisation" : `${v}${unit}`);
const selfView = (v: boolean | null) => (v === null ? "organisation" : v ? "allowed" : "denied");

/** Per-person schedule start / workdays (W17), idle threshold (W21) and own-screenshot access (F08). Empty fields follow the organisation. */
export function TrackingOverrides({ employeeId, timezone }: { employeeId: string; timezone: string }) {
  const [data, setData] = useState<EmployeeTrackingOverridesResponse | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const url = `/settings/employees/${employeeId}/tracking`;

  const load = useCallback(async () => {
    try {
      setData(await api<EmployeeTrackingOverridesResponse>(url));
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }, [url]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const start = String(f.get("expectedStart"));
    const idle = String(f.get("idleThresholdSeconds"));
    const workdays = f.getAll("workday").join("");
    const sv = String(f.get("screenshotSelfView"));
    try {
      setData(await api<EmployeeTrackingOverridesResponse>(url, {
        method: "PUT",
        body: { expectedStart: start || null, workdays: workdays || null, idleThresholdSeconds: idle ? Number(idle) : null, screenshotSelfView: sv === "" ? null : sv === "allow", reason: String(f.get("trackingReason")) },
      }));
      setStatus({ tone: "success", text: "Saved. The schedule applies from this person's next local day; the desktop picks up the idle threshold within about a minute." });
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    }
  }

  const org = data?.organisation;
  return (
    <Card title="Schedule, idle time and screenshots for this person">
      {data && org ? (
        <form key={data.history[0]?.effectiveAt ?? "none"} onSubmit={submit} className="flex flex-col gap-3 text-sm">
          <p className="text-muted">
            Organisation: {org.schedule.enabled ? `start ${org.schedule.expectedStart} (+${org.schedule.graceMinutes} min grace), ${days(org.schedule.workdays)}` : "work schedule off (nobody is marked late)"}; idle after {org.idleThresholdSeconds} s; employees {org.screenshotSelfView ? "may" : "may not"} view their own screenshots.
            {" "}In force for this person: <span className="font-medium text-foreground">start {data.effective.schedule.expectedStart}, {days(data.effective.schedule.workdays)}; idle after {data.effective.idleThresholdSeconds} s; own screenshots {data.effective.screenshotSelfView ? "visible" : "hidden"}</span>.
            Leave a field empty to follow the organisation.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Expected start (their time zone)">
              <input name="expectedStart" type="time" defaultValue={data.override.expectedStart ?? ""} className={inputClass} />
            </Field>
            <Field label="Idle threshold (seconds)" hint={`${SETTINGS_LIMITS.idleThresholdSeconds.min}–${SETTINGS_LIMITS.idleThresholdSeconds.max}`}>
              <input name="idleThresholdSeconds" type="number" min={SETTINGS_LIMITS.idleThresholdSeconds.min} max={SETTINGS_LIMITS.idleThresholdSeconds.max} defaultValue={data.override.idleThresholdSeconds ?? ""} className={inputClass} />
            </Field>
            <Field label="Viewing their own screenshots" hint="Admins and team heads are not affected.">
              <select name="screenshotSelfView" defaultValue={data.override.screenshotSelfView === null ? "" : data.override.screenshotSelfView ? "allow" : "deny"} className={inputClass}>
                <option value="">Follow the organisation ({org.screenshotSelfView ? "allowed" : "not allowed"})</option>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1 font-medium">Workdays (none ticked = organisation)</legend>
            <div className="flex flex-wrap gap-3">
              {DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1">
                  <input type="checkbox" name="workday" value={i + 1} defaultChecked={data.override.workdays?.includes(String(i + 1)) ?? false} /> {d}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Reason for the change" hint="3 to 500 characters; kept in the history.">
            <textarea name="trackingReason" required minLength={3} maxLength={500} rows={2} className={inputClass} />
          </Field>
          <div><button type="submit" className={secondaryButtonClass}>Save these settings</button></div>
          {data.history.length > 0 && (
            <details>
              <summary className="cursor-pointer font-medium">History</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {data.history.map((h, i) => (
                  <li key={i} className="border-t border-border pt-1">
                    {formatInZone(h.effectiveAt, timezone)}: start {orOrg(h.expectedStart)}, workdays {h.workdays ? days(h.workdays) : "organisation"}, idle {orOrg(h.idleThresholdSeconds, " s")}, own screenshots {selfView(h.screenshotSelfView ?? null)} · {h.changedBy.email} · {h.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </form>
      ) : !status && <SkeletonRows label="schedule and idle settings" />}
      {status && <div className="mt-3"><Notice tone={status.tone}>{status.text}</Notice></div>}
    </Card>
  );
}

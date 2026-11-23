"use client";

import type { AttendanceCurrent, EmployeeShiftResponse } from "@workfolio/shared";
import { ShiftSummary } from "@/components/shifts";
import { Card, Notice } from "@/components/ui";
import { dateTime } from "./missing-clock-out-banner";

const time = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone }).format(new Date(iso));

/**
 * Notice about the server's automatic clock-out of the open session: before the shift end (when it will happen)
 * and, more prominently, in the grace period (how long is left). Nothing is shown without a plan.
 */
export function AutoClockOutNotice({ current, tz }: { current: AttendanceCurrent; tz: string }) {
  if (!current.autoClockOutAt || !current.shiftEndAt || current.state === "CLOCKED_OUT") return null;
  const now = Date.parse(current.serverTime);
  const left = Math.max(0, Math.round((Date.parse(current.autoClockOutAt) - now) / 60_000));
  const ended = now >= Date.parse(current.shiftEndAt);
  return (
    <Notice tone={ended ? "warning" : "info"}>
      <span data-testid="auto-clock-out-notice" className="flex flex-col gap-1">
        {ended ? (
          <>
            <strong>Your shift ended at {time(current.shiftEndAt, tz)}. You will be clocked out automatically at {time(current.autoClockOutAt, tz)} ({left} min left).</strong>
            <span>Clock out in the desktop app if you have finished. The app stays signed in after an automatic clock-out.</span>
          </>
        ) : (
          <span>Your shift ends at {time(current.shiftEndAt, tz)}. If you are still clocked in, you will be clocked out automatically at {dateTime(current.autoClockOutAt, tz)}.</span>
        )}
      </span>
    </Notice>
  );
}

export function MyShiftCard({ shift }: { shift: EmployeeShiftResponse }) {
  return (
    <Card title="My shift">
      <ShiftSummary shift={shift.shift} />
      {shift.shift && <p className="mt-2 text-xs text-muted">Set by your administrator; contact them to change it.</p>}
    </Card>
  );
}

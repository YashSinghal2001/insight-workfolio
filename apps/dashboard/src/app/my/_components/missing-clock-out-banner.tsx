import type { ReactNode } from "react";
import type { AttendanceCurrent } from "@workfolio/shared";
import { Notice } from "@/components/ui";
import { stillClockedInSince } from "../_lib/attendance";

/** Date and time in the employee's zone, e.g. "27 Oct 2026, 09:05". */
export const dateTime = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));

/**
 * Forgotten clock-out (earlier local date or open > 14 h; same rule as the desktop app). Flag only: the shift
 * stays open until an approved correction or a clock-out in the desktop app.
 */
export function MissingClockOutBanner({ current, tz, action }: { current: AttendanceCurrent; tz: string; action: ReactNode }) {
  const since = stillClockedInSince(current, tz);
  if (!since) return null;
  return (
    <Notice tone="warning">
      <span data-testid="missing-clock-out-banner" className="flex flex-col gap-2">
        <strong>You are still clocked in since {dateTime(since, tz)}.</strong>
        <span>If you forgot to clock out, the shift is not counted in your worked time. Clock out in the desktop app, then request a correction with the time you really stopped; an administrator reviews it.</span>
        <span>{action}</span>
      </span>
    </Notice>
  );
}

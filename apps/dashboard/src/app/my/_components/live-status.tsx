import type { ActivityStatusResponse, LiveStatus } from "@workfolio/shared";
import { StatusBadge, type Tone } from "@/components/kit";
import { formatInZone } from "@/components/ui";

/** UNKNOWN is its own state: never shown as active or idle. */
export const LIVE_STATUS: Record<LiveStatus, { label: string; tone: Tone }> = {
  NOT_CLOCKED_IN: { label: "Not clocked in", tone: "neutral" },
  ON_BREAK: { label: "On a break", tone: "warning" },
  ACTIVE: { label: "Active", tone: "success" },
  IDLE: { label: "Idle", tone: "warning" },
  UNKNOWN: { label: "Unknown", tone: "neutral" },
};

const seconds = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s} s`);

/** The employee's own status now (GET /activity/me) with the idle threshold and sampling interval in force. */
export function LiveStatusLine({ status: s, tz }: { status: ActivityStatusResponse; tz: string }) {
  return (
    <div data-testid="my-live-status" data-status={s.liveStatus} className="flex flex-col gap-1 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Your status now:</span>
        <StatusBadge tone={LIVE_STATUS[s.liveStatus].tone}>{LIVE_STATUS[s.liveStatus].label}</StatusBadge>
        {s.liveSince && <span className="text-muted">since {formatInZone(s.liveSince, tz)}</span>}
      </p>
      {s.liveStatus === "UNKNOWN" && (
        <p className="text-xs text-muted">You are clocked in, but the desktop app has not reported recently, so whether you are active or idle is not known.</p>
      )}
      {s.liveStatus === "NOT_CLOCKED_IN" && <p className="text-xs text-muted">To clock in, open the Insight Workfolio desktop app on your work computer.</p>}
      <p className="text-xs text-muted">
        {s.policy.enabled
          ? `Idle means no keyboard or mouse input for ${seconds(s.policy.idleThresholdSeconds)}. The desktop app checks every ${seconds(s.policy.sampleSeconds)}.`
          : "Activity monitoring is turned off by your organization, so active and idle time are not recorded."}
      </p>
    </div>
  );
}

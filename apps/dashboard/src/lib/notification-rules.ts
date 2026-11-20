// Pure helpers for the notification-rules settings page (/settings/notifications).
import { ATTENDANCE_NOTIFICATION_TYPES, type AttendanceNotificationType, type NotificationRule, type NotificationRuleMode } from "@workfolio/shared";

export const MODE_LABEL: Record<NotificationRuleMode, string> = { OFF: "Off", IMMEDIATE: "Immediate", DAILY_DIGEST: "Daily digest" };
export const TYPE_LABEL: Record<AttendanceNotificationType, string> = {
  ATTENDANCE_CLOCK_IN: "Clock-in",
  ATTENDANCE_CLOCK_OUT: "Clock-out",
  LATE_ARRIVAL: "Late arrival",
  ABSENCE: "Absence",
  MISSING_CLOCK_OUT: "Missing clock-out",
  PRODUCTIVITY_ALERT: "Productivity alert",
};

export interface Candidate {
  userId: string;
  label: string;
  email: string;
  /** Why this account may receive the rule's emails. */
  kind: "admin" | "head" | "current";
}
export interface TeamLite {
  id: string;
  name: string;
  active: boolean;
  head: { id: string; email: string; fullName: string | null } | null;
}

/** One group per type (fixed order); the organisation-wide rule first, then team rules by team name. */
export function groupRules(rules: NotificationRule[], teamName: (id: string) => string) {
  return ATTENDANCE_NOTIFICATION_TYPES.map((type) => {
    const of = rules.filter((r) => r.type === type);
    return {
      type,
      org: of.find((r) => r.teamId === null) ?? null,
      teams: of.filter((r) => r.teamId !== null).sort((a, b) => teamName(a.teamId!).localeCompare(teamName(b.teamId!))),
    };
  });
}

/**
 * Who can be picked for a rule: every active admin, plus the head of the rule's team (team rules only, active team),
 * plus anyone already a recipient (so they can be removed even if no longer eligible). One entry per account.
 */
export function candidatesFor(rule: Pick<NotificationRule, "teamId" | "recipients">, admins: Omit<Candidate, "kind">[], teams: TeamLite[]): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const a of admins) out.set(a.userId, { ...a, kind: "admin" });
  const team = rule.teamId ? teams.find((t) => t.id === rule.teamId) : undefined;
  if (team?.active && team.head && !out.has(team.head.id)) out.set(team.head.id, { userId: team.head.id, label: team.head.fullName ?? team.head.email, email: team.head.email, kind: "head" });
  for (const r of rule.recipients) if (!out.has(r.userId)) out.set(r.userId, { userId: r.userId, label: r.fullName ?? r.email, email: r.email, kind: "current" });
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Active teams that do not have a rule of this type yet (choices for "Add team rule"). */
export const teamsWithoutRule = (teams: TeamLite[], existing: NotificationRule[]) =>
  teams.filter((t) => t.active && !existing.some((r) => r.teamId === t.id)).sort((a, b) => a.name.localeCompare(b.name));

/** The PATCH body for what changed (null when nothing did). */
export function ruleChanges(rule: Pick<NotificationRule, "mode" | "digestLocalTime" | "timezone">, draft: { mode: NotificationRuleMode; digestLocalTime: string; timezone: string }) {
  const body: Partial<typeof draft> = {};
  if (draft.mode !== rule.mode) body.mode = draft.mode;
  if (draft.digestLocalTime !== (rule.digestLocalTime ?? "")) body.digestLocalTime = draft.digestLocalTime;
  if (draft.timezone.trim() !== rule.timezone) body.timezone = draft.timezone.trim();
  return Object.keys(body).length ? body : null;
}

/** "Off", "Immediate", "Daily digest at 18:00 (Asia/Kolkata)". */
export const ruleSummary = (r: Pick<NotificationRule, "mode" | "digestLocalTime" | "timezone">) =>
  r.mode === "DAILY_DIGEST" ? `Daily digest at ${r.digestLocalTime ?? "18:00"} (${r.timezone})` : MODE_LABEL[r.mode];

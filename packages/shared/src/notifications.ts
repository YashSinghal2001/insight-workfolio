import { z } from "zod";
import type { PlatformRole } from "./roles.js";
import { DEFAULT_TIMEZONE, timeZoneSchema } from "./schemas.js";

/**
 * Email notifications (docs/notifications.md): one sender (the IT mailbox), recipients decided by the server from
 * the event type alone. This table IS the routing matrix: change who is told about an event here, nowhere else.
 */
export const NOTIFICATION_RECIPIENT_ROLES = ["EMPLOYEE", "IT", "SUPER_ADMIN"] as const;
/** EMPLOYEE = the one affected employee; IT = active Admin accounts; SUPER_ADMIN = active Super Admin accounts. */
export type NotificationRecipientRole = (typeof NOTIFICATION_RECIPIENT_ROLES)[number];
export const NOTIFICATION_RECIPIENT_LABEL: Record<NotificationRecipientRole, string> = { EMPLOYEE: "Employee", IT: "IT (Admin)", SUPER_ADMIN: "Super Admin" };

export const NOTIFICATION_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

interface Route {
  label: string;
  severity: NotificationSeverity;
  roles: readonly NotificationRecipientRole[];
}

export const NOTIFICATION_ROUTES = {
  ACCOUNT_ACTIVATED: { label: "Account activation", severity: "INFO", roles: ["EMPLOYEE"] },
  PASSWORD_CHANGED: { label: "Password changed", severity: "WARNING", roles: ["EMPLOYEE"] },
  SECURITY_ALERT: { label: "Security alert", severity: "WARNING", roles: ["EMPLOYEE", "IT"] },
  DEVICE_ISSUE: { label: "Device registration issue", severity: "WARNING", roles: ["IT"] },
  SCREENSHOT_FAILURE: { label: "Screenshot service failure", severity: "WARNING", roles: ["IT"] },
  BACKUP_FAILURE: { label: "Backup failure", severity: "CRITICAL", roles: ["IT", "SUPER_ADMIN"] },
  CRITICAL_FAILURE: { label: "Critical system failure", severity: "CRITICAL", roles: ["IT", "SUPER_ADMIN"] },
  SECURITY_INCIDENT: { label: "Major security incident", severity: "CRITICAL", roles: ["EMPLOYEE", "IT", "SUPER_ADMIN"] },
  ONBOARDING_SUMMARY: { label: "Employee onboarding summary", severity: "INFO", roles: ["IT", "SUPER_ADMIN"] },
  PERIODIC_REPORT: { label: "Periodic report", severity: "INFO", roles: ["IT", "SUPER_ADMIN"] },
  // Attendance events: no fixed group. Recipients come only from notification rules (NotificationRule).
  ATTENDANCE_CLOCK_IN: { label: "Clock-in", severity: "INFO", roles: [] },
  ATTENDANCE_CLOCK_OUT: { label: "Clock-out", severity: "INFO", roles: [] },
  LATE_ARRIVAL: { label: "Late arrival", severity: "INFO", roles: [] },
  ABSENCE: { label: "Absence", severity: "INFO", roles: [] },
  MISSING_CLOCK_OUT: { label: "Missing clock-out", severity: "WARNING", roles: [] },
  PRODUCTIVITY_ALERT: { label: "Productivity alert", severity: "INFO", roles: [] },
} as const satisfies Record<string, Route>;
export type NotificationType = keyof typeof NOTIFICATION_ROUTES;
export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_ROUTES) as NotificationType[];

export const NOTIFICATION_DELIVERY_STATUSES = ["PENDING", "PROCESSING", "SENT", "FAILED", "RETRYING"] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export interface NotificationDelivery {
  id: string;
  role: NotificationRecipientRole;
  /** Null: the group had no active account to send to (recorded as FAILED). */
  recipient: string | null;
  status: NotificationDeliveryStatus;
  attempts: number;
  sentAt: string | null;
  /** Short, sanitized reason of the last failed attempt. */
  lastError: string | null;
  updatedAt: string;
}

export interface NotificationEvent {
  /** Also the incident ID quoted in the emails. */
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  description: string;
  /** The affected account, when the event is about one. */
  subject: { id: string; email: string } | null;
  createdAt: string;
  deliveries: NotificationDelivery[];
}

export interface EmailServiceStatus {
  provider: "none" | "mock" | "graph" | "graph-delegated";
  /** The one mailbox everything is sent from. */
  sender: string | null;
  /** False: nothing reaches an inbox (no provider, or the development mock). */
  delivers: boolean;
  /** graph-delegated only: the OneDrive connection the token comes from is healthy. */
  connected: boolean | null;
  /** graph-delegated only: the connection's token carries Mail.Send (null until the first token refresh). */
  mailSendGranted: boolean | null;
  problem: string | null;
}

export interface NotificationOverview {
  email: EmailServiceStatus;
  counts: { failed: number; waiting: number; criticalUndelivered: number };
  events: NotificationEvent[];
}

export const listNotificationsQuerySchema = z.strictObject({ show: z.enum(["all", "failed", "critical"]).default("all") });

// ---- Attendance notification rules (docs/notifications.md §9) ------------------------------------

/** Event types routed by admin-configured rules instead of the fixed matrix. */
export const ATTENDANCE_NOTIFICATION_TYPES = ["ATTENDANCE_CLOCK_IN", "ATTENDANCE_CLOCK_OUT", "LATE_ARRIVAL", "ABSENCE", "MISSING_CLOCK_OUT", "PRODUCTIVITY_ALERT"] as const satisfies readonly NotificationType[];
export type AttendanceNotificationType = (typeof ATTENDANCE_NOTIFICATION_TYPES)[number];
/** IMMEDIATE: one email per event; DAILY_DIGEST: one summary per recipient per local day; OFF: nothing (default). */
export const NOTIFICATION_RULE_MODES = ["IMMEDIATE", "DAILY_DIGEST", "OFF"] as const;
export type NotificationRuleMode = (typeof NOTIFICATION_RULE_MODES)[number];
export const DEFAULT_DIGEST_LOCAL_TIME = "18:00";

export interface NotificationRule {
  id: string;
  type: AttendanceNotificationType;
  mode: NotificationRuleMode;
  /** Local HH:MM in `timezone` at which the digest is sent (kept for every mode; default 18:00). */
  digestLocalTime: string | null;
  timezone: string;
  /** null: every employee; otherwise only members of this team. */
  teamId: string | null;
  recipients: { userId: string; fullName: string | null; email: string }[];
  /** User id of the last admin who changed the rule. */
  changedBy: string;
  createdAt: string;
  updatedAt: string;
}

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
export const createNotificationRuleSchema = z.strictObject({
  type: z.enum(ATTENDANCE_NOTIFICATION_TYPES),
  mode: z.enum(NOTIFICATION_RULE_MODES).default("OFF"),
  digestLocalTime: localTime.default(DEFAULT_DIGEST_LOCAL_TIME),
  timezone: timeZoneSchema.default(DEFAULT_TIMEZONE),
  teamId: z.uuid().nullable().default(null),
});
export type NotificationRuleInput = z.infer<typeof createNotificationRuleSchema>;
/** Type and team never change (they identify the rule). */
export const updateNotificationRuleSchema = z
  .strictObject({ mode: z.enum(NOTIFICATION_RULE_MODES).optional(), digestLocalTime: localTime.optional(), timezone: timeZoneSchema.optional() })
  .refine((u) => Object.keys(u).length > 0, "Nothing to change");
export type NotificationRuleUpdate = z.infer<typeof updateNotificationRuleSchema>;
/** GET /notifications/rules/recipient-candidates: accounts PUT recipients accepts for this scope (team rule: teamId). */
export const recipientCandidatesQuerySchema = z.strictObject({ teamId: z.uuid().optional() });
export interface NotificationRecipientCandidate {
  userId: string;
  fullName: string | null;
  email: string;
  platformRole: PlatformRole;
  /** Eligible as the head of the given team (not as an admin). */
  teamHead: boolean;
}
/** The full recipient list (replaces the current one). Accounts only; at most 50. */
export const notificationRuleRecipientsSchema = z.strictObject({
  userIds: z.array(z.uuid()).max(50).refine((ids) => new Set(ids).size === ids.length, "Duplicate user id"),
});

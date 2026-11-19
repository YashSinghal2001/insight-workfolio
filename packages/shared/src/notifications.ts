import { z } from "zod";

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

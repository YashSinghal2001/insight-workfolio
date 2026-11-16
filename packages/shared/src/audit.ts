import { z } from "zod";
import { timeZoneSchema } from "./schemas.js";

/** Central account audit (P1, migration 0015). Append-only; see docs/audit.md. */
export const ACCOUNT_AUDIT_ACTIONS = [
  "ACCOUNT_CREATED",
  "ACCOUNT_UPDATED",
  "ACCOUNT_DISABLED",
  "ACCOUNT_ENABLED",
  "SETUP_LINK_ISSUED",
  // Invitation email with the setup link (never the link itself): accepted by the provider, or given up.
  "INVITATION_SENT",
  "INVITATION_FAILED",
  "PASSWORD_SET",
  "SESSION_REVOKED",
  "SESSIONS_REVOKED_OTHERS",
  "SESSIONS_REVOKED_ALL",
  "SESSION_REUSE_DETECTED",
  "DEVICE_REGISTERED",
  "DEVICE_REVOKED",
  // Multi-device, one active login (migration 0031). resource = the device.
  "DEVICE_REREGISTRATION_APPROVED",
  "DEVICE_REREGISTERED",
  "DEVICE_SESSION_STARTED",
  "DEVICE_SESSION_ENDED",
  "DEVICE_SESSION_TAKEOVER",
  "DEVICE_SESSION_REJECTED",
  // Reads of ANOTHER employee's records by an admin or team head (target = that employee's account).
  "EMPLOYEE_SCREENSHOTS_VIEWED",
  "EMPLOYEE_ACTIVITY_TIMELINE_VIEWED",
  "EMPLOYEE_ATTENDANCE_TIMELINE_VIEWED",
  "EMPLOYEE_ACTIVITY_SUMMARY_VIEWED",
  "EMPLOYEE_ATTENDANCE_VIEWED",
  "EMPLOYEE_ATTENDANCE_EXPORTED",
] as const;
export type AccountAuditAction = (typeof ACCOUNT_AUDIT_ACTIONS)[number];
export const ACCOUNT_AUDIT_RESOURCES = ["ACCOUNT", "SESSION", "DEVICE", "SETUP_LINK"] as const;
export type AccountAuditResource = (typeof ACCOUNT_AUDIT_RESOURCES)[number];

/**
 * Where an event in the unified audit view comes from. Each source is an existing append-only table;
 * nothing is copied, so no historical event is invented.
 */
export const AUDIT_SOURCES = ["ACCOUNT", "ROLE", "WEBSITE", "PROJECT", "SCREENSHOT_ACCESS", "SCREENSHOT_DELETION", "TIMELAPSE_ACCESS", "SETTINGS"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_RANGE_MAX_DAYS = 92;

export const auditQuerySchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    /** IANA zone the dates are in (the viewer's); defaults to UTC. */
    timeZone: timeZoneSchema.default("UTC"),
    source: z.enum(AUDIT_SOURCES).optional(),
    actorId: z.uuid().optional(),
    targetUserId: z.uuid().optional(),
    action: z.string().trim().min(1).max(64).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((q) => q.from <= q.to, "from must not be after to");
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditEvent {
  /** `${source}:${row id}`: stable and unique across sources. */
  id: string;
  source: AuditSource;
  at: string;
  action: string;
  actor: { id: string; email: string } | null;
  target: { userId: string; email: string } | null;
  resource: { type: string; id: string | null } | null;
  reason: string | null;
  /** Safe structured details (never secrets or content). */
  details: Record<string, string | number | boolean | null>;
}

// ---- Sessions --------------------------------------------------------------------------------

export const SESSION_CLIENTS = ["WEB", "DESKTOP"] as const;
export type SessionClient = (typeof SESSION_CLIENTS)[number];

/** One of the caller's own sign-in sessions. Never includes tokens or hashes. */
export interface SessionInfo {
  id: string;
  client: SessionClient | null;
  createdAt: string;
  /** Last refresh-token rotation (null until the first one, or for sessions created before 0015). */
  refreshedAt: string | null;
  expiresAt: string;
  current: boolean;
}

export interface RevokeSessionsResponse {
  revoked: number;
}


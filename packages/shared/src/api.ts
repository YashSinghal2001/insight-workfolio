import type { PlatformRole, Role } from "./roles.js";
import type { ActivityAppTotal, ActivityKind, MonitoringNotice, MonitoringPolicy, MonitoringSettings } from "./activity.js";
import type { AttendanceEventType, AttendanceState, LiveStatus } from "./attendance.js";
import type { CorrectionStatus, CorrectionType } from "./corrections.js";
import type { ScreenshotFeatureState, ScreenshotStorageProvider } from "./screenshots.js";
import type { AccountStatus, EmploymentStatus } from "./schemas.js";
import type { SessionSource, Timesheet, TimesheetTotals } from "./timesheet.js";

/** Every API error uses this envelope; successful responses return the resource directly. */
export interface ApiError {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId?: string;
}

export interface HealthResponse {
  status: "ok";
  uptimeSeconds: number;
  timestamp: string;
}

export type DependencyStatus = "up" | "down";

export interface ReadinessCheck {
  status: DependencyStatus;
  latencyMs?: number;
  error?: string;
  /** Storage check only: which provider is configured (never a path, ID or secret). */
  provider?: ScreenshotStorageProvider;
}

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  checks: Record<string, ReadinessCheck>;
  timestamp: string;
}

export const API_VERSION = "1";
export const API_PREFIX = `/api/v${API_VERSION}`;

// ---- Auth -----------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  /** Identity: Super Admin, Admin or Employee (Super Admin and Admin have the same permissions). */
  platformRole: PlatformRole;
}

export interface MeResponse {
  user: AuthUser;
  /** null for admins without an employee profile. */
  employee: Employee | null;
  /** W41: heads an active team (team-scoped reads and the dashboard's "My team" area). */
  teamHead?: boolean;
}

/** Web clients get cookies and this body; desktop clients additionally get tokens. */
export interface LoginResponse {
  user: AuthUser;
}

export interface DesktopTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

export type DesktopLoginResponse = LoginResponse & DesktopTokens;

// ---- Employees ------------------------------------------------------------

/** All timestamps are UTC ISO-8601; convert to `timezone` for display. */
export interface Employee {
  id: string;
  userId: string;
  email: string;
  role: Role;
  accountStatus: AccountStatus;
  /** false until the employee completes the one-time password setup. */
  passwordSet: boolean;
  employeeCode: string;
  fullName: string;
  timezone: string;
  employmentStatus: EmploymentStatus;
  createdAt: string;
  updatedAt: string;
  /** The latest emailed invitation; null when none was ever emailed (no provider, or created before invitations). */
  invitation: Invitation | null;
}

/**
 * PENDING: being sent (or interrupted). SENT: accepted by the email provider; Microsoft Graph gives no delivery
 * confirmation, so this is not proof it reached the inbox. FAILED: the provider refused it or stayed unavailable.
 * ACCEPTED: the employee set their password. EXPIRED: the link expired or was replaced by a newer one.
 */
export const INVITATION_STATUSES = ["PENDING", "SENT", "FAILED", "ACCEPTED", "EXPIRED"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface Invitation {
  id: string;
  status: InvitationStatus;
  recipient: string;
  /** "mock" = development only: nothing left the server. */
  provider: "mock" | "graph";
  attempts: number;
  /** When the provider accepted it. */
  sentAt: string | null;
  /** Short provider error of the last failed attempt (never the link). */
  lastError: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationResponse {
  employee: Employee;
  /** Only when no email was sent (no provider configured, or it failed): the admin hands the link over instead. */
  setup?: SetupToken;
}

export interface Device {
  id: string;
  deviceName: string;
  platform: string;
  registeredAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** One-time password setup token. Shown once to the admin, delivered out-of-band. */
export interface SetupToken {
  token: string;
  expiresAt: string;
}

export type CreateEmployeeResponse = InvitationResponse;

// ---- Devices --------------------------------------------------------------

/** Status of the calling installation. The installation ID itself is never returned. */
export interface DeviceStatusResponse {
  status: "ACTIVE" | "REVOKED" | "NOT_REGISTERED";
  device: Device | null;
  /** true when another of the employee's devices is active (MVP: one active device). */
  otherActiveDevice: boolean;
}

// ---- Attendance -----------------------------------------------------------

/** All timestamps UTC. */
export interface AttendanceBreak {
  id: string;
  startedAt: string;
  endedAt: string | null;
}

export interface AttendanceSession {
  id: string;
  clockInAt: string;
  clockOutAt: string | null;
  status: "OPEN" | "CLOSED";
  breaks: AttendanceBreak[];
  /** Changed by an approved correction (see the correction audit trail). */
  corrected: boolean;
  /** How the clock-in reached the server. */
  clockInSource: SessionSource;
}

export interface AttendanceCurrent {
  state: AttendanceState;
  /** The open session, or the most recent closed one (null if none yet). */
  session: AttendanceSession | null;
  serverTime: string;
  /** The open session was clocked in on an earlier local date (forgotten clock-out). */
  missingClockOut: boolean;
}

export type SyncResultStatus = "ACCEPTED" | "DUPLICATE" | "REJECTED";

export interface SyncResult {
  id: string;
  status: SyncResultStatus;
  /** Effective UTC time recorded by the server (skew-corrected device time). */
  occurredAt?: string;
  reason?: string;
}

export interface SyncResponse {
  results: SyncResult[];
  current: AttendanceCurrent;
}

export interface AttendanceOverviewRow {
  employeeId: string;
  fullName: string;
  employeeCode: string;
  timezone: string;
  state: AttendanceState;
  session: AttendanceSession | null;
  lastEvent: {
    type: AttendanceEventType;
    receivedAt: string;
    source: "ONLINE" | "OFFLINE_SYNC";
    outcome: "ACCEPTED" | "REJECTED";
  } | null;
  deviceLastSeenAt: string | null;
  /** Status now (deriveLiveStatus): attendance first, then the device's last fresh activity report. */
  liveStatus: LiveStatus;
  liveSince: string | null;
  /** The open session was clocked in on an earlier local date (forgotten clock-out). */
  missingClockOut: boolean;
  screenshotState: ScreenshotFeatureState;
}

// ---- Timesheets & corrections ------------------------------------------------

export interface EmployeeRef {
  id: string;
  fullName: string;
  employeeCode: string;
  timezone: string;
}

export interface TimesheetResponse extends Timesheet {
  employee: EmployeeRef;
  pendingCorrections: number;
}

/** Admin listing: one row per employee for the range. */
export interface TimesheetSummaryRow {
  employee: EmployeeRef;
  totals: TimesheetTotals;
  /** Open shift right now (not included in totals). */
  openShift: boolean;
  /** The open shift was clocked in on an earlier local date (forgotten clock-out). */
  missingClockOut: boolean;
  pendingCorrections: number;
}

export interface UserRef {
  id: string;
  email: string;
}

export interface CorrectionRequest {
  id: string;
  employee: EmployeeRef;
  type: CorrectionType;
  status: CorrectionStatus;
  sessionId: string | null;
  breakId: string | null;
  /** The requested values (UTC), e.g. { clockOutAt }. */
  proposed: Record<string, string>;
  reason: string;
  requestedBy: UserRef;
  requestedAt: string;
  reviewedBy: UserRef | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  /** Present once approved: exact before/after values written to the audit table. */
  applied: { correctionId: string; sessionId: string; original: CorrectionValues | null; corrected: CorrectionValues } | null;
}

/** A shift as recorded in the correction audit. `original` is null when the correction added the shift. */
export interface CorrectionValues {
  clockInAt: string;
  clockOutAt: string | null;
  breaks: { id?: string; startedAt: string; endedAt: string | null }[];
}

// ---- Activity ------------------------------------------------------------------

export interface ConsentState {
  /** The notice version currently required. */
  noticeVersion: string;
  /** When the employee acknowledged that version; null = not yet (nothing is recorded). */
  acknowledgedAt: string | null;
}

export interface ActivityStatusResponse {
  policy: MonitoringPolicy;
  /** The notice the employee must acknowledge (text served by the API, not built into the app). */
  notice: MonitoringNotice;
  consent: ConsentState;
  /** Synced totals for today (employee's time zone) and for the latest attendance session. */
  today: { date: string; activeMs: number; idleMs: number };
  currentSession: { sessionId: string; activeMs: number; idleMs: number } | null;
  lastReceivedAt: string | null;
  /** The caller's status now (deriveLiveStatus). */
  liveStatus: LiveStatus;
  liveSince: string | null;
}

export interface ConsentRecord {
  noticeVersion: string;
  noticeTitle: string;
  acknowledgedAt: string;
}

export interface ActivitySyncResult {
  id: string;
  status: "ACCEPTED" | "DUPLICATE" | "REJECTED";
  reason?: string;
}

export interface ActivitySyncResponse {
  results: ActivitySyncResult[];
}

/**
 * Observed time = active + idle intervals uploaded by the agent. Clocked-in time = attendance
 * (non-break). The difference is unobserved: asleep, app not running, monitoring paused, or not
 * uploaded yet. It is reported, never estimated or attributed to an application.
 */
export interface ActivityPeriodTotals {
  activeMs: number;
  idleMs: number;
  clockedInMs: number;
  unobservedMs: number;
}

export interface ActivityReportDay extends ActivityPeriodTotals {
  date: string;
}

export interface ActivityReportWeek extends ActivityPeriodTotals {
  /** First day of the workweek (attendance policy). */
  weekStart: string;
}

export type ActivityWarningCode = "UNOBSERVED_TIME" | "STALE_SYNC" | "NO_CONSENT" | "MONITORING_DISABLED" | "NO_ACTIVE_DEVICE" | "UNSUPPORTED_PLATFORM";

export interface ActivityWarning {
  code: ActivityWarningCode;
  message: string;
  date?: string;
}

export interface ActivitySummaryResponse extends ActivityPeriodTotals {
  employee: EmployeeRef;
  from: string;
  to: string;
  applications: ActivityAppTotal[];
  /** Every date in the range, including days without activity. */
  days: ActivityReportDay[];
  weeks: ActivityReportWeek[];
  /** When this employee's agent last uploaded activity, and when the device was last seen. */
  lastReceivedAt: string | null;
  deviceLastSeenAt: string | null;
  /** CURRENT: uploaded within the freshness window, or nothing to upload; STALE: clocked in but no recent upload. */
  freshness: "CURRENT" | "STALE" | "NO_DATA";
  consent: ConsentState;
  warnings: ActivityWarning[];
}

export interface MonitoringSettingsVersion extends MonitoringSettings {
  /** null for the built-in defaults (no change recorded yet). */
  effectiveAt: string | null;
  changedBy: UserRef | null;
  reason: string | null;
}

export interface MonitoringSettingsResponse {
  effective: MonitoringSettingsVersion;
  /** Newest first. */
  history: MonitoringSettingsVersion[];
  notices: MonitoringNotice[];
}

export interface RetentionRun {
  ranAt: string;
  cutoff: string;
  retentionDays: number;
  deleted: number;
  /** null = the scheduled job. */
  triggeredBy: UserRef | null;
}

/** Dry run: what a purge would delete now. Nothing is deleted by this request. */
export interface RetentionPreview {
  retentionDays: number;
  approved: boolean;
  cutoff: string;
  eligibleIntervals: number;
  eligibleEmployees: number;
  oldestEndedAt: string | null;
  totalIntervals: number;
  runs: RetentionRun[];
}

export interface ActivityTimelineItem {
  id: string;
  kind: ActivityKind;
  applicationIdentifier: string | null;
  applicationName: string | null;
  startedAt: string;
  endedAt: string;
}

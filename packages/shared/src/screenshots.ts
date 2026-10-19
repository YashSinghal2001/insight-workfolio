import { z } from "zod";
import type { MonitoringNotice } from "./activity.js";

// ---- Policy -------------------------------------------------------------------------

export const SCREENSHOT_SCOPES = ["PRIMARY_DISPLAY"] as const;
export type ScreenshotScope = (typeof SCREENSHOT_SCOPES)[number];

/** What the desktop agent needs to capture. Decided by the server (append-only history, migration 0006). */
export interface ScreenshotPolicy {
  /** Organization-wide switch, separate from activity monitoring. Off = nothing captured, uploads refused. */
  enabled: boolean;
  /** One screenshot every this many seconds while clocked in (not on break). */
  intervalSeconds: number;
  /** libwebp quality 0–100 (lossy). */
  webpQuality: number;
  /** Longest edge in pixels; larger displays are scaled down (never up). */
  maxDimension: number;
  /** Only the primary display; other monitors are never captured. */
  captureScope: ScreenshotScope;
}

export interface ScreenshotSettings extends ScreenshotPolicy {
  /** Stored screenshots older than this are deleted from storage, but only once `retentionApproved`. */
  retentionDays: number;
  retentionApproved: boolean;
  /** Screenshot-specific notice every employee must have acknowledged before capture. */
  noticeVersion: string;
  /** Employees may view their own screenshots (admins always can). */
  employeeSelfView: boolean;
}

/** Proposed defaults (pending HR/Legal approval). Off until an admin turns screenshots on. */
export const DEFAULT_SCREENSHOT_NOTICE_VERSION = "2026-10-screenshots-draft-1";
export const DEFAULT_SCREENSHOT_SETTINGS: ScreenshotSettings = {
  enabled: false,
  intervalSeconds: 300,
  webpQuality: 70,
  maxDimension: 1920,
  captureScope: "PRIMARY_DISPLAY",
  retentionDays: 30,
  retentionApproved: false,
  noticeVersion: DEFAULT_SCREENSHOT_NOTICE_VERSION,
  employeeSelfView: true,
};

export const SCREENSHOT_LIMITS = {
  intervalSeconds: { min: 60, max: 3600 },
  webpQuality: { min: 30, max: 95 },
  maxDimension: { min: 640, max: 3840 },
  retentionDays: { min: 7, max: 3650 },
  /** Upload size cap (a 3840 px WebP at quality 95 stays well below this). */
  maxBytes: 10 * 1024 * 1024,
} as const;

const between = (l: { min: number; max: number }) => z.number().int().min(l.min).max(l.max);

export const screenshotSettingsSchema = z
  .object({
    enabled: z.boolean(),
    intervalSeconds: between(SCREENSHOT_LIMITS.intervalSeconds),
    webpQuality: between(SCREENSHOT_LIMITS.webpQuality),
    maxDimension: between(SCREENSHOT_LIMITS.maxDimension),
    captureScope: z.enum(SCREENSHOT_SCOPES),
    retentionDays: between(SCREENSHOT_LIMITS.retentionDays),
    retentionApproved: z.boolean(),
    noticeVersion: z.string().min(1).max(64),
    employeeSelfView: z.boolean(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type ScreenshotSettingsInput = z.infer<typeof screenshotSettingsSchema>;

// ---- Requests ---------------------------------------------------------------------------

export const SCREENSHOT_MIME = "image/webp";
const instant = z.iso.datetime({ offset: true });

/**
 * Metadata registered before the image is uploaded. No image content, no window or app names.
 * The attendance session is derived by the server from the capture time (authoritative).
 */
export const screenshotRegisterSchema = z
  .object({
    /** Client UUID; the idempotency key. */
    id: z.uuid(),
    capturedAt: instant,
    /** Device clock at upload; corrects clock skew like attendance sync. */
    sentAt: instant,
    width: z.number().int().min(1).max(SCREENSHOT_LIMITS.maxDimension.max),
    height: z.number().int().min(1).max(SCREENSHOT_LIMITS.maxDimension.max),
    sizeBytes: z.number().int().min(1).max(SCREENSHOT_LIMITS.maxBytes),
    /** SHA-256 of the WebP file, lowercase hex. */
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    mimeType: z.literal(SCREENSHOT_MIME),
  })
  .strict();
export type ScreenshotRegisterRequest = z.infer<typeof screenshotRegisterSchema>;

export const screenshotQuerySchema = z
  .object({
    employeeId: z.uuid().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((r) => !r.from || !r.to || r.from <= r.to, "from must not be after to");
export type ScreenshotQuery = z.infer<typeof screenshotQuerySchema>;

/** Admin gallery: all employees or one, a date range in the viewer's time zone. */
export const SCREENSHOT_GALLERY_MAX_DAYS = 31;
export const screenshotGallerySchema = z
  .object({
    employeeId: z.uuid().optional(),
    from: z.iso.date(),
    to: z.iso.date(),
    tz: z.string().max(64).refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown time zone").default("UTC"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(60).default(24),
  })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= (SCREENSHOT_GALLERY_MAX_DAYS - 1) * 86_400_000, `Range is limited to ${SCREENSHOT_GALLERY_MAX_DAYS} days`);
export type ScreenshotGalleryQuery = z.infer<typeof screenshotGallerySchema>;

/** `variant=thumbnail` returns the same bytes but is logged as a gallery thumbnail rather than a view. */
export const screenshotContentQuerySchema = z.object({ variant: z.enum(["full", "thumbnail"]).default("full") }).strict();

// ---- Responses --------------------------------------------------------------------------

/** REGISTERED: metadata accepted, image not yet confirmed by storage. STORED: storage confirmed. */
export type ScreenshotUploadStatus = "REGISTERED" | "STORED" | "DELETED";

export interface ScreenshotRegisterResponse {
  id: string;
  /** REJECTED is final (policy, consent, attendance); the client keeps the reason for the employee. */
  status: "REGISTERED" | "STORED" | "REJECTED";
  reason?: string;
}

export interface ScreenshotStoredResponse {
  id: string;
  status: "STORED";
  storedAt: string;
}

export interface ScreenshotStatusResponse {
  policy: ScreenshotPolicy;
  retentionDays: number;
  notice: MonitoringNotice;
  consent: { noticeVersion: string; acknowledgedAt: string | null };
  /** Latest screenshot confirmed by storage (server view). */
  lastStoredAt: string | null;
  storageProvider: ScreenshotStorageProvider;
  /** Whether this employee may view their own screenshots. */
  employeeSelfView: boolean;
}

export type ScreenshotStorageProvider = "LOCAL_DEV" | "MICROSOFT_GRAPH";

export interface ScreenshotItem {
  id: string;
  employeeId: string;
  capturedAt: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  uploadStatus: ScreenshotUploadStatus;
  storageProvider: ScreenshotStorageProvider;
  storedAt: string | null;
}

export interface ScreenshotGalleryItem extends ScreenshotItem {
  employee: { id: string; fullName: string; employeeCode: string };
}

export interface ScreenshotAccess {
  accessedAt: string;
  action: "VIEW" | "THUMBNAIL";
  viewer: { id: string; email: string };
}

/** Metadata of one screenshot; the access log only for admins. */
export interface ScreenshotDetail extends ScreenshotGalleryItem {
  accessLog?: ScreenshotAccess[];
}

/** Server-side counts only: failures that never reached the server are visible on the desktop, not here. */
export interface ScreenshotOverview {
  total: number;
  stored: number;
  /** Registered, image not (yet) confirmed by storage. */
  awaitingUpload: number;
  /** Of those, registered more than an hour ago: the desktop is retrying or offline. */
  stalled: number;
  deleted: number;
  latestCapturedAt: string | null;
  latestStoredAt: string | null;
  retention: ScreenshotRetentionPreview;
}

export interface ScreenshotSettingsVersion extends ScreenshotSettings {
  effectiveAt: string | null;
  changedBy: { id: string; email: string } | null;
  reason: string | null;
}

export interface ScreenshotSettingsResponse {
  effective: ScreenshotSettingsVersion;
  history: ScreenshotSettingsVersion[];
  storageProvider: ScreenshotStorageProvider;
}

export interface ScreenshotRetentionPreview {
  retentionDays: number;
  approved: boolean;
  cutoff: string;
  /** Stored screenshots captured before the cut-off (deleted from storage by a run). */
  eligible: number;
  storedTotal: number;
  /** Deleted so far by retention (metadata rows are kept, marked DELETED). */
  deletedTotal: number;
  /** Set by a run: deletions the storage provider refused (retried next run). */
  failed?: number;
  /** How the provider deletes: SharePoint's recycle bin keeps files recoverable for a while. */
  deletionMode: ScreenshotDeletionMode;
  runs: { ranAt: string; cutoff: string; deleted: number; failed: number; deletionMode: ScreenshotDeletionMode; triggeredBy: { id: string; email: string } | null }[];
}

export type ScreenshotDeletionMode = "LOCAL_DEV" | "RECYCLE_BIN" | "PERMANENT";

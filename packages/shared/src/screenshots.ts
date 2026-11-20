import { z } from "zod";
import type { MonitoringNotice } from "./activity.js";
import { timeZoneSchema } from "./schemas.js";

// ---- Policy -------------------------------------------------------------------------

export const SCREENSHOT_SCOPES = ["PRIMARY_DISPLAY"] as const;
export type ScreenshotScope = (typeof SCREENSHOT_SCOPES)[number];

/**
 * Privacy masks: rectangles filled solid black on the employee's computer **before** the image is
 * encoded, so the covered pixels are never written to disk, uploaded or stored. Coordinates are
 * fractions of the captured frame in units of 1/10 000 (0 = left/top edge, 10 000 = right/bottom),
 * so one rule fits every resolution and scaling; on a display with a different aspect ratio the
 * same fractions cover a differently shaped area. Applied to new screenshots only.
 */
export const SCREENSHOT_MASK_SCALE = 10_000;
export const SCREENSHOT_MASK_MAX_REGIONS = 20;

const unit = z.number().int().min(0).max(SCREENSHOT_MASK_SCALE);
const fits = (m: { x: number; y: number; w: number; h: number }) => m.x + m.w <= SCREENSHOT_MASK_SCALE && m.y + m.h <= SCREENSHOT_MASK_SCALE;
const rect = { x: unit, y: unit, w: unit.min(1), h: unit.min(1) };
const FITS = { message: "The mask must lie inside the screen (x + w and y + h at most 10000)" };

/** A rectangle as applied and reported by the desktop agent (no label). */
export const screenshotMaskRectSchema = z.object(rect).strict().refine(fits, FITS);
export type ScreenshotMaskRect = z.infer<typeof screenshotMaskRectSchema>;

/** A configured mask; the label tells employees and admins what it hides. */
export const screenshotMaskRegionSchema = z
  .object({ ...rect, label: z.string().trim().min(1).max(60) })
  .strict()
  .refine(fits, FITS);
export type ScreenshotMaskRegion = z.infer<typeof screenshotMaskRegionSchema>;

export const screenshotMaskListSchema = z.array(screenshotMaskRegionSchema).max(SCREENSHOT_MASK_MAX_REGIONS);

/** Same rectangles in the same order (labels ignored): what the server requires of an upload. */
export const sameMasks = (a: readonly ScreenshotMaskRect[], b: readonly ScreenshotMaskRect[]) =>
  a.length === b.length && a.every((m, i) => m.x === b[i]!.x && m.y === b[i]!.y && m.w === b[i]!.w && m.h === b[i]!.h);

/** Stored mask JSON, or null when it is missing or invalid (callers then fail closed). */
export function parseMaskRegions(json: unknown): ScreenshotMaskRegion[] | null {
  try {
    const r = screenshotMaskListSchema.safeParse(typeof json === "string" ? JSON.parse(json) : json);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

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
  /** Areas blacked out on the device before encoding (empty = nothing masked). */
  maskRegions: ScreenshotMaskRegion[];
  /**
   * Blur the whole image on the device before encoding (after masks). In the organisation settings
   * this is the organisation-wide value; in `GET /screenshots/me` it is the value in force for the
   * caller now (their per-employee override, else the organisation setting).
   */
  blur: boolean;
}

export interface ScreenshotSettings extends ScreenshotPolicy {
  /** Stored screenshots older than this are deleted from storage, but only once `retentionApproved`. */
  retentionDays: number;
  retentionApproved: boolean;
  /** Screenshot-specific notice every employee must have acknowledged before capture. */
  noticeVersion: string;
  /** Employees may view their own screenshots (admins always can). */
  employeeSelfView: boolean;
  /** F01: queue a timelapse of each finished session automatically after the employee's local day ends. Off by default. */
  autoTimelapse: boolean;
}

/** Proposed defaults (pending HR/Legal approval). Off until an admin turns screenshots on. */
export const DEFAULT_SCREENSHOT_NOTICE_VERSION = "2026-10-screenshots-draft-1";
export const DEFAULT_SCREENSHOT_SETTINGS: ScreenshotSettings = {
  enabled: false,
  intervalSeconds: 300,
  webpQuality: 70,
  maxDimension: 1920,
  captureScope: "PRIMARY_DISPLAY",
  maskRegions: [],
  blur: false,
  retentionDays: 30,
  retentionApproved: false,
  noticeVersion: DEFAULT_SCREENSHOT_NOTICE_VERSION,
  employeeSelfView: true,
  autoTimelapse: false,
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
    maskRegions: screenshotMaskListSchema.default([]),
    /** Older payloads without it mean no blur. */
    blur: z.boolean().default(false),
    retentionDays: between(SCREENSHOT_LIMITS.retentionDays),
    retentionApproved: z.boolean(),
    noticeVersion: z.string().min(1).max(64),
    employeeSelfView: z.boolean(),
    /** Older payloads without it mean off. */
    autoTimelapse: z.boolean().default(false),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type ScreenshotSettingsInput = z.infer<typeof screenshotSettingsSchema>;

// ---- Feature state ----------------------------------------------------------------------

/** What the desktop reports about capture on the device (POST /activity/sync `current.screenshot`). */
export const DEVICE_SCREENSHOT_STATES = ["OK", "PERMISSION_DENIED", "CAPTURE_FAILED"] as const;
export type DeviceScreenshotState = (typeof DEVICE_SCREENSHOT_STATES)[number];

/** Per-screenshot "upload pending" / "uploaded" is ScreenshotItem.uploadStatus, not repeated here. */
export const SCREENSHOT_FEATURE_STATES = ["DISABLED", "AWAITING_CONSENT", "ENABLED", "PERMISSION_DENIED", "CAPTURE_FAILED"] as const;
export type ScreenshotFeatureState = (typeof SCREENSHOT_FEATURE_STATES)[number];

/** A device problem report older than this is ignored (the desktop reports every minute while running). */
export const SCREENSHOT_STATE_STALE_MS = 15 * 60_000;

/**
 * The screenshot feature for one employee: the organisation switch, then their acknowledgement of the
 * current screenshot notice, then a fresh problem reported by their device. A stale or missing report
 * never hides or invents a problem: the state is then ENABLED.
 */
export function screenshotFeatureState(
  input: { enabled: boolean; consented: boolean; report: { state: DeviceScreenshotState; reportedAt: string } | null },
  now = Date.now(),
): ScreenshotFeatureState {
  if (!input.enabled) return "DISABLED";
  if (!input.consented) return "AWAITING_CONSENT";
  const r = input.report;
  return r && r.state !== "OK" && now - Date.parse(r.reportedAt) <= SCREENSHOT_STATE_STALE_MS ? r.state : "ENABLED";
}

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
    /** Masks the agent applied before encoding; must equal the policy in force at capture time. Older agents send none. */
    masks: z.array(screenshotMaskRectSchema).max(SCREENSHOT_MASK_MAX_REGIONS).default([]),
    /** Whether the agent blurred the whole image; must equal the blur in force for the employee at capture time. Older agents send none (false). */
    blurred: z.boolean().default(false),
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
    tz: timeZoneSchema.default("UTC"),
    /** `true`: only screenshots captured while the employee was idle (see ScreenshotGalleryItem.idle). */
    idle: z.stringbool().optional(),
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
  /** Policy, consent and the device's last reported capture problem, in one value. */
  state: ScreenshotFeatureState;
}

export type ScreenshotStorageProvider = "LOCAL_DEV" | "MICROSOFT_GRAPH" | "GOOGLE_DRIVE";

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
  /** Privacy masks blacked out on the device before this image was encoded (0 = none). */
  maskCount: number;
  /** The whole image was blurred on the device before it was encoded. */
  blurred: boolean;
}

export interface ScreenshotGalleryItem extends ScreenshotItem {
  /** `timezone`: the employee's IANA zone, for showing capture times in their local time. */
  employee: { id: string; fullName: string; employeeCode: string; timezone: string };
  /**
   * Captured inside an IDLE activity interval of the employee (no keyboard/mouse input for the idle threshold).
   * False when no activity data covers the capture (monitoring off, not synced yet, or purged by activity retention).
   */
  idle: boolean;
}

export interface ScreenshotAccess {
  accessedAt: string;
  action: "VIEW" | "THUMBNAIL";
  viewer: { id: string; email: string };
}

/** Metadata of one screenshot; the access log only for admins. */
export interface ScreenshotDetail extends ScreenshotGalleryItem {
  accessLog?: ScreenshotAccess[];
  /**
   * The masks blacked out in this image, with their labels: the policy version in force at the
   * capture time (registration only accepts exactly those). Null when they cannot be matched.
   */
  masks: ScreenshotMaskRegion[] | null;
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
  /** Organisation-wide retention status: only for callers with settings:manage (not team heads). */
  retention?: ScreenshotRetentionPreview;
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
  /** AW-04: when the most recent screenshot was successfully stored (any employee); null = never. */
  lastUploadAt: string | null;
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

/** Super Admin deletion of one screenshot. The reason is stored with the row and shown in the audit view. */
export const screenshotDeleteSchema = z.strictObject({ reason: z.string().trim().min(3).max(500) });
export type ScreenshotDeleteRequest = z.infer<typeof screenshotDeleteSchema>;

/** Bulk export (Super Admin): at most this many screenshots and this many registered bytes per ZIP. */
export const SCREENSHOT_EXPORT_LIMITS = { maxItems: 200, maxBytes: 200 * 1024 * 1024 } as const;
export const screenshotExportSchema = z.strictObject({
  ids: z.array(z.uuid()).min(1).max(SCREENSHOT_EXPORT_LIMITS.maxItems).refine((ids) => new Set(ids).size === ids.length, "ids must be unique"),
});
export type ScreenshotExportRequest = z.infer<typeof screenshotExportSchema>;

export interface ScreenshotDeleteResponse {
  screenshot: ScreenshotGalleryItem;
  deletedAt: string;
  /** True when it was already DELETED before this request (nothing changed). */
  alreadyDeleted: boolean;
}

// ---- Per-employee blur override ---------------------------------------------------------

/**
 * Admin override of the organisation blur setting for one employee (append-only history).
 * `blur: null` clears the override (the organisation setting applies again). Applies to captures
 * taken from now on; earlier captures are judged by what was in force when they were taken.
 */
export const screenshotBlurOverrideSchema = z.strictObject({
  blur: z.boolean().nullable(),
  reason: z.string().trim().min(3).max(500),
});
export type ScreenshotBlurOverrideInput = z.infer<typeof screenshotBlurOverrideSchema>;

export const screenshotBlurOverrideQuerySchema = z.strictObject({ employeeId: z.uuid() });

export interface ScreenshotBlurOverrideVersion {
  /** null = override cleared (organisation setting). */
  blur: boolean | null;
  reason: string;
  changedBy: { id: string; email: string };
  effectiveAt: string;
}

export interface ScreenshotBlurOverridesResponse {
  employeeId: string;
  /** The organisation-wide setting now. */
  organisationBlur: boolean;
  /** The employee's current override, null when none (organisation setting applies). */
  override: boolean | null;
  /** What applies to this employee's new captures. */
  effective: boolean;
  /** Newest first. */
  history: ScreenshotBlurOverrideVersion[];
}

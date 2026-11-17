// Desktop auto-update (docs/desktop/AUTO-UPDATE-ARCHITECTURE.md). The API serves the Tauri updater manifest;
// releases, artifacts and rollout are managed in the dashboard; the desktop reports its update state.
import { z } from "zod";

export const RELEASE_STATUSES = ["DRAFT", "TESTING", "PUBLISHED", "DISABLED"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const UPDATE_POLICIES = ["OPTIONAL", "RECOMMENDED", "MANDATORY"] as const;
export type UpdatePolicy = (typeof UPDATE_POLICIES)[number];
/**
 * Tauri updater targets (`{os}-{arch}`) this product ships. The Mac build is Apple Silicon by default;
 * darwin-x86_64 is served only when a release has an Intel (or universal) artifact.
 */
export const UPDATE_TARGETS = ["windows-x86_64", "darwin-aarch64", "darwin-x86_64"] as const;
export type UpdateTarget = (typeof UPDATE_TARGETS)[number];
export const UPDATE_TARGET_LABEL: Record<UpdateTarget, string> = {
  "windows-x86_64": "Windows x64",
  "darwin-aarch64": "macOS Apple Silicon",
  "darwin-x86_64": "macOS Intel",
};
export const UPDATE_STATES = ["UP_TO_DATE", "AVAILABLE", "POSTPONED", "DOWNLOADING", "INSTALLING", "FAILED"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

/** Plain MAJOR.MINOR.PATCH. Pre-release tags are not used for employee releases. */
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
export const isVersion = (v: string) => VERSION.test(v);
/** Negative, 0 or positive like a sort comparator. Throws on anything that is not MAJOR.MINOR.PATCH. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) throw new Error(`Not a MAJOR.MINOR.PATCH version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  return 0;
}

const version = z.string().trim().regex(VERSION, "Use MAJOR.MINOR.PATCH, for example 0.3.0");
const httpsUrl = z.string().trim().url().max(2000);
/** The base64 `.sig` file content written by the Tauri CLI (minisign signature). */
const signature = z.string().trim().min(100).max(4000).regex(/^[A-Za-z0-9+/=]+$/, "Paste the whole content of the .sig file");

export const releaseArtifactSchema = z.object({ target: z.enum(UPDATE_TARGETS), url: httpsUrl, signature });
const releaseFields = {
  notes: z.string().max(10_000),
  policy: z.enum(UPDATE_POLICIES),
  /** Recommended updates: how long "Later" hides the prompt. */
  postponeHours: z.number().int().min(1).max(720),
  rolloutPercent: z.number().int().min(0).max(100),
  /** Installations below this version must update (mandatory for them) whatever this release's policy. */
  minimumVersion: version.nullable(),
  artifacts: z.array(releaseArtifactSchema).max(UPDATE_TARGETS.length),
};
export const createReleaseSchema = z.object({
  version,
  notes: releaseFields.notes.default(""),
  policy: releaseFields.policy.default("OPTIONAL"),
  postponeHours: releaseFields.postponeHours.default(24),
  rolloutPercent: releaseFields.rolloutPercent.default(100),
  minimumVersion: releaseFields.minimumVersion.default(null),
  artifacts: releaseFields.artifacts.default([]),
});
export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;
/** Only the fields sent change (no defaults: a notes edit must not reset the rollout). */
export const updateReleaseSchema = z.object(releaseFields).partial();
export type UpdateReleaseInput = z.infer<typeof updateReleaseSchema>;
export const setReleaseStatusSchema = z.object({ status: z.enum(RELEASE_STATUSES), reason: z.string().trim().max(300).optional() });
export type SetReleaseStatusInput = z.infer<typeof setReleaseStatusSchema>;

export interface ReleaseArtifact {
  target: UpdateTarget;
  url: string;
  signature: string;
  sizeBytes: number | null;
  sha256: string | null;
  /** When the API last downloaded it and checked the signature (and the version it is bound to). */
  verifiedAt: string | null;
}
export interface DesktopRelease {
  id: string;
  version: string;
  notes: string;
  status: ReleaseStatus;
  policy: UpdatePolicy;
  postponeHours: number;
  rolloutPercent: number;
  minimumVersion: string | null;
  artifacts: ReleaseArtifact[];
  createdAt: string;
  createdBy: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  updatedAt: string;
}

/**
 * GET /desktop-updates/manifest/:target/:arch/:currentVersion (200; 204 = nothing to install). The first
 * six fields are the Tauri updater's "dynamic" format; the rest are read by the app from `rawJson`.
 */
export interface UpdateManifest {
  version: string;
  notes: string;
  pub_date: string;
  url: string;
  signature: string;
  policy: UpdatePolicy;
  /** True when this installation is below the minimum supported version (or the release is mandatory). */
  mandatory: boolean;
  minimumVersion: string | null;
  postponeHours: number;
  sizeBytes: number | null;
  releaseId: string;
}

export const reportUpdateStatusSchema = z.object({
  installedVersion: version,
  availableVersion: version.nullable().default(null),
  state: z.enum(UPDATE_STATES),
  /** Short, user-facing error text. Never a stack trace, path or URL with credentials. */
  failureReason: z.string().trim().max(300).nullable().default(null),
});
export type ReportUpdateStatusInput = z.infer<typeof reportUpdateStatusSchema>;

export interface DeviceUpdateStatus {
  deviceId: string;
  deviceName: string;
  platform: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  installedVersion: string;
  availableVersion: string | null;
  state: UpdateState;
  failureReason: string | null;
  lastCheckAt: string;
  lastUpdatedAt: string | null;
  lastUpdatedFrom: string | null;
}

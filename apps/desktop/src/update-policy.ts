// Update prompt rules and error wording. No Tauri imports, so node tests can drive it.
import { compareVersions, isVersion, type ReportUpdateStatusInput, type UpdateManifest, type UpdatePolicy } from "@workfolio/shared";

/** The policy fields the app reads from the updater's rawJson (the API's manifest). */
export interface Offer {
  version: string;
  notes: string;
  policy: UpdatePolicy;
  mandatory: boolean;
  postponeHours: number;
  sizeBytes: number | null;
}

const HOUR = 3_600_000;
/** "Later" on an optional update hides it this long. */
export const OPTIONAL_POSTPONE_HOURS = 24;
/** Background checks while the app runs. */
export const CHECK_EVERY_MS = 4 * HOUR;

/** Reads the manifest extras defensively: an older or foreign server may omit them (then: optional). */
export function offerOf(version: string, notes: string | undefined, raw: Record<string, unknown>): Offer {
  const m = raw as Partial<UpdateManifest>;
  const policy: UpdatePolicy = m.policy === "RECOMMENDED" || m.policy === "MANDATORY" ? m.policy : "OPTIONAL";
  const hours = Number.isInteger(m.postponeHours) && m.postponeHours! > 0 ? m.postponeHours! : OPTIONAL_POSTPONE_HOURS;
  return {
    version,
    notes: notes ?? "",
    policy,
    mandatory: m.mandatory === true,
    postponeHours: policy === "RECOMMENDED" ? hours : OPTIONAL_POSTPONE_HOURS,
    sizeBytes: typeof m.sizeBytes === "number" && m.sizeBytes > 0 ? m.sizeBytes : null,
  };
}

export interface Postponed {
  version: string;
  untilMs: number;
}

/** null = this offer cannot be postponed (mandatory for this installation). */
export const postponeFor = (o: Offer, nowMs: number): Postponed | null => (o.mandatory ? null : { version: o.version, untilMs: nowMs + o.postponeHours * HOUR });

/** Whether to show the prompt now. A manual check always shows it; a postponement covers one version only. */
export const shouldPrompt = (o: Offer, postponed: Postponed | null, nowMs: number, manual: boolean) =>
  manual || o.mandatory || !postponed || postponed.version !== o.version || nowMs >= postponed.untilMs;

export function formatBytes(n: number | null): string | null {
  if (!n) return null;
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * A short reason for the employee and the admin report (at most 300 characters, no paths or URLs).
 * Raw updater errors are English Rust messages; only the known cases are reworded.
 */
export function updateErrorReason(err: unknown): string {
  const raw = String(err instanceof Error ? err.message : err);
  const has = (re: RegExp) => re.test(raw);
  if (has(/signature|minisign|SignedVersion|signed version|signed for version|tampered|public key/i)) return "The downloaded update failed its security check and was not installed.";
  if (has(/no space|ENOSPC|os error 28|os error 112|not enough space|disk full/i)) return "Not enough free disk space to install the update.";
  if (has(/timed out|timeout|connect|dns|network|error sending request|error decoding response body|Connection|reset by peer|Download request failed/i)) return "The update could not be downloaded. Check your connection and try again.";
  if (has(/permission denied|access is denied|os error 5\b|os error 13\b|Operation not permitted/i)) return "The update could not be installed: the app's folder is not writable. Ask your IT administrator.";
  if (has(/not allowed|plugin .*not found|updater.*not.*(found|initialized)/i)) return "Updates are not available in this build of the app.";
  return `The update failed: ${raw.replace(/https?:\/\/\S+/g, "[url]").replace(/(\/|[A-Z]:\\)[^\s]*/g, "[path]").slice(0, 200)}`;
}

/** The manifest path the Tauri updater asks ({{target}}/{{arch}}/{{current_version}}); `os` is app_info's platform. */
export const manifestPath = (os: string, arch: string, version: string) =>
  `/desktop-updates/manifest/${os === "macos" ? "darwin" : os}/${encodeURIComponent(arch)}/${encodeURIComponent(version)}`;

/**
 * The report of a build without the updater (installed by hand). It still says which version is installed,
 * and whether the API offers a newer one (`manifest` undefined = 204, nothing to install).
 */
export function manualStatus(installedVersion: string, manifest: Partial<UpdateManifest> | undefined): ReportUpdateStatusInput {
  const v = manifest?.version;
  const newer = typeof v === "string" && isVersion(v) && isVersion(installedVersion) && compareVersions(v, installedVersion) > 0 ? v : null;
  return { installedVersion, availableVersion: newer, state: newer ? "AVAILABLE" : "UP_TO_DATE", failureReason: null };
}

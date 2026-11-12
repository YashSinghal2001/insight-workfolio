// Screenshot upload loop. No Tauri imports, so node tests can drive it with fakes.
// Order per screenshot: register metadata -> upload bytes -> the server answers STORED only after
// cloud storage confirmed the file. Nothing is deleted here; failures back off and retry.
import type { ScreenshotRegisterResponse, ScreenshotStoredResponse } from "@workfolio/shared";
import { maskText } from "./monitoring.ts";
import { HttpError, isNetworkError } from "./session.ts";

export interface ShotRow {
  id: string;
  sessionId: string;
  capturedMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  checksum: string;
  /** PENDING = register next; REGISTERED = upload the bytes next. */
  status: "PENDING" | "REGISTERED";
  retries: number;
  lastError: string | null;
  /** Privacy masks blacked out before this image was encoded; the server checks them against its policy. */
  masks: { x: number; y: number; w: number; h: number }[];
  /** The whole image was blurred before encoding; the server checks it against its policy. */
  blurred: boolean;
}

/**
 * The policy's blur setting for the native worker: absent (a server from before blur) = off;
 * anything but a boolean = unreadable (null), which pauses capture instead of capturing unblurred.
 */
export function policyBlur(policy: object): boolean | null {
  const blur = (policy as { blur?: unknown }).blur;
  return blur === undefined ? false : typeof blur === "boolean" ? blur : null;
}

/**
 * How long a cached screenshot policy may be acted on without hearing from the server. Online it is
 * refreshed every minute; offline the device cannot learn that an admin turned screenshots off or
 * changed the notice, and the server rejects whatever was captured after that anyway. 24 hours lets
 * a full working day offline (travel, an outage) still be captured as acknowledged, and bounds the
 * pointless capture to that day.
 */
export const POLICY_MAX_AGE_MS = 24 * 3_600_000;

/** Whether a policy fetched at `fetchedAtMs` may still be acted on. Unknown age (null) = no. */
export function policyFresh(fetchedAtMs: number | null, nowMs: number): boolean {
  return fetchedAtMs !== null && nowMs - fetchedAtMs <= POLICY_MAX_AGE_MS;
}

/** What the employee is told about blur and masks. */
export function privacyText(masks: readonly { label: string }[], blur: boolean | null): string {
  if (!blur) return maskText(masks);
  const line = "Screenshots are blurred: the whole image is blurred on this computer before it is saved, so text and details are not readable. The sharp image is never stored or uploaded.";
  return masks.length ? `${line} ${maskText(masks)}` : `${line} No areas are blacked out.`;
}

export type Outcome = "REGISTERED" | "STORED" | "REJECTED" | "RETRY";

export interface ShotDeps {
  next(nowMs: number): Promise<ShotRow | null>;
  read(id: string): Promise<ArrayBuffer>;
  mark(id: string, outcome: Outcome, reason: string | null, nowMs: number): Promise<void>;
  register(body: object): Promise<ScreenshotRegisterResponse>;
  upload(id: string, bytes: ArrayBuffer): Promise<ScreenshotStoredResponse>;
  /** Attendance changes are still waiting to sync: the server judges screenshots by attendance, so wait. */
  attendancePending(): boolean;
  now(): number;
}

/** Uploads waiting screenshots oldest first; stops at the first failure (it is retried later with backoff). */
export async function uploadScreenshots(deps: ShotDeps, max = 20): Promise<{ stored: number; rejected: number; failed: string | null }> {
  const out = { stored: 0, rejected: 0, failed: null as string | null };
  for (let n = 0; n < max && !deps.attendancePending(); n++) {
    const row = await deps.next(deps.now());
    if (!row) break;
    try {
      if (row.status === "PENDING") {
        const r = await deps.register({
          id: row.id,
          capturedAt: new Date(row.capturedMs).toISOString(),
          sentAt: new Date(deps.now()).toISOString(),
          width: row.width,
          height: row.height,
          sizeBytes: row.sizeBytes,
          checksum: row.checksum,
          mimeType: "image/webp",
          masks: row.masks ?? [],
          blurred: row.blurred === true,
        });
        if (r.status === "REJECTED") {
          await deps.mark(row.id, "REJECTED", r.reason ?? "Not accepted by the server", deps.now());
          out.rejected++;
          continue;
        }
        if (r.status === "STORED") {
          await deps.mark(row.id, "STORED", null, deps.now());
          out.stored++;
          continue;
        }
        await deps.mark(row.id, "REGISTERED", null, deps.now());
      }
      await deps.upload(row.id, await deps.read(row.id));
      await deps.mark(row.id, "STORED", null, deps.now());
      out.stored++;
    } catch (err) {
      // 410: the server will never accept it (expired under retention before upload). Kept locally as rejected, not retried.
      if (err instanceof HttpError && err.status === 410) {
        await deps.mark(row.id, "REJECTED", err.message, deps.now());
        out.rejected++;
        continue;
      }
      out.failed = isNetworkError(err) ? "Server unreachable" : err instanceof HttpError ? err.message : String(err);
      await deps.mark(row.id, "RETRY", out.failed, deps.now());
      break;
    }
  }
  return out;
}


/** Employee-facing name of the server's screenshot storage. Unknown providers get neutral wording. */
export function storageLabel(provider: string): string {
  switch (provider) {
    case "LOCAL_DEV":
      return "development storage on the API server; not cloud storage";
    case "MICROSOFT_GRAPH":
      return "Microsoft 365";
    case "GOOGLE_DRIVE":
      return "Google Drive";
    default:
      return "your organization's cloud storage";
  }
}

// Screenshot upload loop. No Tauri imports, so node tests can drive it with fakes.
// Order per screenshot: register metadata -> upload bytes -> the server answers STORED only after
// cloud storage confirmed the file. Nothing is deleted here; failures back off and retry.
import type { ScreenshotRegisterResponse, ScreenshotStoredResponse } from "@workfolio/shared";
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

import { z } from "zod";
import { screenshotGallerySchema } from "./screenshots.js";

// ---- Limits -------------------------------------------------------------------------

/**
 * A timelapse is one attendance session's already-stored screenshots, in capture order, as an
 * H.264 MP4. Nothing extra is captured for it. Every bound here is enforced by the API.
 */
export const TIMELAPSE_LIMITS = {
  /** Fewer stored screenshots than this is not a useful video. */
  minFrames: 2,
  /** ~33 h at the fastest capture interval (60 s); longer sessions are refused, not truncated. */
  maxFrames: 2000,
  fps: { min: 1, max: 30, default: 8 },
  /** Fixed output size; every frame is scaled to fit and letterboxed (aspect ratio kept). */
  width: 1280,
  height: 720,
  /** The encoder stops and the job fails beyond this. */
  maxOutputBytes: 150 * 1024 * 1024,
  /** Wall-clock limit per job; the encoder is killed after it. */
  maxProcessingMs: 15 * 60_000,
  /** Above this many frames the dashboard asks for confirmation (and the API requires `confirm`). */
  confirmAboveFrames: 600,
  /** Queued jobs across all admins; one encodes at a time. */
  maxQueued: 4,
} as const;

export const TIMELAPSE_MIME = "video/mp4";

/** Seconds of video: exactly one frame per 1/fps. */
export const timelapseDurationSeconds = (frames: number, fps: number) => Math.round((frames / fps) * 100) / 100;

// ---- Requests -----------------------------------------------------------------------

/** Session picker: one employee's sessions that started in the date range (viewer's time zone). */
export const timelapseSessionsSchema = screenshotGallerySchema.refine((q) => q.employeeId, { message: "Choose an employee", path: ["employeeId"] });
export type TimelapseSessionsQuery = z.infer<typeof timelapseSessionsSchema> & { employeeId: string };

export const timelapseCreateSchema = z
  .object({
    /** The employee is taken from the session, never from the request. */
    sessionId: z.uuid(),
    fps: z.number().int().min(TIMELAPSE_LIMITS.fps.min).max(TIMELAPSE_LIMITS.fps.max).default(TIMELAPSE_LIMITS.fps.default),
    /** Required when the session has more than `confirmAboveFrames` screenshots. */
    confirm: z.boolean().default(false),
  })
  .strict();
export type TimelapseCreateRequest = z.infer<typeof timelapseCreateSchema>;

/** `download=true` sends it as an attachment and logs a download instead of a view. */
export const timelapseContentQuerySchema = z.object({ download: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).strict();

// ---- Responses ----------------------------------------------------------------------

/**
 * QUEUED → RUNNING → READY | FAILED | CANCELLED. READY → EXPIRED (time limit, or a source
 * screenshot was deleted) or DELETED (by an admin). Only READY has a video file.
 */
export type TimelapseStatus = "QUEUED" | "RUNNING" | "READY" | "FAILED" | "CANCELLED" | "EXPIRED" | "DELETED";

export interface TimelapseJob {
  id: string;
  employeeId: string;
  sessionId: string;
  status: TimelapseStatus;
  fps: number;
  /** Stored screenshots when the job was queued. */
  framesTotal: number;
  /** Encoded so far (progress), or in the finished video. */
  framesDone: number;
  /** Unreadable, corrupt or vanished from storage: left out of the video. */
  framesSkipped: number;
  durationSeconds: number;
  width: number;
  height: number;
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  sizeBytes: number | null;
  /** SHA-256 (hex) of the video file, also sent as the Repr-Digest header. */
  sha256: string | null;
  error: string | null;
  /** Queued by the automatic daily videos setting (F01); requestedBy is then the admin whose settings version turned it on. */
  automatic: boolean;
  requestedBy: { id: string; email: string };
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}

export interface TimelapseSession {
  id: string;
  clockInAt: string;
  clockOutAt: string | null;
  /** Usable frames: stored screenshots. */
  stored: number;
  awaitingUpload: number;
  deleted: number;
  latestJob: TimelapseJob | null;
}

export interface TimelapseSessionsResponse {
  /** Whether this API host can encode at all (FFmpeg with libx264 found); the reason when not. */
  encoder: { available: boolean; reason: string | null };
  /** Hours a finished video is kept before it is deleted. */
  ttlHours: number;
  sessions: TimelapseSession[];
}

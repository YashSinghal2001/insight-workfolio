import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import type { Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TIMELAPSE_LIMITS } from "@workfolio/shared";
import type { Env } from "../config/env.js";

export interface EncodeOptions {
  fps: number;
  maxBytes: number;
  timeoutMs: number;
  /** Cancels the job: the encoder is killed. */
  signal: AbortSignal;
}

/**
 * Turns WebP frames (already in capture order) into an MP4 at `out`. Frames are pulled one at a
 * time, so memory holds one screenshot, not the day. Rejects on failure, timeout or abort; the
 * caller deletes `out` then.
 */
export interface TimelapseEncoder {
  /** Null when usable, otherwise why not (shown to admins). */
  probe(): Promise<string | null>;
  encode(frames: AsyncIterable<Uint8Array>, out: string, o: EncodeOptions): Promise<void>;
}

export const TIMELAPSE_ENCODER = Symbol("TIMELAPSE_ENCODER");

/** Message is safe to show to admins; `detail` (FFmpeg's stderr tail) is for the server log only. */
export class EncoderError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

const { width: W, height: H } = TIMELAPSE_LIMITS;

/** Arguments for one encode. Exported for tests. */
export const ffmpegArgs = (o: Pick<EncodeOptions, "fps" | "maxBytes">, out: string) => [
  "-hide_banner", "-loglevel", "error", "-nostats",
  // Concatenated WebP files on stdin; every frame lasts exactly 1/fps.
  "-threads", "1", "-f", "webp_pipe", "-framerate", String(o.fps), "-i", "pipe:0", // one decoding thread
  // Fit inside W×H, never stretched or upscaled past it; letterbox the rest.
  "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-threads", "2", "-filter_threads", "1",
  "-r", String(o.fps), "-fs", String(o.maxBytes), "-movflags", "+faststart", "-an", "-f", "mp4", "-y", out,
];

/** System FFmpeg (operator-installed; never bundled). One child process per job. */
export function ffmpegEncoder(path: string): TimelapseEncoder {
  return {
    async probe() {
      const run = (arg: string) => promisify(execFile)(path, ["-hide_banner", arg], { timeout: 10_000, maxBuffer: 4 << 20 }).then((r) => r.stdout);
      try {
        const [encoders, demuxers] = await Promise.all([run("-encoders"), run("-demuxers")]);
        if (!/\blibx264\b/.test(encoders)) return "FFmpeg was found but was built without libx264 (H.264)";
        if (!/\bwebp_pipe\b/.test(demuxers)) return "FFmpeg was found but cannot read WebP";
        return null;
      } catch {
        return "FFmpeg is not installed on the API server (or FFMPEG_PATH is wrong)";
      }
    },

    async encode(frames, out, o) {
      const timeout = AbortSignal.timeout(o.timeoutMs);
      const child = spawn(path, ffmpegArgs(o, out), { stdio: ["pipe", "ignore", "pipe"], signal: AbortSignal.any([o.signal, timeout]), killSignal: "SIGKILL" });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      child.stdin.on("error", () => undefined); // EPIPE when FFmpeg stops early; reported through the exit
      const exited = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, sig) => (code === 0 ? resolve() : reject(new EncoderError("The video encoder failed", `exit ${code ?? sig}: ${stderr}`))));
      });
      // Anything that ends FFmpeg before all frames are sent is a failure.
      const early = exited.then(() => Promise.reject(new EncoderError("The video encoder stopped early", stderr)));
      early.catch(() => undefined);
      const it = frames[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await Promise.race([it.next(), early]);
          if (next.done) break;
          if (!child.stdin.write(next.value)) await Promise.race([once(child.stdin, "drain"), early]);
        }
        child.stdin.end();
        await exited;
      } catch (err) {
        child.kill("SIGKILL");
        await exited.catch(() => undefined);
        void it.return?.();
        if (timeout.aborted) throw new EncoderError(`Encoding took longer than ${Math.round(o.timeoutMs / 60_000)} minutes and was stopped`);
        throw err;
      }
    },
  };
}

export const timelapseEncoderProvider: Provider = {
  provide: TIMELAPSE_ENCODER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => ffmpegEncoder(config.get("FFMPEG_PATH", { infer: true })),
};

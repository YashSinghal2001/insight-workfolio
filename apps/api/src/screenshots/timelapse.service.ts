import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DatabaseClient, Row } from "@workfolio/database";
import {
  addDays,
  localDate,
  TIMELAPSE_LIMITS,
  timelapseDurationSeconds,
  zonedToUtc,
  type TimelapseCreateRequest,
  type TimelapseJob,
  type TimelapseSessionsQuery,
  type TimelapseSessionsResponse,
  type TimelapseStatus,
} from "@workfolio/shared";
import { iso, str } from "../attendance/sessions.js";
import type { AuthContext } from "../auth/auth.service.js";
import type { Env } from "../config/env.js";
import { inScope } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { webpSize } from "./screenshots.service.js";
import { SCREENSHOT_STORAGE, StorageError, timelapseKey, type ScreenshotStorage } from "./storage.js";
import { EncoderError, TIMELAPSE_ENCODER, type TimelapseEncoder } from "./timelapse-encoder.js";

const SWEEP_MS = 5 * 60_000;
const PROGRESS_MS = 1_000;
/** F01: how often finished days are checked for automatic videos, and how far back. */
const AUTO_MS = 15 * 60_000;
const AUTO_LOOKBACK_MS = 3 * 86_400_000;
const OWN_FILE = /\.mp4(\.part)?$/;
const JOB_COLUMNS = `t.id, t.employee_id, t.attendance_session_id, t.status, t.fps, t.frames_total, t.frames_done, t.frames_skipped,
  t.first_captured_at, t.last_captured_at, t.size_bytes, t.sha256, t.error, t.created_at, t.finished_at, t.expires_at, t.automatic,
  u.id AS requested_by, u.email AS requested_by_email`;

/** A job failure whose message is safe to show to admins. */
class JobFailure extends Error {}

type Action = "CREATE" | "VIEW" | "DOWNLOAD" | "CANCEL" | "DELETE";

/**
 * Timelapse videos of one attendance session's stored screenshots (admins only). Jobs live in the
 * database; one encodes at a time in this process, through an external FFmpeg process, with a
 * bounded queue. Videos are encoded in TIMELAPSE_DIR (0700/0600, scratch only), then stored with the file
 * storage provider (OneDrive in production, timelapses/<employee>/<id>.mp4) and removed from this host.
 * Stored videos are deleted after TIMELAPSE_TTL_HOURS, or as soon as a screenshot they may contain is deleted.
 * ponytail: single API instance (as deployed, docs/deployment.md); several instances would need
 * shared storage for the files and a DB claim that survives a crashed worker.
 */
@Injectable()
export class TimelapseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimelapseService.name);
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly minFreeBytes: number;
  private encoderReason: string | null = "The video encoder has not been checked yet";
  private running: { id: string; abort: AbortController; finished: Promise<void> } | null = null;
  private pumping: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;
  private autoTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
    @Inject(TIMELAPSE_ENCODER) readonly encoder: TimelapseEncoder,
    private readonly config: ConfigService<Env, true>,
  ) {
    const test = config.get("NODE_ENV", { infer: true }) === "test";
    this.dir = resolve(config.get("TIMELAPSE_DIR", { infer: true }) ?? (test ? mkdtempSync(join(tmpdir(), "wf-timelapses-")) : "./data/timelapses"));
    this.ttlMs = config.get("TIMELAPSE_TTL_HOURS", { infer: true }) * 3_600_000;
    this.minFreeBytes = config.get("TIMELAPSE_MIN_FREE_MB", { infer: true }) * 1_048_576;
  }

  /**
   * Disk guard: null when the scratch filesystem has at least TIMELAPSE_MIN_FREE_MB free (plus room for one
   * video), otherwise why a video must not be started now. Protects the database, which shares the disk.
   */
  async diskReason(): Promise<string | null> {
    if (!this.minFreeBytes) return null;
    const st = await statfs(this.dir).catch(() => null);
    if (!st) return null; // unknown filesystem: do not block on a probe failure
    const free = Number(st.bavail) * Number(st.bsize);
    const need = this.minFreeBytes + TIMELAPSE_LIMITS.maxOutputBytes;
    if (free >= need) return null;
    this.logger.warn({ freeBytes: free, requiredBytes: need, dir: this.dir }, "Timelapse refused: low disk space");
    const mb = (n: number) => Math.floor(n / 1_048_576); // not >>: free space exceeds 32 bits
    return `the server is low on disk space (${mb(free)} MB free, ${mb(need)} MB needed)`;
  }

  async onModuleInit() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    this.encoderReason = await this.encoder.probe();
    if (this.encoderReason) this.logger.warn(`Timelapse videos unavailable: ${this.encoderReason}`);
    // A job that was encoding when the process stopped cannot be resumed; its partial file goes.
    await this.db.execute({
      sql: "UPDATE timelapses SET status = 'FAILED', error = ?, finished_at = ? WHERE status = 'RUNNING'",
      args: ["Interrupted because the server restarted. Create it again.", iso(Date.now())],
    });
    await this.sweep();
    void this.pump();
    if (this.config.get("NODE_ENV", { infer: true }) === "test") return;
    this.timer = setInterval(() => void this.sweep().catch((err: Error) => this.logger.error({ err: err.message }, "Timelapse sweep failed")), SWEEP_MS);
    this.timer.unref();
    this.autoTimer = setInterval(() => void this.autoTick().catch((err: Error) => this.logger.error({ err: err.message }, "Automatic timelapses failed")), AUTO_MS);
    this.autoTimer.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    clearInterval(this.autoTimer);
    this.stopping = true;
    this.running?.abort.abort();
    await this.running?.finished;
  }

  // ---- Reading --------------------------------------------------------------------------

  /** One employee's sessions that started in the range, with screenshot counts and the latest video job. */
  async sessions(q: TimelapseSessionsQuery, caller: AuthContext): Promise<TimelapseSessionsResponse> {
    if (!(await inScope(this.db, caller, "screenshots:read", q.employeeId))) throw new NotFoundException("Employee not found");
    await this.sweep();
    const { rows } = await this.db.execute({
      sql: `SELECT s.id, s.clock_in_at, s.clock_out_at,
              count(CASE WHEN sc.upload_status = 'STORED' THEN 1 END) AS stored,
              count(CASE WHEN sc.upload_status = 'REGISTERED' THEN 1 END) AS awaiting,
              count(CASE WHEN sc.upload_status = 'DELETED' THEN 1 END) AS deleted
            FROM attendance_sessions s LEFT JOIN screenshots sc ON sc.attendance_session_id = s.id
            WHERE s.employee_id = ? AND s.clock_in_at >= ? AND s.clock_in_at < ?
            GROUP BY s.id ORDER BY s.clock_in_at DESC LIMIT 100`,
      args: [q.employeeId, zonedToUtc(`${q.from}T00:00`, q.tz), zonedToUtc(`${addDays(q.to, 1)}T00:00`, q.tz)],
    });
    const jobs = rows.length
      ? (
          await this.db.execute({
            sql: `SELECT ${JOB_COLUMNS} FROM timelapses t JOIN users u ON u.id = t.requested_by
                  WHERE t.attendance_session_id IN (${rows.map(() => "?").join(", ")}) ORDER BY t.created_at DESC, t.rowid DESC`,
            args: rows.map((r) => String(r.id)),
          })
        ).rows.map(toJob)
      : [];
    return {
      encoder: { available: !this.encoderReason, reason: this.encoderReason },
      ttlHours: this.ttlMs / 3_600_000,
      sessions: rows.map((r) => ({
        id: String(r.id),
        clockInAt: String(r.clock_in_at),
        clockOutAt: str(r.clock_out_at),
        stored: Number(r.stored),
        awaitingUpload: Number(r.awaiting),
        deleted: Number(r.deleted),
        latestJob: jobs.find((j) => j.sessionId === r.id) ?? null,
      })),
    };
  }

  /** With `caller`: 404 unless the video's employee is in their scope (team heads: their teams, W41). */
  async job(id: string, caller?: AuthContext): Promise<TimelapseJob> {
    await this.sweep();
    const { rows } = await this.db.execute({ sql: `SELECT ${JOB_COLUMNS} FROM timelapses t JOIN users u ON u.id = t.requested_by WHERE t.id = ?`, args: [id] });
    if (!rows[0] || (caller && !(await inScope(this.db, caller, "screenshots:read", String(rows[0].employee_id))))) throw new NotFoundException("Timelapse not found");
    return toJob(rows[0]);
  }

  /** The video file, after checking it still exists with the recorded size. Every access is logged. */
  async content(caller: AuthContext, id: string, download: boolean): Promise<{ stream: Readable; job: TimelapseJob }> {
    const job = await this.job(id, caller);
    if (job.status === "EXPIRED" || job.status === "DELETED") throw new GoneException(`This timelapse was ${job.status === "EXPIRED" ? "removed" : "deleted"}${job.error ? `: ${job.error}` : ""}. Create it again.`);
    if (job.status !== "READY") throw new ConflictException("This timelapse is not ready");
    const key = timelapseKey(job.employeeId, id);
    const unavailable = (err: unknown) => {
      if (!(err instanceof StorageError)) throw err;
      this.logger.warn({ timelapseId: id, err: err.message }, "Timelapse storage unavailable");
      throw new BadGatewayException("Video storage is unavailable; try again shortly");
    };
    const item = await this.storage.stat(key).catch(unavailable);
    if (item?.size !== job.sizeBytes) {
      this.logger.error({ timelapseId: id, size: item?.size ?? null }, "Timelapse file missing or changed");
      await this.discard(id, "READY", "EXPIRED", "The video file was missing or changed in storage");
      throw new GoneException("The video file is no longer available. Create it again.");
    }
    const { stream } = await this.storage.getStream(key, TIMELAPSE_LIMITS.maxOutputBytes).catch(unavailable);
    await this.log(id, caller, download ? "DOWNLOAD" : "VIEW");
    return { stream, job };
  }

  // ---- Changes --------------------------------------------------------------------------

  /** Queues a video of the session's stored screenshots, or returns the job already queued/encoding for it. */
  async create(caller: AuthContext, req: TimelapseCreateRequest): Promise<TimelapseJob> {
    const { rows: sessions } = await this.db.execute({ sql: "SELECT id, employee_id FROM attendance_sessions WHERE id = ?", args: [req.sessionId] });
    const session = sessions[0];
    if (!session || !(await inScope(this.db, caller, "screenshots:read", String(session.employee_id)))) throw new NotFoundException("Session not found");
    if (this.encoderReason) throw new ServiceUnavailableException(`Timelapse videos are not available on this server: ${this.encoderReason}`);
    const disk = await this.diskReason();
    if (disk) throw new ServiceUnavailableException(`Timelapse videos are not available right now: ${disk}`);

    const active = await this.activeFor(req.sessionId);
    if (active) return this.job(active);
    const frames = (await this.frames(session)).length;
    const { minFrames, maxFrames, confirmAboveFrames, maxQueued } = TIMELAPSE_LIMITS;
    if (frames < minFrames) throw new UnprocessableEntityException(`This session has ${frames} stored screenshot(s); at least ${minFrames} are needed for a video`);
    if (frames > maxFrames) throw new UnprocessableEntityException(`This session has ${frames} stored screenshots; the limit is ${maxFrames}`);
    if (frames > confirmAboveFrames && !req.confirm) throw new BadRequestException(`This session has ${frames} screenshots; confirm to create a video this large`);
    const { rows: queued } = await this.db.execute("SELECT count(*) AS n FROM timelapses WHERE status = 'QUEUED'");
    if (Number(queued[0]!.n) >= maxQueued) throw new HttpException("Too many timelapses are waiting. Try again in a few minutes.", HttpStatus.TOO_MANY_REQUESTS);

    const id = randomUUID();
    try {
      // The job and its CREATE log row together: never a job without a record of who asked for it.
      await this.db.batch(
        [
          {
            sql: "INSERT INTO timelapses (id, employee_id, attendance_session_id, requested_by, fps, status, frames_total) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?)",
            args: [id, String(session.employee_id), req.sessionId, caller.id, req.fps, frames],
          },
          this.logRow(id, caller, "CREATE"),
        ],
        "write",
      );
    } catch (err) {
      // Another request queued one for this session in the meantime (unique index): same job.
      const raced = await this.activeFor(req.sessionId);
      if (raced) return this.job(raced);
      throw err;
    }
    this.logger.log({ userId: caller.id, timelapseId: id, action: "CREATE" }, "Timelapse accessed");
    this.logger.log({ timelapseId: id, sessionId: req.sessionId, userId: caller.id, frames, fps: req.fps }, "Timelapse queued");
    void this.pump();
    return this.job(id);
  }

  /** Stops a queued or encoding job (its partial file is deleted). */
  async cancel(caller: AuthContext, id: string): Promise<TimelapseJob> {
    const job = await this.job(id, caller);
    if (job.status !== "QUEUED" && job.status !== "RUNNING") throw new ConflictException("This timelapse has already finished");
    // The status change and its CANCEL log row together, the row only if this request changed it. An
    // encoding job is marked here too: the worker's final updates (WHERE status = 'RUNNING') then no-op.
    const log = this.logRow(id, caller, "CANCEL");
    const [changed] = await this.db.batch(
      [
        { sql: "UPDATE timelapses SET status = 'CANCELLED', finished_at = ? WHERE id = ? AND status IN ('QUEUED', 'RUNNING')", args: [iso(Date.now()), id] },
        { sql: "INSERT INTO timelapse_access_log (id, timelapse_id, user_id, action) SELECT ?, ?, ?, ? WHERE changes() > 0", args: log.args },
      ],
      "write",
    );
    if (changed!.rowsAffected) this.logger.log({ userId: caller.id, timelapseId: id, action: "CANCEL" }, "Timelapse accessed");
    if (this.running?.id === id) {
      this.running.abort.abort();
      await this.running.finished;
    }
    return this.job(id);
  }

  /** Deletes the video now (or cancels the job). Idempotent; the record and its access log stay. */
  async remove(caller: AuthContext, id: string): Promise<void> {
    const job = await this.job(id, caller);
    if (job.status === "QUEUED" || job.status === "RUNNING") await this.cancel(caller, id);
    await this.log(id, caller, "DELETE");
    if (job.status === "READY") await this.discard(id, "READY", "DELETED", null);
  }

  /**
   * Deletes videos past their time, videos that may show a screenshot deleted since they were
   * made (retention), and any file without a READY record (orphans of a crash).
   */
  async sweep(now = Date.now()) {
    const { rows } = await this.db.execute({
      sql: `SELECT t.id, CASE WHEN t.expires_at <= ? THEN 'Expired after ${this.ttlMs / 3_600_000} h'
                         ELSE 'A screenshot in it was deleted (by an administrator or under the retention policy)' END AS reason
            FROM timelapses t WHERE t.status = 'READY' AND (t.expires_at <= ? OR EXISTS (
              SELECT 1 FROM screenshots s WHERE s.attendance_session_id = t.attendance_session_id
                AND s.upload_status = 'DELETED' AND s.deleted_at >= t.created_at))`,
      args: [iso(now), iso(now)],
    });
    for (const r of rows) {
      // Storage down: the video stays READY and is retried by the next sweep; reads keep working meanwhile.
      await this.discard(String(r.id), "READY", "EXPIRED", String(r.reason)).catch((err: unknown) => {
        if (!(err instanceof StorageError)) throw err;
        this.logger.warn({ timelapseId: String(r.id), err: err.message }, "Timelapse delete from storage failed; retried later");
      });
    }
    // Local files are encoding scratch only (and pre-storage caches): everything but the running job's goes.
    const keep = new Set<string>();
    if (this.running) keep.add(`${this.running.id}.mp4.part`);
    // Only names this service creates: a misconfigured TIMELAPSE_DIR never loses anything else.
    for (const f of await readdir(this.dir)) if (OWN_FILE.test(f) && !keep.has(f)) await rm(join(this.dir, f), { force: true });
  }

  /**
   * F01 automatic daily videos. When the screenshot settings turn them on, queues one video per
   * finished session (clocked out) whose employee's local day has ended (local date of clock-in, in the
   * last 3 days), once per session: never again after an automatic job, nor while a manual one is
   * queued, encoding or ready. Same queue, frames (stored screenshots only, never deleted ones) and
   * limits as a manual request, but always leaves one queue slot for admins; the rest wait for the next
   * tick. requestedBy is the admin whose settings version turned it on. Returns the number queued.
   * ponytail: one job per session, not one per employee-day; a day with several shifts gets several videos.
   */
  async autoTick(now = Date.now()): Promise<number> {
    if (this.encoderReason) return 0;
    const { rows: policy } = await this.db.execute("SELECT auto_timelapse, changed_by FROM screenshot_policies ORDER BY seq DESC LIMIT 1");
    if (Number(policy[0]?.auto_timelapse) !== 1) return 0;
    const by = { id: String(policy[0]!.changed_by) };
    const { rows } = await this.db.execute({
      sql: `SELECT s.id, s.employee_id, s.clock_in_at, e.timezone, count(*) AS frames
            FROM attendance_sessions s JOIN employee_profiles e ON e.id = s.employee_id
            JOIN screenshots sc ON sc.attendance_session_id = s.id AND sc.employee_id = s.employee_id AND sc.upload_status = 'STORED'
            WHERE s.clock_out_at IS NOT NULL AND s.clock_in_at >= ? AND s.clock_in_at < ?
              AND NOT EXISTS (SELECT 1 FROM timelapses t WHERE t.attendance_session_id = s.id AND (t.automatic = 1 OR t.status IN ('QUEUED', 'RUNNING', 'READY')))
            GROUP BY s.id ORDER BY s.clock_in_at, s.id`,
      args: [iso(now - AUTO_LOOKBACK_MS), iso(now)],
    });
    const { minFrames, maxFrames, maxQueued } = TIMELAPSE_LIMITS;
    let queued = 0;
    for (const r of rows) {
      const tz = String(r.timezone);
      if (Date.parse(zonedToUtc(`${addDays(localDate(String(r.clock_in_at), tz), 1)}T00:00`, tz)) > now) continue; // their day has not ended
      const frames = Number(r.frames);
      if (frames < minFrames || frames > maxFrames) continue;
      const { rows: waiting } = await this.db.execute("SELECT count(*) AS n FROM timelapses WHERE status = 'QUEUED'");
      if (Number(waiting[0]!.n) >= maxQueued - 1) break;
      const id = randomUUID();
      try {
        await this.db.batch(
          [
            {
              sql: "INSERT INTO timelapses (id, employee_id, attendance_session_id, requested_by, fps, status, frames_total, automatic) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, 1)",
              args: [id, String(r.employee_id), String(r.id), by.id, TIMELAPSE_LIMITS.fps.default, frames],
            },
            this.logRow(id, by, "CREATE"),
          ],
          "write",
        );
      } catch (err) {
        if (await this.activeFor(String(r.id))) continue; // an admin queued one for this session meanwhile
        throw err;
      }
      queued++;
      this.logger.log({ timelapseId: id, sessionId: String(r.id), frames, automatic: true }, "Timelapse queued");
    }
    if (queued) void this.pump();
    return queued;
  }

  // ---- Worker ---------------------------------------------------------------------------

  /** Encodes queued jobs one at a time, oldest first. Safe to call often. */
  pump(): Promise<void> {
    this.pumping ??= (async () => {
      try {
        for (;;) {
          const { rows } = await this.db.execute("SELECT id FROM timelapses WHERE status = 'QUEUED' ORDER BY created_at, rowid LIMIT 1");
          if (!rows[0]) return;
          const id = String(rows[0].id);
          // Registered before the claim, so a cancel arriving meanwhile always reaches this job.
          const abort = new AbortController();
          let finish!: () => void;
          this.running = { id, abort, finished: new Promise((r) => (finish = r)) };
          try {
            const claimed = await this.db.execute({ sql: "UPDATE timelapses SET status = 'RUNNING' WHERE id = ? AND status = 'QUEUED'", args: [id] });
            if (claimed.rowsAffected) await this.run(id, abort.signal);
          } finally {
            this.running = null;
            finish();
          }
        }
      } catch (err) {
        this.logger.error({ err: (err as Error).message }, "Timelapse worker failed");
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  private async run(id: string, signal: AbortSignal) {
    const part = `${this.file(id)}.part`;
    const { rows } = await this.db.execute({ sql: "SELECT t.fps, t.attendance_session_id AS id, t.employee_id FROM timelapses t WHERE t.id = ?", args: [id] });
    const job = rows[0]!;
    let done = 0;
    let skipped = 0;
    let first: string | null = null;
    let last: string | null = null;
    try {
      const disk = await this.diskReason();
      if (disk) throw new JobFailure(`Not encoded: ${disk}. Create it again later.`);
      const frames = await this.frames(job);
      const progress = (lastAt: number) => this.db.execute({ sql: "UPDATE timelapses SET frames_done = ?, frames_skipped = ? WHERE id = ?", args: [done, skipped, id] }).then(() => lastAt);
      const storage = this.storage;
      const logger = this.logger;
      async function* readFrames() {
        let reported = Date.now();
        for (const f of frames) {
          signal.throwIfAborted();
          const bytes = await storage.get(String(f.storage_key)).catch((err: unknown) => {
            if (!(err instanceof StorageError)) throw err;
            return null;
          });
          // Exactly the bytes that were registered and checked at upload; anything else is left out.
          const dims = bytes && webpSize(bytes);
          if (!bytes || bytes.length !== Number(f.file_size_bytes) || dims?.width !== Number(f.width) || dims.height !== Number(f.height)
            || createHash("sha256").update(bytes).digest("hex") !== f.checksum) {
            logger.warn({ timelapseId: id, screenshotId: f.id, found: !!bytes }, "Timelapse frame unreadable or changed; skipped");
            skipped++;
            continue;
          }
          yield bytes;
          done++;
          first ??= String(f.captured_at);
          last = String(f.captured_at);
          if (Date.now() - reported > PROGRESS_MS) reported = await progress(Date.now());
        }
        if (done < TIMELAPSE_LIMITS.minFrames) throw new JobFailure(`Only ${done} screenshot(s) could be read from storage (${skipped} unreadable); at least ${TIMELAPSE_LIMITS.minFrames} are needed`);
      }
      await this.encoder.encode(readFrames(), part, { fps: Number(job.fps), maxBytes: TIMELAPSE_LIMITS.maxOutputBytes, timeoutMs: TIMELAPSE_LIMITS.maxProcessingMs, signal });
      // -fs stops FFmpeg at the limit with a cut-off video: treat reaching it as a failure.
      const { size } = await stat(part);
      if (size >= TIMELAPSE_LIMITS.maxOutputBytes * 0.99) throw new JobFailure(`The video would be larger than ${TIMELAPSE_LIMITS.maxOutputBytes >> 20} MB`);
      const sha256 = await sha256File(part);
      await chmod(part, 0o600);
      const key = timelapseKey(String(job.employee_id), id);
      const stored = await this.storage.putFile(key, part).catch((err: unknown) => {
        if (!(err instanceof StorageError)) throw err;
        this.logger.warn({ timelapseId: id, err: err.message }, "Timelapse upload to storage failed");
        throw new JobFailure("The video could not be saved to storage. Create it again.");
      });
      await rm(part, { force: true });
      if (stored.size !== size) {
        await this.storage.delete(key).catch(() => {});
        throw new JobFailure("Storage did not confirm the video (size mismatch). Create it again.");
      }
      const now = Date.now();
      const ok = await this.db.execute({
        sql: `UPDATE timelapses SET status = 'READY', frames_done = ?, frames_skipped = ?, first_captured_at = ?, last_captured_at = ?,
                size_bytes = ?, sha256 = ?, finished_at = ?, expires_at = ? WHERE id = ? AND status = 'RUNNING'`,
        args: [done, skipped, first, last, size, sha256, iso(now), iso(now + this.ttlMs), id],
      });
      if (!ok.rowsAffected) await this.storage.delete(key).catch(() => {}); // cancelled meanwhile
      // One video per session on disk: "Create again" replaces the previous one instead of piling up until its TTL.
      const { rows: older } = await this.db.execute({ sql: "SELECT id FROM timelapses WHERE attendance_session_id = ? AND status = 'READY' AND id != ?", args: [String(job.id), id] });
      for (const r of older) await this.discard(String(r.id), "READY", "EXPIRED", "Replaced by a newer video of the same session").catch(() => {}); // else expires on its TTL
      this.logger.log({ timelapseId: id, frames: done, skipped, bytes: size }, "Timelapse ready");
    } catch (err) {
      await rm(part, { force: true });
      const cancelled = signal.aborted && !this.stopping;
      const message = this.stopping ? "Interrupted because the server stopped. Create it again."
        : err instanceof JobFailure || err instanceof EncoderError ? err.message : "The video could not be created";
      if (!cancelled) this.logger.warn({ timelapseId: id, err: (err as Error).message, detail: (err as EncoderError).detail }, "Timelapse failed");
      await this.db.execute({
        sql: "UPDATE timelapses SET status = ?, error = ?, frames_done = ?, frames_skipped = ?, finished_at = ? WHERE id = ? AND status = 'RUNNING'",
        args: [cancelled ? "CANCELLED" : "FAILED", cancelled ? null : message, done, skipped, iso(Date.now()), id],
      });
    }
  }

  // ---- internals ------------------------------------------------------------------------

  /** The session's stored screenshots of its own employee, by verified (server-corrected) capture time. */
  private async frames(session: Row) {
    const { rows } = await this.db.execute({
      sql: `SELECT id, storage_key, file_size_bytes, width, height, checksum, captured_at FROM screenshots
            WHERE attendance_session_id = ? AND employee_id = ? AND upload_status = 'STORED' ORDER BY captured_at, id`,
      args: [String(session.id), String(session.employee_id)],
    });
    return rows;
  }

  private async activeFor(sessionId: string): Promise<string | null> {
    const { rows } = await this.db.execute({ sql: "SELECT id FROM timelapses WHERE attendance_session_id = ? AND status IN ('QUEUED', 'RUNNING')", args: [sessionId] });
    return rows[0] ? String(rows[0].id) : null;
  }

  private file(id: string) {
    return join(this.dir, `${id}.mp4`);
  }

  /** File first (idempotent in storage), then the record: a failed delete leaves it READY, to be retried by the next sweep. */
  private async discard(id: string, from: TimelapseStatus, to: TimelapseStatus, reason: string | null) {
    const { rows } = await this.db.execute({ sql: "SELECT employee_id FROM timelapses WHERE id = ?", args: [id] });
    if (rows[0]) await this.storage.delete(timelapseKey(String(rows[0].employee_id), id));
    await this.db.execute({ sql: "UPDATE timelapses SET status = ?, error = coalesce(?, error) WHERE id = ? AND status = ?", args: [to, reason, id, from] });
    this.logger.log({ timelapseId: id, status: to, reason }, "Timelapse video deleted");
  }

  private logRow(id: string, caller: Pick<AuthContext, "id">, action: Action) {
    return { sql: "INSERT INTO timelapse_access_log (id, timelapse_id, user_id, action) VALUES (?, ?, ?, ?)", args: [randomUUID(), id, caller.id, action] };
  }

  private async log(id: string, caller: AuthContext, action: Action) {
    await this.db.execute(this.logRow(id, caller, action));
    this.logger.log({ userId: caller.id, timelapseId: id, action }, "Timelapse accessed");
  }
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const toJob = (r: Row): TimelapseJob => {
  const done = Number(r.frames_done);
  const status = r.status as TimelapseStatus;
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    sessionId: String(r.attendance_session_id),
    status,
    fps: Number(r.fps),
    automatic: Number(r.automatic) === 1,
    framesTotal: Number(r.frames_total),
    framesDone: done,
    framesSkipped: Number(r.frames_skipped),
    durationSeconds: timelapseDurationSeconds(status === "READY" ? done : Number(r.frames_total), Number(r.fps)),
    width: TIMELAPSE_LIMITS.width,
    height: TIMELAPSE_LIMITS.height,
    firstCapturedAt: str(r.first_captured_at),
    lastCapturedAt: str(r.last_captured_at),
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    sha256: str(r.sha256),
    error: str(r.error),
    requestedBy: { id: String(r.requested_by), email: String(r.requested_by_email) },
    createdAt: String(r.created_at),
    finishedAt: str(r.finished_at),
    expiresAt: str(r.expires_at),
  };
};

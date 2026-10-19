import { createHash, randomUUID } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DatabaseClient, Row } from "@workfolio/database";
import {
  addDays,
  hasPermission,
  todayIn,
  zonedToUtc,
  type AttendancePolicy,
  type AuthUser,
  type EmployeeRef,
  type Paginated,
  SCREENSHOT_LIMITS,
  type ScreenshotDeletionMode,
  type ScreenshotDetail,
  type ScreenshotGalleryItem,
  type ScreenshotGalleryQuery,
  type ScreenshotItem,
  type ScreenshotOverview,
  type ScreenshotQuery,
  type ScreenshotRegisterRequest,
  type ScreenshotRegisterResponse,
  type ScreenshotRetentionPreview,
  type ScreenshotStatusResponse,
  type ScreenshotStorageProvider,
  type ScreenshotStoredResponse,
  type ScreenshotUploadStatus,
} from "@workfolio/shared";
import { clockedInSegments, iso, str } from "../attendance/sessions.js";
import { RateLimiter } from "../auth/crypto.js";
import type { AuthContext } from "../auth/auth.service.js";
import { EmployeeLocks } from "../common/employee-locks.js";
import { POLICY } from "../common/policy.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import type { DeviceContext } from "../devices/devices.service.js";
import { MonitoringSettingsService } from "../settings/monitoring-settings.service.js";
import { ScreenshotSettingsService } from "./screenshot-settings.service.js";
import { quickXorHash, SCREENSHOT_STORAGE, StorageError, type ScreenshotStorage } from "./storage.js";

const DAY_MS = 86_400_000;
/** A capture this far in the future (after skew correction) is refused. */
const FUTURE_TOLERANCE_MS = 60_000;
const SCHEDULE_MS = 6 * 3_600_000;
const RETENTION_CHUNK = 100;

/** Registered but not uploaded for longer than this: the desktop is offline or retrying. */
const STALLED_MS = 3_600_000;
const GALLERY_COLUMNS = `s.id, s.employee_id, s.captured_at, s.width, s.height, s.file_size_bytes, s.upload_status, s.storage_provider, s.stored_at,
  p.full_name, p.employee_code`;
const ITEM_COLUMNS = "id, employee_id, captured_at, width, height, file_size_bytes, upload_status, storage_provider, stored_at";
const toItem = (r: Row): ScreenshotItem => ({
  id: String(r.id),
  employeeId: String(r.employee_id),
  capturedAt: String(r.captured_at),
  width: Number(r.width),
  height: Number(r.height),
  fileSizeBytes: Number(r.file_size_bytes),
  uploadStatus: r.upload_status as ScreenshotUploadStatus,
  storageProvider: r.storage_provider as ScreenshotStorageProvider,
  storedAt: str(r.stored_at),
});

const toGalleryItem = (r: Row): ScreenshotGalleryItem => ({
  ...toItem(r),
  employee: { id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code) },
});

/** Width and height from a WebP header (VP8, VP8L or VP8X), or null when it is not a valid WebP. */
export function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const ascii = (o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length < 30 || !ascii(0, "RIFF") || !ascii(8, "WEBP")) return null;
  const le = (o: number, n: number) => [...b.subarray(o, o + n)].reduceRight((v, x) => v * 256 + x, 0);
  if (le(4, 4) + 8 !== b.length) return null; // RIFF size must match: catches truncated files
  if (ascii(12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: le(26, 2) & 0x3fff, height: le(28, 2) & 0x3fff };
  if (ascii(12, "VP8L") && b[20] === 0x2f) {
    const bits = le(21, 4);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(12, "VP8X")) return { width: le(24, 3) + 1, height: le(27, 3) + 1 };
  return null;
}

/**
 * Screenshot metadata and brokered uploads. The desktop registers metadata, then uploads the
 * bytes to this API, which stores them with the provider (Graph credentials never leave the
 * server) and marks the screenshot STORED only after the provider confirmed the file.
 */
@Injectable()
export class ScreenshotsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScreenshotsService.name);
  /** Per employee, across register and upload. Normal use is ~2 requests per screenshot; a week's offline backlog drains in hours. */
  readonly limiter = new RateLimiter(120, 10 * 60_000);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly attendancePolicy: AttendancePolicy,
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
    private readonly settings: ScreenshotSettingsService,
    private readonly monitoring: MonitoringSettingsService,
    private readonly locks: EmployeeLocks,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit() {
    if (this.config.get("NODE_ENV", { infer: true }) === "test") return;
    this.timer = setInterval(() => void this.scheduledRetention(), SCHEDULE_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ---- Employee / desktop -------------------------------------------------------------

  async status(employee: EmployeeRef): Promise<ScreenshotStatusResponse> {
    const s = await this.settings.current();
    const [notice, [consent, last]] = await Promise.all([
      this.monitoring.notice(s.noticeVersion),
      this.db.batch(
        [
          { sql: "SELECT acknowledged_at FROM monitoring_consents WHERE employee_id = ? AND notice_version = ?", args: [employee.id, s.noticeVersion] },
          { sql: "SELECT max(stored_at) AS at FROM screenshots WHERE employee_id = ?", args: [employee.id] },
        ],
        "read",
      ),
    ]);
    return {
      policy: { enabled: s.enabled, intervalSeconds: s.intervalSeconds, webpQuality: s.webpQuality, maxDimension: s.maxDimension, captureScope: s.captureScope },
      retentionDays: s.retentionDays,
      notice,
      consent: { noticeVersion: s.noticeVersion, acknowledgedAt: str(consent!.rows[0]?.acknowledged_at) },
      lastStoredAt: str(last!.rows[0]?.at),
      storageProvider: this.storage.provider,
      employeeSelfView: s.employeeSelfView,
    };
  }

  /** Acknowledges the currently required screenshot notice. Idempotent; history is kept. */
  async consent(employee: EmployeeRef, noticeVersion: string): Promise<ScreenshotStatusResponse> {
    const { noticeVersion: required } = await this.settings.current();
    if (noticeVersion !== required) throw new BadRequestException("This is not the current screenshot notice");
    await this.db.execute({
      sql: "INSERT OR IGNORE INTO monitoring_consents (id, employee_id, notice_version) VALUES (?, ?, ?)",
      args: [randomUUID(), employee.id, noticeVersion],
    });
    this.logger.log({ employeeId: employee.id, noticeVersion }, "Screenshot notice acknowledged");
    return this.status(employee);
  }

  /**
   * Registers metadata (idempotent by the client id). Policy, consent and attendance are checked
   * against the capture time, so screenshots taken offline are judged by the rules then in force.
   */
  async register(device: DeviceContext, req: ScreenshotRegisterRequest): Promise<ScreenshotRegisterResponse> {
    this.throttle(device.employeeId);
    return this.locks.run(device.employeeId, async () => {
      const existing = await this.byClientId(device.employeeId, req.id);
      if (existing?.upload_status === "DELETED") return { id: req.id, status: "REJECTED", reason: "Deleted under the screenshot retention policy" };
      if (existing) return { id: req.id, status: existing.upload_status === "REGISTERED" ? "REGISTERED" : "STORED" };

      const reject = (reason: string): ScreenshotRegisterResponse => {
        this.logger.log({ employeeId: device.employeeId, reason }, "Screenshot rejected");
        return { id: req.id, status: "REJECTED", reason };
      };
      const receivedAt = Date.now();
      const captured = Date.parse(req.capturedAt) + (receivedAt - Date.parse(req.sentAt));
      if (captured > receivedAt + FUTURE_TOLERANCE_MS) return reject("Captured in the future");
      if (receivedAt - captured > this.attendancePolicy.maxOfflineAgeDays * DAY_MS) return reject("Captured before the offline limit");

      const [periods, acks, segments, near] = await Promise.all([
        this.settings.periods(),
        this.db.execute({ sql: "SELECT notice_version, acknowledged_at FROM monitoring_consents WHERE employee_id = ?", args: [device.employeeId] }),
        clockedInSegments(this.db, device.employeeId, captured, captured, receivedAt + FUTURE_TOLERANCE_MS),
        this.db.execute({
          sql: "SELECT captured_at FROM screenshots WHERE employee_id = ? AND captured_at > ? AND captured_at < ?",
          args: [device.employeeId, iso(captured - 1_800_000), iso(captured + 1_800_000)],
        }),
      ]);
      const p = ScreenshotSettingsService.at(periods, captured);
      if (!p.enabled) return reject("Screenshots were turned off by the organization at that time");
      const ack = acks.rows.find((r) => String(r.notice_version) === p.noticeVersion);
      if (!ack || Date.parse(String(ack.acknowledged_at)) > captured) {
        return reject(`Captured before the required screenshot notice (${p.noticeVersion}) was acknowledged`);
      }
      if (Math.max(req.width, req.height) > p.maxDimension) return reject(`Larger than the maximum resolution in force (${p.maxDimension} px)`);
      // Strictly inside clocked-in, non-break time: no tolerance at break or clock-out edges.
      const segment = segments.find((s) => s.start <= captured && captured < s.end);
      if (!segment) return reject("Captured outside clocked-in time (before clock-in, during a break or after clock-out)");
      // A modified client cannot capture more often than the policy allows (half the interval of slack).
      const spacing = (p.intervalSeconds * 1000) / 2;
      if (near.rows.some((r) => Math.abs(Date.parse(String(r.captured_at)) - captured) < spacing)) {
        return reject(`Too soon after another screenshot (the interval in force is ${p.intervalSeconds} s)`);
      }

      const id = randomUUID();
      await this.db.execute({
        sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at,
                width, height, mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTERED')`,
        args: [
          id, device.employeeId, device.deviceId, segment.sessionId, req.id, iso(captured), req.capturedAt,
          req.width, req.height, req.mimeType, req.sizeBytes, req.checksum, this.storage.provider,
          `${device.employeeId}/${iso(captured).slice(0, 7)}/${id}.webp`,
        ],
      });
      return { id: req.id, status: "REGISTERED" };
    });
  }

  /** Receives the image, verifies it against the registration, stores it, confirms with the provider. */
  async upload(device: DeviceContext, clientId: string, body: unknown): Promise<ScreenshotStoredResponse> {
    this.throttle(device.employeeId);
    if (!(body instanceof Uint8Array)) throw new UnsupportedMediaTypeException("Send the screenshot as image/webp");
    return this.locks.run(device.employeeId, async () => {
      const row = await this.byClientId(device.employeeId, clientId);
      if (!row) throw new NotFoundException("Register the screenshot before uploading it");
      if (String(row.device_id) !== device.deviceId) throw new ForbiddenException("This screenshot was registered by another device");
      // Expired under retention before it was ever uploaded: not stored, and never reported as stored.
      if (row.upload_status === "DELETED" && !row.stored_at) throw new GoneException("Deleted under the screenshot retention policy before it was uploaded");
      if (row.upload_status !== "REGISTERED") return { id: clientId, status: "STORED", storedAt: String(row.stored_at) };

      if (body.length !== Number(row.file_size_bytes)) throw new BadRequestException("Size does not match the registered screenshot");
      const dims = webpSize(body);
      if (!dims) throw new UnsupportedMediaTypeException("Not a valid WebP image");
      if (dims.width !== Number(row.width) || dims.height !== Number(row.height)) throw new BadRequestException("Image dimensions do not match the registration");
      if (createHash("sha256").update(body).digest("hex") !== row.checksum) throw new UnprocessableEntityException("Checksum mismatch; upload again");

      const key = String(row.storage_key);
      let confirmed;
      try {
        await this.storage.put(key, body);
        // Completion = the provider reports the file with the expected size and content hash
        // (QuickXorHash, computed by SharePoint itself), not just "the request returned".
        confirmed = await this.storage.stat(key);
      } catch (err) {
        if (!(err instanceof StorageError)) throw err;
        this.logger.warn({ screenshotId: row.id, err: err.message }, "Screenshot storage failed");
        throw new BadGatewayException("Screenshot storage is unavailable; the upload will be retried");
      }
      if (!confirmed || confirmed.size !== body.length || (confirmed.quickXorHash && confirmed.quickXorHash !== quickXorHash(body))) {
        this.logger.warn({ screenshotId: row.id, found: !!confirmed }, "Storage did not confirm the screenshot");
        throw new BadGatewayException("Storage did not confirm the upload; it will be retried");
      }
      const storedAt = new Date().toISOString();
      await this.db.execute({
        sql: "UPDATE screenshots SET upload_status = 'STORED', stored_at = ?, storage_item_id = ?, updated_at = ? WHERE id = ? AND upload_status = 'REGISTERED'",
        args: [storedAt, confirmed.itemId, storedAt, String(row.id)],
      });
      this.logger.log({ employeeId: device.employeeId, screenshotId: row.id, bytes: body.length, provider: this.storage.provider }, "Screenshot stored");
      return { id: clientId, status: "STORED", storedAt };
    });
  }

  // ---- Reading --------------------------------------------------------------------------

  /** The caller's (or, for admins, any employee's) screenshot metadata. Employees only if self-view is allowed. */
  async list(caller: AuthContext, employee: EmployeeRef, q: ScreenshotQuery): Promise<Paginated<ScreenshotItem>> {
    await this.assertSelfView(caller);
    const today = todayIn(employee.timezone);
    const from = zonedToUtc(`${q.from ?? addDays(today, -30)}T00:00`, employee.timezone);
    const to = zonedToUtc(`${addDays(q.to ?? today, 1)}T00:00`, employee.timezone);
    const where = "employee_id = ? AND captured_at >= ? AND captured_at < ?";
    const [rows, count] = await this.db.batch(
      [
        { sql: `SELECT ${ITEM_COLUMNS} FROM screenshots WHERE ${where} ORDER BY captured_at DESC, id LIMIT ? OFFSET ?`, args: [employee.id, from, to, q.pageSize, (q.page - 1) * q.pageSize] },
        { sql: `SELECT count(*) AS n FROM screenshots WHERE ${where}`, args: [employee.id, from, to] },
      ],
      "read",
    );
    return { items: rows!.rows.map(toItem), total: Number(count!.rows[0]!.n), page: q.page, pageSize: q.pageSize };
  }

  /** Admin gallery: newest first, all employees or one, dates in the viewer's time zone. Metadata only. */
  async gallery(q: ScreenshotGalleryQuery): Promise<Paginated<ScreenshotGalleryItem>> {
    const { where, args } = this.galleryFilter(q);
    const [rows, count] = await this.db.batch(
      [
        {
          sql: `SELECT ${GALLERY_COLUMNS} FROM screenshots s JOIN employee_profiles p ON p.id = s.employee_id
                WHERE ${where} ORDER BY s.captured_at DESC, s.id LIMIT ? OFFSET ?`,
          args: [...args, q.pageSize, (q.page - 1) * q.pageSize],
        },
        { sql: `SELECT count(*) AS n FROM screenshots s WHERE ${where}`, args },
      ],
      "read",
    );
    return { items: rows!.rows.map(toGalleryItem), total: Number(count!.rows[0]!.n), page: q.page, pageSize: q.pageSize };
  }

  /** Real server-side counts for the gallery header (same filters). */
  async overview(q: ScreenshotGalleryQuery): Promise<ScreenshotOverview> {
    const { where, args } = this.galleryFilter(q);
    const [{ rows }, retention] = await Promise.all([
      this.db.execute({
        sql: `SELECT count(*) AS total,
                count(CASE WHEN upload_status = 'STORED' THEN 1 END) AS stored,
                count(CASE WHEN upload_status = 'REGISTERED' THEN 1 END) AS awaiting,
                count(CASE WHEN upload_status = 'REGISTERED' AND created_at < ? THEN 1 END) AS stalled,
                count(CASE WHEN upload_status = 'DELETED' THEN 1 END) AS deleted,
                max(captured_at) AS latest_captured, max(stored_at) AS latest_stored
              FROM screenshots s WHERE ${where}`,
        args: [iso(Date.now() - STALLED_MS), ...args],
      }),
      this.retentionPreview(),
    ]);
    const r = rows[0]!;
    return {
      total: Number(r.total), stored: Number(r.stored), awaitingUpload: Number(r.awaiting), stalled: Number(r.stalled), deleted: Number(r.deleted),
      latestCapturedAt: str(r.latest_captured), latestStoredAt: str(r.latest_stored), retention,
    };
  }

  /** One screenshot's metadata: admins (with its access log) or the owner when self-view is allowed. */
  async detail(caller: AuthContext, id: string): Promise<ScreenshotDetail> {
    const r = await this.readable(caller, id);
    const item: ScreenshotDetail = toGalleryItem(r);
    if (hasPermission(caller.role, "screenshots:read")) {
      const { rows } = await this.db.execute({
        sql: `SELECT l.accessed_at, l.action, u.id AS viewer_id, u.email FROM screenshot_access_log l JOIN users u ON u.id = l.user_id
              WHERE l.screenshot_id = ? ORDER BY l.accessed_at DESC LIMIT 100`,
        args: [id],
      });
      item.accessLog = rows.map((a) => ({ accessedAt: String(a.accessed_at), action: a.action as "VIEW" | "THUMBNAIL", viewer: { id: String(a.viewer_id), email: String(a.email) } }));
    }
    return item;
  }

  /**
   * Image bytes for admins (screenshots:read) or the owner when self-view is allowed. Checked on
   * every request; every access is logged (viewer, screenshot, time, view/thumbnail). The bytes are
   * validated (WebP, size bound, registered size) before they are sent.
   */
  async content(caller: AuthContext, id: string, variant: "full" | "thumbnail"): Promise<Uint8Array> {
    const r = await this.readable(caller, id);
    if (r.upload_status === "DELETED") throw new GoneException("This screenshot was deleted under the retention policy");
    if (r.upload_status !== "STORED") throw new ConflictException("This screenshot has not been stored yet");
    const action = variant === "thumbnail" ? "THUMBNAIL" : "VIEW";
    await this.db.execute({ sql: "INSERT INTO screenshot_access_log (id, screenshot_id, user_id, action) VALUES (?, ?, ?, ?)", args: [randomUUID(), id, caller.id, action] });
    this.logger.log({ userId: caller.id, screenshotId: id, action }, "Screenshot accessed");
    let bytes: Uint8Array;
    try {
      bytes = await this.storage.get(String(r.storage_key));
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
      this.logger.warn({ screenshotId: id, err: err.message }, "Screenshot retrieval failed");
      throw new BadGatewayException("Screenshot storage is unavailable");
    }
    if (bytes.length > SCREENSHOT_LIMITS.maxBytes || bytes.length !== Number(r.file_size_bytes) || !webpSize(bytes)) {
      this.logger.error({ screenshotId: id, bytes: bytes.length }, "Stored screenshot failed validation");
      throw new BadGatewayException("The stored screenshot failed validation");
    }
    return bytes;
  }

  // ---- Retention ------------------------------------------------------------------------

  async retentionPreview(now = Date.now()): Promise<ScreenshotRetentionPreview> {
    const s = await this.settings.current();
    const cutoff = iso(now - s.retentionDays * DAY_MS);
    const [counts, runs] = await this.db.batch(
      [
        {
          sql: `SELECT count(CASE WHEN upload_status != 'DELETED' AND captured_at < ? THEN 1 END) AS eligible,
                  count(CASE WHEN upload_status = 'STORED' THEN 1 END) AS stored,
                  count(CASE WHEN upload_status = 'DELETED' THEN 1 END) AS deleted
                FROM screenshots`,
          args: [cutoff],
        },
        `SELECT r.ran_at, r.cutoff, r.deleted, r.failed, r.deletion_mode, u.id AS user_id, u.email
         FROM screenshot_retention_runs r LEFT JOIN users u ON u.id = r.triggered_by ORDER BY r.ran_at DESC LIMIT 20`,
      ],
      "read",
    );
    const r = counts!.rows[0]!;
    return {
      retentionDays: s.retentionDays, approved: s.retentionApproved, cutoff,
      eligible: Number(r.eligible), storedTotal: Number(r.stored), deletedTotal: Number(r.deleted),
      deletionMode: this.storage.deletionMode,
      runs: runs!.rows.map((x) => ({
        ranAt: String(x.ran_at), cutoff: String(x.cutoff), deleted: Number(x.deleted), failed: Number(x.failed),
        deletionMode: x.deletion_mode as ScreenshotDeletionMode,
        triggeredBy: x.user_id ? { id: String(x.user_id), email: String(x.email) } : null,
      })),
    };
  }

  /**
   * Deletes expired screenshots from storage, then marks their metadata DELETED (who/when kept) and
   * records the run. Refused until approved. A file the provider fails to delete stays STORED and
   * is retried next run. With the SharePoint recycle bin (default) deleted files remain recoverable
   * there until the bin is emptied; this is recorded as the run's deletion mode.
   */
  async retentionRun(admin: AuthUser | null, now = Date.now()): Promise<ScreenshotRetentionPreview> {
    const s = await this.settings.current();
    if (!s.retentionApproved) throw new ConflictException("Screenshot retention has not been approved in the settings; nothing was deleted");
    const cutoff = iso(now - s.retentionDays * DAY_MS);
    let failed = 0;
    let deleted = 0;
    let after = "";
    for (;;) {
      const { rows } = await this.db.execute({
        sql: `SELECT id, storage_key FROM screenshots WHERE upload_status != 'DELETED' AND captured_at < ? AND id > ? ORDER BY id LIMIT ${RETENTION_CHUNK}`,
        args: [cutoff, after],
      });
      for (const r of rows) {
        try {
          await this.storage.delete(String(r.storage_key));
        } catch (err) {
          if (!(err instanceof StorageError)) throw err;
          this.logger.warn({ screenshotId: r.id, err: err.message }, "Retention could not delete a screenshot");
          failed++;
          continue;
        }
        const at = new Date().toISOString();
        await this.db.execute({
          sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?",
          args: [at, admin?.id ?? null, at, String(r.id)],
        });
        deleted++;
      }
      if (rows.length < RETENTION_CHUNK) break;
      after = String(rows.at(-1)!.id);
    }
    await this.db.execute({
      sql: "INSERT INTO screenshot_retention_runs (id, cutoff, retention_days, deleted, failed, deletion_mode, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [randomUUID(), cutoff, s.retentionDays, deleted, failed, this.storage.deletionMode, admin?.id ?? null],
    });
    this.logger.log({ adminId: admin?.id ?? null, cutoff, deleted, failed, mode: this.storage.deletionMode }, "Screenshot retention purge");
    return { ...(await this.retentionPreview(now)), failed };
  }

  private async scheduledRetention() {
    try {
      if ((await this.settings.current()).retentionApproved) await this.retentionRun(null);
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, "Scheduled screenshot retention failed");
    }
  }

  // ---- internals ------------------------------------------------------------------------

  /** Employees see their own screenshots only while the policy allows it; admins always. */
  private async assertSelfView(caller: AuthContext) {
    if (hasPermission(caller.role, "screenshots:read")) return;
    if (!(await this.settings.current()).employeeSelfView) throw new ForbiddenException("Your organization does not allow employees to view screenshots");
  }

  /** The row if the caller may read it; 404 for anyone else (same as a missing id). */
  private async readable(caller: AuthContext, id: string): Promise<Row> {
    const { rows } = await this.db.execute({
      sql: `SELECT ${GALLERY_COLUMNS}, s.storage_key, p.user_id FROM screenshots s JOIN employee_profiles p ON p.id = s.employee_id WHERE s.id = ?`,
      args: [id],
    });
    const r = rows[0];
    if (!r || (!hasPermission(caller.role, "screenshots:read") && r.user_id !== caller.id)) throw new NotFoundException("Screenshot not found");
    await this.assertSelfView(caller);
    return r;
  }

  private galleryFilter(q: ScreenshotGalleryQuery) {
    const args: string[] = [zonedToUtc(`${q.from}T00:00`, q.tz), zonedToUtc(`${addDays(q.to, 1)}T00:00`, q.tz)];
    if (q.employeeId) args.push(q.employeeId);
    return { where: `s.captured_at >= ? AND s.captured_at < ?${q.employeeId ? " AND s.employee_id = ?" : ""}`, args };
  }

  private throttle(employeeId: string) {
    if (!this.limiter.hit(employeeId)) throw new HttpException("Too many screenshot requests. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
  }

  private async byClientId(employeeId: string, clientId: string): Promise<Row | undefined> {
    const { rows } = await this.db.execute({
      sql: "SELECT id, device_id, upload_status, stored_at, file_size_bytes, width, height, checksum, storage_key FROM screenshots WHERE employee_id = ? AND idempotency_key = ?",
      args: [employeeId, clientId],
    });
    return rows[0];
  }
}

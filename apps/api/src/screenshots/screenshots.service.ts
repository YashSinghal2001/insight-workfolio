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
  screenshotFeatureState,
  type EmployeeRef,
  type Paginated,
  SCREENSHOT_LIMITS,
  type ScreenshotDeleteResponse,
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
  sameMasks,
} from "@workfolio/shared";
import { clockedInSegments, iso, screenshotReport, str } from "../attendance/sessions.js";
import { employeeReadAudit } from "../audit/account-audit.js";
import { RateLimiter } from "../auth/crypto.js";
import type { AuthContext } from "../auth/auth.service.js";
import { EmployeeLocks } from "../common/employee-locks.js";
import { POLICY } from "../common/policy.js";
import { canReadEmployee, scopeSql } from "../common/scope.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import type { DeviceContext } from "../devices/devices.service.js";
import { MonitoringSettingsService } from "../settings/monitoring-settings.service.js";
import { ScreenshotSettingsService } from "./screenshot-settings.service.js";
import { quickXorHash, SCREENSHOT_STORAGE, screenshotKey, StorageError, type ScreenshotStorage } from "./storage.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { TimelapseService } from "./timelapse.service.js";

const DAY_MS = 86_400_000;
/** A capture this far in the future (after skew correction) is refused. */
const FUTURE_TOLERANCE_MS = 60_000;
/** Stored as deleted_reason and returned to the device; no personal data. */
const OUTSIDE_WORK_TIME = "Captured during a break or outside clocked-in time (attendance changed after registration); not stored";
const SCHEDULE_MS = 6 * 3_600_000;
const RETENTION_CHUNK = 100;

/** Registered but not uploaded for longer than this: the desktop is offline or retrying. */
const STALLED_MS = 3_600_000;
const GALLERY_COLUMNS = `s.id, s.employee_id, s.captured_at, s.width, s.height, s.file_size_bytes, s.upload_status, s.storage_provider, s.stored_at, s.mask_count, s.blurred,
  p.full_name, p.employee_code, p.timezone`;
const ITEM_COLUMNS = "id, employee_id, captured_at, width, height, file_size_bytes, upload_status, storage_provider, stored_at, mask_count, blurred";
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
  maskCount: Number(r.mask_count),
  blurred: Boolean(r.blurred),
});

const toGalleryItem = (r: Row): ScreenshotGalleryItem => ({
  ...toItem(r),
  employee: { id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) },
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
    private readonly timelapses: TimelapseService,
    private readonly notifications: NotificationsService,
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
    const [s, overrides, selfView] = await Promise.all([this.settings.current(), this.settings.blurOverrides(employee.id), this.monitoring.screenshotSelfView(employee.id)]);
    const blur = overrides.at(-1)?.blur ?? s.blur; // overrides take effect when recorded (never in the future)
    const [notice, [consent, last, device]] = await Promise.all([
      this.monitoring.notice(s.noticeVersion),
      this.db.batch(
        [
          { sql: "SELECT acknowledged_at FROM monitoring_consents WHERE employee_id = ? AND notice_version = ?", args: [employee.id, s.noticeVersion] },
          { sql: "SELECT max(stored_at) AS at FROM screenshots WHERE employee_id = ?", args: [employee.id] },
          { sql: "SELECT screenshot_state, screenshot_state_at FROM devices WHERE employee_id = ? AND revoked_at IS NULL", args: [employee.id] },
        ],
        "read",
      ),
    ]);
    const acknowledgedAt = str(consent!.rows[0]?.acknowledged_at);
    return {
      state: screenshotFeatureState({ enabled: s.enabled, consented: !!acknowledgedAt, report: screenshotReport(device!.rows[0]) }),
      policy: { enabled: s.enabled, intervalSeconds: s.intervalSeconds, webpQuality: s.webpQuality, maxDimension: s.maxDimension, captureScope: s.captureScope, maskRegions: s.maskRegions, blur },
      retentionDays: s.retentionDays,
      notice,
      consent: { noticeVersion: s.noticeVersion, acknowledgedAt },
      lastStoredAt: str(last!.rows[0]?.at),
      storageProvider: this.storage.provider,
      employeeSelfView: selfView ?? s.employeeSelfView, // F08: the per-person override wins
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

      const [periods, acks, segments, near, blurOverrides] = await Promise.all([
        this.settings.periods(),
        this.db.execute({ sql: "SELECT notice_version, acknowledged_at FROM monitoring_consents WHERE employee_id = ?", args: [device.employeeId] }),
        clockedInSegments(this.db, device.employeeId, captured, captured, receivedAt + FUTURE_TOLERANCE_MS),
        this.db.execute({
          sql: "SELECT captured_at FROM screenshots WHERE employee_id = ? AND captured_at > ? AND captured_at < ?",
          args: [device.employeeId, iso(captured - 1_800_000), iso(captured + 1_800_000)],
        }),
        this.settings.blurOverrides(device.employeeId),
      ]);
      const p = ScreenshotSettingsService.at(periods, captured);
      if (!p.enabled) return reject("Screenshots were turned off by the organization at that time");
      const ack = acks.rows.find((r) => String(r.notice_version) === p.noticeVersion);
      if (!ack || Date.parse(String(ack.acknowledged_at)) > captured) {
        return reject(`Captured before the required screenshot notice (${p.noticeVersion}) was acknowledged`);
      }
      if (Math.max(req.width, req.height) > p.maxDimension) return reject(`Larger than the maximum resolution in force (${p.maxDimension} px)`);
      // The privacy masks in force must have been applied, exactly: an older or modified agent, or a
      // capture taken just before a mask change reached the device, is not kept.
      if (!sameMasks(req.masks, p.maskRegions)) {
        return reject(`Captured without the privacy masks in force at that time (${p.maskRegions.length} required); update the desktop app if this repeats`);
      }
      // Same for the whole-image blur (organisation setting or this employee's override at capture time).
      if (req.blurred !== ScreenshotSettingsService.blurAt(periods, blurOverrides, captured)) return reject("Blur setting does not match the policy in force");
      // Strictly inside clocked-in, non-break time: no tolerance at break or clock-out edges.
      const segment = segments.find((s) => s.start <= captured && captured < s.end);
      if (!segment) return reject("Captured outside clocked-in time (before clock-in, during a break or after clock-out)");
      // A modified client cannot capture more often than the policy allows (half the interval of slack).
      const spacing = (p.intervalSeconds * 1000) / 2;
      if (near.rows.some((r) => Math.abs(Date.parse(String(r.captured_at)) - captured) < spacing)) {
        return reject(`Too soon after another screenshot (the interval in force is ${p.intervalSeconds} s)`);
      }

      const id = randomUUID();
      const { rows: team } = await this.db.execute({ sql: "SELECT team_id FROM team_members WHERE employee_id = ? ORDER BY added_at, team_id LIMIT 1", args: [device.employeeId] });
      await this.db.execute({
        sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at,
                width, height, mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, mask_count, blurred)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTERED', ?, ?)`,
        args: [
          // The device's clock reading, normalized to UTC (same instant; a "+05:30" offset is not kept as text).
          id, device.employeeId, device.deviceId, segment.sessionId, req.id, iso(captured), iso(Date.parse(req.capturedAt)),
          req.width, req.height, req.mimeType, req.sizeBytes, req.checksum, this.storage.provider,
          screenshotKey(team[0] ? String(team[0].team_id) : null, device.employeeId, iso(captured), id), req.masks.length,
          req.blurred ? 1 : 0,
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

      // Judged again now: a break or clock-out may have been recorded since registration. Attendance writes
      // hold this same per-employee lock, so a break already persisted can never be bypassed by a delayed upload.
      const captured = Date.parse(String(row.captured_at));
      const segments = await clockedInSegments(this.db, device.employeeId, captured, captured, Date.now() + FUTURE_TOLERANCE_MS);
      if (!segments.some((s) => s.start <= captured && captured < s.end)) {
        const at = new Date().toISOString();
        await this.db.execute({
          sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ?, deleted_reason = ?, updated_at = ? WHERE id = ? AND upload_status = 'REGISTERED'",
          args: [at, OUTSIDE_WORK_TIME, at, String(row.id)],
        });
        this.logger.log({ employeeId: device.employeeId, screenshotId: row.id }, "Screenshot discarded at upload: outside clocked-in time");
        throw new GoneException(OUTSIDE_WORK_TIME);
      }

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
        await this.notifications.storageFailed(err.message);
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
  async list(caller: AuthContext, employee: EmployeeRef & { userId: string }, q: ScreenshotQuery): Promise<Paginated<ScreenshotItem>> {
    await this.assertSelfView(caller, employee.userId, employee.id);
    await this.auditRead(caller, employee, { from: q.from ?? null, to: q.to ?? null });
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
  async gallery(q: ScreenshotGalleryQuery, caller: AuthContext): Promise<Paginated<ScreenshotGalleryItem>> {
    const { where, args } = this.galleryFilter(q, caller);
    // ponytail: only a gallery filtered to one employee is audited here. The all-employees page is not (a row
    // per page per employee would drown the audit); each image actually opened is logged in screenshot_access_log.
    if (q.employeeId) {
      const scope = scopeSql(caller, "screenshots:read", "p.id");
      const { rows } = await this.db.execute({ sql: `SELECT p.id, p.user_id FROM employee_profiles p WHERE p.id = ?${scope.sql}`, args: [q.employeeId, ...scope.args] });
      if (rows[0]) await this.auditRead(caller, { id: String(rows[0].id), userId: String(rows[0].user_id) }, { from: q.from, to: q.to });
    }
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
  async overview(q: ScreenshotGalleryQuery, caller: AuthContext): Promise<ScreenshotOverview> {
    const { where, args } = this.galleryFilter(q, caller);
    // Retention status is organisation-wide (counts, who ran purges): not for team heads.
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
      hasPermission(caller.role, "settings:manage") ? this.retentionPreview() : undefined,
    ]);
    const r = rows[0]!;
    return {
      total: Number(r.total), stored: Number(r.stored), awaitingUpload: Number(r.awaiting), stalled: Number(r.stalled), deleted: Number(r.deleted),
      latestCapturedAt: str(r.latest_captured), latestStoredAt: str(r.latest_stored), ...(retention && { retention }),
    };
  }

  /** One screenshot's metadata: admins (with its access log) or the owner when self-view is allowed. */
  async detail(caller: AuthContext, id: string): Promise<ScreenshotDetail> {
    const r = await this.readable(caller, id);
    await this.auditRead(caller, { id: String(r.employee_id), userId: String(r.user_id) }, { screenshotId: id });
    const base = toGalleryItem(r);
    const inForce = ScreenshotSettingsService.at(await this.settings.periods(), Date.parse(base.capturedAt)).maskRegions;
    const item: ScreenshotDetail = { ...base, masks: inForce.length === base.maskCount ? inForce : null };
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
    if (r.upload_status === "DELETED") throw new GoneException("This screenshot was deleted (by an administrator or under the retention policy)");
    if (r.upload_status !== "STORED") throw new ConflictException("This screenshot has not been stored yet");
    // Stored by another provider (dev/staging after switching storage): this server cannot read it.
    if (r.storage_provider !== this.storage.provider) {
      throw new ConflictException(`This screenshot is stored with ${String(r.storage_provider)}, not the storage this server uses (${this.storage.provider})`);
    }
    // No resized variant exists: `variant=thumbnail` serves the full image, so it is logged as what it is.
    void variant;
    const action = "VIEW";
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

  // ---- Admin deletion -------------------------------------------------------------------

  /**
   * Deletes one screenshot: the file first (idempotent at the provider), then the row is marked
   * DELETED with who and when (the row itself is kept: screenshots are append-only). A storage
   * failure leaves the row unchanged (502). A row stored with another provider is refused (409),
   * never marked DELETED while its file still exists elsewhere. Already deleted: 200, unchanged.
   * Timelapses that may contain it are expired by the timelapse sweep, run right after.
   * The reason is stored with the row (deleted_reason) and shown in the audit view; the application log
   * gets only its length, since free text may contain personal data.
   */
  async remove(admin: AuthContext, id: string, reason: string): Promise<ScreenshotDeleteResponse> {
    const row = async () => {
      const { rows } = await this.db.execute({
        sql: `SELECT ${GALLERY_COLUMNS}, s.storage_key, s.deleted_at FROM screenshots s JOIN employee_profiles p ON p.id = s.employee_id WHERE s.id = ?`,
        args: [id],
      });
      return rows[0];
    };
    const first = await row();
    if (!first) throw new NotFoundException("Screenshot not found");
    // Same lock as upload, so a concurrent upload cannot store a file after it was deleted.
    const result = await this.locks.run(String(first.employee_id), async () => {
      const r = (await row())!;
      if (r.upload_status === "DELETED") return { screenshot: toGalleryItem(r), deletedAt: String(r.deleted_at), alreadyDeleted: true };
      const sameProvider = r.storage_provider === this.storage.provider;
      if (r.upload_status === "STORED" && !sameProvider) {
        throw new ConflictException(`This screenshot is stored with ${String(r.storage_provider)}, not the storage this server uses (${this.storage.provider}); it was not deleted`);
      }
      if (sameProvider) {
        try {
          await this.storage.delete(String(r.storage_key));
        } catch (err) {
          if (!(err instanceof StorageError)) throw err;
          this.logger.warn({ screenshotId: id, err: err.message }, "Screenshot delete failed");
          throw new BadGatewayException("Screenshot storage is unavailable; nothing was deleted");
        }
      }
      const at = new Date().toISOString();
      await this.db.execute({
        sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ?, deleted_by = ?, deleted_reason = ?, updated_at = ? WHERE id = ? AND upload_status != 'DELETED'",
        args: [at, admin.id, reason, at, id],
      });
      this.logger.log({ adminId: admin.id, screenshotId: id, was: r.upload_status, reasonLength: reason.length }, "Screenshot deleted by an admin");
      const fresh = (await row())!;
      return { screenshot: toGalleryItem(fresh), deletedAt: String(fresh.deleted_at), alreadyDeleted: false };
    });
    if (!result.alreadyDeleted) {
      await this.timelapses.sweep().catch((err: Error) => this.logger.error({ err: err.message }, "Timelapse sweep after a screenshot delete failed"));
    }
    return result;
  }

  /**
   * Attendance just recorded a break start or clock-out from `fromMs` (the caller holds this employee's lock).
   * Screenshots captured since then that no longer fall inside clocked-in, non-break time are discarded: the
   * file first (when stored), then the row is marked DELETED with a fixed, non-personal reason. Normally there
   * are none (the desktop stops capture before it timestamps a break and uploads nothing while attendance is
   * unsynced); this covers a break recorded with an earlier time than a screenshot already received.
   * A storage failure leaves that row STORED and is logged as an error (retried on the next such event).
   */
  async discardOutsideWork(employeeId: string, fromMs: number): Promise<number> {
    const { rows } = await this.db.execute({
      sql: "SELECT id, captured_at, upload_status, storage_provider, storage_key FROM screenshots WHERE employee_id = ? AND captured_at >= ? AND upload_status != 'DELETED'",
      args: [employeeId, iso(fromMs)],
    });
    if (!rows.length) return 0;
    const times = rows.map((r) => Date.parse(String(r.captured_at)));
    const segments = await clockedInSegments(this.db, employeeId, Math.min(...times), Math.max(...times), Date.now() + FUTURE_TOLERANCE_MS);
    let discarded = 0;
    for (const [i, r] of rows.entries()) {
      if (segments.some((s) => s.start <= times[i]! && times[i]! < s.end)) continue;
      if (r.upload_status === "STORED") {
        try {
          if (r.storage_provider !== this.storage.provider) throw new StorageError(`stored with ${String(r.storage_provider)}`);
          await this.storage.delete(String(r.storage_key));
        } catch (err) {
          if (!(err instanceof StorageError)) throw err;
          this.logger.error({ employeeId, screenshotId: r.id, err: err.message }, "Screenshot inside a break or after clock-out could not be removed from storage");
          continue;
        }
      }
      const at = new Date().toISOString();
      await this.db.execute({
        sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ?, deleted_reason = ?, updated_at = ? WHERE id = ? AND upload_status != 'DELETED'",
        args: [at, OUTSIDE_WORK_TIME, at, String(r.id)],
      });
      discarded++;
    }
    if (discarded) {
      this.logger.warn({ employeeId, discarded }, "Screenshots discarded: attendance recorded a break or clock-out before their capture time");
      await this.timelapses.sweep().catch((err: Error) => this.logger.error({ err: err.message }, "Timelapse sweep after a discard failed"));
    }
    return discarded;
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
   * Deletes expired screenshots from storage, then marks their metadata DELETED (who/when kept).
   * Per chunk, the DELETED marks and that chunk's run row are one transaction (no silent deletes,
   * no run row claiming deletes that did not happen). Refused until approved. A file the provider
   * fails to delete stays STORED and is retried next run. Rows stored with another provider (dev or
   * staging after switching storage) are skipped, never marked DELETED while their file still
   * exists elsewhere. With the SharePoint recycle bin (default) deleted files remain recoverable
   * there until the bin is emptied; this is recorded as the run's deletion mode.
   */
  async retentionRun(admin: AuthUser | null, now = Date.now()): Promise<ScreenshotRetentionPreview> {
    const s = await this.settings.current();
    if (!s.retentionApproved) throw new ConflictException("Screenshot retention has not been approved in the settings; nothing was deleted");
    const cutoff = iso(now - s.retentionDays * DAY_MS);
    const run = [cutoff, s.retentionDays, this.storage.deletionMode, admin?.id ?? null] as const;
    let failed = 0;
    let deleted = 0;
    let skipped = 0;
    let recorded = false;
    let after = "";
    for (;;) {
      const { rows } = await this.db.execute({
        sql: `SELECT id, storage_key, storage_provider FROM screenshots WHERE upload_status != 'DELETED' AND captured_at < ? AND id > ? ORDER BY id LIMIT ${RETENTION_CHUNK}`,
        args: [cutoff, after],
      });
      const gone: string[] = [];
      let chunkFailed = 0;
      for (const r of rows) {
        if (r.storage_provider !== this.storage.provider) {
          skipped++;
          continue;
        }
        try {
          await this.storage.delete(String(r.storage_key));
          gone.push(String(r.id));
        } catch (err) {
          if (!(err instanceof StorageError)) throw err;
          this.logger.warn({ screenshotId: r.id, err: err.message }, "Retention could not delete a screenshot");
          chunkFailed++;
        }
      }
      if (gone.length || chunkFailed) {
        const at = new Date().toISOString();
        // Storage first, then the marks and the chunk's run row together: a crash in between leaves
        // the rows STORED with their file already gone, and the next run's (idempotent) delete marks them.
        const [marked] = await this.db.batch(
          [
            {
              sql: `UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ?, deleted_by = ?, updated_at = ?
                    WHERE upload_status != 'DELETED' AND id IN (${gone.map(() => "?").join(", ")})`,
              args: [at, admin?.id ?? null, at, ...gone],
            },
            {
              sql: `INSERT INTO screenshot_retention_runs (id, cutoff, retention_days, deleted, failed, deletion_mode, triggered_by)
                    VALUES (?, ?, ?, changes(), ?, ?, ?)`,
              args: [randomUUID(), run[0], run[1], chunkFailed, run[2], run[3]],
            },
          ],
          "write",
        );
        deleted += marked!.rowsAffected;
        failed += chunkFailed;
        recorded = true;
      }
      if (rows.length < RETENTION_CHUNK) break;
      after = String(rows.at(-1)!.id);
    }
    if (!recorded) {
      await this.db.execute({
        sql: "INSERT INTO screenshot_retention_runs (id, cutoff, retention_days, deleted, failed, deletion_mode, triggered_by) VALUES (?, ?, ?, 0, 0, ?, ?)",
        args: [randomUUID(), ...run],
      });
    }
    // ponytail: skipped rows are logged only (no column in screenshot_retention_runs / field in the shared type yet).
    this.logger.log({ adminId: admin?.id ?? null, cutoff, deleted, failed, skipped, mode: this.storage.deletionMode }, "Screenshot retention purge");
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

  /**
   * Employees see their own screenshots only while allowed: their per-person override (F08) if set, else
   * the organisation switch; admins always. Someone else's (`ownerUserId`) only reaches here after the
   * scope check (team heads, W41), so the self-view switch does not apply.
   */
  private async assertSelfView(caller: AuthContext, ownerUserId: string, employeeId: string) {
    if (hasPermission(caller.role, "screenshots:read") || ownerUserId !== caller.id) return;
    const [own, org] = await Promise.all([this.monitoring.screenshotSelfView(employeeId), this.settings.current()]);
    if (own === false) throw new ForbiddenException("Your administrator has turned off viewing your own screenshots");
    if (own === null && !org.employeeSelfView) throw new ForbiddenException("Your organization does not allow employees to view screenshots");
  }

  /** Audit row for a read of someone else's screenshot list (none for the caller's own). */
  private async auditRead(caller: AuthContext, employee: { id: string; userId: string }, what: Record<string, string | null>) {
    const audit = employeeReadAudit(caller, employee, "EMPLOYEE_SCREENSHOTS_VIEWED", what);
    if (audit) await this.db.execute(audit);
  }

  /** The row if the caller may read it; 404 for anyone else (same as a missing id). */
  private async readable(caller: AuthContext, id: string): Promise<Row> {
    const { rows } = await this.db.execute({
      sql: `SELECT ${GALLERY_COLUMNS}, s.storage_key, p.user_id FROM screenshots s JOIN employee_profiles p ON p.id = s.employee_id WHERE s.id = ?`,
      args: [id],
    });
    const r = rows[0];
    if (!r || (r.user_id !== caller.id && !(await canReadEmployee(this.db, caller, "screenshots:read", String(r.employee_id))))) throw new NotFoundException("Screenshot not found");
    await this.assertSelfView(caller, String(r.user_id), String(r.employee_id));
    return r;
  }

  /** Team heads (W41): only their teams' members; another employeeId simply matches nothing. */
  private galleryFilter(q: ScreenshotGalleryQuery, caller: AuthContext) {
    const args: string[] = [zonedToUtc(`${q.from}T00:00`, q.tz), zonedToUtc(`${addDays(q.to, 1)}T00:00`, q.tz)];
    if (q.employeeId) args.push(q.employeeId);
    const scope = scopeSql(caller, "screenshots:read", "s.employee_id");
    return { where: `s.captured_at >= ? AND s.captured_at < ?${q.employeeId ? " AND s.employee_id = ?" : ""}${scope.sql}`, args: [...args, ...scope.args] };
  }

  private throttle(employeeId: string) {
    if (!this.limiter.hit(employeeId)) throw new HttpException("Too many screenshot requests. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
  }

  private async byClientId(employeeId: string, clientId: string): Promise<Row | undefined> {
    const { rows } = await this.db.execute({
      sql: "SELECT id, device_id, upload_status, stored_at, captured_at, file_size_bytes, width, height, checksum, storage_key FROM screenshots WHERE employee_id = ? AND idempotency_key = ?",
      args: [employeeId, clientId],
    });
    return rows[0];
  }
}

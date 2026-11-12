import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { DatabaseClient, Row } from "@workfolio/database";
import {
  DEFAULT_NOTICE_VERSION,
  DEFAULT_SCREENSHOT_SETTINGS,
  parseMaskRegions,
  type ScreenshotMaskRegion,
  type AttendancePolicy,
  type AuthUser,
  type ScreenshotBlurOverrideInput,
  type ScreenshotBlurOverridesResponse,
  type ScreenshotScope,
  type ScreenshotSettingsInput,
  type ScreenshotSettingsResponse,
  type ScreenshotSettingsVersion,
} from "@workfolio/shared";
import { assertMayChangeRetention, POLICY } from "../common/policy.js";
import { DATABASE } from "../database/database.module.js";
import { MonitoringSettingsService } from "../settings/monitoring-settings.service.js";
import { SCREENSHOT_STORAGE, type ScreenshotStorage } from "./storage.js";

/** What applied from `from` (ms) until the next period: used to check screenshots captured offline. */
export interface ScreenshotPeriod {
  from: number;
  enabled: boolean;
  noticeVersion: string;
  intervalSeconds: number;
  maxDimension: number;
  maskRegions: ScreenshotMaskRegion[];
  blur: boolean;
}

/** One employee's blur override from `from` (ms); `blur` null = cleared (organisation setting). */
export interface BlurOverride {
  from: number;
  blur: boolean | null;
}

const COLUMNS = `p.screenshots_enabled, p.mask_regions, p.blur, p.interval_seconds, p.webp_quality, p.max_dimension, p.capture_scope, p.retention_days,
  p.retention_approved, p.notice_version, p.employee_self_view, p.auto_timelapse, p.reason, p.effective_at, u.id AS user_id, u.email AS user_email`;

const log = new Logger("ScreenshotSettingsService");

/**
 * Enabled flag and masks of a stored policy. Masks that cannot be read (the database CHECK only
 * guarantees a JSON array) turn screenshots off rather than capturing without them.
 */
function masksOf(r: Row): { enabled: boolean; maskRegions: ScreenshotMaskRegion[] } {
  const maskRegions = parseMaskRegions(r.mask_regions);
  if (maskRegions) return { enabled: Boolean(r.screenshots_enabled), maskRegions };
  log.error({ effectiveAt: r.effective_at }, "Screenshot privacy masks unreadable; screenshots treated as off");
  return { enabled: false, maskRegions: [] };
}

const toVersion = (r: Row): ScreenshotSettingsVersion => ({
  ...masksOf(r),
  blur: Boolean(r.blur),
  intervalSeconds: Number(r.interval_seconds),
  webpQuality: Number(r.webp_quality),
  maxDimension: Number(r.max_dimension),
  captureScope: String(r.capture_scope) as ScreenshotScope,
  retentionDays: Number(r.retention_days),
  retentionApproved: Boolean(r.retention_approved),
  noticeVersion: String(r.notice_version),
  employeeSelfView: Boolean(r.employee_self_view),
  autoTimelapse: Boolean(r.auto_timelapse),
  effectiveAt: String(r.effective_at),
  changedBy: { id: String(r.user_id), email: String(r.user_email) },
  reason: String(r.reason),
});

const DEFAULTS: ScreenshotSettingsVersion = { ...DEFAULT_SCREENSHOT_SETTINGS, effectiveAt: null, changedBy: null, reason: null };

/** Screenshot policy: append-only history like the monitoring settings; no rows = defaults (off). */
@Injectable()
export class ScreenshotSettingsService {
  private readonly logger = new Logger(ScreenshotSettingsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly attendancePolicy: AttendancePolicy,
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
    private readonly monitoring: MonitoringSettingsService,
  ) {}

  async current(): Promise<ScreenshotSettingsVersion> {
    const { rows } = await this.db.execute(`SELECT ${COLUMNS} FROM screenshot_policies p JOIN users u ON u.id = p.changed_by ORDER BY p.seq DESC LIMIT 1`);
    return rows[0] ? toVersion(rows[0]) : DEFAULTS;
  }

  /** Ascending; the first period (defaults) starts at -Infinity. */
  async periods(): Promise<ScreenshotPeriod[]> {
    const { rows } = await this.db.execute("SELECT screenshots_enabled, mask_regions, blur, notice_version, interval_seconds, max_dimension, effective_at FROM screenshot_policies ORDER BY seq");
    const d = DEFAULT_SCREENSHOT_SETTINGS;
    return [
      { from: -Infinity, enabled: d.enabled, noticeVersion: d.noticeVersion, intervalSeconds: d.intervalSeconds, maxDimension: d.maxDimension, maskRegions: d.maskRegions, blur: d.blur },
      ...rows.map((r) => ({
        from: Date.parse(String(r.effective_at)),
        ...masksOf(r),
        blur: Boolean(r.blur),
        noticeVersion: String(r.notice_version),
        intervalSeconds: Number(r.interval_seconds),
        maxDimension: Number(r.max_dimension),
      })),
    ];
  }

  async overview(): Promise<ScreenshotSettingsResponse> {
    const [policies, last] = await this.db.batch(
      [
        `SELECT ${COLUMNS} FROM screenshot_policies p JOIN users u ON u.id = p.changed_by ORDER BY p.seq DESC LIMIT 100`,
        // AW-04: the most recent successful upload; stored_at stays set if the screenshot is later deleted.
        "SELECT max(stored_at) AS at FROM screenshots",
      ],
      "read",
    );
    const history = policies!.rows.map(toVersion);
    const at = last!.rows[0]?.at;
    const lastUploadAt = at == null ? null : String(at);
    return { effective: history[0] ?? DEFAULTS, history: history.length ? history : [DEFAULTS], storageProvider: this.storage.provider, lastUploadAt };
  }

  async update(admin: AuthUser, input: ScreenshotSettingsInput): Promise<ScreenshotSettingsResponse> {
    assertMayChangeRetention(admin, await this.current(), input);
    const maxOffline = this.attendancePolicy.maxOfflineAgeDays;
    if (input.retentionDays < maxOffline) throw new BadRequestException(`retentionDays: must be at least the offline limit (${maxOffline} days)`);
    await this.monitoring.notice(input.noticeVersion).catch(() => {
      throw new BadRequestException("noticeVersion: no such notice");
    });
    // Consents are kept per notice version: a notice also used for activity monitoring (now or earlier)
    // would make that acknowledgement count as screenshot consent. Screenshots need their own.
    const { rows: shared } = await this.db.execute({ sql: "SELECT 1 FROM monitoring_policies WHERE notice_version = ? LIMIT 1", args: [input.noticeVersion] });
    if (shared.length || input.noticeVersion === DEFAULT_NOTICE_VERSION) {
      throw new BadRequestException("noticeVersion: this notice is used for activity monitoring; screenshots need a separate notice");
    }
    const { reason, ...next } = input;
    await this.db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, blur, interval_seconds, webp_quality, max_dimension, capture_scope,
              retention_days, retention_approved, notice_version, employee_self_view, auto_timelapse, reason, changed_by, effective_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      args: [
        next.enabled ? 1 : 0, JSON.stringify(next.maskRegions), next.blur ? 1 : 0, next.intervalSeconds, next.webpQuality, next.maxDimension, next.captureScope,
        next.retentionDays, next.retentionApproved ? 1 : 0, next.noticeVersion, next.employeeSelfView ? 1 : 0, next.autoTimelapse ? 1 : 0, reason, admin.id,
      ],
    });
    const { maskRegions, ...rest } = next;
    this.logger.log({ adminId: admin.id, ...rest, maskCount: maskRegions.length }, "Screenshot settings changed");
    return this.overview();
  }

  static at(periods: ScreenshotPeriod[], t: number): ScreenshotPeriod {
    let p = periods[0]!;
    for (const q of periods) if (q.from <= t) p = q;
    return p;
  }

  // ---- Per-employee blur override ---------------------------------------------------------

  /** One employee's overrides, ascending. */
  async blurOverrides(employeeId: string): Promise<BlurOverride[]> {
    const { rows } = await this.db.execute({
      sql: "SELECT blur, effective_at FROM screenshot_blur_overrides WHERE employee_id = ? ORDER BY effective_at, rowid",
      args: [employeeId],
    });
    return rows.map((r) => ({ from: Date.parse(String(r.effective_at)), blur: r.blur === null ? null : Boolean(r.blur) }));
  }

  /** Blur in force for an employee at `t`: their latest override (if not cleared), else the organisation policy then. */
  static blurAt(periods: ScreenshotPeriod[], overrides: BlurOverride[], t: number): boolean {
    let o: BlurOverride | undefined;
    for (const q of overrides) if (q.from <= t) o = q;
    return o?.blur ?? ScreenshotSettingsService.at(periods, t).blur;
  }

  async blurOverview(employeeId: string): Promise<ScreenshotBlurOverridesResponse> {
    const [{ rows: emp }, { rows }, org] = await Promise.all([
      this.db.execute({ sql: "SELECT id FROM employee_profiles WHERE id = ?", args: [employeeId] }),
      this.db.execute({
        sql: `SELECT o.blur, o.reason, o.effective_at, u.id AS user_id, u.email AS user_email FROM screenshot_blur_overrides o JOIN users u ON u.id = o.changed_by
              WHERE o.employee_id = ? ORDER BY o.effective_at DESC, o.rowid DESC LIMIT 100`,
        args: [employeeId],
      }),
      this.current(),
    ]);
    if (!emp[0]) throw new NotFoundException("Employee not found");
    const history = rows.map((r) => ({
      blur: r.blur === null ? null : Boolean(r.blur),
      reason: String(r.reason),
      changedBy: { id: String(r.user_id), email: String(r.user_email) },
      effectiveAt: String(r.effective_at),
    }));
    const override = history[0]?.blur ?? null;
    return { employeeId, organisationBlur: org.blur, override, effective: override ?? org.blur, history };
  }

  /** Records a new override (or clears it with `blur: null`); applies to captures from now on. */
  async setBlurOverride(admin: AuthUser, employeeId: string, input: ScreenshotBlurOverrideInput): Promise<ScreenshotBlurOverridesResponse> {
    const { rows } = await this.db.execute({ sql: "SELECT id FROM employee_profiles WHERE id = ?", args: [employeeId] });
    if (!rows[0]) throw new NotFoundException("Employee not found");
    await this.db.execute({
      sql: `INSERT INTO screenshot_blur_overrides (id, employee_id, blur, reason, changed_by, effective_at)
            VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      args: [randomUUID(), employeeId, input.blur === null ? null : input.blur ? 1 : 0, input.reason, admin.id],
    });
    this.logger.log({ adminId: admin.id, employeeId, blur: input.blur }, "Screenshot blur override changed");
    return this.blurOverview(employeeId);
  }
}

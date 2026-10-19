import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import type { DatabaseClient, Row } from "@workfolio/database";
import {
  DEFAULT_SCREENSHOT_SETTINGS,
  type AttendancePolicy,
  type AuthUser,
  type ScreenshotScope,
  type ScreenshotSettingsInput,
  type ScreenshotSettingsResponse,
  type ScreenshotSettingsVersion,
} from "@workfolio/shared";
import { POLICY } from "../common/policy.js";
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
}

const COLUMNS = `p.screenshots_enabled, p.interval_seconds, p.webp_quality, p.max_dimension, p.capture_scope, p.retention_days,
  p.retention_approved, p.notice_version, p.employee_self_view, p.reason, p.effective_at, u.id AS user_id, u.email AS user_email`;

const toVersion = (r: Row): ScreenshotSettingsVersion => ({
  enabled: Boolean(r.screenshots_enabled),
  intervalSeconds: Number(r.interval_seconds),
  webpQuality: Number(r.webp_quality),
  maxDimension: Number(r.max_dimension),
  captureScope: String(r.capture_scope) as ScreenshotScope,
  retentionDays: Number(r.retention_days),
  retentionApproved: Boolean(r.retention_approved),
  noticeVersion: String(r.notice_version),
  employeeSelfView: Boolean(r.employee_self_view),
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
    const { rows } = await this.db.execute("SELECT screenshots_enabled, notice_version, interval_seconds, max_dimension, effective_at FROM screenshot_policies ORDER BY seq");
    const d = DEFAULT_SCREENSHOT_SETTINGS;
    return [
      { from: -Infinity, enabled: d.enabled, noticeVersion: d.noticeVersion, intervalSeconds: d.intervalSeconds, maxDimension: d.maxDimension },
      ...rows.map((r) => ({
        from: Date.parse(String(r.effective_at)),
        enabled: Boolean(r.screenshots_enabled),
        noticeVersion: String(r.notice_version),
        intervalSeconds: Number(r.interval_seconds),
        maxDimension: Number(r.max_dimension),
      })),
    ];
  }

  async overview(): Promise<ScreenshotSettingsResponse> {
    const { rows } = await this.db.execute(`SELECT ${COLUMNS} FROM screenshot_policies p JOIN users u ON u.id = p.changed_by ORDER BY p.seq DESC LIMIT 100`);
    const history = rows.map(toVersion);
    return { effective: history[0] ?? DEFAULTS, history: history.length ? history : [DEFAULTS], storageProvider: this.storage.provider };
  }

  async update(admin: AuthUser, input: ScreenshotSettingsInput): Promise<ScreenshotSettingsResponse> {
    const maxOffline = this.attendancePolicy.maxOfflineAgeDays;
    if (input.retentionDays < maxOffline) throw new BadRequestException(`retentionDays: must be at least the offline limit (${maxOffline} days)`);
    await this.monitoring.notice(input.noticeVersion).catch(() => {
      throw new BadRequestException("noticeVersion: no such notice");
    });
    const { reason, ...next } = input;
    await this.db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope,
              retention_days, retention_approved, notice_version, employee_self_view, reason, changed_by, effective_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      args: [
        next.enabled ? 1 : 0, next.intervalSeconds, next.webpQuality, next.maxDimension, next.captureScope,
        next.retentionDays, next.retentionApproved ? 1 : 0, next.noticeVersion, next.employeeSelfView ? 1 : 0, reason, admin.id,
      ],
    });
    this.logger.log({ adminId: admin.id, ...next }, "Screenshot settings changed");
    return this.overview();
  }

  static at(periods: ScreenshotPeriod[], t: number): ScreenshotPeriod {
    let p = periods[0]!;
    for (const q of periods) if (q.from <= t) p = q;
    return p;
  }
}

import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import {
  DEFAULT_MONITORING_SETTINGS,
  type AttendancePolicy,
  type AuthUser,
  type MonitoringNotice,
  type MonitoringSettingsInput,
  type MonitoringSettingsResponse,
  type MonitoringSettingsVersion,
  type NoticeInput,
} from "@workfolio/shared";
import { POLICY } from "../common/policy.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";

/** What applied from `from` (ms) until the next period: used to check activity recorded offline. */
export interface PolicyPeriod {
  from: number;
  enabled: boolean;
  noticeVersion: string;
}

const COLUMNS = `p.monitoring_enabled, p.sample_seconds, p.idle_threshold_seconds, p.retention_days, p.retention_approved,
  p.notice_version, p.reason, p.effective_at, u.id AS user_id, u.email AS user_email`;

const toVersion = (r: Row): MonitoringSettingsVersion => ({
  enabled: Boolean(r.monitoring_enabled),
  sampleSeconds: Number(r.sample_seconds),
  idleThresholdSeconds: Number(r.idle_threshold_seconds),
  retentionDays: Number(r.retention_days),
  retentionApproved: Boolean(r.retention_approved),
  noticeVersion: String(r.notice_version),
  effectiveAt: String(r.effective_at),
  changedBy: { id: String(r.user_id), email: String(r.user_email) },
  reason: String(r.reason),
});

const toNotice = (r: Row): MonitoringNotice => ({
  version: String(r.version),
  title: String(r.title),
  points: JSON.parse(String(r.points)) as string[],
  draft: Boolean(r.draft),
  createdAt: String(r.created_at),
});

/**
 * Server-controlled monitoring settings. Every change is a new row (who, when, why); the newest
 * row is in effect. Before the first change, the defaults apply (sampling and idle from API env).
 */
@Injectable()
export class MonitoringSettingsService {
  private readonly logger = new Logger(MonitoringSettingsService.name);
  private readonly defaults: MonitoringSettingsVersion;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(POLICY) private readonly attendancePolicy: AttendancePolicy,
    config: ConfigService<Env, true>,
  ) {
    this.defaults = {
      ...DEFAULT_MONITORING_SETTINGS,
      sampleSeconds: config.get("ACTIVITY_SAMPLE_SECONDS", { infer: true }),
      idleThresholdSeconds: config.get("IDLE_THRESHOLD_SECONDS", { infer: true }),
      effectiveAt: null,
      changedBy: null,
      reason: null,
    };
  }

  async current(): Promise<MonitoringSettingsVersion> {
    const { rows } = await this.db.execute(`SELECT ${COLUMNS} FROM monitoring_policies p JOIN users u ON u.id = p.changed_by ORDER BY p.seq DESC LIMIT 1`);
    return rows[0] ? toVersion(rows[0]) : this.defaults;
  }

  /** Ascending; the first period (defaults) starts at -Infinity. */
  async periods(): Promise<PolicyPeriod[]> {
    const { rows } = await this.db.execute("SELECT monitoring_enabled, notice_version, effective_at FROM monitoring_policies ORDER BY seq");
    return [
      { from: -Infinity, enabled: this.defaults.enabled, noticeVersion: this.defaults.noticeVersion },
      ...rows.map((r) => ({ from: Date.parse(String(r.effective_at)), enabled: Boolean(r.monitoring_enabled), noticeVersion: String(r.notice_version) })),
    ];
  }

  async overview(): Promise<MonitoringSettingsResponse> {
    const [history, notices] = await this.db.batch(
      [
        `SELECT ${COLUMNS} FROM monitoring_policies p JOIN users u ON u.id = p.changed_by ORDER BY p.seq DESC LIMIT 100`,
        "SELECT version, title, points, draft, created_at FROM monitoring_notices ORDER BY created_at DESC, version DESC",
      ],
      "read",
    );
    const versions = history!.rows.map(toVersion);
    return { effective: versions[0] ?? this.defaults, history: versions.length ? versions : [this.defaults], notices: notices!.rows.map(toNotice) };
  }

  async notice(version: string): Promise<MonitoringNotice> {
    const { rows } = await this.db.execute({ sql: "SELECT version, title, points, draft, created_at FROM monitoring_notices WHERE version = ?", args: [version] });
    if (!rows[0]) throw new NotFoundException("Monitoring notice not found");
    return toNotice(rows[0]);
  }

  async update(admin: AuthUser, input: MonitoringSettingsInput): Promise<MonitoringSettingsResponse> {
    const maxOffline = this.attendancePolicy.maxOfflineAgeDays;
    // Shorter retention would let a late offline upload be accepted and purged at once.
    if (input.retentionDays < maxOffline) throw new BadRequestException(`retentionDays: must be at least the offline limit (${maxOffline} days)`);
    await this.notice(input.noticeVersion).catch(() => {
      throw new BadRequestException("noticeVersion: no such notice");
    });
    const { reason, ...next } = input;
    await this.db.execute({
      sql: `INSERT INTO monitoring_policies
              (monitoring_enabled, sample_seconds, idle_threshold_seconds, retention_days, retention_approved, notice_version, reason, changed_by, effective_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      args: [
        next.enabled ? 1 : 0, next.sampleSeconds, next.idleThresholdSeconds, next.retentionDays,
        next.retentionApproved ? 1 : 0, next.noticeVersion, reason, admin.id,
      ],
    });
    this.logger.log({ adminId: admin.id, ...next }, "Monitoring settings changed");
    return this.overview();
  }

  /** Publishes a new notice version (does not require it yet; select it in the settings). */
  async publishNotice(admin: AuthUser, input: NoticeInput): Promise<MonitoringNotice> {
    try {
      await this.db.execute({
        sql: "INSERT INTO monitoring_notices (version, title, points, draft, created_by) VALUES (?, ?, ?, ?, ?)",
        args: [input.version, input.title, JSON.stringify(input.points), input.draft ? 1 : 0, admin.id],
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A notice with this version already exists; notices cannot be edited");
      throw err;
    }
    this.logger.log({ adminId: admin.id, version: input.version }, "Monitoring notice published");
    return this.notice(input.version);
  }

  /** The required notice version at instant `t`, and whether monitoring was enabled then. */
  static at(periods: PolicyPeriod[], t: number): PolicyPeriod {
    let p = periods[0]!;
    for (const q of periods) if (q.from <= t) p = q;
    return p;
  }
}


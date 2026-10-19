import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DatabaseClient } from "@workfolio/database";
import type { AuthUser, RetentionPreview } from "@workfolio/shared";
import { iso, str } from "../attendance/sessions.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { MonitoringSettingsService } from "../settings/monitoring-settings.service.js";

const DAY_MS = 86_400_000;
/** Rows deleted per transaction, each recorded together with its deletion (no silent deletes). */
const CHUNK = 5_000;
const SCHEDULE_MS = 6 * 3_600_000;

/**
 * Activity retention. Only `activity_intervals` is purged; attendance, corrections, consents and
 * settings history are separate tables and are never touched. Nothing is deleted until an admin
 * records `retentionApproved` (after HR/Legal sign-off). Unsynced activity lives on the device and
 * is never deleted there; the server only accepts uploads younger than the offline limit, and the
 * retention period cannot be shorter than that, so an accepted upload is never purged at once.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly settings: MonitoringSettingsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit() {
    if (this.config.get("NODE_ENV", { infer: true }) === "test") return;
    this.timer = setInterval(() => void this.scheduled(), SCHEDULE_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Dry run: counts only. */
  async preview(now = Date.now()): Promise<RetentionPreview> {
    const s = await this.settings.current();
    const cutoff = iso(now - s.retentionDays * DAY_MS);
    const [eligible, all, runs] = await this.db.batch(
      [
        { sql: "SELECT count(*) AS n, count(DISTINCT employee_id) AS employees FROM activity_intervals WHERE ended_at < ?", args: [cutoff] },
        "SELECT count(*) AS n, min(ended_at) AS oldest FROM activity_intervals",
        `SELECT r.ran_at, r.cutoff, r.retention_days, r.deleted, u.id AS user_id, u.email
         FROM activity_retention_runs r LEFT JOIN users u ON u.id = r.triggered_by ORDER BY r.ran_at DESC LIMIT 20`,
      ],
      "read",
    );
    return {
      retentionDays: s.retentionDays,
      approved: s.retentionApproved,
      cutoff,
      eligibleIntervals: Number(eligible!.rows[0]!.n),
      eligibleEmployees: Number(eligible!.rows[0]!.employees),
      oldestEndedAt: str(all!.rows[0]!.oldest),
      totalIntervals: Number(all!.rows[0]!.n),
      runs: runs!.rows.map((r) => ({
        ranAt: String(r.ran_at),
        cutoff: String(r.cutoff),
        retentionDays: Number(r.retention_days),
        deleted: Number(r.deleted),
        triggeredBy: r.user_id ? { id: String(r.user_id), email: String(r.email) } : null,
      })),
    };
  }

  /** Purges intervals that ended before the cutoff. `admin` null = scheduled job. */
  async run(admin: AuthUser | null, now = Date.now()): Promise<RetentionPreview> {
    const s = await this.settings.current();
    if (!s.retentionApproved) throw new ConflictException("Activity retention has not been approved in the settings; nothing was deleted");
    const cutoff = iso(now - s.retentionDays * DAY_MS);
    let total = 0;
    for (;;) {
      // The run row is written in the same transaction as the delete, with its exact row count.
      const [deleted] = await this.db.batch(
        [
          { sql: `DELETE FROM activity_intervals WHERE id IN (SELECT id FROM activity_intervals WHERE ended_at < ? LIMIT ${CHUNK})`, args: [cutoff] },
          {
            sql: "INSERT INTO activity_retention_runs (id, cutoff, retention_days, deleted, triggered_by) SELECT ?, ?, ?, changes(), ? WHERE changes() > 0",
            args: [randomUUID(), cutoff, s.retentionDays, admin?.id ?? null],
          },
        ],
        "write",
      );
      total += deleted!.rowsAffected;
      if (deleted!.rowsAffected < CHUNK) break;
    }
    if (!total) {
      await this.db.execute({
        sql: "INSERT INTO activity_retention_runs (id, cutoff, retention_days, deleted, triggered_by) VALUES (?, ?, ?, 0, ?)",
        args: [randomUUID(), cutoff, s.retentionDays, admin?.id ?? null],
      });
    }
    this.logger.log({ adminId: admin?.id ?? null, cutoff, deleted: total }, "Activity retention purge");
    return this.preview(now);
  }

  private async scheduled() {
    try {
      if ((await this.settings.current()).retentionApproved) await this.run(null);
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, "Scheduled activity retention failed");
    }
  }
}

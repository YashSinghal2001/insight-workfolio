import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DatabaseClient, InStatement, Row } from "@workfolio/database";
import {
  NOTIFICATION_RECIPIENT_LABEL,
  NOTIFICATION_ROUTES,
  platformRoleOf,
  type NotificationDelivery,
  type NotificationDeliveryStatus,
  type NotificationEvent,
  type NotificationOverview,
  type NotificationRecipientRole,
  type NotificationSeverity,
  type NotificationType,
  type Role,
} from "@workfolio/shared";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { MailError } from "../reports/mail.js";
import { SCREENSHOT_STORAGE, StorageError, type ScreenshotStorage } from "../screenshots/storage.js";
import { EmailService } from "./email.service.js";
import { renderNotification } from "./templates.js";

export interface NotificationInput {
  type: NotificationType;
  /** Short and safe to email to staff: no secret, token, screenshot or employee activity. Sanitized again here. */
  description: string;
  /** The affected account: the only employee who can ever be a recipient. */
  subjectUserId?: string | null;
  /** The same key again is a no-op (no second event, no second email). */
  dedupeKey?: string;
}

/** Attempts per recipient, and the wait before attempts 2, 3 and 4 after a transient failure (tests set them to 0). */
export const NOTIFICATION_MAX_ATTEMPTS = 4;
export const NOTIFICATION_RETRY = { backoffMs: [60_000, 5 * 60_000, 30 * 60_000] };
const TICK_MS = 60_000;
/** A delivery left PROCESSING this long was interrupted (the API stopped mid-send): it is tried again. */
const STALE_MS = 10 * 60_000;
const BATCH = 50;
/** ponytail: fixed retention of the notification log; make it a setting if a policy ever asks for another period. */
const RETENTION_DAYS = 365;
const STORAGE_PROBE_KEY = "readiness-probe";

const iso = (ms: number) => new Date(ms).toISOString();
const str = (v: unknown) => (v == null ? null : String(v));

/** One line, no control characters, nothing that looks like a token or key, at most 500 characters. */
export const sanitize = (s: string) =>
  s
    .replace(/\p{Cc}+/gu, " ")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "No details";

/** Who is in each group right now. The server decides; no caller can name a recipient. */
const RECIPIENTS: Record<NotificationRecipientRole, string> = {
  EMPLOYEE: "SELECT id FROM users WHERE status = 'ACTIVE' AND id = ?",
  IT: "SELECT id FROM users WHERE status = 'ACTIVE' AND role = 'ADMIN' AND coalesce(admin_title, 'ADMIN') <> 'SUPER_ADMIN'",
  SUPER_ADMIN: "SELECT id FROM users WHERE status = 'ACTIVE' AND role = 'ADMIN' AND admin_title = 'SUPER_ADMIN'",
};

/**
 * Records one event and one PENDING delivery per recipient, in one transaction: the routing matrix
 * (NOTIFICATION_ROUTES) names the groups, each group is resolved on its own, and a group with nobody in it gets a
 * FAILED row instead of silence. Returns the event id, or null when the dedupe key was already recorded.
 * Needs only the database, so the notify CLI (a separate process) uses it too; the API's queue sends the emails.
 */
export async function recordNotification(db: DatabaseClient, input: NotificationInput): Promise<string | null> {
  const route = NOTIFICATION_ROUTES[input.type];
  const id = randomUUID();
  const subject = input.subjectUserId ?? null;
  const ifRecorded = "WHERE EXISTS (SELECT 1 FROM notification_events WHERE id = ?)";
  const statements: InStatement[] = [
    {
      sql: "INSERT INTO notification_events (id, type, severity, subject_user_id, description, dedupe_key) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING",
      args: [id, input.type, route.severity, subject, sanitize(input.description), input.dedupeKey?.slice(0, 200) ?? null],
    },
  ];
  for (const role of route.roles as readonly NotificationRecipientRole[]) {
    if (role === "EMPLOYEE" && !subject) continue; // an event about nobody in particular has no employee to tell
    const users = (await db.execute({ sql: RECIPIENTS[role], args: role === "EMPLOYEE" ? [subject] : [] })).rows.map((r) => String(r.id));
    for (const userId of users) {
      statements.push({ sql: `INSERT INTO notification_deliveries (id, event_id, recipient_role, recipient_user_id) SELECT ?, ?, ?, ? ${ifRecorded}`, args: [randomUUID(), id, role, userId, id] });
    }
    if (!users.length) {
      statements.push({
        sql: `INSERT INTO notification_deliveries (id, event_id, recipient_role, status, last_error) SELECT ?, ?, ?, 'FAILED', ? ${ifRecorded}`,
        args: [randomUUID(), id, role, `No active ${NOTIFICATION_RECIPIENT_LABEL[role]} account to notify`, id],
      });
    }
  }
  const [event] = await db.batch(statements, "write");
  return event?.rowsAffected ? id : null;
}

/**
 * Email notifications (docs/notifications.md). Application code calls `emit`; everything else happens here:
 * routing by event type, recipients from the accounts table, one delivery row per recipient, sending through
 * EmailService with bounded retries and backoff, and the log the dashboard reads.
 *
 * The queue is the notification_deliveries table and one in-process timer, like the report and alert schedulers
 * (single API instance, API-13). A crash between "sent" and "recorded" re-sends that one email after STALE_MS.
 * A failed notification never raises another notification.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly test: boolean;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private ticks = 0;
  private storageFailures = 0;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly email: EmailService,
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.test = config.get("NODE_ENV", { infer: true }) === "test";
  }

  onModuleInit() {
    if (this.test) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /**
   * Records the event and queues its emails. Never throws and never waits for a send: a notification must not
   * break, or slow down, the action that caused it. Returns the event id (null: duplicate, or it failed).
   */
  async emit(input: NotificationInput): Promise<string | null> {
    try {
      const id = await recordNotification(this.db, input);
      if (id) {
        this.logger.log({ eventId: id, type: input.type }, "Notification recorded");
        if (!this.test) void this.tick();
      }
      return id;
    } catch (err) {
      this.logger.error({ type: input.type, err: (err as Error).message }, "Notification could not be recorded");
      return null;
    }
  }

  /** One pass of the queue and its housekeeping. Steps are independent: one failing does not stop the others. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const step = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        this.logger.error({ err: (err as Error).message }, `Notification ${name} failed`);
      }
    };
    try {
      const n = this.ticks++;
      await step("delivery", () => this.deliver(now));
      if (n % 5 === 0) await step("storage check", () => this.checkStorage(now));
      if (n % 60 === 0) {
        await step("onboarding summary", () => this.onboardingSummary(now));
        await step("retention", () => this.purge(now));
      }
    } finally {
      this.ticking = false;
    }
  }

  // ---- Delivery ------------------------------------------------------------------------------

  /** Sends what is due, critical events first. Each recipient is claimed, sent and recorded on its own. */
  async deliver(now = Date.now()): Promise<void> {
    const at = iso(now);
    await this.db.execute({ sql: "UPDATE notification_deliveries SET status = 'RETRYING', next_attempt_at = ?, updated_at = ? WHERE status = 'PROCESSING' AND updated_at < ?", args: [at, at, iso(now - STALE_MS)] });
    const { rows } = await this.db.execute({
      sql: `SELECT d.id, d.recipient_role, d.attempts, e.id AS event_id, e.type, e.severity, e.description, e.created_at, e.subject_user_id,
              u.id AS user_id, u.email, u.status AS user_status, u.role, u.admin_title
            FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id LEFT JOIN users u ON u.id = d.recipient_user_id
            WHERE d.status IN ('PENDING', 'RETRYING') AND d.next_attempt_at <= ?
            ORDER BY (e.severity = 'CRITICAL') DESC, d.created_at, d.id LIMIT ${BATCH}`,
      args: [at],
    });
    for (const r of rows) {
      const deliveryId = String(r.id);
      const claimed = await this.db.execute({ sql: "UPDATE notification_deliveries SET status = 'PROCESSING', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('PENDING', 'RETRYING')", args: [at, deliveryId] });
      if (!claimed.rowsAffected) continue;
      const attempts = Number(r.attempts) + 1;
      try {
        const { messageId } = await this.email.send(this.message(r));
        const done = iso(Date.now());
        await this.db.execute({ sql: "UPDATE notification_deliveries SET status = 'SENT', sent_at = ?, provider_message_id = ?, last_error = NULL, updated_at = ? WHERE id = ?", args: [done, messageId.slice(0, 200), done, deliveryId] });
      } catch (err) {
        const permanent = !(err instanceof MailError) || err.permanent;
        const reason = sanitize(err instanceof MailError ? err.message : "Unexpected error while sending").slice(0, 300);
        const delay = NOTIFICATION_RETRY.backoffMs[attempts - 1];
        const retry = !permanent && attempts < NOTIFICATION_MAX_ATTEMPTS && delay !== undefined;
        await this.db.execute({
          sql: "UPDATE notification_deliveries SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
          args: [retry ? "RETRYING" : "FAILED", reason, iso(now + (retry ? delay : 0)), iso(Date.now()), deliveryId],
        });
        this.logger.warn({ deliveryId, eventId: String(r.event_id), attempts, retry, reason }, "Notification email not sent");
      }
    }
  }

  /** The email for one delivery row. The recipient must still be an active member of the group it was queued for. */
  private message(r: Row) {
    const role = r.recipient_role as NotificationRecipientRole;
    const member =
      r.user_status === "ACTIVE" &&
      (role === "EMPLOYEE" ? r.user_id === r.subject_user_id : platformRoleOf(r.role as Role, str(r.admin_title)) === (role === "IT" ? "ADMIN" : "SUPER_ADMIN"));
    if (!member) throw new MailError(`The recipient is no longer an active ${NOTIFICATION_RECIPIENT_LABEL[role]} account`, true);
    const sender = this.email.sender;
    if (!sender) throw new MailError("No email provider is configured", true);
    return renderNotification({
      event: { id: String(r.event_id), type: r.type as NotificationType, severity: r.severity as NotificationSeverity, description: String(r.description), createdAt: String(r.created_at) },
      role,
      to: String(r.email),
      dashboardUrl: this.config.get("DASHBOARD_URL", { infer: true }),
      sender,
    });
  }

  // ---- Producers that live here --------------------------------------------------------------

  /**
   * The storage readiness probe (the one /ready uses), every 5 minutes. Two failures in a row tell IT; an hour of
   * them is a critical failure (IT and Super Admin). Once a day each, by dedupe key.
   * With `graph-delegated` mail and OneDrive storage, an expired OneDrive authorization stops the emails too:
   * these events then stay in the dashboard as not delivered (docs/notifications.md, "Limits").
   */
  async checkStorage(now = Date.now()): Promise<void> {
    if (this.config.get("SCREENSHOT_STORAGE", { infer: true }) === "local") return;
    try {
      await this.storage.stat(STORAGE_PROBE_KEY);
      this.storageFailures = 0;
    } catch (err) {
      const failures = ++this.storageFailures;
      const why = err instanceof StorageError ? err.message : "unexpected error";
      const day = iso(now).slice(0, 10);
      if (failures === 2) await this.storageFailed(why, now);
      if (failures === 12) await this.emit({ type: "CRITICAL_FAILURE", description: `File storage has been unreachable for an hour (${why}). Screenshots, timelapses and the off-site database backup cannot be stored.`, dedupeKey: `storage-critical:${day}` });
    }
  }

  /** A storage write failed (screenshot upload) or the probe did: IT is told once a day. */
  storageFailed(why: string, now = Date.now()): Promise<string | null> {
    return this.emit({ type: "SCREENSHOT_FAILURE", description: `File storage is not working (${why}). Screenshots and timelapses cannot be stored until it is fixed.`, dedupeKey: `storage:${iso(now).slice(0, 10)}` });
  }

  /** Mondays (UTC): counts for the past seven days, nothing about any one employee. Skipped when nobody was added. */
  async onboardingSummary(now = Date.now()): Promise<void> {
    if (new Date(now).getUTCDay() !== 1) return;
    const since = iso(now - 7 * 86_400_000);
    const [accounts, invitations] = await this.db.batch(
      [
        { sql: "SELECT count(*) AS created, coalesce(sum(password_hash IS NOT NULL), 0) AS activated FROM users WHERE role = 'EMPLOYEE' AND created_at >= ?", args: [since] },
        { sql: "SELECT count(*) AS failed FROM account_invitations WHERE status = 'FAILED' AND created_at >= ?", args: [since] },
      ],
      "read",
    );
    const created = Number(accounts!.rows[0]!.created);
    if (!created) return;
    const activated = Number(accounts!.rows[0]!.activated);
    await this.emit({
      type: "ONBOARDING_SUMMARY",
      description: `Past 7 days: ${created} employee account(s) created, ${activated} activated, ${created - activated} awaiting activation, ${Number(invitations!.rows[0]!.failed)} invitation email(s) not sent.`,
      dedupeKey: `onboarding:${iso(now).slice(0, 10)}`,
    });
  }

  private async purge(now: number): Promise<void> {
    const before = iso(now - RETENTION_DAYS * 86_400_000);
    await this.db.batch(
      [
        { sql: "DELETE FROM notification_deliveries WHERE event_id IN (SELECT id FROM notification_events WHERE created_at < ?)", args: [before] },
        { sql: "DELETE FROM notification_events WHERE created_at < ?", args: [before] },
      ],
      "write",
    );
  }

  // ---- Dashboard -----------------------------------------------------------------------------

  async overview(show: "all" | "failed" | "critical"): Promise<NotificationOverview> {
    const [events, counts] = await this.db.batch(
      [
        {
          sql: `SELECT e.id, e.type, e.severity, e.description, e.created_at, e.subject_user_id, u.email AS subject_email
                FROM notification_events e LEFT JOIN users u ON u.id = e.subject_user_id
                WHERE ?1 = 'all' OR (?1 = 'critical' AND e.severity = 'CRITICAL')
                   OR (?1 = 'failed' AND EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id = e.id AND d.status = 'FAILED'))
                ORDER BY e.created_at DESC, e.id LIMIT 200`,
          args: [show],
        },
        `SELECT (SELECT count(*) FROM notification_deliveries WHERE status = 'FAILED') AS failed,
                (SELECT count(*) FROM notification_deliveries WHERE status IN ('PENDING', 'PROCESSING', 'RETRYING')) AS waiting,
                (SELECT count(*) FROM notification_events e WHERE e.severity = 'CRITICAL'
                   AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id = e.id AND d.status = 'SENT')) AS critical_undelivered`,
      ],
      "read",
    );
    const ids = events!.rows.map((e) => String(e.id));
    const deliveries = ids.length
      ? (
          await this.db.execute({
            sql: `SELECT d.id, d.event_id, d.recipient_role, d.status, d.attempts, d.sent_at, d.last_error, d.updated_at, u.email
                  FROM notification_deliveries d LEFT JOIN users u ON u.id = d.recipient_user_id
                  WHERE d.event_id IN (${ids.map(() => "?").join(", ")}) ORDER BY d.recipient_role, u.email, d.id`,
            args: ids,
          })
        ).rows
      : [];
    const byEvent = new Map<string, NotificationDelivery[]>();
    for (const d of deliveries) {
      const list = byEvent.get(String(d.event_id)) ?? [];
      list.push({ id: String(d.id), role: d.recipient_role as NotificationRecipientRole, recipient: str(d.email), status: d.status as NotificationDeliveryStatus, attempts: Number(d.attempts), sentAt: str(d.sent_at), lastError: str(d.last_error), updatedAt: String(d.updated_at) });
      byEvent.set(String(d.event_id), list);
    }
    const c = counts!.rows[0]!;
    return {
      email: await this.email.status(),
      counts: { failed: Number(c.failed), waiting: Number(c.waiting), criticalUndelivered: Number(c.critical_undelivered) },
      events: events!.rows.map(
        (e): NotificationEvent => ({
          id: String(e.id),
          type: e.type as NotificationType,
          severity: e.severity as NotificationSeverity,
          description: String(e.description),
          subject: e.subject_user_id === null ? null : { id: String(e.subject_user_id), email: String(e.subject_email) },
          createdAt: String(e.created_at),
          deliveries: byEvent.get(String(e.id)) ?? [],
        }),
      ),
    };
  }

  /** An admin's "send again" for one FAILED delivery: a fresh set of attempts, to the same account only. */
  async retry(deliveryId: string, actorId: string): Promise<void> {
    const at = iso(Date.now());
    const res = await this.db.execute({
      sql: "UPDATE notification_deliveries SET status = 'PENDING', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'FAILED' AND recipient_user_id IS NOT NULL",
      args: [at, at, deliveryId],
    });
    if (!res.rowsAffected) {
      if ((await this.db.execute({ sql: "SELECT 1 FROM notification_deliveries WHERE id = ?", args: [deliveryId] })).rows[0]) throw new ConflictException("Only a failed delivery to an account can be sent again");
      throw new NotFoundException("Delivery not found");
    }
    this.logger.log({ deliveryId, actorId }, "Notification delivery queued again");
    if (!this.test) void this.tick();
  }
}

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { guardViolation, isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import {
  addDays,
  categorize,
  DEFAULT_WEBSITE_NOTICE_VERSION,
  localDate,
  normalizeDomain,
  WEBSITE_INTERVAL_MAX_SECONDS,
  type EmployeeRef,
  type WebsiteCategory,
  type WebsiteCategoryRule,
  type WebsiteNotificationStatus,
  type WebsitePolicy,
  type WebsiteReport,
  type WebsiteStatus,
  type ExtensionPairResponse,
  type ExtensionStateResponse,
  type WebsiteAuditEntry,
  type WebsitePairingCode,
  type WebsitePolicyHistoryEntry,
  type WebsiteUsageResponse,
} from "@workfolio/shared";
import { iso, str } from "../attendance/sessions.js";
import type { AuthContext } from "../auth/auth.service.js";
import { RateLimiter } from "../auth/crypto.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { EmployeesService } from "../employees/employees.service.js";
import { MonitoringSettingsService } from "../settings/monitoring-settings.service.js";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const PAIRING_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const MAX_AGE_MS = 24 * 3_600_000; // older intervals are refused (no backfill)
const RETENTION_MS = 6 * 3_600_000;

export interface ExtensionLink {
  id: string;
  employeeId: string;
}
type Result = { id: string; status: "ACCEPTED" | "DUPLICATE" | "REJECTED"; reason?: string };

/**
 * Website usage (F04). Domain names only, from a browser extension the employee connected with a
 * one-time code. Recording needs: policy on, production approval (env), the employee's acknowledgement
 * of the website notice, an open shift without a break; every interval is re-checked here. Logs carry
 * ids and counts, never domains.
 */
@Injectable()
export class WebsitesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebsitesService.name);
  private readonly pairLimit = new RateLimiter(20, 10 * 60_000); // per IP
  private readonly codeLimit = new RateLimiter(10, 3_600_000); // pairing codes per employee
  readonly uploadLimit = new RateLimiter(120, 10 * 60_000); // per extension link
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly employees: EmployeesService,
    private readonly config: ConfigService<Env, true>,
    private readonly monitoring: MonitoringSettingsService,
  ) {}

  onModuleInit() {
    if (this.config.get("NODE_ENV", { infer: true }) === "test") return;
    if (!this.retentionApproved()) this.logger.log("Scheduled website retention is off until the operator sets WEBSITE_RETENTION_APPROVED=true");
    this.timer = setInterval(() => void this.scheduledRetention().catch((err: Error) => this.logger.error({ err: err.message }, "Website retention failed")), RETENTION_MS);
    this.timer.unref();
  }

  /**
   * Like activity and screenshot retention, nothing is deleted automatically until retention is approved.
   * website_policies has no approval column (and no migration may add one now), so the approval is the
   * operator's env flag, plus production approval of website tracking itself. Returns whether it ran.
   */
  async scheduledRetention(): Promise<boolean> {
    if (!this.retentionApproved()) return false;
    await this.retention(null);
    return true;
  }

  private retentionApproved() {
    return this.config.get("WEBSITE_RETENTION_APPROVED", { infer: true }) && this.productionApproved();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ---- Policy ---------------------------------------------------------------------------------

  /** Outside production collection is allowed for testing; in production only with the operator's approval flag. */
  private productionApproved() {
    return this.config.get("NODE_ENV", { infer: true }) !== "production" || this.config.get("WEBSITE_TRACKING_APPROVED", { infer: true });
  }

  async policy(): Promise<WebsitePolicy & { seq: number | null }> {
    const r = (await this.db.execute(
      `SELECT p.seq, p.enabled, p.retention_days, p.notice_version, p.reason, p.changed_by, u.email, p.effective_at
       FROM website_policies p JOIN users u ON u.id = p.changed_by ORDER BY p.seq DESC LIMIT 1`,
    )).rows[0];
    return {
      seq: r ? Number(r.seq) : null,
      enabled: r ? Number(r.enabled) === 1 : false,
      retentionDays: r ? Number(r.retention_days) : 30,
      noticeVersion: r ? String(r.notice_version) : DEFAULT_WEBSITE_NOTICE_VERSION,
      productionApproved: this.productionApproved(),
      changedBy: r ? { id: String(r.changed_by), email: String(r.email) } : null,
      reason: r ? str(r.reason) : null,
      effectiveAt: r ? String(r.effective_at) : null,
    };
  }

  async history(): Promise<WebsitePolicyHistoryEntry[]> {
    const { rows } = await this.db.execute(
      `SELECT p.seq, p.enabled, p.retention_days, p.notice_version, p.reason, u.email, p.effective_at
       FROM website_policies p JOIN users u ON u.id = p.changed_by ORDER BY p.seq DESC LIMIT 100`,
    );
    return rows.map((r) => ({ seq: Number(r.seq), enabled: Number(r.enabled) === 1, retentionDays: Number(r.retention_days), noticeVersion: String(r.notice_version), reason: String(r.reason), changedBy: String(r.email), effectiveAt: String(r.effective_at) }));
  }

  async setPolicy(admin: AuthContext, input: { enabled: boolean; retentionDays: number; noticeVersion: string; reason: string }) {
    if (!(await this.db.execute({ sql: "SELECT 1 FROM monitoring_notices WHERE version = ?", args: [input.noticeVersion] })).rows[0]) {
      throw new BadRequestException("Unknown notice version");
    }
    await this.db.execute({
      sql: "INSERT INTO website_policies (enabled, retention_days, notice_version, reason, changed_by) VALUES (?, ?, ?, ?, ?)",
      args: [input.enabled ? 1 : 0, input.retentionDays, input.noticeVersion, input.reason, admin.id],
    });
    this.logger.log({ actorId: admin.id, enabled: input.enabled }, "Website policy changed");
    return this.policy();
  }

  // ---- Employee ----------------------------------------------------------------------------------

  async status(caller: AuthContext): Promise<WebsiteStatus> {
    return this.statusFor(await this.employees.attendanceTarget(caller));
  }

  private async statusFor(employee: EmployeeRef): Promise<WebsiteStatus> {
    const policy = await this.policy();
    const [notice, ack, links, shift] = await this.db.batch(
      [
        { sql: "SELECT version, title, points, draft FROM monitoring_notices WHERE version = ?", args: [policy.noticeVersion] },
        { sql: "SELECT acknowledged_at FROM monitoring_consents WHERE employee_id = ? AND notice_version = ?", args: [employee.id, policy.noticeVersion] },
        { sql: "SELECT id, label, created_at, last_used_at FROM website_extension_links WHERE employee_id = ? AND claimed_at IS NOT NULL AND revoked_at IS NULL ORDER BY created_at", args: [employee.id] },
        {
          sql: `SELECT EXISTS (SELECT 1 FROM break_sessions b WHERE b.attendance_session_id = s.id AND b.ended_at IS NULL) AS on_break
                FROM attendance_sessions s WHERE s.employee_id = ? AND s.clock_out_at IS NULL`,
          args: [employee.id],
        },
      ],
      "read",
    );
    const n = notice!.rows[0];
    const acknowledgedAt = str(ack!.rows[0]?.acknowledged_at);
    const reasons = [
      !policy.enabled && "Website tracking is turned off by your organization.",
      !policy.productionApproved && "Website tracking is not approved for use yet (the server operator has not confirmed HR/Legal approval).",
      !acknowledgedAt && "You have not acknowledged the website tracking notice.",
      !links!.rows.length && "No browser extension is connected.",
      !shift!.rows[0] ? "You are clocked out." : Number(shift!.rows[0].on_break) ? "You are on a break." : null,
    ].filter((x): x is string => !!x);
    return {
      policy: { ...policy, seq: undefined } as WebsitePolicy,
      notice: n ? { version: String(n.version), title: String(n.title), points: JSON.parse(String(n.points)), draft: Number(n.draft) === 1 } : null,
      acknowledgedAt,
      collecting: !reasons.length,
      reasons,
      links: links!.rows.map((r) => ({ id: String(r.id), label: String(r.label ?? "Browser"), createdAt: String(r.created_at), lastUsedAt: str(r.last_used_at) })),
    };
  }

  async consent(caller: AuthContext, noticeVersion: string): Promise<WebsiteStatus> {
    const employee = await this.employees.attendanceTarget(caller);
    if (noticeVersion !== (await this.policy()).noticeVersion) throw new BadRequestException("This is not the current website notice");
    await this.db.execute({ sql: "INSERT OR IGNORE INTO monitoring_consents (id, employee_id, notice_version) VALUES (?, ?, ?)", args: [randomUUID(), employee.id, noticeVersion] });
    this.logger.log({ employeeId: employee.id, noticeVersion }, "Website notice acknowledged");
    return this.statusFor(employee);
  }

  /** A one-time code (10 minutes) the employee types into the extension. */
  async pairingCode(caller: AuthContext): Promise<WebsitePairingCode> {
    const employee = await this.employees.attendanceTarget(caller);
    if (!this.codeLimit.hit(employee.id)) throw new HttpException("Too many connection codes; try again later", HttpStatus.TOO_MANY_REQUESTS);
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const expiresAt = iso(Date.now() + PAIRING_MS);
    await this.db.execute({
      sql: "INSERT INTO website_extension_links (id, employee_id, pairing_code_hash, pairing_expires_at) VALUES (?, ?, ?, ?)",
      args: [randomUUID(), employee.id, sha256(code), expiresAt],
    });
    return { code, expiresAt };
  }

  async revoke(caller: AuthContext, linkId: string) {
    const employee = await this.employees.attendanceTarget(caller);
    const res = await this.db.execute({
      sql: "UPDATE website_extension_links SET revoked_at = ?, revoked_by = ? WHERE id = ? AND employee_id = ? AND revoked_at IS NULL",
      args: [iso(Date.now()), caller.id, linkId, employee.id],
    });
    if (!res.rowsAffected) throw new NotFoundException("Browser connection not found");
    this.logger.log({ employeeId: employee.id, linkId }, "Website extension disconnected");
    return this.statusFor(employee);
  }

  // ---- Extension ---------------------------------------------------------------------------------

  async pair(code: string, label: string, ip: string): Promise<ExtensionPairResponse> {
    if (!this.pairLimit.hit(ip)) throw new HttpException("Too many attempts; try again later", HttpStatus.TOO_MANY_REQUESTS);
    const token = randomBytes(32).toString("base64url");
    const now = iso(Date.now());
    const res = await this.db.execute({
      sql: `UPDATE website_extension_links SET token_hash = ?, claimed_at = ?, label = ?
            WHERE pairing_code_hash = ? AND claimed_at IS NULL AND revoked_at IS NULL AND pairing_expires_at > ?`,
      args: [sha256(token), now, label, sha256(code), now],
    });
    if (!res.rowsAffected) throw new BadRequestException("Invalid or expired code");
    const r = (await this.db.execute({
      sql: "SELECT l.id, p.full_name, p.employee_code FROM website_extension_links l JOIN employee_profiles p ON p.id = l.employee_id WHERE l.token_hash = ?",
      args: [sha256(token)],
    })).rows[0]!;
    this.logger.log({ linkId: String(r.id) }, "Website extension connected");
    return { token, employee: { fullName: String(r.full_name), employeeCode: String(r.employee_code) } };
  }

  /** The connected extension behind a bearer token (401 if unknown or disconnected). */
  async extension(authorization: string | undefined): Promise<ExtensionLink> {
    const token = authorization?.match(/^Bearer ([\w-]{20,100})$/)?.[1];
    const r = token
      ? (await this.db.execute({
          // A disabled account's browser stops working at once, like its sessions.
          sql: `SELECT l.id, l.employee_id FROM website_extension_links l
                JOIN employee_profiles p ON p.id = l.employee_id JOIN users u ON u.id = p.user_id
                WHERE l.token_hash = ? AND l.revoked_at IS NULL AND u.status = 'ACTIVE'`,
          args: [sha256(token)],
        })).rows[0]
      : undefined;
    if (!r) throw new UnauthorizedException("This browser is not connected");
    await this.db.execute({ sql: "UPDATE website_extension_links SET last_used_at = ? WHERE id = ?", args: [iso(Date.now()), String(r.id)] });
    return { id: String(r.id), employeeId: String(r.employee_id) };
  }

  async extensionState(link: ExtensionLink): Promise<ExtensionStateResponse> {
    const employee = await this.employeeRef(link.employeeId);
    const s = await this.statusFor(employee);
    // The organization's idle threshold (same as activity monitoring): no website time while idle.
    const { idleThresholdSeconds } = await this.monitoring.current();
    return { collect: s.collecting, reasons: s.reasons, intervalMaxSeconds: WEBSITE_INTERVAL_MAX_SECONDS, idleSeconds: idleThresholdSeconds, employee: { fullName: employee.fullName, employeeCode: employee.employeeCode } };
  }

  async disconnect(link: ExtensionLink) {
    await this.db.execute({ sql: "UPDATE website_extension_links SET revoked_at = ?, revoked_by = (SELECT user_id FROM employee_profiles WHERE id = ?) WHERE id = ? AND revoked_at IS NULL", args: [iso(Date.now()), link.employeeId, link.id] });
    return { disconnected: true };
  }

  async submit(link: ExtensionLink, body: { sentAt: string; intervals: { id: string; domain: string; startedAt: string; endedAt: string }[] }, receivedAt = Date.now()): Promise<{ results: Result[] }> {
    if (!this.uploadLimit.hit(link.id)) throw new HttpException("Too many uploads; try again later", HttpStatus.TOO_MANY_REQUESTS);
    const skew = receivedAt - Date.parse(body.sentAt); // device clock → server clock, as for activity
    const policy = await this.policy();
    const ack = policy.seq === null ? undefined : (await this.db.execute({ sql: "SELECT acknowledged_at FROM monitoring_consents WHERE employee_id = ? AND notice_version = ?", args: [link.employeeId, policy.noticeVersion] })).rows[0];
    const blocked = !policy.enabled ? "Website tracking is turned off" : !this.productionApproved() ? "Website tracking is not approved for use" : !ack ? "The website notice has not been acknowledged" : null;
    const results: Result[] = [];
    for (const i of body.intervals) {
      const reject = (reason: string) => results.push({ id: i.id, status: "REJECTED", reason });
      if (blocked) {
        reject(blocked);
        continue;
      }
      // A retry of something already stored (checked first: the overlap trigger runs before the unique key).
      if ((await this.db.execute({ sql: "SELECT 1 FROM website_intervals WHERE employee_id = ? AND client_id = ?", args: [link.employeeId, i.id] })).rows[0]) {
        results.push({ id: i.id, status: "DUPLICATE" });
        continue;
      }
      const domain = normalizeDomain(i.domain);
      const start = Date.parse(i.startedAt) + skew;
      const end = Date.parse(i.endedAt) + skew;
      const ms = end - start;
      if (!domain) reject("Not a website domain");
      else if (!(ms >= 1000 && ms <= WEBSITE_INTERVAL_MAX_SECONDS * 1000)) reject("Invalid duration");
      else if (end > receivedAt + 5000) reject("In the future");
      else if (start < receivedAt - MAX_AGE_MS) reject("Too old");
      else if (iso(start) < String(ack!.acknowledged_at)) reject("Before the website notice was acknowledged");
      else if (!(await this.enabledAt(iso(start)))) reject("Website tracking was off at that time");
      else {
        const [s, e] = [iso(start), iso(end)];
        const session = (await this.db.execute({
          sql: `SELECT s.id FROM attendance_sessions s WHERE s.employee_id = ?1 AND s.clock_in_at <= ?2 AND (s.clock_out_at IS NULL OR s.clock_out_at >= ?3)
                  AND NOT EXISTS (SELECT 1 FROM break_sessions b WHERE b.attendance_session_id = s.id AND b.started_at < ?3 AND coalesce(b.ended_at, '9999') > ?2)`,
          args: [link.employeeId, s, e],
        })).rows[0];
        if (!session) {
          reject("Not within a clocked-in period outside breaks");
          continue;
        }
        try {
          await this.db.execute({
            sql: `INSERT INTO website_intervals (id, employee_id, link_id, attendance_session_id, policy_seq, client_id, domain, started_at, ended_at, duration_ms, received_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [randomUUID(), link.employeeId, link.id, String(session.id), policy.seq, i.id, domain, s, e, ms, iso(receivedAt)],
          });
          results.push({ id: i.id, status: "ACCEPTED" });
        } catch (err) {
          if (isUniqueViolation(err)) results.push({ id: i.id, status: "DUPLICATE" });
          else if (guardViolation(err) === "website_overlap") reject("Overlaps an interval already recorded");
          else throw err;
        }
      }
    }
    this.logger.log({ linkId: link.id, accepted: results.filter((r) => r.status === "ACCEPTED").length, rejected: results.filter((r) => r.status === "REJECTED").length }, "Website intervals received");
    return { results };
  }

  // ---- Reports ----------------------------------------------------------------------------------------

  async myUsage(caller: AuthContext, from: string, to: string, category?: WebsiteCategory, domain?: string): Promise<WebsiteUsageResponse> {
    const employee = await this.employees.attendanceTarget(caller);
    const r = await this.report(from, to, employee.id, category, domain);
    return { from, to, totalMs: r.totalMs, unclassifiedMs: r.unclassifiedMs, byDomain: r.byDomain.map(({ employees: _, ...d }) => d), rows: r.rows.map(({ employee: _, ...x }) => x) };
  }

  async report(from: string, to: string, employeeId?: string, category?: WebsiteCategory, domainFilter?: string): Promise<WebsiteReport> {
    const rules = await this.rules();
    const policy = await this.policy();
    const [rows, ack, all] = await this.db.batch(
      [
        {
          sql: `SELECT w.domain, w.started_at, w.duration_ms, p.id AS employee_id, p.full_name, p.employee_code, p.timezone
                FROM website_intervals w JOIN employee_profiles p ON p.id = w.employee_id
                WHERE w.started_at >= ? AND w.started_at < ? AND (?3 IS NULL OR w.employee_id = ?3)
                  AND (?4 IS NULL OR w.domain = ?4 OR w.domain LIKE '%.' || ?5 ESCAPE '\\')`,
          // widened; local dates below. ?5: the filter with LIKE wildcards escaped (suffix match only).
          args: [`${addDays(from, -1)}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`, employeeId ?? null, domainFilter ?? null, domainFilter?.replace(/[\\%_]/g, (c) => `\\${c}`) ?? null],
        },
        { sql: "SELECT count(DISTINCT c.employee_id) AS n FROM monitoring_consents c JOIN employee_profiles p ON p.id = c.employee_id WHERE c.notice_version = ? AND p.employment_status <> 'TERMINATED'", args: [policy.noticeVersion] },
        "SELECT count(*) AS n FROM employee_profiles WHERE employment_status <> 'TERMINATED'",
      ],
      "read",
    );
    const domains = new Map<string, { durationMs: number; intervals: number; category: WebsiteCategory; people: Set<string> }>();
    const people = new Map<string, { employee: EmployeeRef; durationMs: number; domains: Set<string> }>();
    const daily = new Map<string, WebsiteReport["rows"][number]>();
    let totalMs = 0;
    let unclassifiedMs = 0;
    for (const r of rows!.rows) {
      const date = localDate(String(r.started_at), String(r.timezone));
      if (date < from || date > to) continue;
      const domain = String(r.domain);
      const cat = categorize(domain, rules).category;
      if (category && cat !== category) continue;
      const ms = Number(r.duration_ms);
      const id = String(r.employee_id);
      const employee = { id, fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) };
      totalMs += ms;
      if (cat === "UNCLASSIFIED") unclassifiedMs += ms;
      const d = domains.get(domain) ?? { durationMs: 0, intervals: 0, category: cat, people: new Set<string>() };
      d.durationMs += ms;
      d.intervals++;
      d.people.add(id);
      domains.set(domain, d);
      const who = people.get(id) ?? { employee, durationMs: 0, domains: new Set<string>() };
      who.durationMs += ms;
      who.domains.add(domain);
      people.set(id, who);
      const key = `${date}|${id}|${domain}`;
      const row = daily.get(key) ?? { date, employee, domain, durationMs: 0, category: cat };
      row.durationMs += ms;
      daily.set(key, row);
    }
    return {
      from,
      to,
      totalMs,
      unclassifiedMs,
      employeesWithActivity: people.size,
      byDomain: [...domains].map(([domain, v]) => ({ domain, durationMs: v.durationMs, intervals: v.intervals, category: v.category, employees: v.people.size })).sort((a, b) => b.durationMs - a.durationMs || a.domain.localeCompare(b.domain)),
      byEmployee: [...people.values()].map((p) => ({ employee: p.employee, durationMs: p.durationMs, domains: p.domains.size })).sort((a, b) => a.employee.fullName.localeCompare(b.employee.fullName)),
      rows: [...daily.values()].sort((a, b) => b.date.localeCompare(a.date) || a.employee.fullName.localeCompare(b.employee.fullName) || b.durationMs - a.durationMs),
      acknowledged: { count: Number(ack!.rows[0]!.n), of: Number(all!.rows[0]!.n) },
    };
  }

  /** Who has acknowledged the website notice in force, and how many browsers each has connected. */
  async notifications(): Promise<WebsiteNotificationStatus> {
    const policy = await this.policy();
    const { rows } = await this.db.execute({
      sql: `SELECT p.id, p.full_name, p.employee_code, p.timezone, c.acknowledged_at,
              (SELECT count(*) FROM website_extension_links l WHERE l.employee_id = p.id AND l.claimed_at IS NOT NULL AND l.revoked_at IS NULL) AS browsers
            FROM employee_profiles p LEFT JOIN monitoring_consents c ON c.employee_id = p.id AND c.notice_version = ?
            WHERE p.employment_status <> 'TERMINATED' ORDER BY p.full_name`,
      args: [policy.noticeVersion],
    });
    return {
      policySeq: policy.seq,
      noticeVersion: policy.noticeVersion,
      employees: rows.map((r) => ({ employee: { id: String(r.id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) }, acknowledgedAt: str(r.acknowledged_at), connectedBrowsers: Number(r.browsers) })),
    };
  }

  // ---- Category rules ----------------------------------------------------------------------------------

  async rules(): Promise<WebsiteCategoryRule[]> {
    const { rows } = await this.db.execute("SELECT id, domain, match, category FROM website_category_rules WHERE removed_at IS NULL ORDER BY domain, match");
    return rows.map((r) => ({ id: String(r.id), domain: String(r.domain), match: r.match as WebsiteCategoryRule["match"], category: r.category as WebsiteCategoryRule["category"] }));
  }

  async addRule(admin: AuthContext, input: Omit<WebsiteCategoryRule, "id">) {
    const id = randomUUID();
    try {
      await this.db.batch(
        [
          { sql: "INSERT INTO website_category_rules (id, domain, match, category, created_by) VALUES (?, ?, ?, ?, ?)", args: [id, input.domain, input.match, input.category, admin.id] },
          this.audit(admin.id, "RULE_ADDED", { ruleId: id, ...input }),
        ],
        "write",
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A rule for this domain and match already exists");
      throw err;
    }
    return this.rules();
  }

  async updateRule(admin: AuthContext, id: string, category: WebsiteCategoryRule["category"]) {
    const [res] = await this.db.batch(
      [
        { sql: "UPDATE website_category_rules SET category = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL", args: [category, iso(Date.now()), id] },
        { sql: "INSERT INTO website_audit (id, actor_id, action, details) SELECT ?, ?, 'RULE_CHANGED', ? WHERE changes() > 0", args: [randomUUID(), admin.id, JSON.stringify({ ruleId: id, category })] },
      ],
      "write",
    );
    if (!res!.rowsAffected) throw new NotFoundException("Rule not found");
    return this.rules();
  }

  async removeRule(admin: AuthContext, id: string) {
    const [res] = await this.db.batch(
      [
        { sql: "UPDATE website_category_rules SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL", args: [iso(Date.now()), admin.id, id] },
        { sql: "INSERT INTO website_audit (id, actor_id, action, details) SELECT ?, ?, 'RULE_REMOVED', ? WHERE changes() > 0", args: [randomUUID(), admin.id, JSON.stringify({ ruleId: id })] },
      ],
      "write",
    );
    if (!res!.rowsAffected) throw new NotFoundException("Rule not found");
    return this.rules();
  }

  async auditLog(): Promise<WebsiteAuditEntry[]> {
    const { rows } = await this.db.execute(
      "SELECT a.action, a.details, a.created_at, u.email FROM website_audit a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 200",
    );
    return rows.map((r) => ({ action: String(r.action), details: JSON.parse(String(r.details)), at: String(r.created_at), by: str(r.email) }));
  }

  /** Deletes intervals older than the policy's retention period; every run is audited. */
  async retention(admin: AuthContext | null, now = Date.now()) {
    const { retentionDays } = await this.policy();
    const cutoff = iso(now - retentionDays * 86_400_000);
    const [res] = await this.db.batch(
      [
        { sql: "DELETE FROM website_intervals WHERE started_at < ?", args: [cutoff] },
        { sql: "INSERT INTO website_audit (id, actor_id, action, details) VALUES (?, ?, 'RETENTION_RUN', json_object('cutoff', ?, 'retentionDays', ?, 'deleted', changes()))", args: [randomUUID(), admin?.id ?? null, cutoff, retentionDays] },
      ],
      "write",
    );
    this.logger.log({ deleted: res!.rowsAffected, retentionDays }, "Website retention ran");
    return { cutoff, retentionDays, deleted: res!.rowsAffected };
  }

  /** Whether the policy version in force at that instant had tracking on. */
  private async enabledAt(at: string) {
    const r = (await this.db.execute({ sql: "SELECT enabled FROM website_policies WHERE effective_at <= ? ORDER BY seq DESC LIMIT 1", args: [at] })).rows[0];
    return !!r && Number(r.enabled) === 1;
  }

  private audit(actorId: string, action: string, details: object) {
    return { sql: "INSERT INTO website_audit (id, actor_id, action, details) VALUES (?, ?, ?, ?)", args: [randomUUID(), actorId, action, JSON.stringify(details)] };
  }

  private async employeeRef(id: string): Promise<EmployeeRef> {
    const r: Row = (await this.db.execute({ sql: "SELECT id, full_name, employee_code, timezone FROM employee_profiles WHERE id = ?", args: [id] })).rows[0]!;
    return { id: String(r.id), fullName: String(r.full_name), employeeCode: String(r.employee_code), timezone: String(r.timezone) };
  }
}

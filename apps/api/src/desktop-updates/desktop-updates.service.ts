import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DatabaseClient, InStatement } from "@workfolio/database";
import {
  can,
  compareVersions,
  isVersion,
  UPDATE_TARGETS,
  type CreateReleaseInput,
  type DesktopRelease,
  type DeviceUpdateStatus,
  type ReleaseStatus,
  type ReportUpdateStatusInput,
  type UpdateManifest,
  type UpdateReleaseInput,
  type UpdateTarget,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { sha256 } from "../auth/crypto.js";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { blake2b, parsePublicKey, verifySignature } from "./minisign.js";

const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Deterministic 0-99 bucket per installation and release: the same device stays in or out of a rollout. */
export const rolloutBucket = (releaseId: string, installationId: string) =>
  createHash("sha256").update(`${releaseId}:${installationId}`).digest().readUInt32BE(0) % 100;

export interface ReleaseEvent {
  action: string;
  actor: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  at: string;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));

/**
 * Desktop releases and the Tauri updater manifest (docs/desktop/AUTO-UPDATE-ARCHITECTURE.md).
 * - Only PUBLISHED releases reach employees; TESTING reaches devices registered to administrators.
 * - Before a release reaches anyone (TESTING or PUBLISHED) the API downloads every package and checks its
 *   minisign signature against DESKTOP_UPDATER_PUBKEY and the version it is bound to. The desktop checks
 *   the same again before installing; the private key is never on this server.
 * - Admin (IT) drafts, tests and disables; publishing, and changing what a published release does, is
 *   Super Admin only (updates:publish).
 */
@Injectable()
export class DesktopUpdatesService {
  private readonly logger = new Logger(DesktopUpdatesService.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ---- Releases (admin) -----------------------------------------------------------

  async list(): Promise<DesktopRelease[]> {
    const releases = (await this.db.execute("SELECT r.*, c.email AS created_email, p.email AS published_email FROM desktop_releases r LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users p ON p.id = r.published_by ORDER BY r.created_at DESC")).rows;
    const artifacts = (await this.db.execute("SELECT * FROM desktop_release_artifacts ORDER BY target")).rows;
    return releases.map((r) => this.toRelease(r, artifacts.filter((a) => a.release_id === r.id)));
  }

  async get(id: string): Promise<DesktopRelease> {
    const r = (await this.list()).find((x) => x.id === id);
    if (!r) throw new NotFoundException("Release not found");
    return r;
  }

  async history(id: string): Promise<ReleaseEvent[]> {
    await this.get(id);
    const { rows } = await this.db.execute({
      sql: "SELECT e.action, u.email, e.reason, e.metadata, e.created_at FROM desktop_release_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.release_id = ? ORDER BY e.created_at DESC, e.rowid DESC",
      args: [id],
    });
    return rows.map((e) => ({ action: String(e.action), actor: str(e.email), reason: str(e.reason), metadata: JSON.parse(String(e.metadata)) as Record<string, unknown>, at: String(e.created_at) }));
  }

  async create(actor: AuthContext, input: CreateReleaseInput): Promise<DesktopRelease> {
    this.checkMinimum(input.version, input.minimumVersion);
    this.checkArtifacts(input.artifacts);
    const id = randomUUID();
    try {
      await this.db.batch(
        [
          {
            sql: "INSERT INTO desktop_releases (id, version, notes, policy, postpone_hours, rollout_percent, minimum_version, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            args: [id, input.version, input.notes, input.policy, input.postponeHours, input.rolloutPercent, input.minimumVersion, actor.id],
          },
          ...this.artifactStatements(id, input.artifacts),
          this.event(id, actor, "RELEASE_CREATED", null, { version: input.version, targets: input.artifacts.map((a) => a.target).join(",") }),
        ],
        "write",
      );
    } catch (err) {
      if (/UNIQUE/.test(String(err))) throw new ConflictException(`A release ${input.version} already exists`);
      throw err;
    }
    return this.get(id);
  }

  async update(actor: AuthContext, id: string, input: UpdateReleaseInput): Promise<DesktopRelease> {
    const r = await this.get(id);
    const published = r.status === "PUBLISHED";
    const changesBehaviour = ["policy", "postponeHours", "rolloutPercent", "minimumVersion"].some((k) => k in input && input[k as keyof UpdateReleaseInput] !== undefined);
    if (published && changesBehaviour) this.requirePublisher(actor, "Only a Super Admin can change a published release's policy, rollout or minimum version");
    if (published && input.artifacts) throw new ConflictException("A published release's packages cannot change. Disable it and create a new version.");
    if (input.minimumVersion !== undefined) this.checkMinimum(r.version, input.minimumVersion);
    if (input.artifacts) this.checkArtifacts(input.artifacts);
    const set: [string, unknown][] = [
      ["notes", input.notes],
      ["policy", input.policy],
      ["postpone_hours", input.postponeHours],
      ["rollout_percent", input.rolloutPercent],
      ["minimum_version", input.minimumVersion],
    ].filter(([, v]) => v !== undefined) as [string, unknown][];
    const statements: InStatement[] = [];
    if (set.length) {
      statements.push({
        sql: `UPDATE desktop_releases SET ${set.map(([c]) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        args: [...set.map(([, v]) => v as string | number | null), new Date().toISOString(), id],
      });
    }
    if (input.artifacts) {
      // Replaced packages are unverified again: they are not served until the next TESTING/PUBLISHED check.
      statements.push({ sql: "DELETE FROM desktop_release_artifacts WHERE release_id = ?", args: [id] }, ...this.artifactStatements(id, input.artifacts));
    }
    if (!statements.length) return r;
    const meta: Record<string, unknown> = Object.fromEntries(set.filter(([c]) => c !== "notes"));
    if (input.notes !== undefined) meta.notes = "changed";
    if (input.artifacts) meta.targets = input.artifacts.map((a) => a.target).join(",");
    statements.push(this.event(id, actor, "RELEASE_EDITED", null, meta));
    await this.db.batch(statements, "write");
    return this.get(id);
  }

  async setStatus(actor: AuthContext, id: string, to: ReleaseStatus, reason?: string): Promise<DesktopRelease> {
    const r = await this.get(id);
    if (r.status === "PUBLISHED" || to === "PUBLISHED") {
      // Disabling stays open to Admin (IT): stopping a bad release must not wait for one person.
      if (to !== "DISABLED") this.requirePublisher(actor, "Only a Super Admin can publish or unpublish a release");
    }
    if (to === "TESTING" || to === "PUBLISHED") {
      if (!r.artifacts.length) throw new BadRequestException("Add at least one signed package before testing or publishing");
      if (to === "PUBLISHED") await this.checkNewest(r);
      await this.verifyArtifacts(actor, r);
    }
    const now = new Date().toISOString();
    await this.db.batch(
      [
        {
          sql: `UPDATE desktop_releases SET status = ?, updated_at = ?${to === "PUBLISHED" ? ", published_at = ?, published_by = ?" : ""} WHERE id = ?`,
          args: to === "PUBLISHED" ? [to, now, now, actor.id, id] : [to, now, id],
        },
        this.event(id, actor, `RELEASE_${to}`, reason ?? null, { from: r.status, to, version: r.version, rolloutPercent: r.rolloutPercent, policy: r.policy }),
      ],
      "write",
    );
    this.logger.log({ releaseId: id, version: r.version, from: r.status, to, actorId: actor.id }, "Desktop release status changed");
    return this.get(id);
  }

  // ---- Updater manifest (public) -------------------------------------------------------

  /**
   * What this installation should install, or null (204). The highest eligible release above the current
   * version wins; a rollout below 100% admits a stable share of installations. An installation below the
   * minimum supported version (a MANDATORY release, or a release's minimumVersion) bypasses the rollout.
   */
  async manifest(os: string, arch: string, current: string, installationId: string | undefined): Promise<UpdateManifest | null> {
    const target = `${os}-${arch}`;
    if (!(UPDATE_TARGETS as readonly string[]).includes(target) || !isVersion(current)) return null;
    const tester = installationId ? await this.isTesterDevice(installationId) : false;
    const { rows } = await this.db.execute({
      sql: `SELECT r.id, r.version, r.notes, r.policy, r.postpone_hours, r.rollout_percent, r.minimum_version, r.published_at, r.updated_at,
                   a.url, a.signature, a.size_bytes
            FROM desktop_releases r JOIN desktop_release_artifacts a ON a.release_id = r.id AND a.target = ?
            WHERE a.verified_at IS NOT NULL AND (r.status = 'PUBLISHED' OR (r.status = 'TESTING' AND ?))`,
      args: [target, tester ? 1 : 0],
    });
    let minimum: string | null = null;
    for (const r of rows) {
      for (const v of [str(r.minimum_version), r.policy === "MANDATORY" ? String(r.version) : null]) {
        if (v && (!minimum || compareVersions(v, minimum) > 0)) minimum = v;
      }
    }
    const below = !!minimum && compareVersions(current, minimum) < 0;
    const pick = rows
      .filter((r) => compareVersions(String(r.version), current) > 0)
      .sort((a, b) => compareVersions(String(b.version), String(a.version)))
      .find((r) => below || Number(r.rollout_percent) >= 100 || (!!installationId && rolloutBucket(String(r.id), installationId) < Number(r.rollout_percent)));
    if (!pick) return null;
    return {
      version: String(pick.version),
      notes: String(pick.notes),
      pub_date: String(pick.published_at ?? pick.updated_at),
      url: String(pick.url),
      signature: String(pick.signature),
      policy: pick.policy as UpdateManifest["policy"],
      mandatory: below,
      minimumVersion: minimum,
      postponeHours: Number(pick.postpone_hours),
      sizeBytes: pick.size_bytes == null ? null : Number(pick.size_bytes),
      releaseId: String(pick.id),
    };
  }

  /** TESTING releases go to devices registered to administrators (IT staff test on their own machines). */
  private async isTesterDevice(installationId: string) {
    const { rows } = await this.db.execute({
      sql: `SELECT 1 FROM devices d JOIN employee_profiles p ON p.id = d.employee_id JOIN users u ON u.id = p.user_id
            WHERE d.device_identifier = ? AND d.revoked_at IS NULL AND u.role = 'ADMIN' AND u.status = 'ACTIVE' LIMIT 1`,
      args: [sha256(installationId)],
    });
    return rows.length > 0;
  }

  // ---- Device update status ----------------------------------------------------------------

  /** The desktop reports its own state; the device is resolved from the session's account + installation. */
  async report(caller: AuthContext, installationId: string | undefined, input: ReportUpdateStatusInput): Promise<void> {
    if (caller.client !== "DESKTOP") throw new ForbiddenException("This action is only available from the desktop app");
    const row = installationId
      ? (await this.db.execute({
          sql: `SELECT d.id, s.installed_version FROM devices d JOIN employee_profiles p ON p.id = d.employee_id
                LEFT JOIN desktop_update_status s ON s.device_id = d.id
                WHERE p.user_id = ? AND d.device_identifier = ? AND d.revoked_at IS NULL`,
          args: [caller.id, sha256(installationId)],
        })).rows[0]
      : undefined;
    if (!row) throw new ForbiddenException("This device is not registered or has been revoked");
    const before = str(row.installed_version);
    const upgraded = before !== null && isVersion(before) && compareVersions(input.installedVersion, before) > 0;
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `INSERT INTO desktop_update_status (device_id, installed_version, available_version, state, failure_reason, last_check_at, last_updated_at, last_updated_from)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(device_id) DO UPDATE SET installed_version = ?2, available_version = ?3, state = ?4, failure_reason = ?5, last_check_at = ?6,
              last_updated_at = coalesce(?7, last_updated_at), last_updated_from = coalesce(?8, last_updated_from)`,
      args: [String(row.id), input.installedVersion, input.availableVersion, input.state, input.state === "FAILED" ? input.failureReason : null, now, upgraded ? now : null, upgraded ? before : null],
    });
  }

  /** Every registered (not revoked) device with what it last reported; never-reported devices included. */
  async deviceStatuses(): Promise<(Omit<DeviceUpdateStatus, "installedVersion" | "state" | "lastCheckAt"> & { installedVersion: string | null; state: DeviceUpdateStatus["state"] | null; lastCheckAt: string | null })[]> {
    const { rows } = await this.db.execute(
      `SELECT d.id, d.device_name, d.platform, p.id AS employee_id, p.full_name, p.employee_code, s.*
       FROM devices d JOIN employee_profiles p ON p.id = d.employee_id LEFT JOIN desktop_update_status s ON s.device_id = d.id
       WHERE d.revoked_at IS NULL ORDER BY p.full_name, d.device_name`,
    );
    return rows.map((r) => ({
      deviceId: String(r.id),
      deviceName: String(r.device_name),
      platform: String(r.platform),
      employeeId: String(r.employee_id),
      employeeName: String(r.full_name),
      employeeCode: String(r.employee_code),
      installedVersion: str(r.installed_version),
      availableVersion: str(r.available_version),
      state: (str(r.state) as DeviceUpdateStatus["state"] | null) ?? null,
      failureReason: str(r.failure_reason),
      lastCheckAt: str(r.last_check_at),
      lastUpdatedAt: str(r.last_updated_at),
      lastUpdatedFrom: str(r.last_updated_from),
    }));
  }

  // ---- Helpers ---------------------------------------------------------------------------

  private requirePublisher(actor: AuthContext, message: string) {
    if (!can(actor, "updates:publish")) throw new ForbiddenException(message);
  }

  private checkMinimum(version: string, minimum: string | null | undefined) {
    if (minimum && compareVersions(minimum, version) > 0) throw new BadRequestException("The minimum supported version cannot be above the release version");
  }

  private checkArtifacts(artifacts: { target: UpdateTarget; url: string }[]) {
    if (new Set(artifacts.map((a) => a.target)).size !== artifacts.length) throw new BadRequestException("One package per platform");
    for (const a of artifacts) this.checkUrl(a.url);
  }

  /** https only; plain http to this machine outside production (local QA). No IP-literal or localhost hosts in production. */
  private checkUrl(raw: string) {
    const production = this.config.get("NODE_ENV", { infer: true }) === "production";
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new BadRequestException(`Not a URL: ${raw}`);
    }
    if (u.username || u.password) throw new BadRequestException("Package URLs must not contain credentials");
    const loopback = LOOPBACK.has(u.hostname);
    if (u.protocol === "http:" && loopback && !production) return;
    if (u.protocol !== "https:") throw new BadRequestException("Package URLs must use https://");
    // ponytail: literal-host check only; a DNS name resolving to a private address is not caught. Admin-only input.
    if (production && (loopback || /^[\d.]+$/.test(u.hostname) || u.hostname.startsWith("["))) throw new BadRequestException("Package URLs must use a public host name");
  }

  private async checkNewest(r: DesktopRelease) {
    const { rows } = await this.db.execute({ sql: "SELECT version FROM desktop_releases WHERE status = 'PUBLISHED' AND id <> ?", args: [r.id] });
    const newer = rows.map((x) => String(x.version)).find((v) => compareVersions(v, r.version) >= 0);
    if (newer) throw new ConflictException(`Version ${newer} is already published; publish a higher version (installed apps never downgrade)`);
  }

  /** Downloads each package, checks the signature and its bound version, and records size + SHA-256. */
  private async verifyArtifacts(actor: AuthContext, r: DesktopRelease) {
    const raw = this.config.get("DESKTOP_UPDATER_PUBKEY", { infer: true });
    if (!raw) throw new ConflictException("DESKTOP_UPDATER_PUBKEY is not configured on this server, so packages cannot be verified");
    const pub = parsePublicKey(raw);
    const results: InStatement[] = [];
    for (const a of r.artifacts) {
      this.checkUrl(a.url);
      let digest: { blake2b: Buffer; sha256: string; size: number };
      try {
        digest = await this.download(a.url);
      } catch (err) {
        throw new BadRequestException(`${a.target}: download failed (${(err as Error).message})`);
      }
      let signed: string | null;
      try {
        signed = verifySignature(pub, a.signature, digest);
      } catch (err) {
        throw new BadRequestException(`${a.target}: ${(err as Error).message}`);
      }
      if (signed !== r.version) {
        throw new BadRequestException(`${a.target}: the package is signed for version ${signed ?? "(none)"}, not ${r.version}. Rebuild with the release version.`);
      }
      results.push({
        sql: "UPDATE desktop_release_artifacts SET size_bytes = ?, sha256 = ?, verified_at = ? WHERE release_id = ? AND target = ?",
        args: [digest.size, digest.sha256, new Date().toISOString(), r.id, a.target],
      });
    }
    results.push(this.event(r.id, actor, "RELEASE_VERIFIED", null, { keyId: pub.keyId, targets: r.artifacts.map((a) => a.target).join(",") }));
    await this.db.batch(results, "write");
  }

  private async download(url: string) {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    if (!res.url.startsWith("https:") && !(this.config.get("NODE_ENV", { infer: true }) !== "production" && new URL(res.url).protocol === "http:" && LOOPBACK.has(new URL(res.url).hostname))) {
      throw new Error("redirected to a non-https URL");
    }
    const b2 = blake2b();
    const s2 = createHash("sha256");
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) throw new Error("larger than 500 MB");
      b2.update(chunk);
      s2.update(chunk);
    }
    return { blake2b: b2.digest(), sha256: s2.digest("hex"), size };
  }

  private artifactStatements(id: string, artifacts: CreateReleaseInput["artifacts"]): InStatement[] {
    return artifacts.map((a) => ({ sql: "INSERT INTO desktop_release_artifacts (release_id, target, url, signature) VALUES (?, ?, ?, ?)", args: [id, a.target, a.url, a.signature] }));
  }

  private event(releaseId: string, actor: AuthContext, action: string, reason: string | null, metadata: Record<string, unknown>): InStatement {
    return { sql: "INSERT INTO desktop_release_events (id, release_id, actor_id, action, reason, metadata) VALUES (?, ?, ?, ?, ?, ?)", args: [randomUUID(), releaseId, actor.id, action, reason, JSON.stringify(metadata)] };
  }

  private toRelease(r: Row, artifacts: Row[]): DesktopRelease {
    return {
      id: String(r.id),
      version: String(r.version),
      notes: String(r.notes),
      status: r.status as ReleaseStatus,
      policy: r.policy as DesktopRelease["policy"],
      postponeHours: Number(r.postpone_hours),
      rolloutPercent: Number(r.rollout_percent),
      minimumVersion: str(r.minimum_version),
      artifacts: artifacts.map((a) => ({
        target: a.target as UpdateTarget,
        url: String(a.url),
        signature: String(a.signature),
        sizeBytes: a.size_bytes == null ? null : Number(a.size_bytes),
        sha256: str(a.sha256),
        verifiedAt: str(a.verified_at),
      })),
      createdAt: String(r.created_at),
      createdBy: str(r.created_email),
      publishedAt: str(r.published_at),
      publishedBy: str(r.published_email),
      updatedAt: String(r.updated_at),
    };
  }
}

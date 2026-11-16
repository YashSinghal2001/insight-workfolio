import { randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DatabaseClient } from "@workfolio/database";
import {
  platformRoleOf,
  type AuthUser,
  type DesktopTokens,
  type Role,
  type SessionClient,
  type SessionInfo,
} from "@workfolio/shared";
import { accountAudit } from "../audit/account-audit.js";
import { str } from "../attendance/sessions.js";
import { jwtVerify, SignJWT } from "jose";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { claimDeviceSession, deviceRevoked, rejectedAudit } from "./device-session.js";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  randomToken,
  RateLimiter,
  safeEqual,
  sha256,
  verifyPassword,
} from "./crypto.js";

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ISSUER = "insight-workfolio";
const AUDIENCE = "insight-workfolio-api";
const INVALID_LOGIN = "Invalid email or password";

/** The authenticated caller, attached to the request by AuthGuard. Role always comes from the DB. */
export interface AuthContext extends AuthUser {
  sessionId: string;
  /** Which client signed in (from the session row, set at login). Device registration and device-bound writes need DESKTOP. */
  client: SessionClient | null;
  /** The device this session is the active sign-in of (sessions.device_id), or null when unbound. */
  deviceId: string | null;
  /** Heads at least one active team (W41): team-scoped reads of those teams' members (common/scope.ts). */
  teamHead?: boolean;
}

export interface IssuedSession extends DesktopTokens {
  user: AuthUser;
}

const SESSIONS_LIST_LIMIT = 100;

const tooMany = () => new HttpException("Too many attempts. Try again later.", HttpStatus.TOO_MANY_REQUESTS);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly key: Uint8Array;
  // Per-email limit stops targeted guessing; the per-IP limit is looser for office NAT.
  readonly loginByEmail = new RateLimiter(10, 15 * 60_000);
  readonly loginByIp = new RateLimiter(100, 15 * 60_000);
  readonly setupByIp = new RateLimiter(20, 15 * 60_000);
  // Clients refresh about once per access-token lifetime (15 min); these only stop floods. The IP limit
  // covers made-up session ids; it is looser for office NAT.
  readonly refreshBySession = new RateLimiter(30, 15 * 60_000);
  readonly refreshByIp = new RateLimiter(600, 15 * 60_000);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    config: ConfigService<Env, true>,
  ) {
    const secret = config.get("JWT_SECRET", { infer: true });
    if (!secret) this.logger.warn("JWT_SECRET not set: using an ephemeral key (access tokens reset on restart)");
    this.key = secret ? new TextEncoder().encode(secret) : randomBytes(32);
  }

  async login(email: string, password: string, ip: string, client: SessionClient, device: { installationId?: string; takeover?: boolean } = {}): Promise<IssuedSession> {
    // A blocked IP is refused before its attempt counts against the email, so it can't lock others out.
    if (!this.loginByIp.hit(ip) || !this.loginByEmail.hit(email)) throw tooMany();

    const user = (
      await this.db.execute({
        sql: "SELECT id, email, role, admin_title, status, password_hash FROM users WHERE email = ?",
        args: [email],
      })
    ).rows[0];
    const hash = user?.password_hash ? String(user.password_hash) : await DUMMY_PASSWORD_HASH;
    const valid = await verifyPassword(password, hash);
    // One generic error for unknown email, wrong password, no password yet, or disabled account.
    if (!user || !user.password_hash || !valid || user.status !== "ACTIVE") {
      throw new UnauthorizedException(INVALID_LOGIN);
    }
    this.loginByEmail.reset(email);
    const authUser: AuthUser = { id: String(user.id), email: String(user.email), role: user.role as Role, platformRole: platformRoleOf(user.role as Role, str(user.admin_title)) };
    const deviceId = client === "DESKTOP" && device.installationId ? await this.loginDevice(authUser.id, device.installationId) : null;
    return this.createSession(authUser, client, deviceId, device.takeover === true);
  }

  /**
   * The registered, authorized device a desktop sign-in claims, or null (not registered yet, or a revoked
   * device whose re-registration an admin approved: the app registers it next, which claims then).
   * Called only after the password was verified.
   */
  private async loginDevice(userId: string, installationId: string): Promise<string | null> {
    const row = (
      await this.db.execute({
        sql: `SELECT d.id, d.revoked_at, d.reregistration_approved_at FROM devices d JOIN employee_profiles p ON p.id = d.employee_id
              WHERE p.user_id = ? AND d.device_identifier = ?`,
        args: [userId, sha256(installationId)],
      })
    ).rows[0];
    if (!row) return null;
    if (row.revoked_at === null) return String(row.id);
    if (row.reregistration_approved_at !== null) return null;
    await this.db.batch([rejectedAudit(userId, String(row.id), "DEVICE_REVOKED")], "write");
    throw deviceRevoked();
  }

  /** Rotates the refresh token. Presenting a superseded token revokes the session (theft signal). */
  async refresh(refreshToken: string, ip: string): Promise<IssuedSession> {
    const sessionId = refreshToken.split(".")[0] ?? "";
    // IP first, so a blocked IP can't use up a session's budget.
    if (!this.refreshByIp.hit(ip) || !this.refreshBySession.hit(sessionId)) throw tooMany();
    const now = new Date().toISOString();
    const row = (
      await this.db.execute({
        sql: `SELECT s.refresh_token_hash, s.expires_at, s.revoked_at, u.id, u.email, u.role, u.admin_title, u.status
              FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
        args: [sessionId],
      })
    ).rows[0];
    if (!row) throw new UnauthorizedException();

    const presented = sha256(refreshToken);
    if (!safeEqual(String(row.refresh_token_hash), presented)) {
      if (!row.revoked_at) {
        await this.db.batch(
          [
            { sql: "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", args: [now, sessionId] },
            accountAudit({ actorUserId: null, targetUserId: String(row.id), action: "SESSION_REUSE_DETECTED", resourceType: "SESSION", resourceId: sessionId }, "changes() > 0"),
          ],
          "write",
        );
        this.logger.warn({ sessionId }, "Refresh token reuse detected; session revoked");
      }
      throw new UnauthorizedException();
    }
    if (row.revoked_at || String(row.expires_at) <= now || row.status !== "ACTIVE") {
      throw new UnauthorizedException();
    }

    const next = `${sessionId}.${randomToken()}`;
    // Compare-and-swap: of two concurrent refreshes with the same token, exactly one wins.
    const swapped = await this.db.execute({
      sql: `UPDATE sessions SET refresh_token_hash = ?, refreshed_at = ?
            WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      args: [sha256(next), now, sessionId, presented, now],
    });
    if (swapped.rowsAffected !== 1) throw new UnauthorizedException();

    const user: AuthUser = { id: String(row.id), email: String(row.email), role: row.role as Role, platformRole: platformRoleOf(row.role as Role, str(row.admin_title)) };
    return { user, refreshToken: next, ...(await this.accessToken(user.id, sessionId)) };
  }

  /**
   * Revokes the session the refresh token belongs to. Unknown tokens are ignored (idempotent). Ending a
   * device sign-in frees the account's active slot: the device stays registered (INACTIVE).
   */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const sessionId = refreshToken.split(".")[0] ?? "";
    const session = (await this.db.execute({ sql: "SELECT user_id, device_id FROM sessions WHERE id = ?", args: [sessionId] })).rows[0];
    await this.db.batch(
      [
        { sql: "UPDATE sessions SET revoked_at = ? WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL", args: [new Date().toISOString(), sessionId, sha256(refreshToken)] },
        ...(session?.device_id
          ? [accountAudit({ actorUserId: String(session.user_id), targetUserId: String(session.user_id), action: "DEVICE_SESSION_ENDED", resourceType: "DEVICE", resourceId: String(session.device_id), metadata: { cause: "SIGNED_OUT" } }, "changes() > 0")]
          : []),
      ],
      "write",
    );
  }

  /** Verifies the access token AND that its session is live and the user still active. */
  async authenticate(accessToken: string): Promise<AuthContext> {
    let userId: string, sessionId: string;
    try {
      const { payload } = await jwtVerify(accessToken, this.key, {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (typeof payload.sub !== "string" || typeof payload.sid !== "string") throw new Error("claims");
      [userId, sessionId] = [payload.sub, payload.sid];
    } catch {
      throw new UnauthorizedException();
    }
    const row = (
      await this.db.execute({
        sql: `SELECT u.id, u.email, u.role, u.admin_title, s.client, s.device_id,
                EXISTS (SELECT 1 FROM teams t WHERE t.head_user_id = u.id AND t.active = 1) AS team_head
              FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.id = ? AND u.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'ACTIVE'`,
        args: [sessionId, userId, new Date().toISOString()],
      })
    ).rows[0];
    if (!row) throw new UnauthorizedException();
    return { id: String(row.id), email: String(row.email), role: row.role as Role, platformRole: platformRoleOf(row.role as Role, str(row.admin_title)), sessionId, client: str(row.client) as SessionClient | null, deviceId: str(row.device_id), teamHead: Boolean(row.team_head) };
  }

  /** Consumes a one-time setup token, sets the password and signs out any existing sessions. */
  async setupPassword(token: string, password: string, ip: string): Promise<void> {
    if (!this.setupByIp.hit(ip)) throw tooMany();
    const hash = await hashPassword(password);
    const now = new Date().toISOString();
    const owner = "(SELECT user_id FROM account_setup_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?)";
    const ownerArgs = [sha256(token), now];
    // Who the link belongs to (for the audit row). The batch below re-checks the link itself.
    const link = (
      await this.db.execute({ sql: "SELECT id, user_id FROM account_setup_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", args: ownerArgs })
    ).rows[0];
    if (!link) throw new BadRequestException("This setup link is invalid or has expired");
    const userId = String(link.user_id);
    // One transaction; the token is consumed last because consuming it empties the subquery.
    const [setPassword] = await this.db.batch(
      [
        { sql: `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ${owner}`, args: [hash, now, ...ownerArgs] },
        { sql: `UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND user_id = ${owner}`, args: [now, ...ownerArgs] },
        // Directly after the session revocation (changes() = sessions revoked), while the link is still unused.
        accountAudit({ actorUserId: userId, targetUserId: userId, action: "PASSWORD_SET", resourceType: "SETUP_LINK", resourceId: String(link.id) }, `${owner} = ?`, { whenArgs: [...ownerArgs, userId], changesAs: "sessionsRevoked" }),
        { sql: `UPDATE account_setup_tokens SET used_at = ? WHERE used_at IS NULL AND user_id = ${owner}`, args: [now, ...ownerArgs] },
      ],
      "write",
    );
    if (setPassword?.rowsAffected !== 1) throw new BadRequestException("This setup link is invalid or has expired");
  }

  /** The caller's live sessions, newest first. Never selects token hashes. */
  async listSessions(caller: AuthContext): Promise<SessionInfo[]> {
    const { rows } = await this.db.execute({
      sql: `SELECT id, client, created_at, refreshed_at, expires_at FROM sessions
            WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC, id DESC LIMIT ${SESSIONS_LIST_LIMIT}`,
      args: [caller.id, new Date().toISOString()],
    });
    return rows.map((r) => ({
      id: String(r.id),
      client: str(r.client) as SessionClient | null,
      createdAt: String(r.created_at),
      refreshedAt: str(r.refreshed_at),
      expiresAt: String(r.expires_at),
      current: String(r.id) === caller.sessionId,
    }));
  }

  /** Revokes one of the caller's own live sessions; anything else (unknown, someone else's, already revoked) is 404. */
  async revokeOwnSession(caller: AuthContext, sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    const [revoked] = await this.db.batch(
      [
        { sql: "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?", args: [now, sessionId, caller.id, now] },
        accountAudit({ actorUserId: caller.id, targetUserId: caller.id, action: "SESSION_REVOKED", resourceType: "SESSION", resourceId: sessionId }, "changes() > 0"),
      ],
      "write",
    );
    if (revoked?.rowsAffected !== 1) throw new NotFoundException("Session not found");
  }

  /** Revokes the caller's live sessions: all of them, or all but the current one. Audited with the count. */
  async revokeOwnSessions(caller: AuthContext, includeCurrent: boolean): Promise<number> {
    const now = new Date().toISOString();
    const [revoked] = await this.db.batch(
      [
        {
          sql: `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?${includeCurrent ? "" : " AND id <> ?"}`,
          args: includeCurrent ? [now, caller.id, now] : [now, caller.id, now, caller.sessionId],
        },
        accountAudit({ actorUserId: caller.id, targetUserId: caller.id, action: includeCurrent ? "SESSIONS_REVOKED_ALL" : "SESSIONS_REVOKED_OTHERS", resourceType: "SESSION" }, "changes() > 0", { changesAs: "count" }),
      ],
      "write",
    );
    return revoked?.rowsAffected ?? 0;
  }

  /** With a device, the new session is inserted already bound, in the claim transaction (or not at all). */
  private async createSession(user: AuthUser, client: SessionClient, deviceId: string | null = null, takeover = false): Promise<IssuedSession> {
    const sessionId = randomUUID();
    const refreshToken = `${sessionId}.${randomToken()}`;
    const row = [sessionId, user.id, sha256(refreshToken), new Date(Date.now() + SESSION_TTL_MS).toISOString(), client];
    if (!deviceId) {
      await this.db.execute({ sql: "INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, client) VALUES (?, ?, ?, ?, ?)", args: row });
    } else {
      // Inserted only while the device is still authorized (a revoke committed meanwhile wins).
      const insert = {
        sql: `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, client, device_id)
              SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL)`,
        args: [...row, deviceId, deviceId],
      };
      if ((await claimDeviceSession(this.db, { userId: user.id, deviceId, sessionId, bind: insert, takeover })) !== 1) throw deviceRevoked();
    }
    return { user, refreshToken, ...(await this.accessToken(user.id, sessionId)) };
  }

  private async accessToken(userId: string, sessionId: string) {
    const accessToken = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_S}s`)
      .sign(this.key);
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL_S };
  }
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Controller, Get, Injectable, Logger, NotFoundException, Query, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { CurrentUser, Public, readCookie, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { type Env, GOOGLE_OAUTH_CALLBACK_PATH } from "../config/env.js";
import { StorageError } from "../screenshots/storage.js";
import { DRIVE_FILE_SCOPE, DriveClient, type GoogleDriveConfig, googleDriveConfigFrom, onlyDriveFile, readConnection, setUpFolders, tokenRequest, writeConnection } from "./google-drive-storage.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const STATE_TTL_MS = 10 * 60_000;
/** Pending connects kept at once; the oldest is dropped beyond this. */
const MAX_PENDING = 20;
/** Ties the callback to the browser that started the flow (HttpOnly, SameSite=Lax, path = the callback only). */
export const BINDING_COOKIE = "wf_gdrive_oauth";
const random = () => randomBytes(32).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest();

interface Pending {
  verifier: string;
  binding: Buffer;
  userId: string;
  expiresAt: number;
}

export type ConnectOutcome = "connected" | "denied" | "failed";

/**
 * OAuth 2.0 authorization-code flow with PKCE that connects the API to one Google account's Drive.
 * - begin: an admin's request. Makes a single-use state (10 minutes), a PKCE verifier and a browser
 *   binding secret, and the Google consent URL: scope drive.file only, offline access.
 * - complete: Google's redirect. Accepted only with a known, unexpired, unused state AND the binding cookie
 *   of the browser that started it (the dashboard's session cookie is SameSite=Strict and does not ride
 *   along on a redirect from Google). The code is exchanged server-side with the client secret; Google must
 *   grant exactly drive.file and the signed-in account must be GOOGLE_DRIVE_ACCOUNT_EMAIL, otherwise the
 *   new grant is revoked. The refresh token goes to GOOGLE_DRIVE_TOKEN_FILE only: never into a response,
 *   a URL or a log.
 */
@Injectable()
export class GoogleDriveOAuthService {
  readonly cfg: GoogleDriveConfig | null;
  private readonly redirectUri?: string;
  // ponytail: pending states live in this process; a multi-instance API needs a shared store (DB row with TTL).
  private readonly pending = new Map<string, Pending>();
  private readonly log = new Logger("GoogleDriveOAuth");
  /** Replaced in tests. */
  fetchFn: typeof fetch = (...a) => fetch(...a);

  constructor(config: ConfigService<Env, true>) {
    this.cfg = googleDriveConfigFrom(config);
    this.redirectUri = config.get("GOOGLE_OAUTH_REDIRECT_URI", { infer: true });
  }

  begin(userId: string): { url: string; binding: string } {
    if (!this.cfg || !this.redirectUri) throw new NotFoundException("Google Drive is not configured");
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const state = random();
    const verifier = random();
    const binding = random();
    this.pending.set(state, { verifier, binding: sha256(binding), userId, expiresAt: now + STATE_TTL_MS });
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: DRIVE_FILE_SCOPE,
      access_type: "offline",
      prompt: "consent", // a refresh token on every connect, also a reconnect
      state,
      code_challenge: sha256(verifier).toString("base64url"),
      code_challenge_method: "S256",
    });
    return { url: `${AUTHORIZE_URL}?${params}`, binding };
  }

  /** Validates and consumes the state: single use even when the rest of the check fails. */
  private take(state: unknown, binding: string | undefined): Pending | null {
    if (typeof state !== "string") return null;
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expiresAt <= Date.now() || !binding) return null;
    return timingSafeEqual(sha256(binding), p.binding) ? p : null;
  }

  /** Finishes the flow; the outcome only picks a fixed dashboard page. Never throws to the browser. */
  async complete(q: { state?: unknown; code?: unknown; error?: unknown }, binding: string | undefined): Promise<ConnectOutcome> {
    const p = this.take(q.state, binding);
    if (!this.cfg || !p) {
      this.log.warn("Google Drive callback rejected: unknown, expired or reused state, or a different browser");
      return "failed";
    }
    if (q.error !== undefined) {
      this.log.warn(`Google Drive connect not completed: Google returned ${q.error === "access_denied" ? "access_denied" : "an error"}`);
      return q.error === "access_denied" ? "denied" : "failed";
    }
    if (typeof q.code !== "string" || !q.code || q.code.length > 2048) return "failed";
    try {
      await this.connect(q.code, p.verifier);
      this.log.log(`Google Drive connected (started by user ${p.userId})`);
      return "connected";
    } catch (err) {
      this.log.warn(`Google Drive connect failed: ${err instanceof StorageError ? err.message : "unexpected error"}`);
      return "failed";
    }
  }

  private async connect(code: string, verifier: string): Promise<void> {
    const cfg = this.cfg!;
    const t = await tokenRequest(this.fetchFn, {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: this.redirectUri!,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (!t.refresh_token || !onlyDriveFile(t.scope)) {
      await this.revoke(t.refresh_token ?? t.access_token);
      throw new StorageError("Google did not grant exactly drive.file with offline access; authorization revoked");
    }
    const client = new DriveClient(async () => t.access_token, this.fetchFn);
    const account = await client.accountEmail();
    if (account !== cfg.account) {
      await this.revoke(t.refresh_token);
      throw new StorageError("the signed-in Google account is not GOOGLE_DRIVE_ACCOUNT_EMAIL; authorization revoked");
    }
    const previous = await readConnection(cfg.tokenFile).catch(() => null);
    const same = previous?.clientId === cfg.clientId && previous.account === account;
    const folders = await setUpFolders(client, same ? previous.folders : undefined);
    await writeConnection(cfg.tokenFile, { clientId: cfg.clientId, account, refreshToken: t.refresh_token, folders, connectedAt: new Date().toISOString() }).catch(() => {
      throw new StorageError("GOOGLE_DRIVE_TOKEN_FILE could not be written");
    });
  }

  /** Best effort: a grant the API will not keep is withdrawn at Google. */
  private async revoke(token: string): Promise<void> {
    await this.fetchFn(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(30_000),
    }).then((r) => r.body?.cancel(), () => {});
  }
}

/**
 * GET /api/v1/storage/google-drive/oauth/start: opened by an admin in the browser that is signed in to the
 * dashboard; redirects to Google's consent screen. GET .../callback: Google's redirect target (the exact
 * GOOGLE_OAUTH_REDIRECT_URI registered in Google Cloud); always lands on the dashboard's settings page.
 */
@Controller({ path: "storage/google-drive/oauth", version: "1" })
export class GoogleDriveOAuthController {
  private readonly secure: boolean;
  private readonly dashboard: string;

  constructor(
    private readonly oauth: GoogleDriveOAuthService,
    config: ConfigService<Env, true>,
  ) {
    this.secure = config.get("NODE_ENV", { infer: true }) === "production";
    this.dashboard = config.get("DASHBOARD_URL", { infer: true });
  }

  @Get("start")
  @RequirePermission("settings:manage")
  start(@CurrentUser() user: AuthContext, @Res() res: Response): void {
    const { url, binding } = this.oauth.begin(user.id);
    res.cookie(BINDING_COOKIE, binding, { httpOnly: true, sameSite: "lax", secure: this.secure, path: GOOGLE_OAUTH_CALLBACK_PATH, maxAge: STATE_TTL_MS });
    res.redirect(302, url);
  }

  @Get("callback")
  @Public()
  async callback(@Query() q: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const outcome = await this.oauth.complete(q, readCookie(req, BINDING_COOKIE));
    res.clearCookie(BINDING_COOKIE, { httpOnly: true, sameSite: "lax", secure: this.secure, path: GOOGLE_OAUTH_CALLBACK_PATH });
    res.redirect(302, new URL(`/settings?googleDrive=${outcome}`, this.dashboard).href);
  }
}

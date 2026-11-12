import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Controller, Get, HttpCode, Inject, Injectable, Logger, NotFoundException, Post, Query, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DatabaseClient } from "@workfolio/database";
import type { Request, Response } from "express";
import { decodeJwt } from "jose";
import { CurrentUser, Public, readCookie, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { type Env, ONEDRIVE_CALLBACK_PATH } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { type GraphAuth, StorageError, teamFolder } from "../screenshots/storage.js";

/**
 * Microsoft OneDrive (the dedicated IT storage account's own OneDrive) through Microsoft Graph, DELEGATED:
 * the account signs in once (authorization code + PKCE, confidential client) and grants only
 * Files.ReadWrite (its own files, nothing shared, no SharePoint sites) and offline_access. No application
 * permission, no tenant-wide access, no site or folder grant.
 * - Only ONEDRIVE_ACCOUNT_EMAIL in ONEDRIVE_TENANT_ID is accepted; any other sign-in is discarded.
 * - The refresh token lives only in ONEDRIVE_TOKEN_FILE on the API host, AES-256-GCM encrypted with
 *   ONEDRIVE_TOKEN_KEY (0600, never in a response, URL or log). Microsoft rotates it on every use; the
 *   new one is written back atomically, so the connection survives restarts.
 * - Files live under one app folder (ONEDRIVE_ROOT_FOLDER) in that OneDrive; nothing else is listed or read.
 * - The same connection file is used by the off-site backup uploader (cli/backup-upload.ts, a separate short-lived
 *   process). Both re-read the file before every refresh, so a token rotated by one is picked up by the other.
 */

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
export const ONEDRIVE_SCOPES = "offline_access openid profile Files.ReadWrite";
/** Scopes the token may report (Microsoft lists every scope consented for the app). Anything else, e.g. *.All or Sites.*, is refused. */
const ALLOWED_SCOPES = new Set(["files.readwrite", "openid", "profile", "email", "offline_access", "user.read"]);
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
const TIMEOUT_MS = 30_000;
export const ONEDRIVE_BINDING_COOKIE = "wf_onedrive_oauth";
const random = () => randomBytes(32).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest();
const timedOut = (err: unknown) => (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";

export interface OneDriveConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenFile: string;
  /** 32-byte key (base64) encrypting the token file. */
  tokenKey: Buffer;
  /** The one account allowed to connect (lowercase UPN). */
  account: string;
  rootFolder: string;
}

export function oneDriveConfigFrom(config: ConfigService<Env, true>): OneDriveConfig | null {
  const clientId = config.get("ONEDRIVE_CLIENT_ID", { infer: true });
  if (!clientId) return null;
  return {
    tenantId: config.get("ONEDRIVE_TENANT_ID", { infer: true })!,
    clientId,
    clientSecret: config.get("ONEDRIVE_CLIENT_SECRET", { infer: true })!,
    redirectUri: config.get("ONEDRIVE_REDIRECT_URI", { infer: true })!,
    tokenFile: config.get("ONEDRIVE_TOKEN_FILE", { infer: true })!,
    tokenKey: Buffer.from(config.get("ONEDRIVE_TOKEN_KEY", { infer: true })!, "base64"),
    account: config.get("ONEDRIVE_ACCOUNT_EMAIL", { infer: true })!,
    rootFolder: config.get("ONEDRIVE_ROOT_FOLDER", { infer: true }),
  };
}

// ---- Connection file -----------------------------------------------------------------------

export interface OneDriveConnection {
  tenantId: string;
  clientId: string;
  account: string;
  /** Entra object id of the account; the drive owner must match it. */
  userId: string;
  driveId: string;
  /** The app folder (ONEDRIVE_ROOT_FOLDER) every key lives under. */
  folderId: string;
  refreshToken: string;
  connectedAt: string;
}

/** Null when not connected. Unreadable, tampered or wrong-key files are errors (never silently replaced). */
export async function readOneDriveConnection(path: string, key: Buffer): Promise<OneDriveConnection | null> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StorageError("OneDrive connection file is unreadable");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const c = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as Partial<OneDriveConnection>;
    const fields = ["tenantId", "clientId", "account", "userId", "driveId", "folderId", "refreshToken", "connectedAt"] as const;
    if (!fields.every((f) => typeof c[f] === "string" && c[f])) throw new Error();
    return c as OneDriveConnection;
  } catch {
    throw new StorageError("OneDrive connection file cannot be decrypted (other ONEDRIVE_TOKEN_KEY, or damaged); reconnect OneDrive");
  }
}

export async function writeOneDriveConnection(path: string, key: Buffer, c: OneDriveConnection): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(c), "utf8"), cipher.final()]);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path); // atomic: never a half-written connection
}

// ---- Token endpoint ------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/** Only allow-listed scopes (Graph's "https://graph.microsoft.com/" prefix ignored); Files.ReadWrite required. */
export function scopesAcceptable(scope: unknown): boolean {
  if (typeof scope !== "string") return false;
  const s = scope.split(" ").filter(Boolean).map((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase());
  return s.includes("files.readwrite") && s.every((x) => ALLOWED_SCOPES.has(x));
}

/** Errors carry Microsoft's error code only: never the body, the code, a token or the secret. */
async function tokenRequest(fetchFn: typeof fetch, tenantId: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchFn(`${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new StorageError(`Microsoft token request failed (${timedOut(err) ? "timed out" : "unreachable"})`);
  });
  const body = (await res.json().catch(() => null)) as (Partial<TokenResponse> & { error?: unknown }) | null;
  if (!res.ok) {
    const code = typeof body?.error === "string" && /^\w{1,64}$/.test(body.error) ? body.error : `HTTP ${res.status}`;
    if (code === "invalid_grant") throw new StorageError("OneDrive authorization expired or was revoked; reconnect OneDrive");
    throw new StorageError(`Microsoft token request failed (${code})`);
  }
  if (typeof body?.access_token !== "string" || typeof body.expires_in !== "number") throw new StorageError("Microsoft token request failed (invalid response)");
  return body as TokenResponse;
}

async function graphJson(fetchFn: typeof fetch, token: string, op: string, url: string, init: RequestInit = {}, ok: number[] = []): Promise<{ status: number; body: unknown }> {
  const res = await fetchFn(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((err: unknown) => {
    throw new StorageError(`Microsoft Graph ${op} failed (${timedOut(err) ? "timed out" : "unreachable"})`);
  });
  if (!res.ok && !ok.includes(res.status)) {
    const code = await res.json().then((b) => (b as { error?: { code?: unknown } }).error?.code, () => undefined);
    throw new StorageError(`Microsoft Graph ${op} failed (HTTP ${res.status}${typeof code === "string" && /^\w{1,64}$/.test(code) ? `, ${code}` : ""})`);
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- Service -------------------------------------------------------------------------------

interface Pending {
  verifier: string;
  binding: Buffer;
  userId: string;
  expiresAt: number;
}

export type ConnectOutcome = "connected" | "denied" | "failed";

export interface OneDriveHealth {
  configured: boolean;
  connected: boolean;
  account: string | null;
  connectedAt: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
  quota: { usedBytes: number; totalBytes: number; remainingBytes: number } | null;
}

@Injectable()
export class OneDriveService implements GraphAuth {
  readonly cfg: OneDriveConfig | null;
  private readonly log = new Logger("OneDrive");
  // ponytail: pending states live in this process; a multi-instance API needs a shared store (DB row with TTL).
  private readonly pending = new Map<string, Pending>();
  private access: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private conn: OneDriveConnection | null | undefined;
  /** Bumped by connect/disconnect: a refresh that started before must not write its token back. */
  private generation = 0;
  private lastCheck: { at: string; ok: boolean; error: string | null; quota: OneDriveHealth["quota"] } | null = null;
  /** Replaced in tests. */
  fetchFn: typeof fetch = (...a) => fetch(...a);

  constructor(config: ConfigService<Env, true>) {
    this.cfg = oneDriveConfigFrom(config);
  }

  private config(): OneDriveConfig {
    if (!this.cfg) throw new StorageError("OneDrive is not configured");
    return this.cfg;
  }

  private async connection(): Promise<OneDriveConnection> {
    const cfg = this.config();
    this.conn ??= await readOneDriveConnection(cfg.tokenFile, cfg.tokenKey);
    const c = this.conn;
    if (!c) throw new StorageError("OneDrive is not connected yet; an administrator connects it in Settings › Storage");
    if (c.clientId !== cfg.clientId || c.tenantId !== cfg.tenantId || c.account !== cfg.account) {
      throw new StorageError("OneDrive connection belongs to another app registration, tenant or account; reconnect OneDrive");
    }
    return c;
  }

  // GraphAuth ------------------------------------------------------------------------------

  async target() {
    const c = await this.connection();
    return { driveId: c.driveId, folderId: c.folderId };
  }

  /** Cached access token; one refresh at a time (Microsoft rotates the refresh token on every use). */
  async token(fresh: boolean): Promise<string> {
    if (!fresh && this.access && this.access.expiresAt > Date.now() + 5 * 60_000) return this.access.value;
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const cfg = this.config();
    // Re-read the file first: the backup uploader (cli/backup-upload.ts) shares this connection and writes
    // the refresh token Microsoft rotated for it; whichever process refreshed last must be the one followed.
    this.conn = undefined;
    const c = await this.connection();
    const gen = this.generation;
    const t = await tokenRequest(this.fetchFn, cfg.tenantId, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      scope: ONEDRIVE_SCOPES,
    }).catch((err: unknown) => {
      this.access = null;
      throw err;
    });
    if (t.scope !== undefined && !scopesAcceptable(t.scope)) throw new StorageError("OneDrive token carries a scope beyond Files.ReadWrite; refusing to use it");
    if (gen !== this.generation) throw new StorageError("OneDrive was reconnected or disconnected meanwhile; try again");
    if (t.refresh_token && t.refresh_token !== c.refreshToken) {
      const next = { ...c, refreshToken: t.refresh_token };
      await writeOneDriveConnection(cfg.tokenFile, cfg.tokenKey, next).catch(() => {
        throw new StorageError("ONEDRIVE_TOKEN_FILE could not be written");
      });
      this.conn = next;
    }
    this.access = { value: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return this.access.value;
  }

  // Connect flow ---------------------------------------------------------------------------

  begin(userId: string): { url: string; binding: string } {
    if (!this.cfg) throw new NotFoundException("OneDrive is not configured");
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const state = random();
    const verifier = random();
    const binding = random();
    this.pending.set(state, { verifier, binding: sha256(binding), userId, expiresAt: now + STATE_TTL_MS });
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: ONEDRIVE_SCOPES,
      state,
      login_hint: this.cfg.account,
      prompt: "select_account",
      code_challenge: sha256(verifier).toString("base64url"),
      code_challenge_method: "S256",
    });
    return { url: `${LOGIN}/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/authorize?${params}`, binding };
  }

  private take(state: unknown, binding: string | undefined): Pending | null {
    if (typeof state !== "string") return null;
    const p = this.pending.get(state);
    this.pending.delete(state); // single use even when the rest fails
    if (!p || p.expiresAt <= Date.now() || !binding) return null;
    return timingSafeEqual(sha256(binding), p.binding) ? p : null;
  }

  /** Finishes the flow; the outcome only picks a fixed dashboard page. Never throws to the browser. */
  async complete(q: { state?: unknown; code?: unknown; error?: unknown }, binding: string | undefined): Promise<ConnectOutcome> {
    const p = this.take(q.state, binding);
    if (!this.cfg || !p) {
      this.log.warn("OneDrive callback rejected: unknown, expired or reused state, or a different browser");
      return "failed";
    }
    if (q.error !== undefined) {
      this.log.warn(`OneDrive connect not completed: Microsoft returned ${q.error === "access_denied" ? "access_denied" : "an error"}`);
      return q.error === "access_denied" ? "denied" : "failed";
    }
    if (typeof q.code !== "string" || !q.code || q.code.length > 4096) return "failed";
    try {
      const c = await this.connect(q.code, p.verifier);
      this.log.log({ startedBy: p.userId, account: c.account }, "OneDrive connected");
      return "connected";
    } catch (err) {
      this.log.warn(`OneDrive connect failed: ${err instanceof StorageError ? err.message : "unexpected error"}`);
      return "failed";
    }
  }

  private async connect(code: string, verifier: string): Promise<OneDriveConnection> {
    const cfg = this.config();
    const t = await tokenRequest(this.fetchFn, cfg.tenantId, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
      scope: ONEDRIVE_SCOPES,
    });
    // Refused grants are simply not kept (Microsoft has no endpoint to revoke one refresh token).
    if (!t.refresh_token || !t.id_token) throw new StorageError("Microsoft did not return offline access");
    if (!scopesAcceptable(t.scope)) throw new StorageError("Microsoft granted scopes beyond Files.ReadWrite; not kept");
    // The ID token comes straight from the token endpoint over TLS (OIDC Core 3.1.3.7): its claims are trusted as is.
    const claims = decodeJwt(t.id_token);
    const account = String(claims.preferred_username ?? "").toLowerCase();
    if (claims.tid !== cfg.tenantId || account !== cfg.account || typeof claims.oid !== "string") {
      throw new StorageError("the signed-in account is not ONEDRIVE_ACCOUNT_EMAIL in ONEDRIVE_TENANT_ID; not kept");
    }
    const drive = (await graphJson(this.fetchFn, t.access_token, "drive lookup", `${GRAPH}/me/drive?$select=id,driveType,owner`)).body as {
      id?: unknown;
      driveType?: unknown;
      owner?: { user?: { id?: unknown } };
    } | null;
    if (typeof drive?.id !== "string" || drive.driveType !== "business" || drive.owner?.user?.id !== claims.oid) {
      throw new StorageError("the account's OneDrive for Business could not be confirmed");
    }
    const folderId = await this.ensureFolder(t.access_token, cfg.rootFolder);
    const c: OneDriveConnection = {
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      account,
      userId: claims.oid,
      driveId: drive.id,
      folderId,
      refreshToken: t.refresh_token,
      connectedAt: new Date().toISOString(),
    };
    await writeOneDriveConnection(cfg.tokenFile, cfg.tokenKey, c).catch(() => {
      throw new StorageError("ONEDRIVE_TOKEN_FILE could not be written");
    });
    this.generation++;
    this.conn = c;
    this.access = { value: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    this.lastCheck = null;
    return c;
  }

  /** The app folder at the OneDrive root: existing one reused, else created. */
  private async ensureFolder(token: string, name: string): Promise<string> {
    const found = await graphJson(this.fetchFn, token, "folder lookup", `${GRAPH}/me/drive/root:/${encodeURIComponent(name)}?$select=id,folder`, {}, [404]);
    const existing = found.body as { id?: unknown; folder?: unknown } | null;
    if (found.status !== 404) {
      if (typeof existing?.id !== "string" || !existing.folder) throw new StorageError(`"${name}" in the OneDrive root is not a folder`);
      return existing.id;
    }
    const made = (
      await graphJson(this.fetchFn, token, "create folder", `${GRAPH}/me/drive/root/children`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      })
    ).body as { id?: unknown } | null;
    if (typeof made?.id !== "string") throw new StorageError("Microsoft Graph create folder failed (invalid response)");
    return made.id;
  }

  /**
   * A dedicated subfolder of the app folder (existing one reused, else created), for the off-site database
   * backups: `<ONEDRIVE_ROOT_FOLDER>/<name>`, beside (never inside) screenshots/ and timelapses/.
   */
  async ensureSubfolder(name: string): Promise<{ driveId: string; folderId: string }> {
    const c = await this.connection();
    const token = await this.token(false);
    const base = `${GRAPH}/drives/${encodeURIComponent(c.driveId)}/items/${encodeURIComponent(c.folderId)}`;
    const found = await graphJson(this.fetchFn, token, "folder lookup", `${base}:/${encodeURIComponent(name)}?$select=id,folder`, {}, [404]);
    const existing = found.body as { id?: unknown; folder?: unknown } | null;
    if (found.status !== 404) {
      if (typeof existing?.id !== "string" || !existing.folder) throw new StorageError(`"${name}" in the app folder is not a folder`);
      return { driveId: c.driveId, folderId: existing.id };
    }
    const made = (
      await graphJson(this.fetchFn, token, "create folder", `${base}/children`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      })
    ).body as { id?: unknown } | null;
    if (typeof made?.id !== "string") throw new StorageError("Microsoft Graph create folder failed (invalid response)");
    return { driveId: c.driveId, folderId: made.id };
  }

  /** Forgets the connection: the encrypted token file is deleted and cached tokens dropped. */
  async disconnect(userId: string): Promise<void> {
    const cfg = this.config();
    this.generation++;
    await rm(cfg.tokenFile, { force: true });
    this.conn = null;
    this.access = null;
    this.lastCheck = null;
    this.log.log({ by: userId }, "OneDrive disconnected");
  }

  /** Live check: refreshes the token, confirms the drive is still the connected one, reads its quota. */
  async check(): Promise<OneDriveHealth> {
    const base: OneDriveHealth = { configured: !!this.cfg, connected: false, account: null, connectedAt: null, lastCheckAt: null, lastCheckOk: null, lastError: null, quota: null };
    if (!this.cfg) return base;
    const at = new Date().toISOString();
    let c: OneDriveConnection | null = null;
    try {
      c = await this.connection();
      const token = await this.token(false);
      const d = (await graphJson(this.fetchFn, token, "drive lookup", `${GRAPH}/me/drive?$select=id,quota`)).body as { id?: unknown; quota?: { used?: unknown; total?: unknown; remaining?: unknown } } | null;
      if (d?.id !== c.driveId) throw new StorageError("the signed-in OneDrive is not the connected drive; reconnect OneDrive");
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      this.lastCheck = { at, ok: true, error: null, quota: d.quota ? { usedBytes: n(d.quota.used), totalBytes: n(d.quota.total), remainingBytes: n(d.quota.remaining) } : null };
    } catch (err) {
      this.lastCheck = { at, ok: false, error: err instanceof StorageError ? err.message : "Unexpected error", quota: null };
    }
    return {
      ...base,
      connected: !!c,
      account: c?.account ?? null,
      connectedAt: c?.connectedAt ?? null,
      lastCheckAt: this.lastCheck.at,
      lastCheckOk: this.lastCheck.ok,
      lastError: this.lastCheck.error,
      quota: this.lastCheck.quota,
    };
  }
}

// ---- Controller ----------------------------------------------------------------------------

@Controller({ path: "storage/onedrive", version: "1" })
export class OneDriveController {
  private readonly secure: boolean;
  private readonly dashboard: string;

  constructor(
    private readonly onedrive: OneDriveService,
    @Inject(DATABASE) private readonly db: DatabaseClient,
    config: ConfigService<Env, true>,
  ) {
    this.secure = config.get("NODE_ENV", { infer: true }) === "production";
    this.dashboard = config.get("DASHBOARD_URL", { infer: true });
  }

  /** Opened in the admin's signed-in browser: redirects to Microsoft's sign-in for the IT storage account. */
  @Get("oauth/start")
  @RequirePermission("storage:manage")
  start(@CurrentUser() user: AuthContext, @Res() res: Response): void {
    const { url, binding } = this.onedrive.begin(user.id);
    res.cookie(ONEDRIVE_BINDING_COOKIE, binding, { httpOnly: true, sameSite: "lax", secure: this.secure, path: ONEDRIVE_CALLBACK_PATH, maxAge: STATE_TTL_MS });
    res.redirect(302, url);
  }

  @Get("oauth/callback")
  @Public()
  async callback(@Query() q: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const outcome = await this.onedrive.complete(q, readCookie(req, ONEDRIVE_BINDING_COOKIE));
    res.clearCookie(ONEDRIVE_BINDING_COOKIE, { httpOnly: true, sameSite: "lax", secure: this.secure, path: ONEDRIVE_CALLBACK_PATH });
    res.redirect(302, new URL(`/settings?oneDrive=${outcome}`, this.dashboard).href);
  }

  /** Connection status, quota, last upload and the team folder mapping. Never a token or secret. */
  @Get("status")
  @RequirePermission("settings:manage")
  async status() {
    const health = await this.onedrive.check();
    const [{ rows: last }, { rows: teams }] = await Promise.all([
      this.db.execute("SELECT max(stored_at) AS at FROM screenshots WHERE storage_provider = 'MICROSOFT_GRAPH' AND stored_at IS NOT NULL"),
      this.db.execute("SELECT id, name, active FROM teams ORDER BY name"),
    ]);
    const root = this.onedrive.cfg?.rootFolder ?? null;
    return {
      provider: "MICROSOFT_ONEDRIVE" as const,
      ...health,
      rootFolder: root,
      lastUploadAt: last[0]?.at == null ? null : String(last[0].at),
      teams: teams.map((t) => ({ id: String(t.id), name: String(t.name), active: Number(t.active) === 1, folder: `${root}/${teamFolder(String(t.id))}` })),
      unassignedFolder: `${root}/${teamFolder(null)}`,
      timelapseFolder: `${root}/timelapses`,
    };
  }

  @Post("disconnect")
  @HttpCode(204)
  @RequirePermission("storage:manage")
  async disconnect(@CurrentUser() user: AuthContext): Promise<void> {
    await this.onedrive.disconnect(user.id);
  }
}

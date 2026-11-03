import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat as statFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { Logger, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SCREENSHOT_LIMITS, type ScreenshotDeletionMode, type ScreenshotStorageProvider } from "@workfolio/shared";
import { SignJWT } from "jose";
import type { DatabaseClient } from "@workfolio/database";
import type { Env } from "../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { GoogleDriveStorage, googleDriveConfigFrom } from "../storage/google-drive-storage.js";
import type { OneDriveService } from "../storage/onedrive.js";

/**
 * Provider-independent file storage (local dev disk or a SharePoint library via Microsoft Graph).
 * - Metadata lives in per-kind tables (`screenshots`: owner, size, checksum, provider, status);
 *   storage holds bytes only.
 * - Keys are server-generated ("<kind or employee uuid>/<yyyy-mm>/<uuid>.<ext>"): no names, no
 *   client input, no content.
 * - Access control is enforced by the owning service before any storage call; adapters trust it.
 * - Nothing is ever publicly linked: bytes go through the API, never a shareable or download URL.
 */
export interface FileStorage {
  readonly provider: ScreenshotStorageProvider;
  /** What `delete` does: a SharePoint recycle-bin delete is still recoverable for a while. */
  readonly deletionMode: ScreenshotDeletionMode;
  /** Stores (or replaces) the file. Resolves only once the provider accepted it. */
  put(key: string, data: Uint8Array): Promise<StoredItem>;
  /** Same as put, streamed from a local file in chunks (timelapse videos): never loads the whole file. */
  putFile(key: string, filePath: string): Promise<StoredItem>;
  /** Lookup with the provider's own checksum of the stored bytes; null when the file does not exist. */
  stat(key: string): Promise<StoredItem | null>;
  /** Controlled retrieval: bytes go through the API, never a public or shareable link. Refuses more than `maxBytes`. */
  get(key: string, maxBytes?: number): Promise<Uint8Array>;
  /** Like get, unbuffered (large videos): the stream errors with a StorageError past `maxBytes`. */
  getStream(key: string, maxBytes: number): Promise<{ stream: Readable; size: number }>;
  /** Idempotent: a missing file is not an error. */
  delete(key: string): Promise<void>;
}

export type ScreenshotStorage = FileStorage;

export interface StoredItem {
  itemId: string;
  size: number;
  /** QuickXorHash (base64) as computed by the provider; SharePoint/OneDrive for Business report this one. */
  quickXorHash?: string;
  /** SHA-256 (hex) as reported by the provider (Google Drive). */
  sha256?: string;
}

/** Storage failed or is unreachable. Message carries no secrets, tokens, paths or response bodies. */
export class StorageError extends Error {}

/**
 * Team-separated layout (the same in every provider): screenshots/teams/<team id>/<employee id>/<yyyy-mm>/<id>.webp,
 * screenshots/unassigned/... for an employee in no team. The team is the employee's earliest membership at
 * registration; the key is then fixed (screenshots_immutable), so later team moves never move files. Folder
 * names are IDs only (no names); access is decided by the API (role scope), never by the folder.
 */
export const teamFolder = (teamId: string | null) => (teamId ? `screenshots/teams/${teamId}` : "screenshots/unassigned");
export const screenshotKey = (teamId: string | null, employeeId: string, capturedIso: string, id: string) =>
  `${teamFolder(teamId)}/${employeeId}/${capturedIso.slice(0, 7)}/${id}.webp`;
/** Timelapse videos: per employee (the timelapses table has no storage-key column; adding one needs a migration). */
export const timelapseKey = (employeeId: string, id: string) => `timelapses/${employeeId}/${id}.mp4`;

export const FILE_STORAGE = Symbol("FILE_STORAGE");
/** The OneDrive connection (OneDriveService), by token: avoids an import cycle with ../storage/onedrive. */
export const ONEDRIVE_AUTH = Symbol("ONEDRIVE_AUTH");
/** Same token as FILE_STORAGE (existing injections keep working). */
export const SCREENSHOT_STORAGE = FILE_STORAGE;

/**
 * Microsoft's QuickXorHash (the content hash OneDrive for Business and SharePoint expose; they do
 * not offer SHA-256): each byte is XORed into a 160-bit ring at bit offset (index × 11) mod 160,
 * then the 64-bit little-endian length is XORed into the last 8 bytes. Base64 encoded.
 */
export function quickXorHash(data: Uint8Array): string {
  const ring = new Uint8Array(20);
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if (!b) continue;
    const pos = (i * 11) % 160;
    for (let k = 0; k < 8; k++) {
      if ((b >> k) & 1) {
        const bit = (pos + k) % 160;
        ring[bit >> 3]! ^= 1 << (bit & 7);
      }
    }
  }
  let len = BigInt(data.length);
  for (let k = 0; k < 8; k++, len >>= 8n) ring[12 + k]! ^= Number(len & 0xffn);
  return Buffer.from(ring).toString("base64");
}

/** DEVELOPMENT ONLY: files on the API host's disk. Refused in production by env validation. */
export class LocalDevStorage implements FileStorage {
  readonly provider = "LOCAL_DEV" as const;
  readonly deletionMode = "LOCAL_DEV" as const;
  private readonly root: string;
  private rootReady?: Promise<void>;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new StorageError("Invalid storage key");
    return p;
  }

  async put(key: string, data: Uint8Array): Promise<StoredItem> {
    const p = this.path(key);
    await this.ensureRoot();
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(`${p}.tmp`, data, { mode: 0o600 });
    await rename(`${p}.tmp`, p); // atomic: never a partial file under the final name
    return { itemId: key, size: data.length };
  }

  async putFile(key: string, filePath: string): Promise<StoredItem> {
    const p = this.path(key);
    await this.ensureRoot();
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await copyFile(filePath, `${p}.tmp`);
    await chmod(`${p}.tmp`, 0o600); // copyFile keeps the source's mode
    await rename(`${p}.tmp`, p);
    return { itemId: key, size: (await statFile(p)).size };
  }

  async stat(key: string): Promise<StoredItem | null> {
    const bytes = await readFile(this.path(key)).catch(() => null);
    return bytes && { itemId: key, size: bytes.length, quickXorHash: quickXorHash(bytes) };
  }

  /** The root is 0700 even if it already existed with looser permissions (POSIX only). Once per process. */
  private ensureRoot() {
    this.rootReady ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await chmod(this.root, 0o700);
    })().catch((err: unknown) => {
      this.rootReady = undefined;
      throw err;
    });
    return this.rootReady;
  }

  async get(key: string, maxBytes = SCREENSHOT_LIMITS.maxBytes): Promise<Uint8Array> {
    const bytes = await readFile(this.path(key)).catch(() => {
      throw new StorageError("File not found in storage");
    });
    if (bytes.length > maxBytes) throw new StorageError("File is larger than allowed");
    return bytes;
  }

  async getStream(key: string, maxBytes: number): Promise<{ stream: Readable; size: number }> {
    // The open handle pins the file: a concurrent replace (rename) cannot change what is streamed.
    const file = await open(this.path(key)).catch(() => {
      throw new StorageError("File not found in storage");
    });
    const { size } = await file.stat();
    if (size > maxBytes) {
      await file.close();
      throw new StorageError("File is larger than allowed");
    }
    return { stream: file.createReadStream(), size };
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** Delegated Graph access (OneDrive of one connected account): tokens and the target folder come from the connection. */
export interface GraphAuth {
  /** An access token; `fresh` after a 401 (revoked or expired early). */
  token(fresh: boolean): Promise<string>;
  target(): Promise<{ driveId: string; folderId: string }>;
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  /** One of: client secret, or certificate (PKCS#8 private key PEM + SHA-1 thumbprint hex from Entra). */
  clientSecret?: string;
  certificate?: { privateKeyPem: string; thumbprintSha1Hex: string };
  /** The drive (SharePoint library or OneDrive) holding the storage folder; the site is only for verify-graph. */
  siteId?: string;
  driveId: string;
  /** Folder item ID: files are addressed under it. Without it, `folder` is a path under the drive root. */
  folderId?: string;
  folder: string;
  /** Retention deletes bypass the site recycle bin (permanentDelete). Default: recycle bin. */
  permanentDelete: boolean;
}

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Throttling and transient errors are retried this many times inside one call (desktop retries later anyway). */
const TRANSIENT = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5_000;
/** Every token and Graph request (including reading the body) is aborted after this. */
const TIMEOUT_MS = 30_000;
const timedOut = (err: unknown) => (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
/** Upload session chunk: Graph wants a multiple of 320 KiB, at most 60 MiB. */
const CHUNK_BYTES = 32 * 320 * 1024; // 10 MiB
// ponytail: one deadline for a whole streamed download (body included), not an idle timeout; switch to
// an idle timer if long videos over slow links hit it.
const STREAM_TIMEOUT_MS = 15 * 60_000;
const retryWait = (res: Response, attempt: number) => {
  const after = Number(res.headers.get("retry-after"));
  return Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt);
};
/** The Graph error code only, never its message (it can echo request data). */
const httpFailure = async (op: string, res: Response) => {
  const code = await res.json().then((b) => (b as { error?: { code?: string } }).error?.code, () => undefined);
  return new StorageError(`Microsoft Graph ${op} failed (HTTP ${res.status}${code ? `, ${code}` : ""})`);
};

/**
 * Microsoft Graph adapter (SharePoint document library), app-only OAuth 2.0 client credentials
 * with a secret or a certificate. Least privilege: `Sites.Selected` with `write` granted on the one
 * screenshot site only (docs/onedrive.md); no tenant-wide Files.* or Sites.ReadWrite.All.
 * NOT VERIFIED against a real tenant yet: exercised with a fake Graph in tests; real checks in
 * apps/api/scripts/verify-graph.mjs once credentials exist.
 */
export class GraphStorage implements FileStorage {
  readonly provider = "MICROSOFT_GRAPH" as const;
  readonly deletionMode: ScreenshotDeletionMode;
  private token: { value: string; expiresAt: number } | null = null;
  private driveId: string;
  private folderId?: string;

  /** Without `auth`: app-only client credentials from `cfg`. With it: delegated tokens and the drive of a connected account (OneDrive). */
  constructor(
    private readonly cfg: GraphConfig,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly timeoutMs = TIMEOUT_MS,
    private readonly auth?: GraphAuth,
  ) {
    if (!auth && !cfg.clientSecret === !cfg.certificate) throw new Error("Graph storage needs exactly one of a client secret or a certificate");
    this.deletionMode = cfg.permanentDelete ? "PERMANENT" : "RECYCLE_BIN";
    this.driveId = cfg.driveId;
    this.folderId = cfg.folderId;
  }

  /** Delegated mode: the drive and folder of the current connection (they change only on a reconnect). */
  private async ready() {
    if (!this.auth) return;
    const t = await this.auth.target();
    this.driveId = t.driveId;
    this.folderId = t.folderId;
  }

  private tokenUrl() {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`;
  }

  /** Signed client assertion (RFC 7523) for certificate credentials. */
  private async assertion(): Promise<string> {
    const { privateKeyPem, thumbprintSha1Hex } = this.cfg.certificate!;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT", x5t: Buffer.from(thumbprintSha1Hex.replace(/[^0-9a-f]/gi, ""), "hex").toString("base64url") })
      .setIssuer(this.cfg.clientId)
      .setSubject(this.cfg.clientId)
      .setAudience(this.tokenUrl())
      .setJti(randomUUID())
      .setNotBefore(now)
      .setExpirationTime(now + 600)
      .sign(createPrivateKey(privateKeyPem));
  }

  private async accessToken(fresh = false): Promise<string> {
    if (this.auth) return this.auth.token(fresh);
    if (this.token && this.token.expiresAt > Date.now() + 5 * 60_000) return this.token.value;
    const form = new URLSearchParams({ client_id: this.cfg.clientId, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    if (this.cfg.clientSecret) form.set("client_secret", this.cfg.clientSecret);
    else {
      form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      form.set("client_assertion", await this.assertion());
    }
    const failed = (why: string) => new StorageError(`Microsoft identity platform token request failed (${why})`);
    const res = await this.fetchFn(this.tokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      throw failed(timedOut(err) ? "timed out" : "unreachable");
    });
    if (!res.ok) throw failed(`HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof body?.access_token !== "string" || typeof body.expires_in !== "number") throw failed("invalid response");
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  private drive() {
    return `${GRAPH}/drives/${encodeURIComponent(this.driveId)}`;
  }

  /**
   * `/drives/{id}/items/{folderId}:/<key>`, or without a folder ID `/drives/{id}/root:/<folder>/<key>`;
   * each segment URL-encoded. Callers append `:/content` (or another `:/` sub-resource) or a `?` query.
   */
  private item(key: string) {
    const segments = key.split("/").map(encodeURIComponent).join("/");
    if (this.folderId) return `${this.drive()}/items/${encodeURIComponent(this.folderId)}:/${segments}`;
    return `${this.drive()}/root:/${encodeURIComponent(this.cfg.folder)}/${segments}`;
  }

  /**
   * One Graph request, aborted after the timeout; transient failures (throttling, 5xx) retried with
   * Retry-After (bounded); a 401 retried once with a fresh token (revoked or rotated credentials).
   */
  async call(op: string, url: string, init: RequestInit = {}, okStatuses: number[] = [], timeoutMs = this.timeoutMs): Promise<Response> {
    let reauthenticated = false;
    for (let attempt = 0; ; attempt++) {
      const authorization = `Bearer ${await this.accessToken(reauthenticated && attempt === 0)}`;
      const res = await this.fetchFn(url, { ...init, headers: { ...init.headers, authorization }, signal: AbortSignal.timeout(timeoutMs) }).catch((err: unknown) => {
        throw new StorageError(`Microsoft Graph ${op} failed (${timedOut(err) ? "timed out" : "unreachable"})`);
      });
      if (res.ok || okStatuses.includes(res.status)) return res;
      if (res.status === 401) {
        this.token = null;
        if (!reauthenticated) {
          reauthenticated = true;
          attempt = -1; // the next round asks for a fresh token; not a transient retry
          await res.body?.cancel();
          continue;
        }
      }
      if (TRANSIENT.has(res.status) && attempt < MAX_RETRIES) {
        await this.sleep(retryWait(res, attempt));
        continue;
      }
      throw await httpFailure(op, res);
    }
  }

  async put(key: string, data: Uint8Array): Promise<StoredItem> {
    await this.ready();
    // Simple upload (files up to 250 MB); screenshots are capped at 10 MB.
    const res = await this.call("upload", `${this.item(key)}:/content?@microsoft.graph.conflictBehavior=replace`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: data,
    });
    return toItem(await json(res, "upload"));
  }

  /**
   * Resumable upload session: the file is read and sent in 10 MiB chunks, each retried on transient
   * failures. Any failure cancels the session (best effort) so no partial upload lingers.
   */
  async putFile(key: string, filePath: string): Promise<StoredItem> {
    await this.ready();
    const file = await open(filePath).catch(() => {
      throw new StorageError("Microsoft Graph upload failed (source file unreadable)");
    });
    try {
      const { size: total } = await file.stat();
      if (!total) return await this.put(key, new Uint8Array());
      const res = await this.call("upload session", `${this.item(key)}:/createUploadSession`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
      });
      const { uploadUrl } = ((await json(res, "upload session")) ?? {}) as { uploadUrl?: unknown };
      if (typeof uploadUrl !== "string") throw new StorageError("Microsoft Graph upload session failed (invalid response)");
      try {
        const buf = Buffer.alloc(Math.min(CHUNK_BYTES, total));
        for (let start = 0; ; ) {
          const { bytesRead } = await file.read(buf, 0, Math.min(CHUNK_BYTES, total - start), start);
          if (!bytesRead) throw new StorageError("Microsoft Graph upload failed (source file changed)");
          const end = start + bytesRead - 1;
          const chunk = await this.uploadChunk(uploadUrl, buf.subarray(0, bytesRead), `bytes ${start}-${end}/${total}`);
          start = end + 1;
          if (start >= total) return toItem(await json(chunk, "upload")); // the last chunk answers with the driveItem
          await chunk.body?.cancel();
        }
      } catch (err) {
        await this.fetchFn(uploadUrl, { method: "DELETE", signal: AbortSignal.timeout(this.timeoutMs) }).then((r) => r.body?.cancel(), () => {});
        if (err instanceof StorageError) throw err;
        throw new StorageError(`Microsoft Graph upload failed (${timedOut(err) ? "timed out" : "source file unreadable"})`);
      }
    } finally {
      await file.close();
    }
  }

  /** One chunk to the pre-authenticated upload URL: no Authorization header (it must not go there). */
  private async uploadChunk(uploadUrl: string, chunk: Uint8Array, range: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(uploadUrl, {
        method: "PUT",
        headers: { "content-length": String(chunk.length), "content-range": range },
        body: chunk,
        signal: AbortSignal.timeout(this.timeoutMs),
      }).catch((err: unknown) => {
        throw new StorageError(`Microsoft Graph upload failed (${timedOut(err) ? "timed out" : "unreachable"})`);
      });
      if (res.ok) return res;
      if (TRANSIENT.has(res.status) && attempt < MAX_RETRIES) {
        await res.body?.cancel();
        await this.sleep(retryWait(res, attempt));
        continue;
      }
      throw await httpFailure("upload", res);
    }
  }

  async stat(key: string): Promise<StoredItem | null> {
    await this.ready();
    const res = await this.call("lookup", `${this.item(key)}?$select=id,size,file`, {}, [404]);
    return res.status === 404 ? null : toItem(await json(res, "lookup"));
  }

  async get(key: string, maxBytes = SCREENSHOT_LIMITS.maxBytes): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of (await this.download(key, maxBytes)).body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async getStream(key: string, maxBytes: number): Promise<{ stream: Readable; size: number }> {
    const { body, declared, cancel } = await this.download(key, maxBytes, STREAM_TIMEOUT_MS);
    if (declared === undefined) {
      await cancel();
      throw new StorageError("Microsoft Graph download failed (invalid response)");
    }
    const stream = Readable.from(body, { objectMode: false });
    stream.once("close", cancel); // destroyed before the first read: the generator never reached the body
    return { stream, size: declared };
  }

  /**
   * Graph answers with a redirect to a short-lived download URL; it is followed here and never
   * handed to a browser (fetch drops the Authorization header on the cross-origin redirect).
   * Bounded: never yields more than `maxBytes`, whatever the provider declares or sends.
   */
  private async download(key: string, maxBytes: number, timeoutMs = this.timeoutMs) {
    await this.ready();
    const res = await this.call("download", `${this.item(key)}:/content`, {}, [], timeoutMs);
    const tooLarge = () => new StorageError("Microsoft Graph download failed (larger than allowed)");
    const length = res.headers.get("content-length");
    if (Number(length) > maxBytes) {
      await res.body?.cancel();
      throw tooLarge();
    }
    async function* bounded() {
      let size = 0;
      try {
        for await (const chunk of res.body ?? []) {
          size += chunk.length;
          if (size > maxBytes) throw tooLarge(); // leaving the loop cancels the stream
          yield chunk;
        }
      } catch (err) {
        if (err instanceof StorageError) throw err;
        throw new StorageError(`Microsoft Graph download failed (${timedOut(err) ? "timed out" : "interrupted"})`);
      }
    }
    const cancel = () => res.body?.cancel().catch(() => {}); // a no-op once the body is being read
    return { body: bounded(), declared: length !== null && /^\d+$/.test(length) ? Number(length) : undefined, cancel };
  }

  async delete(key: string): Promise<void> {
    await this.ready();
    if (!this.cfg.permanentDelete) {
      await this.call("delete", this.item(key), { method: "DELETE" }, [404]);
      return;
    }
    const item = await this.stat(key);
    if (item) await this.call("permanent delete", `${this.drive()}/items/${encodeURIComponent(item.itemId)}/permanentDelete`, { method: "POST" }, [404]);
  }

  /** Configuration check: the drive is a library of the intended site (used by verify-graph and startup diagnostics). */
  async driveBelongsToSite(): Promise<boolean> {
    const res = await this.call("site lookup", `${GRAPH}/sites/${encodeURIComponent(this.cfg.siteId!)}/drives?$select=id`);
    const { value } = (await json(res, "site lookup")) as { value?: { id: string }[] };
    return (value ?? []).some((d) => d.id === this.driveId);
  }

  /** Configuration check: GRAPH_FOLDER_ID is a folder in GRAPH_DRIVE_ID (used by verify-graph-storage). */
  async folderIsConfigured(): Promise<boolean> {
    if (!this.folderId) return false;
    const res = await this.call("folder lookup", `${this.drive()}/items/${encodeURIComponent(this.folderId)}?$select=id,name,folder,parentReference`);
    const item = (await json(res, "folder lookup")) as { folder?: unknown; parentReference?: { driveId?: unknown } } | null;
    return !!item?.folder && item.parentReference?.driveId === this.driveId;
  }
}

/** A body that is not JSON (truncated, a proxy's HTML page, timed out mid-body) is a storage failure, not a 500. */
const json = (res: Response, op: string): Promise<unknown> =>
  res.json().catch((err: unknown) => {
    throw new StorageError(`Microsoft Graph ${op} failed (${timedOut(err) ? "timed out" : "invalid response"})`);
  });

const toItem = (j: unknown): StoredItem => {
  const item = j as { id?: unknown; size?: unknown; file?: { hashes?: { quickXorHash?: string } } } | null;
  if (typeof item?.id !== "string" || typeof item.size !== "number") throw new StorageError("Microsoft Graph returned an unexpected item");
  return { itemId: item.id, size: item.size, quickXorHash: item.file?.hashes?.quickXorHash };
};

/** Same SHA-1 thumbprint Entra shows for an uploaded certificate (for operators comparing values). */
export const certificateThumbprint = (certPem: string) => createHash("sha1").update(Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ""), "base64")).digest("hex").toUpperCase();

export function graphConfigFrom(config: ConfigService<Env, true>): GraphConfig {
  const keyPath = config.get("GRAPH_CERT_KEY_PATH", { infer: true });
  return {
    tenantId: config.get("GRAPH_TENANT_ID", { infer: true })!,
    clientId: config.get("GRAPH_CLIENT_ID", { infer: true })!,
    clientSecret: config.get("GRAPH_CLIENT_SECRET", { infer: true }),
    certificate: keyPath ? { privateKeyPem: readFileSync(keyPath, "utf8"), thumbprintSha1Hex: config.get("GRAPH_CERT_THUMBPRINT", { infer: true })! } : undefined,
    siteId: config.get("GRAPH_SITE_ID", { infer: true }),
    driveId: config.get("GRAPH_DRIVE_ID", { infer: true })!,
    folderId: config.get("GRAPH_FOLDER_ID", { infer: true }),
    folder: config.get("GRAPH_FOLDER", { infer: true }),
    permanentDelete: config.get("GRAPH_PERMANENT_DELETE", { infer: true }),
  };
}

export const screenshotStorageProvider: Provider = {
  provide: FILE_STORAGE,
  inject: [ConfigService, DATABASE, ONEDRIVE_AUTH],
  useFactory: async (config: ConfigService<Env, true>, db: DatabaseClient, onedrive: OneDriveService): Promise<FileStorage> => {
    const logger = new Logger("ScreenshotStorage");
    if (config.get("SCREENSHOT_STORAGE", { infer: true }) === "graph") return new GraphStorage(graphConfigFrom(config));
    if (config.get("SCREENSHOT_STORAGE", { infer: true }) === "onedrive") {
      // Same Graph adapter, delegated: the IT storage account's OneDrive, under its app folder (rows record MICROSOFT_GRAPH).
      const cfg = onedrive.cfg!;
      logger.log(`Screenshot storage: Microsoft OneDrive of ${cfg.account} (delegated Files.ReadWrite), folder ${cfg.rootFolder}.`);
      return new GraphStorage(
        { tenantId: cfg.tenantId, clientId: cfg.clientId, driveId: "", folder: cfg.rootFolder, permanentDelete: config.get("GRAPH_PERMANENT_DELETE", { infer: true }) },
        undefined,
        undefined,
        undefined,
        onedrive,
      );
    }
    if (config.get("SCREENSHOT_STORAGE", { infer: true }) === "google-drive") {
      // Screenshot rows record their provider, and the schema accepts GOOGLE_DRIVE only after a migration
      // that is not written yet (needs approval). Refuse to start rather than fail every upload.
      const table = await db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'screenshots'");
      if (!String(table.rows[0]?.sql ?? "").includes("'GOOGLE_DRIVE'")) {
        throw new Error("SCREENSHOT_STORAGE=google-drive: the screenshots table does not accept GOOGLE_DRIVE yet (migration pending approval); refusing to start");
      }
      logger.warn("Screenshot storage: Google Drive TESTING POC (personal My Drive, drive.file scope).");
      return new GoogleDriveStorage(googleDriveConfigFrom(config)!, "Screenshots");
    }
    const dir = config.get("SCREENSHOT_LOCAL_DIR", { infer: true });
    logger.warn(`Screenshot storage: LOCAL DEVELOPMENT adapter (${resolve(dir)}). Not for production; no Microsoft Graph upload happens.`);
    return new LocalDevStorage(dir);
  },
};

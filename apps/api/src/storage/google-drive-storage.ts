import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ConfigService } from "@nestjs/config";
import { SCREENSHOT_LIMITS, type ScreenshotDeletionMode } from "@workfolio/shared";
import type { Env } from "../config/env.js";
import { type FileStorage, StorageError, type StoredItem } from "../screenshots/storage.js";

/**
 * Google Drive adapter. TESTING POC on a personal My Drive (GOOGLE-DRIVE-STORAGE-SETUP.md).
 * - OAuth 2.0 user credentials with the "drive.file" scope only: the app sees just the files and folders
 *   it created itself. Its own "InsightWorkfolio" folder (created at connect time, IDs kept in the
 *   connection file) is the storage boundary; nothing else in the Drive is listed, read or changed, and a
 *   folder of the same name made by hand stays invisible to the app.
 * - The refresh token lives only in GOOGLE_DRIVE_TOKEN_FILE on the API host (0600), never in a response.
 * NOT VERIFIED against real Google yet: exercised with a fake Drive in tests; real checks in
 * apps/api/scripts/verify-google-drive.mjs once the account is connected.
 */

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
export const ROOT_FOLDER = "InsightWorkfolio";
export const AREAS = ["Screenshots", "Timelapse", "TestFiles"] as const;
export type DriveArea = (typeof AREAS)[number];
const FIELDS = "id,size,md5Checksum,sha256Checksum";
const JSON_HEADERS = { "content-type": "application/json; charset=UTF-8" };
/** Throttling and transient errors are retried this many times inside one call. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
/** Drive also signals rate limits as 403 with one of these reasons. */
const RATE_LIMITED = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5_000;
const TIMEOUT_MS = 30_000;
// ponytail: one deadline for a whole streamed download, like GraphStorage; idle timer if long videos hit it.
const STREAM_TIMEOUT_MS = 15 * 60_000;
/** Resumable upload chunk: Google wants a multiple of 256 KiB. */
const CHUNK_BYTES = 32 * 256 * 1024; // 8 MiB
/** Key segment: no separators, no leading dot (so never "." or ".."), no quotes (they would end a Drive query string). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SEGMENTS = 8;
/** Drive item IDs, checked before one goes into a URL or a query. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const timedOut = (err: unknown) => (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
const digest = (alg: "sha256" | "md5", data: Uint8Array) => createHash(alg).update(data).digest("hex");

// ---- Connection file ------------------------------------------------------

export type DriveFolders = Record<"root" | DriveArea, string>;

/** What a completed connect leaves on the API host: one file, 0600, in a 0700 directory. */
export interface GoogleDriveConnection {
  /** The OAuth client it was issued to: a staging connection file is refused by a production client and vice versa. */
  clientId: string;
  account: string;
  refreshToken: string;
  folders: DriveFolders;
  connectedAt: string;
}

/** Null when not connected yet. A malformed file is an error (never silently replaced by a new connection). */
export async function readConnection(path: string): Promise<GoogleDriveConnection | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StorageError("Google Drive connection file is unreadable");
  }
  const c = (() => {
    try {
      return JSON.parse(text) as Partial<GoogleDriveConnection>;
    } catch {
      return null;
    }
  })();
  const folders = c?.folders as Partial<DriveFolders> | undefined;
  const ok =
    typeof c?.clientId === "string" &&
    typeof c.account === "string" &&
    typeof c.refreshToken === "string" &&
    !!c.refreshToken &&
    typeof c.connectedAt === "string" &&
    (["root", ...AREAS] as const).every((k) => typeof folders?.[k] === "string" && DRIVE_ID.test(folders[k]));
  if (!ok) throw new StorageError("Google Drive connection file is malformed");
  return c as GoogleDriveConnection;
}

export async function writeConnection(path: string, c: GoogleDriveConnection): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(c), { mode: 0o600 });
  await chmod(tmp, 0o600); // writeFile's mode applies only to a new file
  await rename(tmp, path); // atomic: never a half-written connection
}

// ---- Configuration --------------------------------------------------------

export interface GoogleDriveConfig {
  clientId: string;
  clientSecret: string;
  tokenFile: string;
  /** The one Google account allowed to connect (lowercase). */
  account: string;
  /** Deletes bypass the Drive trash. Default: trash (recoverable for 30 days). */
  permanentDelete: boolean;
}

/** Null when Google Drive is not configured (env validation guarantees the rest once the client ID is set). */
export function googleDriveConfigFrom(config: ConfigService<Env, true>): GoogleDriveConfig | null {
  const clientId = config.get("GOOGLE_OAUTH_CLIENT_ID", { infer: true });
  if (!clientId) return null;
  return {
    clientId,
    clientSecret: config.get("GOOGLE_OAUTH_CLIENT_SECRET", { infer: true })!,
    tokenFile: config.get("GOOGLE_DRIVE_TOKEN_FILE", { infer: true })!,
    account: config.get("GOOGLE_DRIVE_ACCOUNT_EMAIL", { infer: true })!,
    permanentDelete: config.get("GOOGLE_DRIVE_PERMANENT_DELETE", { infer: true }),
  };
}

// ---- Token endpoint -------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** True only for exactly the drive.file scope (nothing broader, nothing extra). */
export const onlyDriveFile = (scope: unknown) => typeof scope === "string" && scope.split(" ").filter(Boolean).join(" ") === DRIVE_FILE_SCOPE;

/** Google's token endpoint. Errors carry Google's error code only: never the response body, the code or a token. */
export async function tokenRequest(fetchFn: typeof fetch, form: Record<string, string>, timeoutMs = TIMEOUT_MS): Promise<TokenResponse> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: unknown) => {
    throw new StorageError(`Google token request failed (${timedOut(err) ? "timed out" : "unreachable"})`);
  });
  const body = (await res.json().catch(() => null)) as (Partial<TokenResponse> & { error?: unknown }) | null;
  if (!res.ok) {
    const code = typeof body?.error === "string" && /^\w{1,64}$/.test(body.error) ? body.error : `HTTP ${res.status}`;
    if (code === "invalid_grant") throw new StorageError("Google Drive authorization expired or was revoked; reconnect Google Drive");
    throw new StorageError(`Google token request failed (${code})`);
  }
  if (typeof body?.access_token !== "string" || typeof body.expires_in !== "number") throw new StorageError("Google token request failed (invalid response)");
  return body as TokenResponse;
}

// ---- Drive client ---------------------------------------------------------

/** One Drive item as this adapter uses it. */
interface DriveFile {
  id: string;
  size?: number;
  md5?: string;
  sha256?: string;
}

/** Google's error reason only (e.g. "rateLimitExceeded"), never its message: it can echo request data. */
const reasonOf = (res: Response): Promise<string | undefined> =>
  res.json().then(
    (b) => {
      const e = (b as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
      const r = e?.errors?.[0]?.reason ?? e?.status;
      return typeof r === "string" && /^\w{1,64}$/.test(r) ? r : undefined;
    },
    () => undefined,
  );

const failure = async (op: string, res: Response) => {
  const reason = await reasonOf(res);
  return new StorageError(`Google Drive ${op} failed (HTTP ${res.status}${reason ? `, ${reason}` : ""})`);
};

const retryWait = (res: Response, attempt: number) => {
  const after = Number(res.headers.get("retry-after"));
  return Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt);
};

/** A body that is not JSON (truncated, a proxy's HTML page, timed out mid-body) is a storage failure. */
const json = (res: Response, op: string): Promise<unknown> =>
  res.json().catch((err: unknown) => {
    throw new StorageError(`Google Drive ${op} failed (${timedOut(err) ? "timed out" : "invalid response"})`);
  });

function driveFile(j: unknown, op: string): DriveFile {
  const f = j as { id?: unknown; size?: unknown; md5Checksum?: unknown; sha256Checksum?: unknown } | null;
  if (typeof f?.id !== "string" || !DRIVE_ID.test(f.id)) throw new StorageError(`Google Drive ${op} failed (unexpected item)`);
  return {
    id: f.id,
    size: typeof f.size === "string" && /^\d+$/.test(f.size) ? Number(f.size) : undefined,
    md5: typeof f.md5Checksum === "string" ? f.md5Checksum : undefined,
    sha256: typeof f.sha256Checksum === "string" ? f.sha256Checksum : undefined,
  };
}

const toItem = (f: DriveFile): StoredItem => {
  if (f.size === undefined) throw new StorageError("Google Drive returned an item without a size");
  return { itemId: f.id, size: f.size, sha256: f.sha256 };
};

/** Accepted only when Drive reports the bytes that were sent: same size and SHA-256 (MD5 when Drive gives no SHA-256). */
function verified(j: unknown, size: number, sha256: string, md5: string): StoredItem {
  const f = driveFile(j, "upload");
  if (f.size !== size || (f.sha256 ? f.sha256 !== sha256 : f.md5 !== md5)) throw new StorageError("Google Drive upload failed (size or checksum mismatch)");
  return toItem(f);
}

/**
 * Authenticated Drive requests: each aborted after the timeout; 429/5xx and Drive's 403 rate-limit reasons
 * retried (bounded, Retry-After honoured); a 401 retried once with a fresh access token.
 */
export class DriveClient {
  constructor(
    private readonly token: (fresh: boolean) => Promise<string>,
    readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    readonly timeoutMs = TIMEOUT_MS,
  ) {}

  async call(op: string, url: string, init: RequestInit = {}, okStatuses: number[] = [], timeoutMs = this.timeoutMs): Promise<Response> {
    let reauthenticated = false;
    for (let attempt = 0; ; attempt++) {
      const authorization = `Bearer ${await this.token(reauthenticated && attempt === 0)}`;
      const res = await this.fetchFn(url, { ...init, headers: { ...init.headers, authorization }, signal: AbortSignal.timeout(timeoutMs) }).catch((err: unknown) => {
        throw new StorageError(`Google Drive ${op} failed (${timedOut(err) ? "timed out" : "unreachable"})`);
      });
      if (res.ok || okStatuses.includes(res.status)) return res;
      if (res.status === 401 && !reauthenticated) {
        reauthenticated = true;
        attempt = -1; // the next round asks for a fresh token; not a transient retry
        await res.body?.cancel();
        continue;
      }
      const rateLimited = res.status === 403 && RATE_LIMITED.has((await reasonOf(res.clone())) ?? "");
      if ((TRANSIENT.has(res.status) || rateLimited) && attempt < MAX_RETRIES) {
        await res.body?.cancel();
        await this.sleep(retryWait(res, attempt));
        continue;
      }
      throw await failure(op, res);
    }
  }

  /** Items matching a Drive query. Only called with queries scoped to one parent folder of the app's own tree. */
  async list(q: string): Promise<DriveFile[]> {
    const url = `${DRIVE}/files?${new URLSearchParams({ q, fields: `files(${FIELDS})`, pageSize: "10", spaces: "drive" })}`;
    const body = (await json(await this.call("lookup", url), "lookup")) as { files?: unknown } | null;
    if (!Array.isArray(body?.files)) throw new StorageError("Google Drive lookup failed (invalid response)");
    return body.files.map((f) => driveFile(f, "lookup"));
  }

  /** The folder `name` directly in `parent`; created when missing and `create` is set. */
  async childFolder(parent: string, name: string, create: boolean): Promise<string | null> {
    if (!DRIVE_ID.test(parent) || !SEGMENT.test(name)) throw new StorageError("Invalid storage key");
    const [found] = await this.list(`'${parent}' in parents and name = '${name}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
    if (found) return found.id;
    return create ? this.createFolder(name, parent) : null;
  }

  /** A new folder in `parent`, or in My Drive's root without one. */
  async createFolder(name: string, parent?: string): Promise<string> {
    const res = await this.call("create folder", `${DRIVE}/files?fields=id`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) }),
    });
    return driveFile(await json(res, "create folder"), "create folder").id;
  }

  /** Exists, is a folder and is not in the trash (404 also when drive.file does not cover it). */
  async isLiveFolder(id: string): Promise<boolean> {
    if (!DRIVE_ID.test(id)) return false;
    const res = await this.call("folder lookup", `${DRIVE}/files/${id}?fields=id,mimeType,trashed`, {}, [404]);
    if (res.status === 404) return false;
    const f = (await json(res, "folder lookup")) as { mimeType?: unknown; trashed?: unknown } | null;
    return f?.mimeType === FOLDER_MIME && f.trashed === false;
  }

  /** The signed-in account's email address (lowercase), from Drive's about resource. */
  async accountEmail(): Promise<string> {
    const res = await this.call("account lookup", `${DRIVE}/about?fields=user(emailAddress)`);
    const email = ((await json(res, "account lookup")) as { user?: { emailAddress?: unknown } } | null)?.user?.emailAddress;
    if (typeof email !== "string") throw new StorageError("Google Drive account lookup failed (invalid response)");
    return email.toLowerCase();
  }
}

/**
 * At connect time: keep the folders of a previous connection when all still exist (untrashed), else create
 * InsightWorkfolio/{Screenshots,Timelapse,TestFiles} in My Drive. Never searches the Drive by name.
 */
export async function setUpFolders(client: DriveClient, previous?: DriveFolders): Promise<DriveFolders> {
  if (previous && (await Promise.all(Object.values(previous).map((id) => client.isLiveFolder(id)))).every(Boolean)) return previous;
  const root = await client.createFolder(ROOT_FOLDER);
  const folders = { root } as DriveFolders;
  for (const area of AREAS) folders[area] = await client.createFolder(area, root);
  return folders;
}

/** SHA-256 and MD5 of a local file, streamed. */
const fileDigests = (path: string) =>
  new Promise<[string, string]>((resolve, reject) => {
    const sha = createHash("sha256");
    const md5 = createHash("md5");
    createReadStream(path)
      .on("data", (c) => {
        sha.update(c);
        md5.update(c);
      })
      .on("error", () => reject(new StorageError("Google Drive upload failed (source file unreadable)")))
      .on("end", () => resolve([sha.digest("hex"), md5.digest("hex")]));
  });

// ---- Adapter --------------------------------------------------------------

export interface GoogleDriveOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  chunkBytes?: number;
}

/** Files under one area folder (Screenshots, Timelapse or TestFiles) of the app's own InsightWorkfolio folder. */
export class GoogleDriveStorage implements FileStorage {
  readonly provider = "GOOGLE_DRIVE" as const;
  readonly deletionMode: ScreenshotDeletionMode;
  readonly client: DriveClient;
  /** The scope Google reported at the last token refresh (verify script). */
  grantedScope?: string;
  private access: { value: string; expiresAt: number } | null = null;
  private base?: string;
  // ponytail: folder IDs cached per process (keyed by parent ID, so a reconnect never hits stale entries);
  // a folder deleted by hand while the API runs fails uploads into it until a restart.
  private readonly ids = new Map<string, string>();
  private readonly creating = new Map<string, Promise<string | null>>();
  private readonly chunkBytes: number;

  constructor(
    private readonly cfg: GoogleDriveConfig,
    private readonly area: DriveArea,
    opts: GoogleDriveOptions = {},
  ) {
    this.client = new DriveClient((fresh) => this.accessToken(fresh), opts.fetchFn, opts.sleep, opts.timeoutMs);
    this.deletionMode = cfg.permanentDelete ? "PERMANENT" : "RECYCLE_BIN";
    this.chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  }

  /** Refresh-token grant. The connection file is re-read for each new token, so a reconnect needs no restart. */
  private async accessToken(fresh: boolean): Promise<string> {
    if (!fresh && this.access && this.access.expiresAt > Date.now() + 5 * 60_000) return this.access.value;
    this.access = null;
    const conn = await readConnection(this.cfg.tokenFile);
    if (!conn) throw new StorageError("Google Drive is not connected yet (GOOGLE-DRIVE-STORAGE-SETUP.md)");
    if (conn.clientId !== this.cfg.clientId || conn.account !== this.cfg.account) {
      throw new StorageError("Google Drive connection file belongs to another OAuth client or account; reconnect Google Drive");
    }
    const t = await tokenRequest(
      this.client.fetchFn,
      { client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: conn.refreshToken, grant_type: "refresh_token" },
      this.client.timeoutMs,
    );
    if (t.scope !== undefined && !onlyDriveFile(t.scope)) throw new StorageError("Google Drive token has a scope other than drive.file; refusing to use it");
    this.grantedScope = t.scope;
    this.base = conn.folders[this.area];
    this.access = { value: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return this.access.value;
  }

  /** The area folder of the current connection. */
  private async ready(): Promise<string> {
    await this.accessToken(false);
    return this.base!;
  }

  private split(key: string) {
    const parts = key.split("/");
    if (parts.length > MAX_SEGMENTS || !parts.every((p) => SEGMENT.test(p))) throw new StorageError("Invalid storage key");
    return { dirs: parts.slice(0, -1), name: parts.at(-1)! };
  }

  /** The folder for `dirs` under the area folder; null when missing and not `create`. Concurrent creators share one creation. */
  private async dir(dirs: string[], create: boolean): Promise<string | null> {
    let parent = await this.ready();
    for (const name of dirs) {
      const k = `${parent}/${name}`;
      let id = this.ids.get(k) ?? null;
      if (!id) {
        if (create) {
          let p = this.creating.get(k);
          if (!p) {
            p = this.client.childFolder(parent, name, true).finally(() => this.creating.delete(k));
            this.creating.set(k, p);
          }
          id = await p;
        } else id = await this.client.childFolder(parent, name, false);
        if (!id) return null;
        this.ids.set(k, id);
      }
      parent = id;
    }
    return parent;
  }

  private async find(parent: string, name: string): Promise<DriveFile | null> {
    // ponytail: two concurrent first uploads of one key could create two files; keys are server-generated UUIDs.
    const [f] = await this.client.list(`'${parent}' in parents and name = '${name}' and mimeType != '${FOLDER_MIME}' and trashed = false`);
    return f ?? null;
  }

  /** Simple upload (multipart create, or media update of the existing file so its ID stays the same). */
  async put(key: string, data: Uint8Array): Promise<StoredItem> {
    const { dirs, name } = this.split(key);
    const parent = (await this.dir(dirs, true))!;
    const existing = await this.find(parent, name);
    const res = existing
      ? await this.client.call("upload", `${UPLOAD}/files/${existing.id}?uploadType=media&fields=${FIELDS}`, {
          method: "PATCH",
          headers: { "content-type": "application/octet-stream" },
          body: data,
        })
      : await this.client.call("upload", `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, multipart({ name, parents: [parent] }, data));
    return verified(await json(res, "upload"), data.length, digest("sha256", data), digest("md5", data));
  }

  /**
   * Resumable upload session, sent in chunks read from disk. After each chunk Google's Range header says
   * how much it holds, so the next chunk starts there. Any failure cancels the session (best effort).
   */
  async putFile(key: string, filePath: string): Promise<StoredItem> {
    const { dirs, name } = this.split(key);
    const [sha256, md5] = await fileDigests(filePath);
    const file = await open(filePath).catch(() => {
      throw new StorageError("Google Drive upload failed (source file unreadable)");
    });
    try {
      const { size: total } = await file.stat();
      if (!total) return await this.put(key, new Uint8Array());
      const parent = (await this.dir(dirs, true))!;
      const existing = await this.find(parent, name);
      const init = await this.client.call("upload session", `${UPLOAD}/files${existing ? `/${existing.id}` : ""}?uploadType=resumable&fields=${FIELDS}`, {
        method: existing ? "PATCH" : "POST",
        headers: { ...JSON_HEADERS, "x-upload-content-type": "application/octet-stream", "x-upload-content-length": String(total) },
        body: JSON.stringify(existing ? {} : { name, parents: [parent] }),
      });
      await init.body?.cancel();
      const session = init.headers.get("location");
      // The bearer token goes along with each chunk, so the session URL must be Google's upload endpoint.
      if (!session?.startsWith(`${UPLOAD}/`)) throw new StorageError("Google Drive upload session failed (invalid response)");
      try {
        const buf = Buffer.alloc(Math.min(this.chunkBytes, total));
        const maxRounds = Math.ceil(total / this.chunkBytes) + MAX_RETRIES + 1;
        for (let start = 0, round = 0; ; round++) {
          if (round >= maxRounds) throw new StorageError("Google Drive upload failed (no progress)");
          const { bytesRead } = await file.read(buf, 0, Math.min(this.chunkBytes, total - start), start);
          if (!bytesRead) throw new StorageError("Google Drive upload failed (source file changed)");
          const end = start + bytesRead - 1;
          const res = await this.client.call("upload", session, { method: "PUT", headers: { "content-range": `bytes ${start}-${end}/${total}` }, body: buf.subarray(0, bytesRead) }, [308]);
          if (res.status !== 308) return verified(await json(res, "upload"), total, sha256, md5);
          await res.body?.cancel();
          // 308 Resume Incomplete: "bytes=0-N" is what Google holds (no Range header: nothing yet).
          const held = /^bytes=0-(\d+)$/.exec(res.headers.get("range") ?? "");
          start = held ? Number(held[1]) + 1 : 0;
          if (start >= total) throw new StorageError("Google Drive upload failed (invalid response)");
        }
      } catch (err) {
        await this.client.fetchFn(session, { method: "DELETE", signal: AbortSignal.timeout(this.client.timeoutMs) }).then((r) => r.body?.cancel(), () => {});
        if (err instanceof StorageError) throw err;
        throw new StorageError(`Google Drive upload failed (${timedOut(err) ? "timed out" : "source file unreadable"})`);
      }
    } finally {
      await file.close();
    }
  }

  async stat(key: string): Promise<StoredItem | null> {
    const { dirs, name } = this.split(key);
    const parent = await this.dir(dirs, false);
    const f = parent && (await this.find(parent, name));
    return f ? toItem(f) : null;
  }

  async get(key: string, maxBytes = SCREENSHOT_LIMITS.maxBytes): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of (await this.download(key, maxBytes)).body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async getStream(key: string, maxBytes: number): Promise<{ stream: Readable; size: number }> {
    const { body, size, cancel } = await this.download(key, maxBytes, STREAM_TIMEOUT_MS);
    const stream = Readable.from(body, { objectMode: false });
    stream.once("close", cancel); // destroyed before the first read: the generator never reached the body
    return { stream, size };
  }

  /** Bytes go through the API (alt=media), never a shareable link. Never yields more than `maxBytes`. */
  private async download(key: string, maxBytes: number, timeoutMs = this.client.timeoutMs) {
    const tooLarge = () => new StorageError("Google Drive download failed (larger than allowed)");
    const item = await this.stat(key);
    if (!item) throw new StorageError("File not found in storage");
    if (item.size > maxBytes) throw tooLarge();
    const res = await this.client.call("download", `${DRIVE}/files/${item.itemId}?alt=media`, {}, [], timeoutMs);
    if (Number(res.headers.get("content-length")) > maxBytes) {
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
        throw new StorageError(`Google Drive download failed (${timedOut(err) ? "timed out" : "interrupted"})`);
      }
    }
    const cancel = () => res.body?.cancel().catch(() => {});
    return { body: bounded(), size: item.size, cancel };
  }

  /** Idempotent. Default: to the Drive trash (recoverable for 30 days); GOOGLE_DRIVE_PERMANENT_DELETE=true deletes for good. */
  async delete(key: string): Promise<void> {
    const item = await this.stat(key);
    if (!item) return;
    if (this.cfg.permanentDelete) await this.client.call("delete", `${DRIVE}/files/${item.itemId}`, { method: "DELETE" }, [404]);
    else await this.client.call("delete", `${DRIVE}/files/${item.itemId}?fields=id`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ trashed: true }) }, [404]);
  }
}

/** multipart/related upload body: JSON metadata, then the bytes. */
function multipart(meta: object, data: Uint8Array): RequestInit {
  const boundary = `wf-${randomUUID()}`;
  return {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]),
  };
}

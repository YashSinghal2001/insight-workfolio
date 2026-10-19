import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Logger, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SCREENSHOT_LIMITS, type ScreenshotDeletionMode, type ScreenshotStorageProvider } from "@workfolio/shared";
import { SignJWT } from "jose";
import type { Env } from "../config/env.js";

/**
 * Where screenshot images live. The database holds metadata only. Keys are server-generated
 * paths ("<employee uuid>/<yyyy-mm>/<uuid>.webp"): no names or content.
 */
export interface ScreenshotStorage {
  readonly provider: ScreenshotStorageProvider;
  /** What `delete` does: a SharePoint recycle-bin delete is still recoverable for a while. */
  readonly deletionMode: ScreenshotDeletionMode;
  /** Stores (or replaces) the file. Resolves only once the provider accepted it. */
  put(key: string, data: Uint8Array): Promise<StoredItem>;
  /** Lookup with the provider's own checksum of the stored bytes; null when the file does not exist. */
  stat(key: string): Promise<StoredItem | null>;
  /** Controlled retrieval: bytes go through the API, never a public or shareable link. */
  get(key: string): Promise<Uint8Array>;
  /** Idempotent: a missing file is not an error. */
  delete(key: string): Promise<void>;
}

export interface StoredItem {
  itemId: string;
  size: number;
  /** QuickXorHash (base64) as computed by the provider; SharePoint/OneDrive for Business report this one. */
  quickXorHash?: string;
}

/** Storage failed or is unreachable. Message carries no secrets, tokens, paths or response bodies. */
export class StorageError extends Error {}

export const SCREENSHOT_STORAGE = Symbol("SCREENSHOT_STORAGE");

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
export class LocalDevStorage implements ScreenshotStorage {
  readonly provider = "LOCAL_DEV" as const;
  readonly deletionMode = "LOCAL_DEV" as const;
  private readonly root: string;

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
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(`${p}.tmp`, data, { mode: 0o600 });
    await rename(`${p}.tmp`, p); // atomic: never a partial file under the final name
    return { itemId: key, size: data.length };
  }

  async stat(key: string): Promise<StoredItem | null> {
    const bytes = await readFile(this.path(key)).catch(() => null);
    return bytes && { itemId: key, size: bytes.length, quickXorHash: quickXorHash(bytes) };
  }

  async get(key: string): Promise<Uint8Array> {
    return readFile(this.path(key)).catch(() => {
      throw new StorageError("Screenshot file not found in storage");
    });
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  /** One of: client secret, or certificate (PKCS#8 private key PEM + SHA-1 thumbprint hex from Entra). */
  clientSecret?: string;
  certificate?: { privateKeyPem: string; thumbprintSha1Hex: string };
  /** The dedicated SharePoint site, and the drive (document library) inside it. */
  siteId: string;
  driveId: string;
  folder: string;
  /** Retention deletes bypass the site recycle bin (permanentDelete). Default: recycle bin. */
  permanentDelete: boolean;
}

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Throttling and transient errors are retried this many times inside one call (desktop retries later anyway). */
const TRANSIENT = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5_000;

/**
 * Microsoft Graph adapter (SharePoint document library), app-only OAuth 2.0 client credentials
 * with a secret or a certificate. Least privilege: `Sites.Selected` with `write` granted on the one
 * screenshot site only (docs/onedrive.md); no tenant-wide Files.* or Sites.ReadWrite.All.
 * NOT VERIFIED against a real tenant yet: exercised with a fake Graph in tests; real checks in
 * apps/api/scripts/verify-graph.mjs once credentials exist.
 */
export class GraphStorage implements ScreenshotStorage {
  readonly provider = "MICROSOFT_GRAPH" as const;
  readonly deletionMode: ScreenshotDeletionMode;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: GraphConfig,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!cfg.clientSecret === !cfg.certificate) throw new Error("Graph storage needs exactly one of a client secret or a certificate");
    this.deletionMode = cfg.permanentDelete ? "PERMANENT" : "RECYCLE_BIN";
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

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 5 * 60_000) return this.token.value;
    const form = new URLSearchParams({ client_id: this.cfg.clientId, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    if (this.cfg.clientSecret) form.set("client_secret", this.cfg.clientSecret);
    else {
      form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      form.set("client_assertion", await this.assertion());
    }
    const res = await this.fetchFn(this.tokenUrl(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }).catch(() => null);
    if (!res?.ok) throw new StorageError(`Microsoft identity platform token request failed${res ? ` (HTTP ${res.status})` : " (unreachable)"}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  private drive() {
    return `${GRAPH}/drives/${encodeURIComponent(this.cfg.driveId)}`;
  }

  /** `/drives/{id}/root:/<folder>/<key>`, each segment URL-encoded. */
  private item(key: string) {
    return `${this.drive()}/root:/${[this.cfg.folder, ...key.split("/")].map(encodeURIComponent).join("/")}`;
  }

  /** One Graph request; transient failures (throttling, 5xx) retried with Retry-After (bounded). */
  async call(op: string, url: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${await this.accessToken()}` } }).catch(() => null);
      if (!res) throw new StorageError(`Microsoft Graph ${op} failed (unreachable)`);
      if (res.ok || okStatuses.includes(res.status)) return res;
      if (res.status === 401) this.token = null;
      if (TRANSIENT.has(res.status) && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get("retry-after"));
        await this.sleep(Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt));
        continue;
      }
      const code = await res.json().then((b) => (b as { error?: { code?: string } }).error?.code, () => undefined);
      throw new StorageError(`Microsoft Graph ${op} failed (HTTP ${res.status}${code ? `, ${code}` : ""})`);
    }
  }

  async put(key: string, data: Uint8Array): Promise<StoredItem> {
    // Simple upload (files up to 250 MB); screenshots are capped at 10 MB.
    const res = await this.call("upload", `${this.item(key)}:/content?@microsoft.graph.conflictBehavior=replace`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: data,
    });
    return toItem(await res.json());
  }

  async stat(key: string): Promise<StoredItem | null> {
    const res = await this.call("lookup", `${this.item(key)}?$select=id,size,file`, {}, [404]);
    return res.status === 404 ? null : toItem(await res.json());
  }

  async get(key: string): Promise<Uint8Array> {
    // Graph answers with a redirect to a short-lived download URL; it is followed here and never
    // handed to a browser (fetch drops the Authorization header on the cross-origin redirect).
    const res = await this.call("download", `${this.item(key)}:/content`);
    // Bounded: never buffer more than a screenshot can be, whatever the provider sends.
    const tooLarge = () => new StorageError("Microsoft Graph download failed (larger than a screenshot can be)");
    if (Number(res.headers.get("content-length")) > SCREENSHOT_LIMITS.maxBytes) {
      await res.body?.cancel();
      throw tooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > SCREENSHOT_LIMITS.maxBytes) throw tooLarge(); // leaving the loop cancels the stream
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    if (!this.cfg.permanentDelete) {
      await this.call("delete", this.item(key), { method: "DELETE" }, [404]);
      return;
    }
    const item = await this.stat(key);
    if (item) await this.call("permanent delete", `${this.drive()}/items/${encodeURIComponent(item.itemId)}/permanentDelete`, { method: "POST" }, [404]);
  }

  /** Configuration check: the drive is a library of the intended site (used by verify-graph and startup diagnostics). */
  async driveBelongsToSite(): Promise<boolean> {
    const res = await this.call("site lookup", `${GRAPH}/sites/${encodeURIComponent(this.cfg.siteId)}/drives?$select=id`);
    const { value } = (await res.json()) as { value: { id: string }[] };
    return value.some((d) => d.id === this.cfg.driveId);
  }
}

const toItem = (j: unknown): StoredItem => {
  const item = j as { id: string; size: number; file?: { hashes?: { quickXorHash?: string } } };
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
    siteId: config.get("GRAPH_SITE_ID", { infer: true })!,
    driveId: config.get("GRAPH_DRIVE_ID", { infer: true })!,
    folder: config.get("GRAPH_FOLDER", { infer: true }),
    permanentDelete: config.get("GRAPH_PERMANENT_DELETE", { infer: true }),
  };
}

export const screenshotStorageProvider: Provider = {
  provide: SCREENSHOT_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): ScreenshotStorage => {
    const logger = new Logger("ScreenshotStorage");
    if (config.get("SCREENSHOT_STORAGE", { infer: true }) === "graph") return new GraphStorage(graphConfigFrom(config));
    const dir = config.get("SCREENSHOT_LOCAL_DIR", { infer: true });
    logger.warn(`Screenshot storage: LOCAL DEVELOPMENT adapter (${resolve(dir)}). Not for production; no Microsoft Graph upload happens.`);
    return new LocalDevStorage(dir);
  },
};

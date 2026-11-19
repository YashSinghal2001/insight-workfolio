import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";

/** The Google OAuth callback route (GoogleDriveOAuthController); GOOGLE_OAUTH_REDIRECT_URI must end in exactly this. */
export const GOOGLE_OAUTH_CALLBACK_PATH = "/api/v1/storage/google-drive/oauth/callback";
/** The Microsoft OneDrive callback route (OneDriveController); ONEDRIVE_REDIRECT_URI must end in exactly this. */
export const ONEDRIVE_CALLBACK_PATH = "/api/v1/storage/onedrive/oauth/callback";
const redirectUriOk = (uri: string, production: boolean, path = GOOGLE_OAUTH_CALLBACK_PATH) => {
  try {
    const u = new URL(uri);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return (
      u.pathname === path &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password &&
      (u.protocol === "https:" || (u.protocol === "http:" && loopback && !production))
    );
  } catch {
    return false;
  }
};

/** `file:` + an absolute path, nothing else (no query such as ?mode=ro, no `file://host/` form). */
const isProductionFileUrl = (url: string) => {
  if (!url.startsWith("file:")) return false;
  const path = url.slice("file:".length);
  return isAbsolute(path) && !path.startsWith("//") && !/[?#]/.test(path);
};

const LOCAL_ORIGINS = "http://localhost:3000,http://localhost:1420,tauri://localhost,http://tauri.localhost";
/** The desktop app's webview origins (macOS, Windows): local to each device, allowed in production. */
const TAURI_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];
/** Express's named ranges for `trust proxy`. `true` (trust every hop) is deliberately not accepted. */
const PROXY_RANGES = new Set(["loopback", "linklocal", "uniquelocal"]);
const isProxyAddress = (p: string) => {
  if (PROXY_RANGES.has(p) || isIP(p)) return true;
  const [ip = "", bits, ...rest] = p.split("/");
  const v = isIP(ip);
  return !rest.length && !!v && /^\d{1,3}$/.test(bits ?? "") && Number(bits) <= (v === 4 ? 32 : 128);
};

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /** Address the API listens on. Loopback by default: a reverse proxy on this host (Caddy) is the only public entry. */
    HOST: z
      .string()
      .default("127.0.0.1")
      .refine((v) => v === "localhost" || isIP(v) !== 0, "must be an IP address or localhost"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    /**
     * Which hops may set X-Forwarded-For, i.e. where req.ip (and so every per-IP rate limit) comes from.
     * A hop count ("1" behind one proxy such as Render's: the client is the address that proxy appended;
     * anything a client puts further left is ignored), "loopback" (default: only a reverse proxy on this
     * host), or a comma list of addresses/CIDRs (plus "linklocal"/"uniquelocal"). Too-trusting values let
     * clients pick their own req.ip; too-strict ones put every client behind the proxy in one bucket.
     */
    TRUST_PROXY: z
      .string()
      .default("loopback")
      .transform((v, ctx) => {
        const s = v.trim();
        if (/^\d{1,2}$/.test(s) && Number(s) <= 10) return Number(s);
        const list = s.split(",").map((p) => p.trim()).filter(Boolean);
        if (list.length && list.every(isProxyAddress)) return list;
        ctx.addIssue({ code: "custom", message: "must be a hop count (0-10), loopback, or a comma-separated list of IP addresses/CIDRs" });
        return z.NEVER;
      }),
    /**
     * Requests per minute per authenticated session (429 + Retry-After), plus a per-IP ceiling of 10x that
     * on all requests (health/ready excluded; offices share one IP). 0 turns both off. Unset: 600 in
     * production, off in development and test. Login, setup-password, pairing and refresh keep their own
     * stricter limits regardless.
     */
    API_RATE_LIMIT_PER_MINUTE: z.preprocess(
      (v) => (typeof v === "string" && !v.trim() ? undefined : v), // empty means unset (the default), never "off"
      z.coerce.number().int().min(0).max(100_000).optional(),
    ),
    CORS_ORIGINS: z
      .string()
      .default(LOCAL_ORIGINS)
      .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),
    DATABASE_URL: z.string().min(1).default("file:./data/dev.db"),
    DATABASE_AUTH_TOKEN: z.string().optional().transform((v) => v || undefined),
    /** HMAC key for access tokens. Optional outside production (an ephemeral key is generated). */
    JWT_SECRET: z
      .string()
      .optional()
      .transform((v) => v || undefined)
      .pipe(z.string().min(32, "must be at least 32 characters").optional()),
    // Attendance policy (configurable MVP defaults, not legal rules; see docs/architecture.md).
    /** ISO weekday the workweek starts on: 1 = Monday … 7 = Sunday. */
    WORKWEEK_START_DAY: z.coerce.number().int().min(1).max(7).default(1),
    /** Scheduled hours per worked day; net time beyond it is reported as overtime. */
    SCHEDULED_HOURS_PER_DAY: z.coerce.number().min(0.5).max(24).default(8),
    /** Offline events older than this are rejected on sync and need a correction. */
    OFFLINE_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    // Activity monitoring policy (configurable MVP defaults; see docs/security.md).
    /** Foreground-application sampling interval in seconds. */
    ACTIVITY_SAMPLE_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
    /** No input for this long counts as idle. */
    IDLE_THRESHOLD_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    // Screenshot storage (see docs/onedrive.md). "local" writes files under SCREENSHOT_LOCAL_DIR and
    // exists for development only; production must use Microsoft Graph (SharePoint document library).
    SCREENSHOT_STORAGE: z.enum(["local", "graph", "onedrive", "google-drive"]).default("local"),
    SCREENSHOT_LOCAL_DIR: z.string().min(1).default("./data/screenshots"),
    /** Entra ID app registration (client credentials). Secret stays on the server only. */
    GRAPH_TENANT_ID: z.string().optional().transform((v) => v || undefined),
    GRAPH_CLIENT_ID: z.string().optional().transform((v) => v || undefined),
    GRAPH_CLIENT_SECRET: z.string().optional().transform((v) => v || undefined),
    /** Certificate credential instead of a secret: PKCS#8 private key file + the SHA-1 thumbprint Entra shows. */
    GRAPH_CERT_KEY_PATH: z.string().optional().transform((v) => v || undefined),
    GRAPH_CERT_THUMBPRINT: z.string().regex(/^[0-9A-Fa-f:]{40,59}$/).optional().or(z.literal("").transform(() => undefined)),
    /** Optional: the SharePoint site holding the drive (Graph site ID, "host,siteCollectionId,webId"); only verify:graph uses it. */
    GRAPH_SITE_ID: z.string().optional().transform((v) => v || undefined),
    /** Retention deletes bypass the SharePoint recycle bin. Off: deleted files stay recoverable there for a while. */
    GRAPH_PERMANENT_DELETE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    /** Drive ID of the drive holding the storage folder (a SharePoint document library or a OneDrive). */
    GRAPH_DRIVE_ID: z.string().optional().transform((v) => v || undefined),
    /** Folder display name: checked by verify:graph-storage; the path under the drive root when GRAPH_FOLDER_ID is unset. */
    GRAPH_FOLDER: z.string().regex(/^[\w -]{1,64}$/).default("Workfolio Screenshots"),
    /** Item ID of the dedicated storage folder in that drive. Set: files are addressed under it, never through the drive root. */
    GRAPH_FOLDER_ID: z.string().optional().transform((v) => v || undefined),
    // Google Drive (GOOGLE-DRIVE-STORAGE-SETUP.md): TESTING POC on a personal My Drive. OAuth "Web application"
    // client, scope drive.file only. Use a separate client and token file per environment.
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional().transform((v) => v || undefined),
    /** Server only; never logged, never sent to the dashboard or desktops. */
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional().transform((v) => v || undefined),
    /** Exactly the URI registered in Google Cloud: <API origin> + GOOGLE_OAUTH_CALLBACK_PATH. */
    GOOGLE_OAUTH_REDIRECT_URI: z.string().optional().transform((v) => v || undefined),
    /** Where the connect flow keeps the refresh token and folder IDs (absolute path; file 0600, directory 0700). */
    GOOGLE_DRIVE_TOKEN_FILE: z
      .string()
      .optional()
      .transform((v) => v || undefined)
      .refine((v) => !v || isAbsolute(v), "must be an absolute path"),
    /** The one Google account allowed to connect; any other account's grant is revoked at the callback. */
    GOOGLE_DRIVE_ACCOUNT_EMAIL: z
      .string()
      .optional()
      .transform((v) => v?.trim().toLowerCase() || undefined)
      .refine((v) => !v || z.email().safeParse(v).success, "must be an email address"),
    /** Deletes bypass the Drive trash. Off: deleted files stay recoverable in the account's trash for 30 days. */
    GOOGLE_DRIVE_PERMANENT_DELETE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    // Microsoft OneDrive of the dedicated IT storage account (docs/onedrive.md), delegated Files.ReadWrite only.
    // Entra app registration: "Web" platform, redirect URI = ONEDRIVE_REDIRECT_URI, no application permissions.
    /**
     * Desktop auto-update: the updater PUBLIC key (base64, exactly tauri.conf.json plugins.updater.pubkey of the
     * builds this server updates). The API verifies every package with it before a release reaches anyone.
     * Unset: releases cannot be tested or published. Never the private key (docs/desktop/AUTO-UPDATE-SECURITY.md).
     */
    DESKTOP_UPDATER_PUBKEY: z.string().optional().transform((v) => v?.trim() || undefined),
    ONEDRIVE_TENANT_ID: z.string().optional().transform((v) => v || undefined),
    ONEDRIVE_CLIENT_ID: z.string().optional().transform((v) => v || undefined),
    /** Server only; never logged, never sent to the dashboard or desktops. */
    ONEDRIVE_CLIENT_SECRET: z.string().optional().transform((v) => v || undefined),
    /** Exactly the URI registered in Entra: <API origin> + ONEDRIVE_CALLBACK_PATH. */
    ONEDRIVE_REDIRECT_URI: z.string().optional().transform((v) => v || undefined),
    /** Encrypted connection file (refresh token, drive and folder IDs). Absolute path on a persistent disk. */
    ONEDRIVE_TOKEN_FILE: z
      .string()
      .optional()
      .transform((v) => v || undefined)
      .refine((v) => !v || isAbsolute(v), "must be an absolute path"),
    /** 32 random bytes, base64 (openssl rand -base64 32): encrypts ONEDRIVE_TOKEN_FILE. Changing it means reconnecting. */
    ONEDRIVE_TOKEN_KEY: z
      .string()
      .optional()
      .transform((v) => v || undefined)
      .refine((v) => !v || Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64 encoded"),
    /** The one account allowed to connect (its sign-in name), e.g. it@tffdigital.com. */
    ONEDRIVE_ACCOUNT_EMAIL: z
      .string()
      .optional()
      .transform((v) => v?.trim().toLowerCase() || undefined)
      .refine((v) => !v || z.email().safeParse(v).success, "must be an email address"),
    /** The app folder at the OneDrive root; every file lives under it. */
    ONEDRIVE_ROOT_FOLDER: z.string().regex(/^[\w -]{1,64}$/).default("InsightWorkfolio"),
    /**
     * Off-site database backups (deploy/scripts/backup-db.sh → cli/backup-upload.ts): a dedicated subfolder of
     * ONEDRIVE_ROOT_FOLDER, never the screenshot or timelapse folders. Only gpg-encrypted files are uploaded.
     */
    ONEDRIVE_BACKUP_FOLDER: z
      .string()
      .regex(/^[\w -]{1,64}$/)
      .default("db-backups")
      .refine((v) => !/^(screenshots|timelapses)$/i.test(v), "must not be the screenshot or timelapse folder"),
    /** Delete off-site backups older than this many days after each upload (recycle bin). Unset: never delete. */
    ONEDRIVE_BACKUP_KEEP_DAYS: z.coerce.number().int().min(1).max(3650).optional(),
    // Screenshot timelapses (docs/timelapse.md). Encoded by an operator-installed FFmpeg with libx264;
    // without it the feature reports itself unavailable. Videos are a short-lived cache on this host.
    FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
    /** Default ./data/timelapses; under NODE_ENV=test a fresh temporary folder, so tests never sweep a real one. */
    TIMELAPSE_DIR: z.string().optional().transform((v) => v || undefined),
    /** A finished video is deleted after this many hours (it can be made again from the screenshots). */
    TIMELAPSE_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    /** Videos are refused (not queued, not encoded) while the TIMELAPSE_DIR filesystem has less free space than this. 0 disables. */
    TIMELAPSE_MIN_FREE_MB: z.coerce.number().int().min(0).max(1_000_000).default(1024),
    // Email reports (docs/email-reports.md). No real provider is integrated yet: "none" generates and
    // records reports without emailing them; "mock" keeps messages in memory (development and tests only).
    REPORT_MAIL_PROVIDER: z.enum(["none", "mock"]).default("none"),
    /** How often the report scheduler checks for due reports and retries; 0 turns it off. */
    REPORT_SCHEDULER_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
    // Website tracking (docs/website-usage.md). In production, collection stays blocked until the
    // operator sets this after HR/Legal approved the policy and the employee notice; an admin
    // turning the policy on in the dashboard is not that approval.
    WEBSITE_TRACKING_APPROVED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    /**
     * The scheduled website-retention purge deletes intervals only once the operator sets this after
     * HR/Legal approved the retention period (and, in production, WEBSITE_TRACKING_APPROVED). The admin's
     * confirmed manual run (POST /websites/retention/run) is not gated by it.
     */
    WEBSITE_RETENTION_APPROVED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    /** Base of password-setup links: printed by the admin bootstrap CLI and put in invitation emails. */
    DASHBOARD_URL: z.url().default("http://localhost:3000"),
    // Employee invitation emails (docs/invitations.md). Separate from REPORT_MAIL_PROVIDER: configuring it
    // emails invitations only. none = the admin hands the setup link over (as before); mock = in memory,
    // development and tests only; graph = Microsoft Graph sendMail, app-only, from MAIL_SENDER;
    // graph-delegated = Microsoft Graph sendMail with the OneDrive connection's delegated token (Mail.Send),
    // as ONEDRIVE_ACCOUNT_EMAIL: needs the ONEDRIVE_* settings, none of the MAIL_GRAPH_* ones.
    INVITATION_MAIL_PROVIDER: z.enum(["none", "mock", "graph", "graph-delegated"]).default("none"),
    MAIL_GRAPH_TENANT_ID: z.string().optional().transform((v) => v || undefined),
    MAIL_GRAPH_CLIENT_ID: z.string().optional().transform((v) => v || undefined),
    /** Server only; never logged, never sent to the dashboard or desktops. */
    MAIL_GRAPH_CLIENT_SECRET: z.string().optional().transform((v) => v || undefined),
    /** The mailbox invitations are sent from, and the support address named in them, e.g. IT@TFFDigital.com. */
    MAIL_SENDER: z
      .string()
      .optional()
      .transform((v) => v?.trim() || undefined)
      .refine((v) => !v || z.email().safeParse(v).success, "must be an email address"),
  })
  .refine((env) => env.NODE_ENV !== "production" || env.INVITATION_MAIL_PROVIDER !== "mock", {
    message: "INVITATION_MAIL_PROVIDER=mock is for development and tests only",
    path: ["INVITATION_MAIL_PROVIDER"],
  })
  .refine((env) => env.INVITATION_MAIL_PROVIDER !== "graph" || !!(env.MAIL_GRAPH_TENANT_ID && env.MAIL_GRAPH_CLIENT_ID && env.MAIL_GRAPH_CLIENT_SECRET && env.MAIL_SENDER), {
    message: "MAIL_GRAPH_TENANT_ID, MAIL_GRAPH_CLIENT_ID, MAIL_GRAPH_CLIENT_SECRET and MAIL_SENDER are all required for INVITATION_MAIL_PROVIDER=graph",
    path: ["INVITATION_MAIL_PROVIDER"],
  })
  // Delegated mail is sent as the OneDrive account and nobody else: the sender must be that account.
  .refine((env) => env.INVITATION_MAIL_PROVIDER !== "graph-delegated" || (!!env.ONEDRIVE_CLIENT_ID && !!env.MAIL_SENDER && env.MAIL_SENDER.toLowerCase() === env.ONEDRIVE_ACCOUNT_EMAIL), {
    message: "INVITATION_MAIL_PROVIDER=graph-delegated needs the OneDrive settings (ONEDRIVE_*) and MAIL_SENDER equal to ONEDRIVE_ACCOUNT_EMAIL",
    path: ["INVITATION_MAIL_PROVIDER"],
  })
  // Production: a hosted database (libsql:// or https://; no wss://, Turso refuses the WebSocket transport) or a
  // persistent local file by ABSOLUTE path (the VPS: outside the repository, on a disk that survives deploys).
  // The relative development default, :memory: and a file: URL with a query are refused.
  .refine((env) => env.NODE_ENV !== "production" || /^(libsql|https):\/\//.test(env.DATABASE_URL) || isProductionFileUrl(env.DATABASE_URL), {
    message: "DATABASE_URL must be libsql:// or https:// (Turso) or file:/absolute/path (persistent local SQLite) in production; a relative file:, :memory: and wss:// are not allowed",
    path: ["DATABASE_URL"],
  })
  // Every environment: a remote URL carries no credentials or query (libsql accepts ?authToken= and echoes
  // the whole URL in some errors; the token belongs in DATABASE_AUTH_TOKEN), and plaintext http:// is
  // allowed only to this machine (tests), so a token is never sent in clear.
  .refine(
    (env) => {
      const url = env.DATABASE_URL;
      if (url.startsWith("file:") || url === ":memory:") return true;
      try {
        const u = new URL(url);
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
        return !u.username && !u.password && !u.search && (u.protocol === "libsql:" || u.protocol === "https:" || (u.protocol === "http:" && loopback));
      } catch {
        return false;
      }
    },
    { message: "DATABASE_URL must be libsql://<host> or https://<host> without credentials or query string (put the token in DATABASE_AUTH_TOKEN)", path: ["DATABASE_URL"] },
  )
  .refine((env) => env.NODE_ENV !== "production" || env.REPORT_MAIL_PROVIDER !== "mock", {
    message: "REPORT_MAIL_PROVIDER=mock is for development and tests only",
    path: ["REPORT_MAIL_PROVIDER"],
  })
  .refine((env) => env.NODE_ENV !== "production" || env.SCREENSHOT_STORAGE !== "local", {
    message: "SCREENSHOT_STORAGE must be onedrive or graph (or google-drive for testing) in production; local storage is for development only",
    path: ["SCREENSHOT_STORAGE"],
  })
  .refine(
    (env) =>
      !(env.SCREENSHOT_STORAGE === "onedrive" || env.ONEDRIVE_CLIENT_ID) ||
      !!(env.ONEDRIVE_TENANT_ID && env.ONEDRIVE_CLIENT_ID && env.ONEDRIVE_CLIENT_SECRET && env.ONEDRIVE_REDIRECT_URI && env.ONEDRIVE_TOKEN_FILE && env.ONEDRIVE_TOKEN_KEY && env.ONEDRIVE_ACCOUNT_EMAIL),
    {
      message: "ONEDRIVE_TENANT_ID, ONEDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_SECRET, ONEDRIVE_REDIRECT_URI, ONEDRIVE_TOKEN_FILE, ONEDRIVE_TOKEN_KEY and ONEDRIVE_ACCOUNT_EMAIL are all required for OneDrive",
      path: ["ONEDRIVE_CLIENT_ID"],
    },
  )
  .refine((env) => !env.ONEDRIVE_REDIRECT_URI || redirectUriOk(env.ONEDRIVE_REDIRECT_URI, env.NODE_ENV === "production", ONEDRIVE_CALLBACK_PATH), {
    message: `ONEDRIVE_REDIRECT_URI must be https://<API host>${ONEDRIVE_CALLBACK_PATH} (plain http only for localhost outside production), without query or fragment`,
    path: ["ONEDRIVE_REDIRECT_URI"],
  })
  .refine(
    (env) =>
      !(env.SCREENSHOT_STORAGE === "google-drive" || env.GOOGLE_OAUTH_CLIENT_ID) ||
      !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI && env.GOOGLE_DRIVE_TOKEN_FILE && env.GOOGLE_DRIVE_ACCOUNT_EMAIL),
    {
      message: "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI, GOOGLE_DRIVE_TOKEN_FILE and GOOGLE_DRIVE_ACCOUNT_EMAIL are all required for Google Drive",
      path: ["GOOGLE_OAUTH_CLIENT_ID"],
    },
  )
  .refine((env) => !env.GOOGLE_OAUTH_REDIRECT_URI || redirectUriOk(env.GOOGLE_OAUTH_REDIRECT_URI, env.NODE_ENV === "production"), {
    message: `GOOGLE_OAUTH_REDIRECT_URI must be https://<API host>${GOOGLE_OAUTH_CALLBACK_PATH} (plain http only for localhost outside production), without query or fragment`,
    path: ["GOOGLE_OAUTH_REDIRECT_URI"],
  })
  .refine((env) => env.SCREENSHOT_STORAGE !== "graph" || (env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_DRIVE_ID), {
    message: "GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_DRIVE_ID are required for graph storage",
    path: ["SCREENSHOT_STORAGE"],
  })
  .refine((env) => env.SCREENSHOT_STORAGE !== "graph" || !env.GRAPH_CLIENT_SECRET !== !(env.GRAPH_CERT_KEY_PATH && env.GRAPH_CERT_THUMBPRINT), {
    message: "Set exactly one Graph credential: GRAPH_CLIENT_SECRET, or GRAPH_CERT_KEY_PATH with GRAPH_CERT_THUMBPRINT",
    path: ["SCREENSHOT_STORAGE"],
  })
  .refine((env) => env.NODE_ENV !== "production" || env.CORS_ORIGINS.every((o) => o.startsWith("https://") || TAURI_ORIGINS.includes(o)), {
    message: "CORS_ORIGINS must be set to https:// origins (plus the desktop app origins) in production; localhost and plain http are not allowed",
    path: ["CORS_ORIGINS"],
  })
  .refine((env) => env.NODE_ENV !== "production" || env.DASHBOARD_URL.startsWith("https://"), {
    message: "DASHBOARD_URL must be https:// in production (password setup links are sent to it)",
    path: ["DASHBOARD_URL"],
  })
  .refine((env) => env.NODE_ENV !== "production" || env.JWT_SECRET, {
    message: "JWT_SECRET is required in production",
    path: ["JWT_SECRET"],
  });

export type Env = z.infer<typeof envSchema>;

/** Validates process env at boot. Error lists variable names and issues only, never values. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}

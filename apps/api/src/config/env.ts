import { z } from "zod";

const LOCAL_ORIGINS = "http://localhost:3000,http://localhost:1420,tauri://localhost,http://tauri.localhost";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
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
    SCREENSHOT_STORAGE: z.enum(["local", "graph"]).default("local"),
    SCREENSHOT_LOCAL_DIR: z.string().min(1).default("./data/screenshots"),
    /** Entra ID app registration (client credentials). Secret stays on the server only. */
    GRAPH_TENANT_ID: z.string().optional().transform((v) => v || undefined),
    GRAPH_CLIENT_ID: z.string().optional().transform((v) => v || undefined),
    GRAPH_CLIENT_SECRET: z.string().optional().transform((v) => v || undefined),
    /** Certificate credential instead of a secret: PKCS#8 private key file + the SHA-1 thumbprint Entra shows. */
    GRAPH_CERT_KEY_PATH: z.string().optional().transform((v) => v || undefined),
    GRAPH_CERT_THUMBPRINT: z.string().regex(/^[0-9A-Fa-f:]{40,59}$/).optional().or(z.literal("").transform(() => undefined)),
    /** The dedicated SharePoint site (Graph site ID, "host,siteCollectionId,webId"). */
    GRAPH_SITE_ID: z.string().optional().transform((v) => v || undefined),
    /** Retention deletes bypass the SharePoint recycle bin. Off: deleted files stay recoverable there for a while. */
    GRAPH_PERMANENT_DELETE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    /** Drive ID of the dedicated SharePoint document library (not a personal OneDrive). */
    GRAPH_DRIVE_ID: z.string().optional().transform((v) => v || undefined),
    /** Folder inside that library; created on first upload. */
    GRAPH_FOLDER: z.string().regex(/^[\w -]{1,64}$/).default("Workfolio Screenshots"),
    /** Used only to print password-setup links (admin bootstrap CLI). */
    DASHBOARD_URL: z.url().default("http://localhost:3000"),
  })
  .refine((env) => env.NODE_ENV !== "production" || /^(libsql|https|wss):\/\//.test(env.DATABASE_URL), {
    message: "DATABASE_URL must point to Turso (libsql://) in production; local SQLite is not allowed",
    path: ["DATABASE_URL"],
  })
  .refine((env) => env.NODE_ENV !== "production" || env.SCREENSHOT_STORAGE === "graph", {
    message: "SCREENSHOT_STORAGE must be graph in production; local storage is for development only",
    path: ["SCREENSHOT_STORAGE"],
  })
  .refine((env) => env.SCREENSHOT_STORAGE !== "graph" || (env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_SITE_ID && env.GRAPH_DRIVE_ID), {
    message: "GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_SITE_ID and GRAPH_DRIVE_ID are required for graph storage",
    path: ["SCREENSHOT_STORAGE"],
  })
  .refine((env) => env.SCREENSHOT_STORAGE !== "graph" || !env.GRAPH_CLIENT_SECRET !== !(env.GRAPH_CERT_KEY_PATH && env.GRAPH_CERT_THUMBPRINT), {
    message: "Set exactly one Graph credential: GRAPH_CLIENT_SECRET, or GRAPH_CERT_KEY_PATH with GRAPH_CERT_THUMBPRINT",
    path: ["SCREENSHOT_STORAGE"],
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

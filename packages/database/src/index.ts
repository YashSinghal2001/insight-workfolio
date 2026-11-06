import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client } from "@libsql/client";

export type { Client as DatabaseClient, InStatement, Row } from "@libsql/client";

export interface DatabaseConfig {
  /** `libsql://<db>.turso.io` in hosted envs, `file:./data/dev.db` for local development. */
  url: string;
  /** Turso auth token. Required for remote `libsql://` URLs, ignored for `file:` URLs. */
  authToken?: string;
}

export function createDatabase(config: DatabaseConfig): Client {
  const remote = !config.url.startsWith("file:") && config.url !== ":memory:";
  if (remote && !config.authToken) {
    throw new Error("DATABASE_AUTH_TOKEN is required for remote libSQL/Turso URLs");
  }
  if (config.url.startsWith("file:")) {
    mkdirSync(dirname(config.url.slice("file:".length)), { recursive: true });
  }
  // Local files: every pooled connection waits up to 5 s for another process's write lock (a PRAGMA
  // would reach only one connection of the pool). Remote Turso has no file lock.
  return createClient({ url: config.url, authToken: remote ? config.authToken : undefined, ...(remote ? {} : { timeout: 5000 }) });
}

/** Round-trips a trivial query; throws if the database is unreachable. Returns latency in ms. */
export async function pingDatabase(db: Client): Promise<number> {
  const started = performance.now();
  await db.execute("SELECT 1");
  return Math.round(performance.now() - started);
}

export { MIGRATIONS, migrate, migrationStatus, schemaVersion, type MigrationStatus } from "./migrations.js";

/**
 * Local file databases only: switches the file to write-ahead logging, so the API's pooled readers are
 * not blocked by a write (and vice versa). The mode is stored in the file, so it persists across
 * connections and restarts; repeating the call is a no-op. Returns the resulting journal mode
 * ("wal"; ":memory:" answers "memory"). Never call it on a hosted (libsql://, https://) database.
 */
export async function enableWal(db: Client): Promise<string> {
  return String((await db.execute("PRAGMA journal_mode = WAL")).rows[0]?.journal_mode ?? "").toLowerCase();
}

/** The file's current journal mode (read-only). */
export async function journalMode(db: Client): Promise<string> {
  return String((await db.execute("PRAGMA journal_mode")).rows[0]?.journal_mode ?? "").toLowerCase();
}

/** Whether this connection enforces foreign keys (the schema relies on them). */
export async function foreignKeysEnforced(db: Client): Promise<boolean> {
  return Number((await db.execute("SELECT foreign_keys FROM pragma_foreign_keys")).rows[0]?.foreign_keys) === 1;
}

/** True for SQLITE_CONSTRAINT_UNIQUE errors; `column` narrows to e.g. "users.email". */
export function isUniqueViolation(err: unknown, column?: string): boolean {
  const e = err as { code?: string; extendedCode?: string; message?: string } | null;
  const unique = e?.extendedCode === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/.test(e?.message ?? "");
  return unique && (!column || (e?.message ?? "").includes(column));
}

const GUARDS = ["attendance_overlap", "attendance_immutable", "break_overlap", "break_open", "append_only", "already_reviewed", "activity_overlap", "activity_too_long", "screenshot_immutable", "screenshot_transition", "website_overlap", "unknown_notice"] as const;
export type GuardViolation = (typeof GUARDS)[number];

/** Name of the schema trigger guard (migrations 0002–0007) that rejected a write, if any. */
export function guardViolation(err: unknown): GuardViolation | undefined {
  const message = (err as { message?: string } | null)?.message ?? "";
  return GUARDS.find((g) => message.includes(g));
}

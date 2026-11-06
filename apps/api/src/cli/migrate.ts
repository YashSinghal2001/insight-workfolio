/**
 * Migrate-only command: applies pending schema migrations without booting the API.
 *
 *   pnpm --filter @workfolio/api build
 *   pnpm --filter @workfolio/api db:migrate [--dry-run]
 *
 * - Environment is loaded like admin:create: ./.env when present, then validated (DATABASE_URL,
 *   DATABASE_AUTH_TOKEN). Values are never printed.
 * - Prints the target host first (never the token or a local path).
 * - --dry-run lists applied and pending migrations and checks applied checksums (migrationStatus,
 *   SELECTs only); it never writes.
 * - A real run switches a local file to WAL (persistent), applies pending migrations (each atomically,
 *   safe to repeat), then checks that the connection enforces foreign keys and prints the schema version.
 *   This is the only migration path for a production database (the API verifies only at boot).
 * Exit codes: 0 done, 1 failure (unknown/edited migration, failed statement, foreign keys off).
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createDatabase, enableWal, foreignKeysEnforced, MIGRATIONS, migrate, migrationStatus, schemaVersion } from "@workfolio/database";
import { validateEnv } from "../config/env.js";

const out = (line: string) => process.stdout.write(`${line}\n`);
/** Which database is targeted, without the token, path or any query string. */
const target = (url: string) => (url.startsWith("file:") || url === ":memory:" ? "local SQLite" : new URL(url).host);

async function dryRun(url: string, authToken: string | undefined): Promise<number> {
  // A missing local file would be created by opening it: report everything pending instead.
  const path = url.startsWith("file:") ? url.slice("file:".length) : null;
  let status = { applied: [] as string[], pending: MIGRATIONS.map((m) => m.id), unknown: [] as string[], edited: [] as string[] };
  if (!path || existsSync(path)) {
    const db = createDatabase({ url, authToken });
    try {
      status = await migrationStatus(db); // SELECTs only
    } finally {
      db.close();
    }
  }
  for (const id of status.unknown) out(`UNKNOWN  ${id} (applied by a newer build)`);
  for (const id of status.edited) out(`EDITED   ${id} (checksum mismatch)`);
  out(`Applied: ${status.applied.length + status.unknown.length}; pending: ${status.pending.length}`);
  for (const id of status.pending) out(`PENDING  ${id}`);
  out("Dry run: nothing was written.");
  return status.unknown.length || status.edited.length ? 1 : 0;
}

async function run(url: string, authToken: string | undefined): Promise<number> {
  const db = createDatabase({ url, authToken });
  try {
    // A local file is switched to WAL here (persistent; the production API only verifies and never writes at boot).
    if (url.startsWith("file:")) out(`Journal mode ${await enableWal(db)}`);
    const ran = await migrate(db);
    for (const id of ran) out(`APPLIED  ${id}`);
    if (!ran.length) out("No pending migrations.");
    if (!(await foreignKeysEnforced(db))) {
      console.error("Foreign keys are NOT enforced on this connection; the schema relies on them.");
      return 1;
    }
    out("Foreign keys enforced.");
    out(`Schema version ${await schemaVersion(db)}`);
    return 0;
  } finally {
    db.close();
  }
}

if (existsSync(".env")) process.loadEnvFile(".env");
const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
try {
  const env = validateEnv(process.env);
  out(`Target: ${target(env.DATABASE_URL)}${values["dry-run"] ? " (dry run)" : ""}`);
  process.exitCode = await (values["dry-run"] ? dryRun : run)(env.DATABASE_URL, env.DATABASE_AUTH_TOKEN);
} catch (err) {
  // Messages name migrations or variables, never values; strip the token anyway in case a driver echoes it.
  const token = process.env.DATABASE_AUTH_TOKEN;
  const message = String((err as Error).message ?? err);
  console.error(`Migration failed: ${token ? message.split(token).join("[redacted]") : message}`);
  process.exitCode = 1;
}

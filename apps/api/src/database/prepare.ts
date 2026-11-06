import { enableWal, foreignKeysEnforced, journalMode, migrate, migrationStatus, schemaVersion, type DatabaseClient } from "@workfolio/database";

/** Hosted = remote libSQL/Turso (libsql://, https://). Local files and :memory: are the developer workflow and the VPS. */
export const isHostedDatabaseUrl = (url: string) => !url.startsWith("file:") && url !== ":memory:";

export interface PrepareOptions {
  /**
   * Check the schema only; never migrate. True for every hosted database and for any database in
   * production (the persistent SQLite file on the VPS), so schema changes reach production only through
   * the approved `db:migrate` command. False = the developer workflow: pending migrations are applied.
   */
  verifyOnly: boolean;
  /** A local file or :memory: (where journal mode can be set), as opposed to a hosted database. */
  local: boolean;
}

/** Startup options for `url` in `nodeEnv`: production and hosted databases verify only; a local file outside production migrates. */
export const prepareOptionsFor = (url: string, nodeEnv: string): PrepareOptions => {
  const local = !isHostedDatabaseUrl(url);
  return { verifyOnly: !local || nodeEnv === "production", local };
};

/**
 * Startup checks for the API's database. Verify-only: never writes (reads only); refuses to start on
 * pending, unknown or edited migrations, and warns when a local file is not in WAL mode (db:migrate sets it).
 * Otherwise (local, not production): switches the file to WAL and applies pending migrations.
 * Both: refuse if foreign keys are off. Messages name migration ids only, never the URL or token.
 */
export async function prepareDatabase(db: DatabaseClient, opts: PrepareOptions, log: (line: string) => void = () => {}): Promise<string | null> {
  if (opts.verifyOnly) {
    const { pending, unknown, edited } = await migrationStatus(db);
    if (unknown.length) throw new Error(`Database has migrations this build does not know (${unknown.join(", ")}); refusing to start`);
    if (edited.length) throw new Error(`Migrations changed after they were applied (checksum mismatch: ${edited.join(", ")}); refusing to start`);
    if (pending.length) {
      throw new Error(
        `Database has ${pending.length} pending migration(s) (${pending.join(", ")}); the API does not migrate at startup in production or on a hosted database. ` +
          "Apply them with the approved migration command `pnpm --filter @workfolio/api db:migrate`, then restart",
      );
    }
    if (opts.local) {
      const mode = await journalMode(db);
      if (mode !== "wal" && mode !== "memory") log(`Warning: the database file is in journal mode "${mode}", not WAL; run db:migrate once to switch it`);
    }
  } else {
    if (opts.local) await enableWal(db);
    const applied = await migrate(db);
    if (applied.length) log(`Applied migrations: ${applied.join(", ")}`);
  }
  // The schema's integrity rules (RESTRICT references) depend on this; never run without it.
  if (!(await foreignKeysEnforced(db))) throw new Error("The database connection does not enforce foreign keys; refusing to start");
  const version = await schemaVersion(db);
  log(`Schema version ${version}`);
  return version;
}

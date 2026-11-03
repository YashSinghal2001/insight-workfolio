import { foreignKeysEnforced, migrate, migrationStatus, schemaVersion, type DatabaseClient } from "@workfolio/database";

/** Hosted = remote libSQL/Turso (libsql://, https://). Local files and :memory: are the developer workflow. */
export const isHostedDatabaseUrl = (url: string) => !url.startsWith("file:") && url !== ":memory:";

/**
 * Startup checks for the API's database. Local: applies pending migrations (developer workflow).
 * Hosted: never migrates (reads only); refuses to start on pending, unknown or edited migrations, so
 * schema changes go only through the approved `db:migrate` command. Both: refuse if foreign keys are off.
 * Messages name migration ids only, never the URL or token.
 */
export async function prepareDatabase(db: DatabaseClient, hosted: boolean, log: (line: string) => void = () => {}): Promise<string | null> {
  if (hosted) {
    const { pending, unknown, edited } = await migrationStatus(db);
    if (unknown.length) throw new Error(`Database has migrations this build does not know (${unknown.join(", ")}); refusing to start`);
    if (edited.length) throw new Error(`Migrations changed after they were applied (checksum mismatch: ${edited.join(", ")}); refusing to start`);
    if (pending.length) {
      throw new Error(
        `Hosted database has ${pending.length} pending migration(s) (${pending.join(", ")}); the API does not migrate hosted databases at startup. ` +
          "Apply them with the approved migration command `pnpm --filter @workfolio/api db:migrate`, then restart",
      );
    }
  } else {
    const applied = await migrate(db);
    if (applied.length) log(`Applied migrations: ${applied.join(", ")}`);
  }
  // The schema's integrity rules (RESTRICT references) depend on this; never run without it.
  if (!(await foreignKeysEnforced(db))) throw new Error("The database connection does not enforce foreign keys; refusing to start");
  const version = await schemaVersion(db);
  log(`Schema version ${version}`);
  return version;
}

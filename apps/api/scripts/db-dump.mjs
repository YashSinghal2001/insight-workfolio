// READ-ONLY logical dump of a libSQL/Turso database (schema + data, including schema_migrations) to a
// timestamped .sql file. Run before every migration-bearing deploy (docs/database-operations.md).
//
//   pnpm build:packages
//   pnpm --filter @workfolio/api db:dump --db-env <path> [--out <dir>]          (preferred for Turso)
//   pnpm --filter @workfolio/api db:dump file:/abs/path/copy.db [--out <dir>]
//   DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… pnpm --filter @workfolio/api db:dump [--out <dir>]
//
// With --db-env, DATABASE_URL and DATABASE_AUTH_TOKEN come ONLY from that file (parsed into a local
// object; process.env is never read for them). Otherwise the URL is the first argument or DATABASE_URL and
// the token is DATABASE_AUTH_TOKEN. Only libsql://, https:// and existing file: URLs are accepted. The URL
// and token are never printed (only the host); the token is redacted from any error. Output goes to --out,
// else DUMP_DIR, else ~/insight-workfolio-backups (never inside the repo: the dump holds personal data),
// file mode 600. Everything is read in one read transaction (BEGIN TRANSACTION READONLY: a consistent
// snapshot, enforced read-only by the server); nothing is written to the database, and the file is written
// only after every read succeeded. Restore: sqlite3 <new.db> < <dump.sql> (see the doc).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { createDatabase } from "@workfolio/database";

const usage = "usage: db-dump.mjs [--db-env <path> | <file:|libsql://|https:// URL>] [--out <dir>]  (or set DATABASE_URL)";
const fail = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

let values, positionals;
try {
  ({ values, positionals } = parseArgs({ options: { out: { type: "string" }, "db-env": { type: "string" } }, allowPositionals: true }));
} catch {
  fail(usage);
}
let env = process.env;
if (values["db-env"]) {
  if (positionals.length) fail("give either --db-env or a URL argument, not both");
  try {
    env = parseEnv(readFileSync(values["db-env"], "utf8"));
  } catch {
    fail("the env file could not be read. Nothing was contacted.");
  }
}
const url = ((values["db-env"] ? undefined : positionals[0]) ?? env.DATABASE_URL ?? "").trim();
const token = env.DATABASE_AUTH_TOKEN?.trim() || undefined;
const redact = (s) => {
  let out = String(s).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted token]").replace(/authToken=[^&\s'"]+/gi, "authToken=[redacted]");
  return token ? out.split(token).join("[redacted]") : out;
};
const outDir = resolve(values.out ?? process.env.DUMP_DIR ?? join(homedir(), "insight-workfolio-backups"));

if (!url) fail(usage);
const local = url.startsWith("file:");
// http:// would send the token in clear text; ws(s):// is refused by Turso. Embedded credentials stay out
// of URLs (libsql echoes a malformed URL verbatim in its error).
if (!local && !/^(libsql|https):\/\/[^/?#@]+\/?$/.test(url)) fail("the URL must be libsql://<host> or https://<host> (no path, query or credentials), or file:. Nothing was contacted.");
// Opening a missing local file would create an empty database.
if (local && !existsSync(url.slice("file:".length).split("?")[0])) fail("no such local database file. Nothing was contacted.");
if (!local && !token) fail("DATABASE_AUTH_TOKEN is not set. Nothing was contacted.");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (!relative(repo, outDir).startsWith("..")) fail("--out/DUMP_DIR must be outside the repository (the dump holds personal data)");

// Engine/provider-internal objects are not part of the app schema.
const INTERNAL = /^(sqlite_|libsql_|_litestream|_cf_)/;
const ident = (name) => `"${name.replaceAll('"', '""')}"`;

console.log(`dumping ${local ? "local file" : new URL(url).host} (read-only)`);
let db, tx;
try {
  db = createDatabase({ url, authToken: token });
  tx = await db.transaction("read");
  const master = (await tx.execute("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")).rows
    .map((r) => ({ type: String(r.type), name: String(r.name), sql: String(r.sql) }));
  // Shapes this dump cannot restore faithfully: fail loudly rather than write a wrong backup.
  const unsupported = master.filter((o) => o.name === "sqlite_sequence" || (o.type === "table" && (/^CREATE VIRTUAL/i.test(o.sql) || /WITHOUT\s+ROWID/i.test(o.sql.slice(o.sql.lastIndexOf(")"))))));
  if (unsupported.length) throw new Error(`unsupported schema objects (AUTOINCREMENT, virtual or WITHOUT ROWID tables): ${unsupported.map((o) => o.name).join(", ")}; extend db-dump.mjs`);
  const objects = master.filter((o) => !INTERNAL.test(o.name));
  const out = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];
  const counts = {};
  for (const t of objects.filter((o) => o.type === "table")) {
    out.push(`${t.sql};`);
    // pragma_table_info omits generated columns, which must not be inserted.
    const cols = (await tx.execute({ sql: "SELECT name FROM pragma_table_info(?)", args: [t.name] })).rows.map((r) => ident(String(r.name)));
    // quote() renders each value as an exact SQL literal (integers, reals, text, blobs, NULL).
    const rows = (await tx.execute(`SELECT ${cols.map((c) => `quote(${c})`).join(" || ',' || ")} AS v FROM ${ident(t.name)} ORDER BY rowid`)).rows;
    for (const r of rows) out.push(`INSERT INTO ${ident(t.name)} (${cols.join(",")}) VALUES(${r.v});`);
    counts[t.name] = rows.length;
  }
  // Indexes and views, then triggers last so append-only/overlap guards do not fire on restored rows.
  for (const type of ["index", "view", "trigger"]) for (const o of objects.filter((x) => x.type === type)) out.push(`${o.sql};`);
  out.push("COMMIT;", "");
  const migrations = (await tx.execute("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => String(r.id));

  mkdirSync(outDir, { recursive: true, mode: 0o700 }); // mode applies only when the directory is created
  if (statSync(outDir).mode & 0o077) console.warn(`warning: ${outDir} is accessible to other users; the dump file itself is 0600`);
  const file = join(outDir, `workfolio-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`);
  writeFileSync(file, out.join("\n"), { mode: 0o600, flag: "wx" });
  console.log(`dumped ${Object.keys(counts).length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows to ${file}`);
  console.log(`schema_migrations: ${migrations.join(", ")}`);
} catch (err) {
  console.error(`dump failed: ${redact(err?.message ?? err)}`);
  process.exitCode = 1;
} finally {
  tx?.close();
  db?.close();
}

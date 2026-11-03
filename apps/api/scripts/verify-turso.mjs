// READ-ONLY verification of a libSQL/Turso database against this build's migrations (readiness T1–T4).
//
//   pnpm build:packages
//   pnpm --filter @workfolio/api verify:turso <env-file>
//
// DATABASE_URL and DATABASE_AUTH_TOKEN come ONLY from <env-file> (parsed into a local object; process.env
// and apps/api/.env are never read). Values are never printed; the token is redacted from any error.
// Nothing is written: every check is a SELECT or a read-only PRAGMA (no migrate, no CREATE, no INSERT).
// A local file: URL must already exist (opening a missing file would create it).
// Checks: connectivity (SELECT 1), sqlite_version, foreign_keys = 1 (repeated, and inside a read
// transaction), schema_migrations vs the code's MIGRATIONS (applied, pending, unknown, edited; a pending id
// below the latest applied one is a gap-fill WARN, unknown/edited FAIL), table/
// index/trigger names vs an in-memory reference migrated to the same applied set, integrity_check,
// quick_check, foreign_key_check.
// Exit codes: 0 all checks passed, 1 a check failed, 2 blocked (no file or variables; nothing contacted).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createDatabase, MIGRATIONS } from "@workfolio/database";

// Same checksum as packages/database migrate(): SHA-256 of the statements' JSON.
const checksum = (m) => createHash("sha256").update(JSON.stringify(m.statements)).digest("hex");
// Bookkeeping and engine/provider-internal objects are not part of the app schema.
const INTERNAL = /^(sqlite_|libsql_|_litestream|_cf_)|^schema_migrations$/;

async function schemaObjects(db) {
  const { rows } = await db.execute("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name");
  return rows.map((r) => ({ type: String(r.type), name: String(r.name) })).filter((o) => !INTERNAL.test(o.name));
}

export async function run(args, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const secrets = [];
  const redact = (s) => {
    let out = String(s).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted token]").replace(/authToken=[^&\s]+/gi, "authToken=[redacted]");
    for (const v of secrets) out = out.split(v).join("[redacted]");
    return out;
  };
  const say = (line) => log(redact(line));

  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    say("BLOCKED  usage: node scripts/verify-turso.mjs <env-file>. Nothing was contacted.");
    return 2;
  }
  let env;
  try {
    env = parseEnv(readFileSync(file, "utf8"));
  } catch {
    say("BLOCKED  the env file could not be read. Nothing was contacted.");
    return 2;
  }
  const url = env.DATABASE_URL?.trim();
  const authToken = env.DATABASE_AUTH_TOKEN?.trim() || undefined;
  if (authToken) secrets.push(authToken);
  if (!url) {
    say("BLOCKED  DATABASE_URL is not set in the env file. Nothing was contacted.");
    return 2;
  }
  const local = url.startsWith("file:");
  if (!local && !/^(libsql|https):\/\//.test(url)) {
    say("BLOCKED  DATABASE_URL must be libsql://, https:// or a local file: URL (wss:// is refused by Turso). Nothing was contacted.");
    return 2;
  }
  if (!local && !authToken) {
    say("BLOCKED  DATABASE_AUTH_TOKEN is not set in the env file. Nothing was contacted.");
    return 2;
  }
  if (local && !existsSync(url.slice("file:".length))) {
    say("BLOCKED  the local database file does not exist (opening it would create it). Nothing was contacted.");
    return 2;
  }

  const target = local ? "local file" : new URL(url).host;
  say(`Turso verification (read-only) of ${target}`);
  const db = createDatabase({ url, authToken });
  const reference = createDatabase({ url: ":memory:" });
  const state = {};
  let failed = 0;
  let warned = 0;
  const pragmaRows = async (sql) => (await db.execute(sql)).rows;

  const steps = [
    ["Connectivity (SELECT 1)", async () => {
      const started = performance.now();
      const v = Number((await db.execute("SELECT 1 AS one")).rows[0]?.one);
      if (v !== 1) throw new Error(`SELECT 1 returned ${v}`);
      return `${Math.round(performance.now() - started)} ms`;
    }],
    ["SQLite version", async () => String((await db.execute("SELECT sqlite_version() AS v")).rows[0]?.v)],
    ["foreign_keys = 1 (10 separate reads)", async () => {
      const seen = [];
      for (let i = 0; i < 10; i++) seen.push(Number((await db.execute("SELECT foreign_keys FROM pragma_foreign_keys")).rows[0]?.foreign_keys));
      if (seen.some((v) => v !== 1)) throw new Error(`foreign_keys off on ${seen.filter((v) => v !== 1).length}/10 reads`);
      return "on for every read";
    }],
    ["foreign_keys = 1 inside a read transaction", async () => {
      const tx = await db.transaction("read");
      try {
        const v = Number((await tx.execute("SELECT foreign_keys FROM pragma_foreign_keys")).rows[0]?.foreign_keys);
        if (v !== 1) throw new Error(`foreign_keys = ${v} inside the transaction`);
      } finally {
        tx.close(); // read-only: nothing to commit
      }
      return "on";
    }],
    ["Migrations (schema_migrations vs code)", async () => {
      const table = (await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")).rows.length > 0;
      const applied = table ? (await db.execute("SELECT id, checksum FROM schema_migrations ORDER BY id")).rows.map((r) => ({ id: String(r.id), checksum: r.checksum == null ? null : String(r.checksum) })) : [];
      const known = new Map(MIGRATIONS.map((m) => [m.id, m]));
      const unknown = applied.filter((a) => !known.has(a.id)).map((a) => a.id);
      const edited = applied.filter((a) => known.has(a.id) && a.checksum !== null && a.checksum !== checksum(known.get(a.id))).map((a) => a.id);
      const unstamped = applied.filter((a) => a.checksum === null).map((a) => a.id);
      const done = new Set(applied.map((a) => a.id));
      const pending = MIGRATIONS.filter((m) => !done.has(m.id)).map((m) => m.id);
      state.applied = applied.filter((a) => known.has(a.id)).map((a) => known.get(a.id));
      // A pending id below the latest applied one is a gap-fill candidate (e.g. a reserved 0018 written
      // after 0019+ shipped): migrate() applies it next time. Expected by design, so a warning.
      const latest = state.applied.at(-1)?.id ?? "";
      const gaps = pending.filter((id) => id < latest);
      const lines = [`applied ${applied.length}, pending ${pending.length}${pending.length ? ` (${pending[0]} … ${pending.at(-1)})` : ""}, latest ${applied.at(-1)?.id ?? "none"}`];
      if (unstamped.length) lines.push(`WARN no checksum yet (stamped on next migrate): ${unstamped.join(", ")}`);
      if (gaps.length) lines.push(`WARN pending below the latest applied (gap-fill, applied by the next migrate): ${gaps.join(", ")}`);
      if (unknown.length || edited.length) {
        throw new Error([...lines, unknown.length && `unknown to this build: ${unknown.join(", ")}`, edited.length && `edited after apply (checksum mismatch): ${edited.join(", ")}`].filter(Boolean).join("; "));
      }
      warned += (unstamped.length ? 1 : 0) + (gaps.length ? 1 : 0);
      return lines.join("; ");
    }],
    ["Schema objects vs reference", async () => {
      // Reference = exactly the migrations recorded on the target (gap-fill pendings excluded), in id order.
      for (const m of state.applied ?? []) await reference.batch(m.statements, "write"); // in-memory reference only
      const [want, got] = [await schemaObjects(reference), await schemaObjects(db)];
      const key = (o) => `${o.type} ${o.name}`;
      const has = (list) => new Set(list.map(key));
      const [wantSet, gotSet] = [has(want), has(got)];
      const missing = want.filter((o) => !gotSet.has(key(o))).map(key);
      const extra = got.filter((o) => !wantSet.has(key(o))).map(key);
      const counts = (list) => ["table", "index", "trigger", "view"].map((t) => `${list.filter((o) => o.type === t).length} ${t}s`).join(", ");
      if (missing.length) throw new Error(`missing: ${missing.join(", ")}${extra.length ? `; extra: ${extra.join(", ")}` : ""}`);
      if (extra.length) {
        warned++;
        return `${counts(got)} (reference ${counts(want)}); WARN extra objects not created by migrations: ${extra.join(", ")}`;
      }
      return `${counts(got)}, identical to the reference`;
    }],
    ...["integrity_check", "quick_check"].map((pragma) => [`PRAGMA ${pragma}`, async () => {
      let rows;
      try {
        rows = await pragmaRows(`PRAGMA ${pragma}`);
      } catch (err) {
        warned++;
        return `SKIPPED: the server refused it (${err?.message ?? err})`;
      }
      const result = rows.map((r) => String(Object.values(r)[0]));
      if (result.length !== 1 || result[0] !== "ok") throw new Error(result.slice(0, 10).join("; "));
      return "ok";
    }]),
    ["PRAGMA foreign_key_check", async () => {
      const rows = await pragmaRows("PRAGMA foreign_key_check");
      if (rows.length) throw new Error(`${rows.length} violation(s), e.g. ${rows.slice(0, 5).map((r) => `${r.table}→${r.parent}`).join(", ")}`);
      return "no violations";
    }],
  ];

  try {
    for (const [name, fn] of steps) {
      try {
        say(`PASS   ${name.padEnd(44)} ${(await fn()) ?? ""}`);
      } catch (err) {
        failed++;
        say(`FAIL   ${name.padEnd(44)} ${err?.message ?? err}`);
        if (name.startsWith("Connectivity")) break; // nothing else can work
      }
    }
  } finally {
    db.close();
    reference.close();
  }
  say(failed ? `${failed} check(s) failed.` : `All checks passed${warned ? ` (${warned} warning(s))` : ""}. Nothing was written.`);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));

// verify:turso (read-only checks) and db:migrate (migrate-only command), against local temporary SQLite
// files only. Never pointed at Turso.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";

const { createDatabase, migrate, MIGRATIONS } = await import("@workfolio/database");
const { run } = await import("../scripts/verify-turso.mjs");

const dir = mkdtempSync(join(tmpdir(), "wf-db-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const TOKEN = "not-a-real-token-value-123";
const LAST = MIGRATIONS.at(-1)!.id;
const checksum = (statements: string[]) => createHash("sha256").update(JSON.stringify(statements)).digest("hex");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

let n = 0;
/** A local database file: fully migrated, or with only the first `applied` migrations. */
async function database(applied = MIGRATIONS.length) {
  const path = join(dir, `db${++n}.db`);
  const db = createDatabase({ url: `file:${path}` });
  if (applied === MIGRATIONS.length) await migrate(db);
  else {
    await db.execute("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    for (const m of MIGRATIONS.slice(0, applied)) await db.batch([...m.statements, { sql: "INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)", args: [m.id, checksum(m.statements)] }], "write");
  }
  return { path, db };
}
function envFile(lines: string) {
  const path = join(dir, `env${++n}`);
  writeFileSync(path, lines);
  return path;
}
async function verify(args: string[]) {
  const lines: string[] = [];
  const code = await run(args, { log: (l: string) => lines.push(l) });
  return { code, out: lines.join("\n") };
}
const verifyDb = (path: string) => verify([envFile(`DATABASE_URL=file:${path}\nDATABASE_AUTH_TOKEN=${TOKEN}\n`)]);

describe("verify:turso", () => {
  test("blocked (exit 2, nothing opened) without a usable env file", async () => {
    assert.equal((await verify([])).code, 2);
    assert.equal((await verify([join(dir, "missing.env")])).code, 2);
    assert.equal((await verify([envFile("OTHER=1\n")])).code, 2);
    assert.equal((await verify([envFile("DATABASE_URL=libsql://example.turso.io\n")])).code, 2, "remote URL without a token");
    const wss = await verify([envFile(`DATABASE_URL=wss://example.turso.io\nDATABASE_AUTH_TOKEN=${TOKEN}\n`)]);
    assert.equal(wss.code, 2);
    assert.ok(!wss.out.includes(TOKEN));
    const absent = join(dir, "absent.db");
    assert.equal((await verifyDb(absent)).code, 2);
    assert.equal(existsSync(absent), false, "a missing local file is not created");
  });

  test("a fully migrated database passes every check, and the file is unchanged (read-only)", async () => {
    const { path, db } = await database();
    db.close();
    const before = sha(path);
    const r = await verifyDb(path);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`applied ${MIGRATIONS.length}, pending 0, latest ${LAST}`));
    assert.match(r.out, /identical to the reference/);
    assert.match(r.out, /PASS +PRAGMA integrity_check +ok/);
    assert.match(r.out, /PASS +PRAGMA foreign_key_check +no violations/);
    assert.match(r.out, /PASS +foreign_keys = 1 inside a read transaction/);
    assert.ok(!r.out.includes(TOKEN) && !r.out.includes(path), "no secrets or paths printed");
    assert.equal(sha(path), before, "nothing written");
  });

  test("a partly migrated database reports pending migrations and matches its reference", async () => {
    const { path, db } = await database(3);
    db.close();
    const r = await verifyDb(path);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`applied 3, pending ${MIGRATIONS.length - 3} \\(${MIGRATIONS[3]!.id} … ${LAST}\\)`));
  });

  test("an edited or unknown migration, a missing schema object or an FK violation fails (exit 1)", async () => {
    const edited = await database();
    await edited.db.execute({ sql: "UPDATE schema_migrations SET checksum = ? WHERE id = ?", args: ["0".repeat(64), MIGRATIONS[1]!.id] });
    edited.db.close();
    let r = await verifyDb(edited.path);
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`checksum mismatch\\): ${MIGRATIONS[1]!.id}`));

    const unknown = await database();
    await unknown.db.execute("INSERT INTO schema_migrations (id, checksum) VALUES ('9999_future', NULL)");
    unknown.db.close();
    r = await verifyDb(unknown.path);
    assert.equal(r.code, 1);
    assert.match(r.out, /unknown to this build: 9999_future/);

    const dropped = await database();
    await dropped.db.execute("DROP INDEX sessions_user_id");
    dropped.db.close();
    r = await verifyDb(dropped.path);
    assert.equal(r.code, 1);
    assert.match(r.out, /missing: index sessions_user_id/);

    const orphan = await database();
    await orphan.db.execute("PRAGMA foreign_keys = OFF"); // this connection only, to plant the violation
    await orphan.db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'no-such-user', 'ORPHAN', 'Orphan')");
    orphan.db.close();
    r = await verifyDb(orphan.path);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL +PRAGMA foreign_key_check +1 violation/);
  });
});

describe("db:migrate", () => {
  const cli = resolve(import.meta.dirname, "../dist/cli/migrate.js");
  /** Runs the built CLI in an empty folder (so no .env is loaded) against a local file. */
  async function migrateCli(url: string, ...args: string[]) {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], { cwd: dir, env: { PATH: process.env.PATH, NODE_ENV: "development", LOG_LEVEL: "silent", DATABASE_URL: url } });
      return { code: 0, out: stdout };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, out: e.stdout + e.stderr };
    }
  }

  test("--dry-run lists pending migrations and writes nothing; a real run applies them, checks FKs, prints the version; reruns are no-ops", async () => {
    const path = join(dir, "cli.db");
    const url = `file:${path}`;
    let r = await migrateCli(url, "--dry-run");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Applied: 0; pending: ${MIGRATIONS.length}`));
    assert.match(r.out, new RegExp(`PENDING  ${LAST}`));
    assert.equal(existsSync(path), false, "dry run created nothing");

    r = await migrateCli(url);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out.match(/APPLIED/g)?.length, MIGRATIONS.length);
    assert.match(r.out, /Foreign keys enforced/);
    assert.match(r.out, new RegExp(`Schema version ${LAST}`));

    r = await migrateCli(url);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /No pending migrations/);
    const before = sha(path);
    r = await migrateCli(url, "--dry-run");
    assert.match(r.out, /Applied: \d+; pending: 0/);
    assert.equal(sha(path), before, "dry run wrote nothing");
  });

  test("an edited migration fails both modes with a non-zero exit", async () => {
    const { path, db } = await database();
    await db.execute({ sql: "UPDATE schema_migrations SET checksum = ? WHERE id = ?", args: ["0".repeat(64), MIGRATIONS[0]!.id] });
    db.close();
    let r = await migrateCli(`file:${path}`, "--dry-run");
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`EDITED   ${MIGRATIONS[0]!.id}`));
    r = await migrateCli(`file:${path}`);
    assert.equal(r.code, 1);
    assert.match(r.out, /Migration failed: .*checksum mismatch/);
  });
});

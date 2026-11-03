// Database startup policy (prepareDatabase): local databases migrate at boot; hosted (Turso) ones are
// only checked and refuse to start on pending/unknown/edited migrations. "Hosted" is simulated by passing
// hosted=true with local temporary files or :memory:; nothing here touches the network except an
// unreachable loopback port, and nothing touches data/dev.db.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { createDatabase, migrate, MIGRATIONS } = await import("@workfolio/database");
const { isHostedDatabaseUrl, prepareDatabase } = await import("../dist/database/prepare.js");

const dir = mkdtempSync(join(tmpdir(), "wf-db-startup-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const LAST = MIGRATIONS.at(-1)!.id;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const checksum = (statements: string[]) => createHash("sha256").update(JSON.stringify(statements)).digest("hex");

let n = 0;
/** A closed local database file with the first `applied` migrations (all by default). */
async function file(applied = MIGRATIONS.length, setup?: (db: ReturnType<typeof createDatabase>) => Promise<unknown>) {
  const path = join(dir, `db${++n}.db`);
  const db = createDatabase({ url: `file:${path}` });
  if (applied === MIGRATIONS.length) await migrate(db);
  else if (applied > 0) {
    await db.execute("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    for (const m of MIGRATIONS.slice(0, applied)) await db.batch([...m.statements, { sql: "INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)", args: [m.id, checksum(m.statements)] }], "write");
  }
  await setup?.(db);
  db.close();
  return path;
}
/** Runs prepareDatabase on the file and returns the outcome, with the file's hash before and after. */
async function prepare(path: string, hosted: boolean) {
  const before = sha(path);
  const db = createDatabase({ url: `file:${path}` });
  const lines: string[] = [];
  try {
    return { version: await prepareDatabase(db, hosted, (l: string) => lines.push(l)), lines, before, after: (db.close(), sha(path)) };
  } catch (error) {
    db.close();
    return { error: error as Error, lines, before, after: sha(path) };
  }
}

test("hosted means a remote URL; file: and :memory: are local", () => {
  for (const url of ["libsql://x.turso.io", "https://x.turso.io", "http://127.0.0.1:8080"]) assert.equal(isHostedDatabaseUrl(url), true, url);
  for (const url of ["file:./data/dev.db", "file:/tmp/x.db", ":memory:"]) assert.equal(isHostedDatabaseUrl(url), false, url);
});

test("hosted startup with pending migrations refuses, names them and the migrate command, and writes nothing", async () => {
  const path = await file(3);
  const r = await prepare(path, true);
  assert.ok(r.error, "refused");
  assert.match(r.error.message, new RegExp(`${MIGRATIONS.length - 3} pending migration\\(s\\) \\(${MIGRATIONS[3]!.id}, .*${LAST}\\)`));
  assert.match(r.error.message, /pnpm --filter @workfolio\/api db:migrate/);
  assert.ok(!r.error.message.includes(path), "no path in the message");
  assert.equal(r.after, r.before, "file unchanged");
  const db = createDatabase({ url: `file:${path}` });
  assert.equal((await db.execute("SELECT count(*) AS n FROM schema_migrations")).rows[0]!.n, 3);
  db.close();
});

test("hosted startup on an empty database refuses without creating schema_migrations (or anything else)", async () => {
  const path = await file(0);
  const r = await prepare(path, true);
  assert.match(r.error?.message ?? "", new RegExp(`${MIGRATIONS.length} pending migration`));
  const db = createDatabase({ url: `file:${path}` });
  assert.equal((await db.execute("SELECT count(*) AS n FROM sqlite_master")).rows[0]!.n, 0);
  db.close();
});

test("hosted startup on a fully migrated database succeeds without writing (migrate is not called)", async () => {
  const path = await file();
  const r = await prepare(path, true);
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.version, LAST);
  assert.deepEqual(r.lines, [`Schema version ${LAST}`], "no 'Applied migrations' line");
  assert.equal(r.after, r.before, "file unchanged");
});

test("hosted startup with a NULL (pre-checksum) row is accepted and left unstamped (no write)", async () => {
  const path = await file(MIGRATIONS.length, (db) => db.execute({ sql: "UPDATE schema_migrations SET checksum = NULL WHERE id = ?", args: [MIGRATIONS[0]!.id] }));
  const r = await prepare(path, true);
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.after, r.before);
});

test("hosted startup refuses an unknown or edited migration, without writing", async () => {
  const unknown = await file(MIGRATIONS.length, (db) => db.execute("INSERT INTO schema_migrations (id, checksum) VALUES ('9999_future', NULL)"));
  let r = await prepare(unknown, true);
  assert.match(r.error?.message ?? "", /does not know \(9999_future\); refusing to start/);
  assert.equal(r.after, r.before);

  const edited = await file(MIGRATIONS.length, (db) => db.execute({ sql: "UPDATE schema_migrations SET checksum = ? WHERE id = ?", args: ["0".repeat(64), MIGRATIONS[1]!.id] }));
  r = await prepare(edited, true);
  assert.match(r.error?.message ?? "", new RegExp(`checksum mismatch: ${MIGRATIONS[1]!.id}\\); refusing to start`));
  assert.equal(r.after, r.before);
});

test("local startup still migrates (fresh and partly migrated)", async () => {
  let r = await prepare(await file(0), false);
  assert.equal(r.version, LAST);
  assert.match(r.lines[0]!, /^Applied migrations: /);
  r = await prepare(await file(3), false);
  assert.equal(r.version, LAST);
  assert.equal(r.lines[0], `Applied migrations: ${MIGRATIONS.slice(3).map((m) => m.id).join(", ")}`);
  r = await prepare(await file(), false);
  assert.deepEqual(r.lines, [`Schema version ${LAST}`], "nothing to apply");
});

test("foreign keys: a libSQL client enforces them; startup refuses a connection that does not", async () => {
  const db = createDatabase({ url: ":memory:" });
  try {
    assert.equal(await prepareDatabase(db, false), LAST);
    await db.execute("PRAGMA foreign_keys = OFF"); // :memory: is one connection, so this sticks
    await assert.rejects(prepareDatabase(db, true), /does not enforce foreign keys; refusing to start/);
  } finally {
    db.close();
  }
});

test("an unreachable hosted database rejects startup without echoing the token", async () => {
  const TOKEN = "not-a-real-token-startup-123";
  const db = createDatabase({ url: "http://127.0.0.1:1", authToken: TOKEN });
  try {
    await assert.rejects(prepareDatabase(db, true), (e: Error) => !String(e.message).includes(TOKEN) && !String(e.stack).includes(TOKEN));
  } finally {
    db.close();
  }
});

test("CLIs against an unreachable hosted database exit non-zero without echoing the token (admin:create, db:migrate --dry-run)", async () => {
  const { execFile } = await import("node:child_process");
  const TOKEN = "not-a-real-token-cli-456";
  const cli = (name: string, args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) =>
      execFile(process.execPath, [new URL(`../dist/cli/${name}.js`, import.meta.url).pathname, ...args], {
        cwd: dir, // no .env picked up
        env: { PATH: process.env.PATH, NODE_ENV: "development", LOG_LEVEL: "silent", DATABASE_URL: "http://127.0.0.1:1", DATABASE_AUTH_TOKEN: TOKEN },
      }, (err, stdout, stderr) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr })),
    );
  const admin = await cli("create-admin", ["--email", "hosted-admin@example.invalid", "--super-admin"]);
  assert.notEqual(admin.code, 0, admin.out);
  assert.ok(!admin.out.includes(TOKEN), "admin:create must not echo the token");
  assert.ok(!admin.out.includes("setup-password"), "no setup link issued");
  const dry = await cli("migrate", ["--dry-run"]);
  assert.equal(dry.code, 1, dry.out);
  assert.match(dry.out, /Target: 127\.0\.0\.1:1 \(dry run\)/);
  assert.ok(!dry.out.includes(TOKEN), "db:migrate must not echo the token");
});

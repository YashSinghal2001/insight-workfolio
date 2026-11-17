// scripts/verify-turso.mjs against local file: databases in a temp dir: offline, never contacts Turso.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDatabase, migrate, MIGRATIONS } from "@workfolio/database";

const SCRIPT = fileURLToPath(new URL("../scripts/verify-turso.mjs", import.meta.url));
const { run } = await import(SCRIPT);

// A file: URL ignores the token, but the script must never print it either way.
const TOKENS = ["eyJhbGciOiJFZERTQSJ9.eyJhIjoicncifQ.fake-signature", "plain-fake-turso-token-value"];
const dir = mkdtempSync(join(tmpdir(), "verify-turso-"));

/** A database file migrated with `skip` ids left out (MIGRATIONS is restored afterwards). */
async function dbFile(skip: string[] = [], tweak?: (db: ReturnType<typeof createDatabase>) => Promise<unknown>) {
  const path = join(dir, `${Math.random()}.db`);
  const removed = skip.map((id) => {
    const at = MIGRATIONS.findIndex((m) => m.id === id);
    assert.ok(at >= 0, id);
    return { at, m: MIGRATIONS.splice(at, 1)[0]! };
  });
  const db = createDatabase({ url: `file:${path}` });
  try {
    await migrate(db);
    await tweak?.(db);
  } finally {
    for (const { at, m } of removed.reverse()) MIGRATIONS.splice(at, 0, m);
    db.close();
  }
  return path;
}

const envFile = (dbPath: string, token: string) => {
  const p = join(dir, `${Math.random()}.env`);
  writeFileSync(p, `DATABASE_URL=file:${dbPath}\nDATABASE_AUTH_TOKEN=${token}\n`);
  return p;
};

async function verify(dbPath: string) {
  const results = [];
  for (const token of TOKENS) {
    const lines: string[] = [];
    const code = await run([envFile(dbPath, token)], { log: (l: string) => lines.push(l) });
    const out = lines.join("\n");
    assert.ok(!TOKENS.some((t) => out.includes(t)), "token printed");
    results.push({ code, out });
  }
  assert.equal(results[0]!.code, results[1]!.code);
  return results[0]!;
}

test("fully migrated: every check passes, nothing pending", async () => {
  const { code, out } = await verify(await dbFile());
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`applied ${MIGRATIONS.length}, pending 0`));
  assert.match(out, /identical to the reference/);
  assert.doesNotMatch(out, /FAIL|WARN/);
});

test("pending only after the latest applied: passes and reports them", async () => {
  const { code, out } = await verify(await dbFile(["0032_desktop_updates"]));
  assert.equal(code, 0, out);
  assert.match(out, /pending 1 \(0032_desktop_updates … 0032_desktop_updates\), latest 0031_multi_device_single_session/);
  assert.doesNotMatch(out, /FAIL|WARN/);
});

test("gap (a lower id pending below applied ones, like a later-written 0018): WARN, exit 0", async () => {
  const path = await dbFile(["0022_holidays"]);
  const { code, out } = await verify(path);
  assert.equal(code, 0, out);
  assert.match(out, /PASS +Migrations .*WARN pending below the latest applied \(gap-fill.*\): 0022_holidays/);
  assert.match(out, /PASS +Schema objects vs reference .*identical to the reference/);
  assert.match(out, /All checks passed \(1 warning\(s\)\)/);
  // Real CLI: exit 0 reaches the shell.
  await promisify(execFile)(process.execPath, [SCRIPT, envFile(path, TOKENS[0]!)]);
  // Read-only: the gap is still there (the verifier never migrates).
  const db = createDatabase({ url: `file:${path}` });
  assert.equal((await db.execute("SELECT count(*) AS n FROM schema_migrations WHERE id = '0022_holidays'")).rows[0]!.n, 0);
  assert.equal((await db.execute("SELECT count(*) AS n FROM sqlite_master WHERE name = 'holidays'")).rows[0]!.n, 0);
  db.close();
});

test("unknown id (migrated by a newer build): FAIL, exit 1", async () => {
  const path = await dbFile([], (db) => db.execute("INSERT INTO schema_migrations (id, checksum) VALUES ('9999_from_a_newer_build', 'x')"));
  const { code, out } = await verify(path);
  assert.equal(code, 1);
  assert.match(out, /FAIL +Migrations .*unknown to this build: 9999_from_a_newer_build/);
});

test("edited migration (checksum mismatch): FAIL, exit 1", async () => {
  const path = await dbFile([], (db) => db.execute("UPDATE schema_migrations SET checksum = 'edited' WHERE id = '0021_leave_types'"));
  const { code, out } = await verify(path);
  assert.equal(code, 1);
  assert.match(out, /FAIL +Migrations .*edited after apply \(checksum mismatch\): 0021_leave_types/);
});

test("missing database file: BLOCKED (exit 2), file not created", async () => {
  const missing = join(dir, "missing.db");
  const { code, out } = await verify(missing);
  assert.equal(code, 2);
  assert.match(out, /BLOCKED .*does not exist/);
  assert.ok(!existsSync(missing));
  await assert.rejects(promisify(execFile)(process.execPath, [SCRIPT, envFile(missing, TOKENS[0]!)]), (err: { code: number }) => err.code === 2);
  assert.ok(!existsSync(missing));
});

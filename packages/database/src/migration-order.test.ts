import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDatabase, migrate, MIGRATIONS } from "../dist/index.js";

// MIGRATIONS is the live array migrate() reads, so tests splice probes in and always restore it.
const probe = { id: "0018_order_probe", statements: ["CREATE TABLE order_probe (x INTEGER) STRICT"] };
async function withProbe<T>(fn: () => Promise<T>): Promise<T> {
  const at = MIGRATIONS.findIndex((m) => m.id > probe.id);
  MIGRATIONS.splice(at, 0, probe);
  try {
    return await fn();
  } finally {
    MIGRATIONS.splice(at, 1);
  }
}
const ids = async (db: ReturnType<typeof createDatabase>) =>
  (await db.execute("SELECT id FROM schema_migrations ORDER BY rowid")).rows.map((r) => String(r.id));

test("gap-fill: a middle id missing at first migrate is applied once when it appears", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  assert.ok((await ids(db)).includes("0019_screenshot_blur_policy"));
  await withProbe(async () => {
    assert.deepEqual(await migrate(db), [probe.id]);
    assert.deepEqual(await migrate(db), [], "re-run applies nothing");
    assert.equal((await ids(db)).at(-1), probe.id, "applied after 0019 on an existing database");
    await db.execute("INSERT INTO order_probe (x) VALUES (1)");
  });
  db.close();
});

test("gap-fill: on a fresh database the middle id runs in id order (before 0019)", async () => {
  const db = createDatabase({ url: ":memory:" });
  await withProbe(async () => {
    const ran = await migrate(db);
    assert.ok(ran.indexOf(probe.id) < ran.indexOf("0019_screenshot_blur_policy"));
    assert.deepEqual(await ids(db), ran);
  });
  db.close();
});

test("an applied id unknown to this build refuses to migrate", async () => {
  const db = createDatabase({ url: ":memory:" });
  await withProbe(() => migrate(db));
  // The probe is gone from the code again: the database is "ahead" of this build.
  await assert.rejects(migrate(db), /does not know \(0018_order_probe\); refusing to start/);
  db.close();
});

test("an applied migration edited afterwards (checksum mismatch) refuses to migrate", async () => {
  const db = createDatabase({ url: ":memory:" });
  await withProbe(() => migrate(db));
  const original = probe.statements[0]!;
  probe.statements[0] = `${original} -- edited`;
  try {
    await assert.rejects(withProbe(() => migrate(db)), /Migration 0018_order_probe was changed after it was applied \(checksum mismatch\)/);
  } finally {
    probe.statements[0] = original;
  }
  assert.deepEqual(await withProbe(() => migrate(db)), [], "unedited code is accepted again");
  db.close();
});

test("fresh file database: 0001-0017 and 0019 apply once, re-run applies nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-order-"));
  try {
    const url = `file:${join(dir, "fresh.db")}`;
    const db = createDatabase({ url });
    const ran = await migrate(db);
    assert.deepEqual(ran, MIGRATIONS.map((m) => m.id));
    const prefixes = ran.map((id) => id.slice(0, 4));
    for (let n = 1; n <= 17; n++) {
      const id = String(n).padStart(4, "0");
      assert.ok(prefixes.includes(id), `${id} applied`);
    }
    assert.ok(prefixes.includes("0019"));
    db.close();
    const again = createDatabase({ url }); // new connection, same file
    assert.deepEqual(await migrate(again), []);
    assert.deepEqual(await ids(again), ran);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

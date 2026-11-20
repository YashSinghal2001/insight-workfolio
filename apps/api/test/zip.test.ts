// STORE-only ZIP writer used by the screenshot export: structure, CRC-32 (checked against an independent table
// implementation and the standard check value), names, offsets; `unzip -t` too when the tool is installed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { zipStream } = await import("../dist/screenshots/zip.js");

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Uint8Array) => (b.reduce((c, x) => TABLE[(c ^ x) & 0xff]! ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

async function build(entries: { name: string; data: Uint8Array; modified: Date }[]) {
  async function* src() {
    yield* entries;
  }
  const parts: Uint8Array[] = [];
  for await (const p of zipStream(src())) parts.push(p);
  return Buffer.concat(parts);
}

/** Reads the archive through its central directory (as unzip tools do) and checks every local header. */
function read(zip: Buffer) {
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  assert.equal(p + zip.readUInt32LE(eocd + 12), eocd, "central directory ends at the end record");
  const out: { name: string; data: Buffer; crc: number; time: number; date: number }[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50);
    const [method, time, date, sum, size, nameLen, local] = [zip.readUInt16LE(p + 10), zip.readUInt16LE(p + 12), zip.readUInt16LE(p + 14), zip.readUInt32LE(p + 16), zip.readUInt32LE(p + 20), zip.readUInt16LE(p + 28), zip.readUInt32LE(p + 42)];
    assert.equal(method, 0, "STORE");
    assert.equal(zip.readUInt32LE(p + 24), size, "stored: compressed = uncompressed size");
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString();
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt32LE(local + 14), sum, "local CRC = central CRC");
    assert.equal(zip.subarray(local + 30, local + 30 + nameLen).toString(), name);
    const start = local + 30 + nameLen + zip.readUInt16LE(local + 28);
    out.push({ name, data: zip.subarray(start, start + size), crc: sum, time, date });
    p += 46 + nameLen;
  }
  return out;
}

test("crc check value and a multi-entry archive round-trip", async () => {
  assert.equal(crc(Buffer.from("123456789")), 0xcbf43926);
  const a = { name: "a.webp", data: Buffer.from("123456789"), modified: new Date("2026-11-10T09:30:42Z") };
  const b = { name: "screenshot-E1-2026-11-10T10-00-00Z-x.webp", data: Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) & 0xff)), modified: new Date("2026-01-02T03:04:05Z") };
  const empty = { name: "empty.webp", data: new Uint8Array(0), modified: new Date("2026-11-10T00:00:00Z") };
  const zip = await build([a, b, empty]);
  const files = read(zip);
  assert.deepEqual(files.map((f) => f.name), [a.name, b.name, empty.name]);
  for (const [i, src] of [a, b, empty].entries()) {
    assert.deepEqual(files[i]!.data, Buffer.from(src.data));
    assert.equal(files[i]!.crc, crc(src.data));
  }
  assert.equal(files[0]!.crc, 0xcbf43926);
  // DOS time 09:30:42 (2 s resolution) and date 2026-11-10 (UTC fields).
  assert.equal(files[0]!.time, (9 << 11) | (30 << 5) | 21);
  assert.equal(files[0]!.date, ((2026 - 1980) << 9) | (11 << 5) | 10);

  const dir = mkdtempSync(join(tmpdir(), "wf-zip-"));
  try {
    writeFileSync(join(dir, "t.zip"), zip);
    let out: string | null = null;
    try {
      out = execFileSync("unzip", ["-t", join(dir, "t.zip")], { encoding: "utf8" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // unzip found an error: fail
    }
    if (out !== null) assert.match(out, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty archive is a valid end record only", async () => {
  const zip = await build([]);
  assert.equal(zip.length, 22);
  assert.deepEqual(read(zip), []);
});

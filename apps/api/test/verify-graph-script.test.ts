// scripts/verify-graph.mjs against a fake Graph: offline, never contacts Microsoft.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT = fileURLToPath(new URL("../scripts/verify-graph.mjs", import.meta.url));
const { run } = await import(SCRIPT);
const { quickXorHash } = await import("../dist/screenshots/storage.js");

const SECRET = "verify-script-secret-value";
// Dummy unsigned JWT ({"alg":"none"}.{"sub":"x"}); joined at runtime so secret scanners don't flag a fixture.
const TOKEN = ["eyJhbGciOiJub25lIn0", "eyJzdWIiOiJ4In0", "sig"].join(".");
const dir = mkdtempSync(join(tmpdir(), "verify-graph-"));
const envFile = (extra = "") => {
  const p = join(dir, `${Math.random()}.env`);
  writeFileSync(p, `GRAPH_TENANT_ID=t\nGRAPH_CLIENT_ID=c\nGRAPH_CLIENT_SECRET=${SECRET}\nGRAPH_SITE_ID=site-1\nGRAPH_DRIVE_ID=drive-1\n${extra}`);
  return p;
};

/** Fake Graph: `override(url, method)` may answer first; records every request. */
function fakeGraph(override: (url: string, method: string) => Response | undefined = () => undefined) {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const item = (path: string, bytes: Uint8Array) => Response.json({ id: `id:${path}`, size: bytes.length, file: { hashes: { quickXorHash: quickXorHash(bytes) } } });
  const fetchFn = async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.startsWith("https://login.microsoftonline.com/")) return Response.json({ access_token: TOKEN, expires_in: 3600 });
    const hit = override(url, method);
    if (hit) return hit;
    if (url.endsWith("/drives/drive-1?$select=id")) return Response.json({ id: "drive-1" });
    if (url.includes("/sites/site-1/drives")) return Response.json({ value: [{ id: "drive-1" }] });
    if (url.includes("/sites/root") || url.includes("/users")) return Response.json({ error: { code: "accessDenied" } }, { status: 403 });
    const m = /\/root:\/(.+?)(:\/content.*|\?\$select.*)?$/.exec(url);
    if (!m) return new Response(null, { status: 500 });
    const path = m[1]!;
    if (method === "PUT") {
      files.set(path, new Uint8Array(init.body as Uint8Array));
      return item(path, files.get(path)!);
    }
    if (method === "DELETE") return new Response(null, { status: files.delete(path) ? 204 : 404 });
    const bytes = files.get(path);
    if (!bytes) return Response.json({ error: { code: "itemNotFound" } }, { status: 404 });
    return m[2]?.startsWith(":/content") ? new Response(bytes, { headers: { "content-length": String(bytes.length) } }) : item(path, bytes);
  };
  return { fetchFn, calls, writes: () => calls.filter((c) => !c.startsWith("GET ") && !c.includes("login.microsoftonline.com")) };
}

async function verify(args: string[], graph = fakeGraph()) {
  const lines: string[] = [];
  const code = await run(args, { fetchFn: graph.fetchFn, log: (l: string) => lines.push(l), sleep: async () => {} });
  const out = lines.join("\n");
  assert.ok(!out.includes(SECRET) && !out.includes(TOKEN), "secret or token printed");
  return { code, out };
}

test("missing env file or arguments: BLOCKED (exit 2), nothing contacted", async () => {
  const graph = fakeGraph();
  assert.equal((await verify([join(dir, "nope.env")], graph)).code, 2);
  assert.equal((await verify([], graph)).code, 2);
  const incomplete = join(dir, "incomplete.env");
  writeFileSync(incomplete, `GRAPH_TENANT_ID=t\nGRAPH_CLIENT_SECRET=${SECRET}\n`);
  assert.equal((await verify([incomplete], graph)).code, 2);
  assert.deepEqual(graph.calls, []);
  // Real CLI: the exit code reaches the shell.
  await assert.rejects(promisify(execFile)(process.execPath, [SCRIPT, join(dir, "nope.env")]), (err: { code: number }) => err.code === 2);
});

test("read-only by default: checks pass, no PUT/POST/DELETE", async () => {
  const graph = fakeGraph();
  const { code, out } = await verify([envFile()], graph);
  assert.equal(code, 0);
  assert.match(out, /write tests skipped; pass --write to run them/);
  assert.deepEqual(graph.writes(), []);
  assert.ok(graph.calls.some((c) => c.includes("/sites/root")) && graph.calls.some((c) => c.includes("/users")));
});

test("--write: full round trip under verify-<uuid>/TEST000/, cleaned up", async () => {
  const graph = fakeGraph();
  const { code, out } = await verify([envFile(), "--write"], graph);
  assert.equal(code, 0, out);
  assert.match(graph.writes()[0]!, /^PUT .*\/verify-[0-9a-f-]{36}\/TEST000\/test\.webp:\/content/);
  assert.ok(graph.writes().some((c) => c.startsWith("DELETE ")));
  assert.match(out, /recycle bin of the drive's owner/);
});

test("a failed configuration step stops everything: no later reads, no writes", async () => {
  const graph = fakeGraph((url) => (url.includes("/sites/site-1/drives") ? Response.json({ value: [{ id: "other-drive" }] }) : undefined));
  const { code, out } = await verify([envFile(), "--write"], graph);
  assert.equal(code, 1);
  assert.match(out, /FAIL .*Drive belongs to GRAPH_SITE_ID/);
  assert.deepEqual(graph.writes(), []);
  assert.ok(!graph.calls.some((c) => c.includes("/sites/root")));
});

test("negative check answering 2xx is a boundary breach (exit 4) and nothing is written", async () => {
  for (const target of ["/sites/root", "/users"]) {
    const graph = fakeGraph((url) => (url.includes(target) ? Response.json({ id: "x", value: [] }) : undefined));
    const { code, out } = await verify([envFile(), "--write"], graph);
    assert.equal(code, 4, out);
    assert.match(out, /BREACH/);
    assert.deepEqual(graph.writes(), []);
  }
});

test("a failure after upload deletes the synthetic file and stops", async () => {
  const graph = fakeGraph((url, method) => (method === "GET" && url.includes(":/content") ? new Response(null, { status: 500 }) : undefined));
  const { code, out } = await verify([envFile(), "--write"], graph);
  assert.equal(code, 1);
  assert.match(out, /cleanup: deleted verify-/);
  assert.ok(!out.includes("Duplicate upload"));
});

test("GRAPH_FOLDER_ID is checked when set", async () => {
  const graph = fakeGraph((url) => (url.includes("/items/folder-1?") ? Response.json({ id: "folder-1", folder: {}, parentReference: { driveId: "elsewhere" } }) : undefined));
  const { code, out } = await verify([envFile("GRAPH_FOLDER_ID=folder-1\n")], graph);
  assert.equal(code, 1);
  assert.match(out, /GRAPH_FOLDER_ID is not a folder/);
});

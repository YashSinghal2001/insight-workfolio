// Real Google Drive verification of the storage adapter (GOOGLE-DRIVE-STORAGE-SETUP.md).
//
//   pnpm --filter @workfolio/api build
//   node apps/api/scripts/verify-google-drive.mjs <env-file>            # read-only checks
//   node apps/api/scripts/verify-google-drive.mjs <env-file> --write    # + synthetic upload/read/overwrite/delete
//
// GOOGLE_* values come ONLY from <env-file> (process.env and apps/api/.env are never read). The account must
// have been connected through the API's OAuth flow first (GOOGLE_DRIVE_TOKEN_FILE). Stops at the first failure.
// Writes go only to a new "verify-<uuid>" folder inside the app's own InsightWorkfolio/TestFiles folder, use
// random synthetic bytes, and only items this run created are deleted. No personal file is touched: the
// optional GOOGLE_DRIVE_VERIFY_UNRELATED_FILE_ID (a file you name) is only read, and must be refused.
// Exit codes: 0 pass, 1 fail, 2 blocked (no usable configuration; nothing contacted), 4 boundary breach.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const LARGE_BYTES = 12 * 1024 * 1024; // two resumable chunks of 8 MiB
class Breach extends Error {}

export async function run(args, { fetchFn = (...a) => fetch(...a), log = (line) => process.stdout.write(`${line}\n`), sleep, chunkBytes } = {}) {
  const secrets = [];
  const redact = (s) => {
    let out = String(s).replace(/ya29\.[\w.-]+/g, "[redacted token]").replace(/1\/\/[\w.-]+/g, "[redacted token]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    for (const v of secrets) out = out.split(v).join("[redacted]");
    return out;
  };
  const say = (line) => log(redact(line));

  const write = args.includes("--write");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    say("BLOCKED  usage: node scripts/verify-google-drive.mjs <env-file> [--write]. Nothing was contacted.");
    return 2;
  }
  let env;
  try {
    env = parseEnv(readFileSync(file, "utf8"));
  } catch {
    say(`BLOCKED  cannot read env file ${file}. Nothing was contacted.`);
    return 2;
  }
  const missing = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_DRIVE_TOKEN_FILE", "GOOGLE_DRIVE_ACCOUNT_EMAIL"].filter((k) => !env[k]);
  if (missing.length) {
    say(`BLOCKED  missing ${missing.join(", ")}. Nothing was contacted.`);
    return 2;
  }
  secrets.push(env.GOOGLE_OAUTH_CLIENT_SECRET);
  const { GoogleDriveStorage, readConnection, DRIVE, DRIVE_FILE_SCOPE } = await import("../dist/storage/google-drive-storage.js");
  let conn;
  try {
    conn = await readConnection(env.GOOGLE_DRIVE_TOKEN_FILE);
  } catch (err) {
    say(`BLOCKED  ${err.message}. Nothing was contacted.`);
    return 2;
  }
  if (!conn) {
    say("BLOCKED  not connected yet: run the OAuth connect flow (GOOGLE-DRIVE-STORAGE-SETUP.md). Nothing was contacted.");
    return 2;
  }
  secrets.push(conn.refreshToken);

  const cfg = {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    tokenFile: env.GOOGLE_DRIVE_TOKEN_FILE,
    account: env.GOOGLE_DRIVE_ACCOUNT_EMAIL.trim().toLowerCase(),
    permanentDelete: env.GOOGLE_DRIVE_PERMANENT_DELETE === "true",
  };
  const storage = new GoogleDriveStorage(cfg, "TestFiles", { fetchFn, ...(sleep ? { sleep } : {}), ...(chunkBytes ? { chunkBytes } : {}) });
  const drive = storage.client;
  const must = (ok, msg) => {
    if (!ok) throw new Error(msg);
  };
  const dir = `verify-${randomUUID()}`;
  const small = `${dir}/small.bin`;
  const large = `${dir}/large.bin`;
  const created = new Set(); // item IDs this run created: the only things it ever deletes
  const tmp = mkdtempSync(join(tmpdir(), "wf-gdrive-verify-"));
  const bytesA = randomBytes(4096);
  const bytesB = randomBytes(5000);
  let smallId;
  const metadata = async (id) => {
    const res = await drive.call("metadata", `${DRIVE}/files/${id}?fields=id,trashed`, {}, [404]);
    return res.status === 404 ? null : res.json();
  };
  const purge = async (id) => {
    await drive.call("cleanup", `${DRIVE}/files/${id}`, { method: "DELETE" }, [404]);
    created.delete(id);
  };

  const steps = [
    ["Token refresh with the stored grant", async () => {
      await storage.stat(`${dir}/none.bin`); // refreshes the token; the folder does not exist
      if (storage.grantedScope === undefined) return "scope not reported on refresh (it was checked to be exactly drive.file at connect)";
      must(storage.grantedScope === DRIVE_FILE_SCOPE, `granted scope is "${storage.grantedScope}"`);
      return `scope is exactly ${DRIVE_FILE_SCOPE}`;
    }],
    ["Signed-in account", async () => {
      must((await drive.accountEmail()) === cfg.account, "account differs from GOOGLE_DRIVE_ACCOUNT_EMAIL");
      return cfg.account;
    }],
    ["App folders exist (InsightWorkfolio + 3)", async () => {
      for (const [name, id] of Object.entries(conn.folders)) must(await drive.isLiveFolder(id), `${name} folder ${id} is missing or trashed`);
      return `root ${conn.folders.root}`;
    }],
    ["Visible items are all inside InsightWorkfolio", async () => {
      // With drive.file, Drive lists only what this app created (or the user opened with it). Every listed
      // item must descend from the app's root folder; anything else means the access is broader than intended.
      const items = new Map();
      let pageToken;
      do {
        const q = new URLSearchParams({ q: "trashed = false", fields: "nextPageToken,files(id,parents)", pageSize: "1000", spaces: "drive", ...(pageToken ? { pageToken } : {}) });
        const body = await (await drive.call("list", `${DRIVE}/files?${q}`)).json();
        for (const f of body.files ?? []) items.set(f.id, f.parents ?? []);
        pageToken = body.nextPageToken;
      } while (pageToken && items.size < 10_000);
      const inside = (id, seen = new Set()) => id === conn.folders.root || (!seen.has(id) && seen.add(id) && (items.get(id) ?? []).some((p) => inside(p, seen)));
      const outside = [...items.keys()].filter((id) => !inside(id));
      if (outside.length) throw new Breach(`${outside.length} item(s) visible outside InsightWorkfolio (e.g. ${outside.slice(0, 3).join(", ")}); an older app folder from a previous connect also counts`);
      return `${items.size} item(s), all inside`;
    }],
    ["A file you named is not accessible", async () => {
      const id = env.GOOGLE_DRIVE_VERIFY_UNRELATED_FILE_ID;
      if (!id) return "skipped (set GOOGLE_DRIVE_VERIFY_UNRELATED_FILE_ID to the ID of one of your own files)";
      const res = await drive.call("unrelated file", `${DRIVE}/files/${encodeURIComponent(id)}?fields=id`, {}, [403, 404]);
      await res.body?.cancel();
      if (res.ok) throw new Breach(`file ${id} is readable (HTTP ${res.status}): access is broader than drive.file`);
      return `HTTP ${res.status}`;
    }],
  ];
  const writeSteps = [
    ["1. Upload (small, synthetic)", async () => {
      const item = await storage.put(small, bytesA);
      smallId = item.itemId;
      created.add(smallId);
      return `TestFiles/${small}: item ${item.itemId}, ${item.size} bytes`;
    }],
    ["2. Read back", async () => {
      must(sha(Buffer.from(await storage.get(small))) === sha(bytesA), "downloaded bytes differ");
      return "SHA-256 of the download matches";
    }],
    ["3. Hash and size match", async () => {
      const s = await storage.stat(small);
      must(s?.itemId === smallId && s.size === bytesA.length, `lookup returned ${JSON.stringify(s)}`);
      if (!s.sha256) return "size matches (Drive reported no SHA-256; MD5 was checked at upload)";
      must(s.sha256 === sha(bytesA), "Drive's SHA-256 differs");
      return "Drive's SHA-256 and size match";
    }],
    ["4. Overwrite (same key)", async () => {
      const again = await storage.put(small, bytesB);
      must(again.itemId === smallId, `item ID changed to ${again.itemId}`);
      must(sha(Buffer.from(await storage.get(small))) === sha(bytesB), "content after overwrite differs");
      return "replaced in place (same item ID); new content reads back";
    }],
    ["Resumable upload + streamed read (12 MiB)", async () => {
      const path = join(tmp, "large.bin");
      const big = randomBytes(LARGE_BYTES);
      writeFileSync(path, big);
      const item = await storage.putFile(large, path);
      created.add(item.itemId);
      const { stream, size } = await storage.getStream(large, LARGE_BYTES);
      const h = createHash("sha256");
      for await (const c of stream) h.update(c);
      must(size === LARGE_BYTES && h.digest("hex") === sha(big), "streamed download differs");
      return `item ${item.itemId}; streamed SHA-256 matches`;
    }],
    ["5. Delete", async () => {
      await storage.delete(small);
      must((await storage.stat(small)) === null, "file still listed in its folder");
      const meta = await metadata(smallId);
      return storage.deletionMode === "RECYCLE_BIN" ? `mode RECYCLE_BIN: in the trash (trashed=${meta?.trashed})` : "mode PERMANENT";
    }],
    ["6. Deleted file is inaccessible", async () => {
      await purge(smallId); // this run's own synthetic file, permanently
      must((await metadata(smallId)) === null, "item still reachable by ID");
      return "lookup by ID answers 404";
    }],
  ];

  say(`Google Drive verification (${write ? "read + write" : "read-only"})`);
  let code = 0;
  for (const [name, fn] of write ? [...steps, ...writeSteps] : steps) {
    try {
      say(`PASS   ${name.padEnd(46)} ${(await fn()) ?? ""}`);
    } catch (err) {
      const breach = err instanceof Breach;
      say(`${breach ? "BREACH" : "FAIL  "} ${name.padEnd(46)} ${err?.message ?? err}`);
      say("Stopped at the first failure; later steps were not run.");
      code = breach ? 4 : 1;
      break;
    }
  }
  if (write) {
    // Only this run's own items and its own verify folder.
    for (const id of created) await purge(id).then(() => say(`       cleanup: deleted ${id}`), () => say(`       cleanup FAILED: delete ${id} by hand`));
    const folder = await storage.client.childFolder(conn.folders.TestFiles, dir, false).catch(() => null);
    if (folder) await purge(folder).then(() => say(`       cleanup: deleted folder TestFiles/${dir}`), () => say(`       cleanup FAILED: delete TestFiles/${dir} by hand`));
  } else if (!code) say("write tests skipped; pass --write to run them");
  rmSync(tmp, { recursive: true, force: true });
  return code;
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));

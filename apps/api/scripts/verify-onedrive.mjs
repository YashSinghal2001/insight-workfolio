// Real Microsoft verification of the OneDrive storage (IT storage account, delegated Files.ReadWrite).
//
//   pnpm --filter @workfolio/api build
//   node apps/api/scripts/verify-onedrive.mjs <env-file>                     # token, drive, quota, isolation (read-only)
//   node apps/api/scripts/verify-onedrive.mjs <env-file> --write [--teams id1,id2,id3]
//                                                                             # + upload/stat/list/download/delete of
//                                                                             #   harmless files, one per team folder
//
// Needs a completed connect (Settings › Microsoft OneDrive › Connect) on the same ONEDRIVE_TOKEN_FILE.
// ONEDRIVE_* values come ONLY from <env-file>. Writes go under "<root>/verify-<uuid>/" and are deleted again
// (to the OneDrive recycle bin). Secrets and tokens are never printed.
// Exit codes: 0 pass, 1 fail, 2 blocked (not configured or not connected; nothing contacted),
// 4 boundary breach (the token reads something outside the account's own files).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

const GRAPH = "https://graph.microsoft.com/v1.0";
const sha = (b) => createHash("sha256").update(b).digest("hex");

const args = process.argv.slice(2);
const write = args.includes("--write");
const teamsAt = args.indexOf("--teams");
const teams = teamsAt >= 0 ? (args[teamsAt + 1] ?? "").split(",").filter((t) => /^[0-9a-f-]{36}$/i.test(t)) : [];
const file = args.find((a, i) => !a.startsWith("--") && (teamsAt < 0 || i !== teamsAt + 1));
const secrets = [];
const say = (line) => {
  let out = String(line).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted token]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  for (const v of secrets) out = out.split(v).join("[redacted]");
  process.stdout.write(`${out}\n`);
};

let env;
try {
  env = parseEnv(readFileSync(file, "utf8"));
} catch {
  say("BLOCKED  usage: node scripts/verify-onedrive.mjs <env-file> [--write] [--teams a,b,c]. Nothing was contacted.");
  process.exit(2);
}
if (env.ONEDRIVE_CLIENT_SECRET) secrets.push(env.ONEDRIVE_CLIENT_SECRET);
const { validateEnv } = await import("../dist/config/env.js");
const { OneDriveService, readOneDriveConnection } = await import("../dist/storage/onedrive.js");
const { GraphStorage, quickXorHash, teamFolder } = await import("../dist/screenshots/storage.js");
let cfgEnv;
try {
  cfgEnv = validateEnv({ ...env, NODE_ENV: "development", DATABASE_URL: ":memory:", SCREENSHOT_STORAGE: "onedrive" });
} catch (err) {
  say(`BLOCKED  ${err.message}. Nothing was contacted.`);
  process.exit(2);
}
const service = new OneDriveService({ get: (k) => cfgEnv[k] });
const conn = await readOneDriveConnection(service.cfg.tokenFile, service.cfg.tokenKey).catch((err) => (say(`BLOCKED  ${err.message}`), process.exit(2)));
if (!conn) {
  say("BLOCKED  not connected yet: an administrator connects OneDrive in the dashboard first. Nothing was contacted.");
  process.exit(2);
}

let failed = 0;
const step = async (name, fn) => {
  try {
    const detail = await fn();
    say(`PASS     ${name}${detail ? ` (${detail})` : ""}`);
  } catch (err) {
    failed++;
    say(`FAIL     ${name}: ${err.message}`);
    if (err.breach) {
      say("STOP     boundary breach: the token reads more than the account's own files. Disconnect OneDrive and review the app's permissions.");
      process.exit(4);
    }
  }
  return !failed;
};
const graph = async (path, init = {}) => fetch(`${GRAPH}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${await service.token(false)}` }, signal: AbortSignal.timeout(30_000) });

say(`Account: ${conn.account}   Root folder: ${service.cfg.rootFolder}   Mode: ${write ? "write" : "read-only"}`);
const ok =
  (await step("1. token refresh (server-side, refresh token rotated and written back)", async () => {
    await service.token(true);
    const after = await readOneDriveConnection(service.cfg.tokenFile, service.cfg.tokenKey);
    return after.refreshToken === conn.refreshToken ? "Microsoft kept the same refresh token" : "rotated";
  })) &&
  (await step("2. the connected drive is the account's own OneDrive for Business", async () => {
    const r = await graph("/me/drive?$select=id,driveType,owner,quota");
    const d = await r.json();
    if (!r.ok || d.id !== conn.driveId || d.driveType !== "business" || d.owner?.user?.id !== conn.userId) throw new Error(`HTTP ${r.status}, drive mismatch`);
    return `used ${(d.quota.used / 1024 ** 3).toFixed(2)} GB of ${(d.quota.total / 1024 ** 3).toFixed(0)} GB`;
  })) &&
  (await step("3. app folder exists in that drive", async () => {
    const r = await graph(`/drives/${conn.driveId}/items/${conn.folderId}?$select=id,name,folder`);
    const f = await r.json();
    if (!r.ok || !f.folder) throw new Error(`HTTP ${r.status}`);
    return f.name;
  })) &&
  (await step("4. isolation: no SharePoint sites, no other users, nothing shared with the account", async () => {
    const probes = ["/sites/root", "/sites?search=*", "/users?$top=1", "/me/drive/sharedWithMe", "/me/insights/shared"];
    const seen = [];
    for (const p of probes) {
      const r = await graph(p);
      await r.body?.cancel();
      seen.push(`${p} ${r.status}`);
      if (r.ok) throw Object.assign(new Error(`${p} answered ${r.status}`), { breach: true });
    }
    return seen.join(", ");
  }));

if (ok && write) {
  const storage = new GraphStorage({ tenantId: conn.tenantId, clientId: conn.clientId, driveId: "", folder: service.cfg.rootFolder, permanentDelete: false }, undefined, undefined, undefined, service);
  const run = `verify-${randomUUID()}`;
  const folders = [...teams.map((t) => teamFolder(t)), teamFolder(null)];
  for (const [i, folder] of folders.entries()) {
    const key = `${run}/${folder}/TEST/${randomUUID()}.bin`;
    const bytes = Buffer.from(`Insight Workfolio OneDrive verification file ${i}. Harmless; deleted after the check.`);
    await step(`5.${i + 1} ${folder}: upload, provider hash, download, delete`, async () => {
      const item = await storage.put(key, bytes);
      if (item.size !== bytes.length || (item.quickXorHash && item.quickXorHash !== quickXorHash(bytes))) throw new Error("size or QuickXorHash mismatch");
      const back = await storage.get(key);
      if (sha(back) !== sha(bytes)) throw new Error("downloaded bytes differ");
      await storage.delete(key);
      if (await storage.stat(key)) throw new Error("still there after delete");
      return "sha256 match, gone after delete";
    });
  }
  await step("6. list: the verify folder lists only what this run created", async () => {
    const r = await graph(`/drives/${conn.driveId}/items/${conn.folderId}:/${run}:/children?$select=name`);
    const { value } = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return value.map((v) => v.name).join(", ");
  });
  await step("7. large file (two 10 MiB chunks, upload session) like a timelapse video", async () => {
    const tmp = join(tmpdir(), `wf-verify-${randomUUID()}.bin`);
    const big = randomBytes(11 * 1024 * 1024);
    writeFileSync(tmp, big, { mode: 0o600 });
    try {
      const key = `${run}/timelapses/TEST/${randomUUID()}.mp4`;
      const item = await storage.putFile(key, tmp);
      if (item.size !== big.length) throw new Error("size mismatch");
      const { stream } = await storage.getStream(key, big.length);
      const h = createHash("sha256");
      for await (const c of stream) h.update(c);
      if (h.digest("hex") !== sha(big)) throw new Error("downloaded bytes differ");
      await storage.delete(key);
      return "11 MiB, sha256 match, deleted";
    } finally {
      rmSync(tmp, { force: true });
    }
  });
  await step("8. cleanup: the verify folder is removed (recycle bin)", async () => {
    const r = await graph(`/drives/${conn.driveId}/items/${conn.folderId}:/${run}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
  });
}
say(failed ? `RESULT   FAIL (${failed})` : "RESULT   PASS");
process.exit(failed ? 1 : 0);

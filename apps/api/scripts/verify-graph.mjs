// Real Microsoft Graph verification of the screenshot storage adapter (docs/onedrive.md).
//
//   pnpm --filter @workfolio/api build
//   node apps/api/scripts/verify-graph.mjs <env-file>            # read-only checks
//   node apps/api/scripts/verify-graph.mjs <env-file> --write    # + upload/download/delete of a synthetic file
//
// GRAPH_* values come ONLY from <env-file> (parsed into a local object; process.env and apps/api/.env are
// never read). Stops at the first failed step: nothing is written after a failed configuration, read or
// boundary check. Writes use a synthetic 1x1 WebP under "verify-<uuid>/TEST000/" and delete it again.
// Secrets and tokens are never printed.
// Exit codes: 0 pass, 1 fail, 2 blocked (no usable configuration; nothing contacted), 4 boundary breach
// (the app can read something it must not: permissions are broader than Sites.Selected).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const GRAPH = "https://graph.microsoft.com/v1.0";
// Synthetic 1x1 lossless WebP: contains no screen content.
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const sha = (b) => createHash("sha256").update(b).digest("hex");

class Breach extends Error {}

export async function run(args, { fetchFn = (...a) => fetch(...a), log = (line) => process.stdout.write(`${line}\n`), sleep } = {}) {
  const secrets = [];
  const redact = (s) => {
    let out = String(s).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted token]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    for (const v of secrets) out = out.split(v).join("[redacted]");
    return out;
  };
  const say = (line) => log(redact(line));

  const write = args.includes("--write");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    say("BLOCKED  usage: node scripts/verify-graph.mjs <env-file> [--write]. Nothing was contacted.");
    return 2;
  }
  let env;
  try {
    env = parseEnv(readFileSync(file, "utf8"));
  } catch {
    say(`BLOCKED  cannot read env file ${file}. Nothing was contacted.`);
    return 2;
  }
  if (env.GRAPH_CLIENT_SECRET) secrets.push(env.GRAPH_CLIENT_SECRET);
  const missing = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_DRIVE_ID"].filter((k) => !env[k]);
  if (!env.GRAPH_CLIENT_SECRET === !(env.GRAPH_CERT_KEY_PATH && env.GRAPH_CERT_THUMBPRINT)) missing.push("exactly one of GRAPH_CLIENT_SECRET or GRAPH_CERT_KEY_PATH+GRAPH_CERT_THUMBPRINT");
  if (missing.length) {
    say(`BLOCKED  missing ${missing.join(", ")}. Nothing was contacted.`);
    return 2;
  }
  let certificate;
  if (env.GRAPH_CERT_KEY_PATH) {
    try {
      certificate = { privateKeyPem: readFileSync(env.GRAPH_CERT_KEY_PATH, "utf8"), thumbprintSha1Hex: env.GRAPH_CERT_THUMBPRINT };
    } catch {
      say("BLOCKED  GRAPH_CERT_KEY_PATH is not readable. Nothing was contacted.");
      return 2;
    }
    secrets.push(certificate.privateKeyPem);
  }

  const { GraphStorage, quickXorHash } = await import("../dist/screenshots/storage.js");
  let failNext = 0;
  const wrappedFetch = (url, init) => {
    if (failNext > 0 && String(url).startsWith("https://graph.microsoft.com/")) {
      failNext--;
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "simulatedTransientFailure" } }), { status: 503 }));
    }
    return fetchFn(url, init);
  };
  const cfg = {
    tenantId: env.GRAPH_TENANT_ID, clientId: env.GRAPH_CLIENT_ID, clientSecret: env.GRAPH_CLIENT_SECRET || undefined, certificate,
    siteId: env.GRAPH_SITE_ID || undefined, driveId: env.GRAPH_DRIVE_ID, folderId: env.GRAPH_FOLDER_ID || undefined,
    folder: env.GRAPH_FOLDER || "Workfolio Screenshots", permanentDelete: env.GRAPH_PERMANENT_DELETE === "true",
  };
  const storage = new GraphStorage(cfg, wrappedFetch, ...(sleep ? [sleep] : []));
  const key = `verify-${randomUUID()}/TEST000/test.webp`;
  const must = (ok, msg) => {
    if (!ok) throw new Error(msg);
  };
  /** Any 2xx on something outside the granted site is a boundary breach (exit 4). */
  const mustBeDenied = async (name, url) => {
    const res = await storage.call(name, url, {}, [403, 404]);
    await res.body?.cancel();
    if (res.ok) throw new Breach(`${name} readable (HTTP ${res.status}): permission is broader than Sites.Selected`);
    return `HTTP ${res.status}`;
  };

  const steps = [
    ["Token + drive is reachable", async () => {
      const res = await storage.call("drive lookup", `${GRAPH}/drives/${encodeURIComponent(cfg.driveId)}?$select=id`);
      await res.body?.cancel();
      return `drive ${cfg.driveId}`;
    }],
    ["Drive belongs to GRAPH_SITE_ID", async () => {
      if (!cfg.siteId) return "skipped (no GRAPH_SITE_ID: not a site-level design)";
      must(await storage.driveBelongsToSite(), "GRAPH_DRIVE_ID is not a library of GRAPH_SITE_ID");
      return `site ${cfg.siteId}`;
    }],
    ["GRAPH_FOLDER_ID is a folder in the drive", async () => {
      if (!cfg.folderId) return `skipped (no GRAPH_FOLDER_ID; path "${cfg.folder}" is used)`;
      must(await storage.folderIsConfigured(), "GRAPH_FOLDER_ID is not a folder in GRAPH_DRIVE_ID");
      return `folder ${cfg.folderId}`;
    }],
    ["Tenant root site is not accessible", () => mustBeDenied("tenant root site", `${GRAPH}/sites/root?$select=id`)],
    ["Directory users are not accessible", () => mustBeDenied("users", `${GRAPH}/users?$select=id&$top=1`)],
  ];
  let item;
  let uploaded = false;
  const writeSteps = [
    ["Upload a synthetic test WebP", async () => {
      item = await storage.put(key, WEBP);
      uploaded = true;
      return `${key}: item ${item.itemId}, ${item.size} bytes`;
    }],
    ["File identity and metadata", async () => {
      const s = await storage.stat(key);
      must(s && s.itemId === item.itemId && s.size === WEBP.length, `lookup returned ${JSON.stringify(s)}`);
      must(s.quickXorHash === quickXorHash(WEBP), `QuickXorHash ${s.quickXorHash} vs local ${quickXorHash(WEBP)}`);
      return "same item id and size; QuickXorHash matches the local computation";
    }],
    ["Download and verify checksum", async () => {
      const bytes = Buffer.from(await storage.get(key));
      must(sha(bytes) === sha(WEBP), "SHA-256 differs");
      return `SHA-256 ${sha(bytes).slice(0, 16)}… matches`;
    }],
    ["Duplicate upload (same key)", async () => {
      const again = await storage.put(key, WEBP);
      must((await storage.stat(key))?.size === WEBP.length, "unexpected size after re-upload");
      return `replaced in place (item ${again.itemId === item.itemId ? "unchanged" : `changed to ${again.itemId}`}); one file`;
    }],
    ["Retry after a temporary failure", async () => {
      failNext = 1; // the next Graph call answers 503 once
      const s = await storage.stat(key);
      must(failNext === 0 && s?.size === WEBP.length, "retry did not recover");
      return "simulated 503 retried and recovered";
    }],
    ["Delete", async () => {
      await storage.delete(key);
      uploaded = false;
      return `mode ${storage.deletionMode}`;
    }],
    ["After deletion", async () => {
      must((await storage.stat(key)) === null, "file still visible in the drive");
      await storage.delete(key); // idempotent
      return storage.deletionMode === "RECYCLE_BIN"
        ? "gone from the drive; it stays in the recycle bin of the drive's owner (the SharePoint site's, or the OneDrive user's) until emptied or 93 days pass."
        : "gone from the drive; permanently deleted (not in any recycle bin). Tenant retention policies may still keep a copy (Preservation Hold Library).";
    }],
  ];

  say(`Microsoft Graph verification (${write ? "read + write" : "read-only"})`);
  for (const [name, fn] of write ? [...steps, ...writeSteps] : steps) {
    try {
      say(`PASS   ${name.padEnd(42)} ${(await fn()) ?? ""}`);
    } catch (err) {
      const breach = err instanceof Breach;
      say(`${breach ? "BREACH" : "FAIL  "} ${name.padEnd(42)} ${err?.message ?? err}`);
      if (uploaded) {
        // Only our own synthetic file, only once it exists: never leave test data behind.
        await storage.delete(key).then(() => say(`       cleanup: deleted ${key}`), () => say(`       cleanup FAILED: delete ${key} by hand`));
      }
      say("Stopped at the first failure; later steps were not run.");
      return breach ? 4 : 1;
    }
  }
  if (!write) say("write tests skipped; pass --write to run them");
  return 0;
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));

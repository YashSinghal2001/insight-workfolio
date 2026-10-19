// Real Microsoft Graph verification of the screenshot storage adapter (docs/onedrive.md).
//
//   pnpm --filter @workfolio/api build && pnpm --filter @workfolio/api verify:graph
//
// Reads the same GRAPH_* environment as the API (from the shell or apps/api/.env). Uses only a
// synthetic 1x1 WebP (no screen content), in a "verify-<uuid>" folder under the configured
// folder, and deletes it again. Prints PASS / FAIL per check; exits 2 (BLOCKED) without credentials.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, "../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const missing = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_SITE_ID", "GRAPH_DRIVE_ID"].filter((k) => !env[k]);
if (!env.GRAPH_CLIENT_SECRET && !(env.GRAPH_CERT_KEY_PATH && env.GRAPH_CERT_THUMBPRINT)) missing.push("GRAPH_CLIENT_SECRET or GRAPH_CERT_KEY_PATH+GRAPH_CERT_THUMBPRINT");
if (missing.length) {
  console.log(`BLOCKED  Real Microsoft Graph verification: missing ${missing.join(", ")}. Nothing was contacted.`);
  process.exit(2);
}

const { GraphStorage, quickXorHash } = await import("../dist/screenshots/storage.js");
// Synthetic 1x1 lossless WebP: contains no screen content.
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const sha = (b) => createHash("sha256").update(b).digest("hex");
let failNext = 0;
const fetchFn = (url, init) => {
  if (failNext > 0 && String(url).startsWith("https://graph.microsoft.com/")) {
    failNext--;
    return Promise.resolve(new Response(JSON.stringify({ error: { code: "simulatedTransientFailure" } }), { status: 503 }));
  }
  return fetch(url, init);
};
const cfg = {
  tenantId: env.GRAPH_TENANT_ID, clientId: env.GRAPH_CLIENT_ID, clientSecret: env.GRAPH_CLIENT_SECRET || undefined,
  certificate: env.GRAPH_CERT_KEY_PATH ? { privateKeyPem: readFileSync(env.GRAPH_CERT_KEY_PATH, "utf8"), thumbprintSha1Hex: env.GRAPH_CERT_THUMBPRINT } : undefined,
  siteId: env.GRAPH_SITE_ID, driveId: env.GRAPH_DRIVE_ID, folder: env.GRAPH_FOLDER || "Workfolio Screenshots",
  permanentDelete: env.GRAPH_PERMANENT_DELETE === "true",
};
const storage = new GraphStorage(cfg, fetchFn);
const key = `verify-${randomUUID()}/test.webp`;
const results = [];
async function step(name, fn) {
  try {
    results.push(["PASS", name, (await fn()) ?? ""]);
  } catch (err) {
    results.push(["FAIL", name, err.message]);
  }
}
const must = (ok, msg) => {
  if (!ok) throw new Error(msg);
};

let item;
await step("1. Server-side token + 2. drive is in the intended site", async () => {
  must(await storage.driveBelongsToSite(), "GRAPH_DRIVE_ID is not a library of GRAPH_SITE_ID");
  return `drive ${cfg.driveId} belongs to site ${cfg.siteId}`;
});
await step("3. Upload a synthetic test WebP", async () => {
  item = await storage.put(key, WEBP);
  return `item ${item.itemId}, ${item.size} bytes`;
});
await step("4. File identity and metadata", async () => {
  const s = await storage.stat(key);
  must(s && s.itemId === item?.itemId && s.size === WEBP.length, `lookup returned ${JSON.stringify(s)}`);
  must(s.quickXorHash === quickXorHash(WEBP), `QuickXorHash ${s.quickXorHash} vs local ${quickXorHash(WEBP)}`);
  return `same item id and size; QuickXorHash matches the local computation`;
});
await step("5. Download and verify checksum", async () => {
  const bytes = Buffer.from(await storage.get(key));
  must(sha(bytes) === sha(WEBP), "SHA-256 differs");
  return `SHA-256 ${sha(bytes).slice(0, 16)}… matches`;
});
await step("6. Duplicate upload (same key)", async () => {
  const again = await storage.put(key, WEBP);
  const s = await storage.stat(key);
  must(s?.size === WEBP.length, "unexpected size after re-upload");
  return `replaced in place (item ${again.itemId === item?.itemId ? "unchanged" : `changed to ${again.itemId}`}); one file`;
});
await step("7. Retry after a temporary failure", async () => {
  failNext = 1; // the next Graph call answers 503 once
  const s = await storage.stat(key);
  must(failNext === 0 && s?.size === WEBP.length, "retry did not recover");
  return "simulated 503 retried and recovered";
});
await step("8. Delete", async () => {
  await storage.delete(key);
  return `mode ${storage.deletionMode}`;
});
await step("9. After deletion", async () => {
  must((await storage.stat(key)) === null, "file still visible in the library");
  await storage.delete(key); // idempotent
  return storage.deletionMode === "RECYCLE_BIN"
    ? "not in the library; it remains in the site recycle bin (first stage) until emptied or 93 days pass. Check Site contents > Recycle bin."
    : "not in the library; permanently deleted (not in the recycle bin). Tenant retention policies may still preserve a copy (Preservation Hold Library).";
});
await step("10. Unrelated sites are not accessible", async () => {
  const res = await storage.call("unrelated site", "https://graph.microsoft.com/v1.0/sites/root?$select=id", {}, [403, 404]);
  must(res.status === 403 || res.status === 404, `tenant root site readable (HTTP ${res.status}): permission is broader than Sites.Selected`);
  return `tenant root site: HTTP ${res.status}`;
});

console.log("\nReal Microsoft Graph verification\n");
for (const [status, name, detail] of results) console.log(`${status.padEnd(6)} ${name.padEnd(52)} ${detail}`);
process.exit(results.some(([s]) => s === "FAIL") ? 1 : 0);

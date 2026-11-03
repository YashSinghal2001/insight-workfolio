// Release build for a production API: `WORKFOLIO_API_URL=https://api.example.com pnpm package [tauri build args]`.
// Validates the URL (https only), merges a CSP whose connect-src allows exactly that API origin (instead of
// the dev http://localhost:4000) into tauri.conf.json via `tauri build --config <file>`, and passes the URL
// to the front end as VITE_API_URL. `--print` writes nothing and prints the override instead.
// The URL is public configuration, not a secret; nothing secret is ever embedded in the app.
// WORKFOLIO_DASHBOARD_URL (https, required) is the web dashboard shown to administrators (VITE_DASHBOARD_URL).
// WORKFOLIO_ENV=staging|production (default production) picks the bundle identity (environmentIdentity), so a
// staging build installs beside production with its own app data and credential-store entries.
// Signing is optional: without APPLE_SIGNING_IDENTITY the bundle is unsigned (ad-hoc linker signature
// only). With it, the Tauri CLI signs (hardened runtime, src-tauri/Entitlements.plist) and, given one
// complete set of notarization credentials, notarizes and staples the .app. See docs/deployment.md.
// Windows signing is optional too (windowsSigningPlan): a certificate in the store by thumbprint, or
// Azure Trusted Signing; without either the NSIS installer is unsigned (SmartScreen warns).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApiUrl } from "../src/api-url.ts";

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEV_CONNECT = "http://localhost:4000";

/** The tauri.conf.json override for a release build against `rawUrl`. */
export function releaseConfig(rawUrl, baseCsp) {
  const apiUrl = resolveApiUrl(rawUrl, "production");
  const origin = new URL(apiUrl).origin;
  const directives = baseCsp.split(";").map((d) => d.trim()).filter(Boolean);
  const connect = directives.findIndex((d) => d.startsWith("connect-src "));
  if (connect < 0 || !directives[connect].split(/\s+/).includes(DEV_CONNECT)) {
    throw new Error(`tauri.conf.json connect-src must list ${DEV_CONNECT} (the dev API) for this script to replace`);
  }
  directives[connect] = directives[connect].split(/\s+/).map((s) => (s === DEV_CONNECT ? origin : s)).join(" ");
  return { apiUrl, origin, config: { app: { security: { csp: directives.join("; ") } } } };
}

/**
 * The web dashboard URL a release build shows to administrators: https only, and required, so a release
 * never points them at the dev http://localhost:3000. Exception: an API on the reserved `.invalid` TLD
 * (RFC 2606; CI's unsigned test installer uses https://api.example.invalid) cannot be a real release, so it
 * gets the placeholder https://app.example.invalid.
 */
export function releaseDashboardUrl(raw, apiUrl) {
  if (!raw?.trim()) {
    if (new URL(apiUrl).hostname.endsWith(".invalid")) return "https://app.example.invalid";
    throw new Error("is not set: release builds need the https:// web dashboard URL shown to administrators");
  }
  return resolveApiUrl(raw, "production");
}

/** Bundle identity per WORKFOLIO_ENV. Production is exactly tauri.conf.json, so existing installs are unaffected. */
export const ENVIRONMENTS = {
  production: { identifier: "com.insightworkfolio.desktop", productName: "Insight Workfolio" },
  staging: { identifier: "com.insightworkfolio.desktop.staging", productName: "Insight Workfolio Staging" },
};

/**
 * Identity for WORKFOLIO_ENV (unset = production). The identifier also names the app data directory and
 * (Windows) the single-instance mutex; the keychain / Credential Manager service is the identifier too,
 * compiled into the Rust side through WORKFOLIO_KEYCHAIN_SERVICE (src-tauri/src/lib.rs).
 */
export function environmentIdentity(raw) {
  const env = raw?.trim() || "production";
  if (!Object.hasOwn(ENVIRONMENTS, env)) throw new Error(`must be staging or production, not "${raw}"`);
  const identity = ENVIRONMENTS[env];
  return { env, ...identity, keychainService: identity.identifier };
}

const NOTARY_SETS = [
  ["APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"], // App Store Connect API key (preferred)
  ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"], // Apple ID + app-specific password
];

/** What the Tauri CLI will do with the APPLE_* variables in `env`; throws on a half-configured setup. */
export function signingPlan(env) {
  const has = (k) => Boolean(env[k]);
  const identity = env.APPLE_SIGNING_IDENTITY;
  if (has("APPLE_CERTIFICATE") !== has("APPLE_CERTIFICATE_PASSWORD")) {
    throw new Error("APPLE_CERTIFICATE (base64 .p12) and APPLE_CERTIFICATE_PASSWORD go together");
  }
  if (has("APPLE_CERTIFICATE") && !identity) throw new Error("APPLE_CERTIFICATE needs APPLE_SIGNING_IDENTITY");
  const started = NOTARY_SETS.filter((set) => set.some(has));
  for (const set of started) {
    const missing = set.filter((k) => !has(k));
    if (missing.length) throw new Error(`notarization: ${set.join(", ")} must all be set (missing ${missing.join(", ")})`);
  }
  if (started.length && !identity) throw new Error("notarization needs a signed build: set APPLE_SIGNING_IDENTITY");
  if (identity && identity !== "-" && !identity.startsWith("Developer ID Application:")) {
    throw new Error('APPLE_SIGNING_IDENTITY must be a "Developer ID Application: …" certificate (or "-" for ad-hoc)');
  }
  return { identity: identity ?? null, notarize: started.length > 0 };
}

const AZURE_SIGNING = ["AZURE_TRUSTED_SIGNING_ENDPOINT", "AZURE_TRUSTED_SIGNING_ACCOUNT", "AZURE_TRUSTED_SIGNING_PROFILE"];
const AZURE_AUTH = ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID"];

/**
 * The bundle.windows override for signing with the WINDOWS_* / AZURE_* variables in `env`, or null
 * (unsigned). Throws on a half-configured setup. Either:
 * - WINDOWS_CERTIFICATE_THUMBPRINT (SHA-1 of an OV/EV certificate in the Windows certificate store,
 *   used by signtool) + WINDOWS_TIMESTAMP_URL (the CA's RFC 3161 server; WINDOWS_TIMESTAMP_TSP=1
 *   if the CA requires TSP, e.g. SSL.com), or
 * - Azure Trusted Signing through trusted-signing-cli (on PATH): AZURE_TRUSTED_SIGNING_ENDPOINT,
 *   _ACCOUNT, _PROFILE plus the service principal AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID
 *   (read by the CLI from the environment, never written to the config).
 */
export function windowsSigningPlan(env) {
  const has = (k) => Boolean(env[k]);
  const thumb = env.WINDOWS_CERTIFICATE_THUMBPRINT;
  const azure = [...AZURE_SIGNING, ...AZURE_AUTH];
  const azureStarted = AZURE_SIGNING.some(has);
  if (thumb && azureStarted) throw new Error("choose one: WINDOWS_CERTIFICATE_THUMBPRINT or Azure Trusted Signing, not both");
  if (thumb || has("WINDOWS_TIMESTAMP_URL")) {
    if (!thumb || !has("WINDOWS_TIMESTAMP_URL")) {
      throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT and WINDOWS_TIMESTAMP_URL go together (an untimestamped signature expires with the certificate)");
    }
    const clean = thumb.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]{40}$/.test(clean)) throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT must be the 40 hex characters of the certificate's SHA-1 thumbprint");
    if (!/^https?:\/\//.test(env.WINDOWS_TIMESTAMP_URL)) throw new Error("WINDOWS_TIMESTAMP_URL must be the CA's http(s) timestamp server");
    return {
      method: "certificate",
      config: { certificateThumbprint: clean.toUpperCase(), digestAlgorithm: "sha256", timestampUrl: env.WINDOWS_TIMESTAMP_URL, tsp: env.WINDOWS_TIMESTAMP_TSP === "1" },
    };
  }
  if (azureStarted) {
    const missing = azure.filter((k) => !has(k));
    if (missing.length) throw new Error(`Azure Trusted Signing: ${azure.join(", ")} must all be set (missing ${missing.join(", ")})`);
    const [endpoint, account, profile] = AZURE_SIGNING.map((k) => env[k]);
    return {
      method: "azure-trusted-signing",
      config: { signCommand: { cmd: "trusted-signing-cli", args: ["-e", endpoint, "-a", account, "-c", profile, "-d", "Insight Workfolio", "%1"] } },
    };
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const base = JSON.parse(readFileSync(join(DESKTOP, "src-tauri/tauri.conf.json"), "utf8"));
  let result;
  let dashboardUrl;
  let identity;
  try {
    result = releaseConfig(process.env.WORKFOLIO_API_URL, base.app.security.csp);
  } catch (err) {
    console.error(`WORKFOLIO_API_URL: ${err.message}`);
    process.exit(1);
  }
  try {
    dashboardUrl = releaseDashboardUrl(process.env.WORKFOLIO_DASHBOARD_URL, result.apiUrl);
  } catch (err) {
    console.error(`WORKFOLIO_DASHBOARD_URL: ${err.message}`);
    process.exit(1);
  }
  try {
    identity = environmentIdentity(process.env.WORKFOLIO_ENV);
  } catch (err) {
    console.error(`WORKFOLIO_ENV: ${err.message}`);
    process.exit(1);
  }
  if (identity.env !== "production") Object.assign(result.config, { identifier: identity.identifier, productName: identity.productName });
  let signing;
  let windowsSigning;
  try {
    signing = signingPlan(process.env);
    windowsSigning = windowsSigningPlan(process.env);
  } catch (err) {
    console.error(`Signing: ${err.message}`);
    process.exit(1);
  }
  if (windowsSigning) result.config.bundle = { windows: windowsSigning.config };
  if (args.includes("--print")) {
    console.warn(JSON.stringify({ apiUrl: result.apiUrl, dashboardUrl, keychainService: identity.keychainService, ...result.config }, null, 2));
    process.exit(0);
  }
  const file = join(mkdtempSync(join(tmpdir(), "workfolio-desktop-")), "tauri.release.conf.json");
  writeFileSync(file, JSON.stringify(result.config, null, 2));
  console.warn(`Release build (${identity.env}, ${identity.identifier}) for ${result.apiUrl} (connect-src ${result.origin}), dashboard ${dashboardUrl}`);
  if (process.platform === "win32") {
    console.warn(windowsSigning ? `Windows signing: ${windowsSigning.method}` : "Unsigned Windows installer: for testing only, SmartScreen will warn (docs/deployment.md)");
  }
  console.warn(signing.identity ? `Signing as ${signing.identity}; notarization ${signing.notarize ? "on" : "off"}` : "Unsigned build (no APPLE_SIGNING_IDENTITY): for testing only, Gatekeeper will block it");
  const run = spawnSync("pnpm", ["exec", "tauri", "build", "--config", file, ...args], {
    cwd: DESKTOP,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      VITE_API_URL: result.apiUrl,
      VITE_DASHBOARD_URL: dashboardUrl,
      WORKFOLIO_CSP_ORIGIN: result.origin,
      WORKFOLIO_KEYCHAIN_SERVICE: identity.keychainService,
      WORKFOLIO_PRODUCT_NAME: identity.productName,
    },
  });
  process.exit(run.status ?? 1);
}

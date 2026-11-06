// Production configuration checks (validateEnv runs at boot; the API refuses to start on failure).
import assert from "node:assert/strict";
import { test } from "node:test";

const { validateEnv } = await import("../dist/config/env.js");

const SECRET = "graph-client-secret-value-not-real";
const production = {
  NODE_ENV: "production",
  DATABASE_URL: "libsql://workfolio-example.turso.io",
  JWT_SECRET: "x".repeat(48),
  CORS_ORIGINS: "https://dashboard.example.com,tauri://localhost,http://tauri.localhost",
  DASHBOARD_URL: "https://dashboard.example.com",
  SCREENSHOT_STORAGE: "graph",
  GRAPH_TENANT_ID: "tenant",
  GRAPH_CLIENT_ID: "client",
  GRAPH_CLIENT_SECRET: SECRET,
  GRAPH_SITE_ID: "host,site,web",
  GRAPH_DRIVE_ID: "b!drive",
};
const refused = (patch: Record<string, string | undefined>, variable: string) => {
  assert.throws(() => validateEnv({ ...production, ...patch }), (e: Error) => e.message.includes(variable) && !e.message.includes(SECRET), variable);
};

test("a complete production configuration is accepted", () => {
  const env = validateEnv(production);
  assert.deepEqual(env.CORS_ORIGINS, ["https://dashboard.example.com", "tauri://localhost", "http://tauri.localhost"]);
});

test("production refuses insecure or development settings, naming the variable but never a value", () => {
  refused({ CORS_ORIGINS: undefined }, "CORS_ORIGINS"); // the localhost development default
  refused({ CORS_ORIGINS: "https://dashboard.example.com,http://localhost:3000" }, "CORS_ORIGINS");
  refused({ CORS_ORIGINS: "http://dashboard.example.com" }, "CORS_ORIGINS");
  refused({ DASHBOARD_URL: "http://dashboard.example.com" }, "DASHBOARD_URL");
  refused({ DATABASE_URL: "file:./data/dev.db" }, "DATABASE_URL");
  refused({ JWT_SECRET: undefined }, "JWT_SECRET");
  refused({ JWT_SECRET: "short" }, "JWT_SECRET");
  refused({ SCREENSHOT_STORAGE: "local" }, "SCREENSHOT_STORAGE");
  refused({ GRAPH_CERT_KEY_PATH: "/etc/key.pem", GRAPH_CERT_THUMBPRINT: "A".repeat(40) }, "SCREENSHOT_STORAGE"); // two credentials
});

test("development keeps its local defaults", () => {
  const env = validateEnv({});
  assert.equal(env.NODE_ENV, "development");
  assert.ok(env.CORS_ORIGINS.includes("http://localhost:3000"));
});

test("email reports: the mock provider is refused in production; the default sends nothing", () => {
  refused({ REPORT_MAIL_PROVIDER: "mock" }, "REPORT_MAIL_PROVIDER");
  assert.equal(validateEnv(production).REPORT_MAIL_PROVIDER, "none");
  assert.throws(() => validateEnv({ ...production, REPORT_MAIL_PROVIDER: "smtp" }));
});

test("website tracking: production collection is blocked until the operator sets WEBSITE_TRACKING_APPROVED=true", () => {
  assert.equal(validateEnv(production).WEBSITE_TRACKING_APPROVED, false);
  assert.equal(validateEnv({ ...production, WEBSITE_TRACKING_APPROVED: "true" }).WEBSITE_TRACKING_APPROVED, true);
  assert.throws(() => validateEnv({ ...production, WEBSITE_TRACKING_APPROVED: "yes" }));
});

test("DATABASE_URL: production accepts libsql:// and https://, refuses wss:// (Turso rejects the WebSocket transport)", () => {
  assert.equal(validateEnv({ ...production, DATABASE_URL: "https://workfolio-example.turso.io" }).DATABASE_URL, "https://workfolio-example.turso.io");
  refused({ DATABASE_URL: "wss://workfolio-example.turso.io" }, "DATABASE_URL");
  assert.throws(() => validateEnv({ ...production, DATABASE_URL: "wss://workfolio-example.turso.io" }), /libsql:\/\/ or https:\/\//);
});

test("DATABASE_URL: production never falls back to the development database (unset, relative file: or :memory: refused), libsql:// accepted", () => {
  assert.equal(validateEnv(production).DATABASE_URL, "libsql://workfolio-example.turso.io");
  for (const url of [undefined, "file:./data/dev.db", "file:data/dev.db", ":memory:"]) {
    assert.throws(() => validateEnv({ ...production, DATABASE_URL: url }), /DATABASE_URL must be libsql:\/\/ or https:\/\/ \(Turso\) or file:\/absolute\/path/, String(url));
  }
  assert.throws(() => validateEnv({ ...production, DATABASE_URL: "" }), /DATABASE_URL/); // empty: rejected as too short
});

test("DATABASE_URL: production accepts a persistent local file by absolute path only (no query, no file://host form)", () => {
  assert.equal(validateEnv({ ...production, DATABASE_URL: "file:/var/lib/workfolio/db/workfolio.db" }).DATABASE_URL, "file:/var/lib/workfolio/db/workfolio.db");
  for (const url of ["file:/var/lib/workfolio/db/workfolio.db?mode=ro", "file:///var/lib/workfolio/db/workfolio.db", "file://host/x.db", "file:/x.db#frag"]) {
    refused({ DATABASE_URL: url }, "DATABASE_URL");
  }
});

test("single-origin launch on a public IP: https IP-literal origins are accepted in production, plain http is not", () => {
  const ip = { ...production, CORS_ORIGINS: "https://189.72.144.117,tauri://localhost,http://tauri.localhost", DASHBOARD_URL: "https://189.72.144.117" };
  const env = validateEnv(ip);
  assert.deepEqual(env.CORS_ORIGINS, ["https://189.72.144.117", "tauri://localhost", "http://tauri.localhost"]);
  assert.equal(env.DASHBOARD_URL, "https://189.72.144.117");
  refused({ CORS_ORIGINS: "http://189.72.144.117,tauri://localhost" }, "CORS_ORIGINS");
  refused({ DASHBOARD_URL: "http://189.72.144.117" }, "DASHBOARD_URL");
});

test("TIMELAPSE_MIN_FREE_MB: 1024 by default; 0 disables; negative or huge refused", () => {
  assert.equal(validateEnv(production).TIMELAPSE_MIN_FREE_MB, 1024);
  assert.equal(validateEnv({ ...production, TIMELAPSE_MIN_FREE_MB: "0" }).TIMELAPSE_MIN_FREE_MB, 0);
  for (const v of ["-1", "2000000", "lots"]) refused({ TIMELAPSE_MIN_FREE_MB: v }, "TIMELAPSE_MIN_FREE_MB");
});

test("HOST: loopback by default; an IP address or localhost; anything else refused", () => {
  assert.equal(validateEnv({}).HOST, "127.0.0.1");
  assert.equal(validateEnv(production).HOST, "127.0.0.1");
  for (const ok of ["0.0.0.0", "::1", "localhost", "10.0.0.5"]) assert.equal(validateEnv({ HOST: ok }).HOST, ok);
  for (const bad of ["api.example.com", "*", "127.0.0.1:4000", " "]) assert.throws(() => validateEnv({ HOST: bad }), /HOST/, bad);
});

test("TRUST_PROXY: default loopback; hop count, named ranges or address/CIDR lists; anything else refused", () => {
  assert.deepEqual(validateEnv({}).TRUST_PROXY, ["loopback"]);
  assert.equal(validateEnv({ TRUST_PROXY: "1" }).TRUST_PROXY, 1);
  assert.equal(validateEnv({ TRUST_PROXY: "0" }).TRUST_PROXY, 0);
  assert.deepEqual(validateEnv({ TRUST_PROXY: "loopback, 10.0.0.0/8,fd00::/8 ,192.168.1.10" }).TRUST_PROXY, ["loopback", "10.0.0.0/8", "fd00::/8", "192.168.1.10"]);
  for (const bad of ["true", "all", "11", "-1", "1.5", "10.0.0.0/33", "fd00::/129", "10.0.0.0/8/1", "not-an-ip", ",", "10.0.0.0/"]) {
    assert.throws(() => validateEnv({ TRUST_PROXY: bad }), /TRUST_PROXY/, bad);
  }
});

test("API_RATE_LIMIT_PER_MINUTE: optional (the app picks its default); empty means unset; 0 turns it off", () => {
  assert.equal(validateEnv({}).API_RATE_LIMIT_PER_MINUTE, undefined);
  assert.equal(validateEnv({ API_RATE_LIMIT_PER_MINUTE: "" }).API_RATE_LIMIT_PER_MINUTE, undefined);
  assert.equal(validateEnv({ API_RATE_LIMIT_PER_MINUTE: "0" }).API_RATE_LIMIT_PER_MINUTE, 0);
  assert.equal(validateEnv({ API_RATE_LIMIT_PER_MINUTE: "1200" }).API_RATE_LIMIT_PER_MINUTE, 1200);
  for (const bad of ["-1", "abc", "1.5"]) assert.throws(() => validateEnv({ API_RATE_LIMIT_PER_MINUTE: bad }), /API_RATE_LIMIT_PER_MINUTE/, bad);
});

test("WEBSITE_RETENTION_APPROVED: off by default; only true/false", () => {
  assert.equal(validateEnv(production).WEBSITE_RETENTION_APPROVED, false);
  assert.equal(validateEnv({ ...production, WEBSITE_RETENTION_APPROVED: "true" }).WEBSITE_RETENTION_APPROVED, true);
  assert.throws(() => validateEnv({ ...production, WEBSITE_RETENTION_APPROVED: "yes" }));
});

test("DATABASE_URL: any environment refuses credentials or a query in a remote URL, and plaintext http:// except to this machine", () => {
  for (const ok of ["file:./data/dev.db", ":memory:", "libsql://db-org.aws-ap-south-1.turso.io", "https://db-org.turso.io", "http://127.0.0.1:8080"]) {
    assert.equal(validateEnv({ DATABASE_URL: ok }).DATABASE_URL, ok);
  }
  for (const bad of ["libsql://db.turso.io?authToken=eyJx.y.z", "libsql://user:pw@db.turso.io", "http://db.turso.io", "ws://db.turso.io", "not a url"]) {
    assert.throws(() => validateEnv({ DATABASE_URL: bad }), (err) => /DATABASE_URL/.test(err.message) && !err.message.includes("eyJx"), bad);
  }
});

test("OneDrive (IT storage account): accepted in production when complete; partial, wrong callback, short key or relative file refused", () => {
  const od = {
    ...production,
    SCREENSHOT_STORAGE: "onedrive",
    ONEDRIVE_TENANT_ID: "tenant",
    ONEDRIVE_CLIENT_ID: "client-od",
    ONEDRIVE_CLIENT_SECRET: SECRET,
    ONEDRIVE_REDIRECT_URI: "https://api.example.com/api/v1/storage/onedrive/oauth/callback",
    ONEDRIVE_TOKEN_FILE: "/var/data/secrets/onedrive.json",
    ONEDRIVE_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
    ONEDRIVE_ACCOUNT_EMAIL: "IT@TFFDigital.com",
  };
  const env = validateEnv(od);
  assert.deepEqual([env.SCREENSHOT_STORAGE, env.ONEDRIVE_ACCOUNT_EMAIL, env.ONEDRIVE_ROOT_FOLDER], ["onedrive", "it@tffdigital.com", "InsightWorkfolio"]);
  const bad = (patch: Record<string, string | undefined>, variable: string) =>
    assert.throws(() => validateEnv({ ...od, ...patch }), (e: Error) => e.message.includes(variable) && !e.message.includes(SECRET), JSON.stringify(patch));
  bad({ ONEDRIVE_CLIENT_SECRET: undefined }, "ONEDRIVE_CLIENT_ID");
  bad({ ONEDRIVE_TOKEN_KEY: Buffer.alloc(16).toString("base64") }, "ONEDRIVE_TOKEN_KEY");
  bad({ ONEDRIVE_TOKEN_FILE: "data/onedrive.json" }, "ONEDRIVE_TOKEN_FILE");
  bad({ ONEDRIVE_REDIRECT_URI: "https://api.example.com/api/v1/storage/google-drive/oauth/callback" }, "ONEDRIVE_REDIRECT_URI");
  assert.equal(validateEnv({ ...od, ONEDRIVE_REDIRECT_URI: "https://189.72.144.117/api/v1/storage/onedrive/oauth/callback" }).ONEDRIVE_REDIRECT_URI, "https://189.72.144.117/api/v1/storage/onedrive/oauth/callback", "single-origin launch");
  bad({ ONEDRIVE_REDIRECT_URI: "http://189.72.144.117/api/v1/storage/onedrive/oauth/callback" }, "ONEDRIVE_REDIRECT_URI");
  // Off-site database backups: a dedicated subfolder, never the screenshot or timelapse folders; retention opt-in.
  assert.deepEqual([env.ONEDRIVE_BACKUP_FOLDER, env.ONEDRIVE_BACKUP_KEEP_DAYS], ["db-backups", undefined]);
  assert.equal(validateEnv({ ...od, ONEDRIVE_BACKUP_FOLDER: "Backups 2026", ONEDRIVE_BACKUP_KEEP_DAYS: "90" }).ONEDRIVE_BACKUP_KEEP_DAYS, 90);
  for (const folder of ["screenshots", "Timelapses", "db/backups", ""]) bad({ ONEDRIVE_BACKUP_FOLDER: folder }, "ONEDRIVE_BACKUP_FOLDER");
  bad({ ONEDRIVE_BACKUP_KEEP_DAYS: "0" }, "ONEDRIVE_BACKUP_KEEP_DAYS");
  bad({ ONEDRIVE_REDIRECT_URI: "http://api.example.com/api/v1/storage/onedrive/oauth/callback" }, "ONEDRIVE_REDIRECT_URI");
  bad({ ONEDRIVE_ACCOUNT_EMAIL: "not an email" }, "ONEDRIVE_ACCOUNT_EMAIL");
});

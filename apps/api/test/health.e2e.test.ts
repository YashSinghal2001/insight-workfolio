import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { FILE_STORAGE } = await import("../dist/screenshots/storage.js");
const { ConfigService } = await import("@nestjs/config");

let app: INestApplication;
let base: string;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
});
after(() => app.close());

test("GET /api/v1/health reports the process is up", async () => {
  const res = await fetch(`${base}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(typeof body.uptimeSeconds, "number");
});

test("GET /api/v1/health reports the API version and the deployed commit, only when it is a plain hex id", async () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const health = async (commit: string | undefined) => {
    if (commit === undefined) delete process.env.WORKFOLIO_BUILD_COMMIT;
    else process.env.WORKFOLIO_BUILD_COMMIT = commit;
    const res = await fetch(`${base}/api/v1/health`);
    assert.equal(res.status, 200);
    return res.json();
  };
  try {
    const plain = await health(undefined);
    assert.deepEqual(Object.keys(plain).sort(), ["commit", "status", "timestamp", "uptimeSeconds", "version"]);
    assert.equal(plain.version, version);
    assert.equal(plain.commit, null, "not set");
    assert.equal((await health("3a315bb")).commit, "3a315bb", "short sha (7)");
    const full = "0123456789abcdef0123456789abcdef01234567";
    assert.equal((await health(full)).commit, full, "full sha (40)");
    for (const bad of ["", "3a315b", "3A315BB", `${full}8`, "3a315bb\n", "3a315bb; rm -rf /", "<script>", "g123456"]) {
      assert.equal((await health(bad)).commit, null, JSON.stringify(bad));
    }
  } finally {
    delete process.env.WORKFOLIO_BUILD_COMMIT;
  }
});

test("GET /api/v1/ready is ready when the database answers", async () => {
  const res = await fetch(`${base}/api/v1/ready`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ready");
  assert.equal(body.checks.database.status, "up");
  assert.equal(body.checks.storage.status, "up");
  assert.equal(body.checks.storage.provider, "LOCAL_DEV");
});

test("GET /api/v1/ready returns 503 when the storage provider is unusable, without leaking details", async () => {
  const storage = app.get(FILE_STORAGE);
  const original = storage.stat;
  storage.stat = async () => {
    throw new Error("token refresh failed for /secret/path client_secret=abc");
  };
  try {
    const res = await fetch(`${base}/api/v1/ready`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, "not_ready");
    assert.equal(body.checks.database.status, "up");
    assert.deepEqual(body.checks.storage, { status: "down", error: "unreachable", provider: "LOCAL_DEV" });
    assert.ok(!JSON.stringify(body).includes("secret"));
  } finally {
    storage.stat = original;
  }
  assert.equal((await fetch(`${base}/api/v1/ready`)).status, 200);
});

test("Strict-Transport-Security is sent in production mode only", async () => {
  assert.equal((await fetch(`${base}/api/v1/health`)).headers.get("strict-transport-security"), null);
  // A second app whose wiring sees NODE_ENV=production (the rest of the test env is unchanged).
  const prod = await NestFactory.create(AppModule, { logger: false });
  const config = prod.get(ConfigService);
  const get = config.get.bind(config);
  config.get = ((key: string, opts?: unknown) => (key === "NODE_ENV" ? "production" : get(key, opts))) as typeof config.get;
  configureApp(prod);
  await prod.listen(0);
  try {
    const url = (await prod.getUrl()).replace("[::1]", "localhost");
    for (const path of ["/api/v1/health", "/api/v1/nope"]) {
      const res = await fetch(`${url}${path}`);
      assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains", path);
    }
  } finally {
    await prod.close();
  }
});

test("unknown routes return the ApiError envelope", async () => {
  const res = await fetch(`${base}/api/v1/nope?token=secret`, { headers: { "x-request-id": "test-123" } });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.statusCode, 404);
  assert.equal(body.path, "/api/v1/nope");
  assert.equal(body.requestId, "test-123");
  assert.ok(!JSON.stringify(body).includes("secret"), "query string must not be echoed");
});

test("CORS allows the dashboard origin and rejects others", async () => {
  const ok = await fetch(`${base}/api/v1/health`, { headers: { origin: "http://localhost:3000" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:3000");
  const bad = await fetch(`${base}/api/v1/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

// Runs last: closes the DB client so readiness genuinely fails.
test("GET /api/v1/ready returns 503 when the database is down", async () => {
  app.get(DATABASE).close();
  const res = await fetch(`${base}/api/v1/ready`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, "not_ready");
  assert.deepEqual(body.checks.database, { status: "down", error: "unreachable" });
});

test("API responses are never cached, sniffed or framed (including errors)", async () => {
  for (const path of ["/api/v1/health", "/api/v1/nope"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer", path);
    assert.equal(res.headers.get("x-frame-options"), "DENY", path);
  }
});

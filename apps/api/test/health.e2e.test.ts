import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");

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

test("GET /api/v1/ready is ready when the database answers", async () => {
  const res = await fetch(`${base}/api/v1/ready`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ready");
  assert.equal(body.checks.database.status, "up");
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

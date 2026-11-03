// F12 with the default provider ("none"): reports are generated and recorded, and nothing is sent.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
delete process.env.REPORT_MAIL_PROVIDER;

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");

let app: INestApplication;
let base: string;
let cookie: string;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  const db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword("report password 1")] });
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "report password 1" }) });
  cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
after(() => app.close());

const api = async (path: string, method = "GET", body?: unknown) => {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { origin: "http://localhost:3000", cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test("no provider configured: the run is recorded as not emailed, never as sent", async () => {
  assert.deepEqual((await api("/reports/provider")).body, { provider: "none", delivers: false, schedulerSeconds: 300 });
  const s = (await api("/reports/schedules", "POST", { name: "Daily", frequency: "DAILY", timeZone: "UTC" })).body;
  const me = (await api(`/reports/schedules/${s.id}/eligible-recipients`)).body[0];
  await api(`/reports/schedules/${s.id}/recipients`, "POST", { userId: me.id });
  const r = await api(`/reports/schedules/${s.id}/run`, "POST");
  const d = r.body.run.deliveries[0];
  assert.deepEqual([r.body.run.status, d.status, d.provider, d.attempts[0].outcome], ["NOT_EMAILED", "NOT_CONFIGURED", "none", "NOT_CONFIGURED"]);
  assert.match(d.lastError, /No email provider is configured; nothing was sent/);
});

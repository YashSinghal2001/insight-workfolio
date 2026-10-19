// Day 8: a screenshot registered before an API restart is uploaded after it (file database, same storage).
// Own file: the API reads DATABASE_URL once at import, so the file URL must be set before importing.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const DIR = mkdtempSync(join(tmpdir(), "wf-restart-test-"));
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = `file:${join(DIR, "api.db")}`;
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.SCREENSHOT_STORAGE = "local";
process.env.SCREENSHOT_LOCAL_DIR = join(DIR, "storage");

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { DEFAULT_SCREENSHOT_NOTICE_VERSION } = await import("@workfolio/shared");

const PASSWORD = "employee password 1";
const iso = (ms: number) => new Date(ms).toISOString();
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

async function boot(): Promise<{ app: INestApplication; base: string; db: Db }> {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  return { app, base: (await app.getUrl()).replace("[::1]", "localhost"), db: app.get(DATABASE) };
}
async function api(base: string, path: string, { method = "GET", body, raw, cookie, bearer, device }: { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; bearer?: string; device?: string } = {}) {
  const headers: Record<string, string> = { origin: "http://localhost:3000" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, res };
}

after(() => rmSync(DIR, { recursive: true, force: true }));

test("registrations survive an API restart; the upload completes against the restarted API", async () => {
  let { app, base, db } = await boot();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const login = await api(base, "/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  const cookie = login.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at)
          VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test', (SELECT id FROM users LIMIT 1), ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 86_400_000)],
  });
  const r = await api(base, "/employees", { method: "POST", cookie, body: { email: "restart@example.com", employeeCode: "RS-1", fullName: "Restart", timezone: "UTC" } });
  await api(base, "/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const desktop = async () => (await api(base, "/auth/login", { method: "POST", body: { email: "restart@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken as string;
  let bearer = await desktop();
  const device = randomUUID();
  await api(base, "/devices/register", { method: "POST", bearer, body: { installationId: device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), r.body.employee.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 3_600_000)] });
  await api(base, "/attendance/sync", { method: "POST", bearer, device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 1_800_000) }] } });

  const bytes = new Uint8Array(1032);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  new DataView(bytes.buffer).setUint32(16, bytes.length - 20, true);
  bytes[20] = 0x2f;
  new DataView(bytes.buffer).setUint32(21, 1919 | (1079 << 14), true);
  const id = randomUUID();
  const meta = { id, capturedAt: iso(Date.now() - 600_000), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp" };
  const register = () => api(base, "/screenshots/register", { method: "POST", bearer, device, body: { ...meta, sentAt: iso(Date.now()) } });
  assert.equal((await register()).body.status, "REGISTERED");
  await app.close(); // API restarts between registration and upload

  ({ app, base, db } = await boot());
  try {
    bearer = await desktop();
    assert.equal((await register()).body.status, "REGISTERED", "idempotent after restart");
    const up = await api(base, `/screenshots/${id}/content`, { method: "PUT", bearer, device, raw: bytes });
    assert.equal(up.body.status, "STORED");
    assert.equal((await db.execute("SELECT count(*) AS n FROM screenshots")).rows[0]!.n, 1, "no duplicate row");
  } finally {
    await app.close();
  }
});

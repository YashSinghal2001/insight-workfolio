// Desktop auto-update (migration 0032): releases, package verification, the public updater manifest,
// rollout, minimum version, Testing ring, permissions and device status reporting.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

// The updater key pair for this test (the API only ever sees the public half).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY_ID = Buffer.from("1122334455667788", "hex"); // little-endian on the wire, printed reversed
const pubRaw = Buffer.concat([Buffer.from("Ed"), KEY_ID, Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")]);
const PUBKEY = Buffer.from(`untrusted comment: minisign public key: 8877665544332211\n${pubRaw.toString("base64")}\n`).toString("base64");
function sigFor(file: Buffer, version: string, key = privateKey, id = KEY_ID) {
  const sig = sign(null, createHash("blake2b512").update(file).digest(), key);
  const trusted = `timestamp:1\tfile:app.tar.gz\tversion:${version}`;
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), key);
  return Buffer.from(`untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`).toString("base64");
}

const DIR = mkdtempSync(join(tmpdir(), "wf-updates-"));
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = `file:${join(DIR, "api.db")}`;
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.DESKTOP_UPDATER_PUBKEY = PUBKEY;

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { AuthService } = await import("../dist/auth/auth.service.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { rolloutBucket } = await import("../dist/desktop-updates/desktop-updates.service.js");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let superCookie: string;
let itCookie: string;

// Package host (stands in for GitHub Releases / the VPS download folder).
const files = new Map<string, Buffer>();
let files404 = false;
let pkgServer: Server;
let pkgBase: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string };
async function api(path: string, { method = "GET", body, cookie, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "idempotency-key": randomUUID() };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
async function webLogin(email: string) {
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function adminUser(email: string, title: "SUPER_ADMIN" | null) {
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, 'ADMIN', ?, ?)", args: [randomUUID(), email, title, await hashPassword(PASSWORD)] });
}
let seq = 0;
/** An employee signed in on a registered desktop installation. */
async function desktopEmployee(platform: "macos" | "windows" = "macos") {
  const n = ++seq;
  const email = `upd${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: superCookie, body: { email, employeeCode: `UPD-${n}`, fullName: `Update ${n}`, timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const installationId = randomUUID();
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop", installationId } });
  assert.equal(login.status, 200, login.text);
  const reg = await api("/devices/register", { method: "POST", bearer: login.body.accessToken, body: { installationId, deviceName: `Device ${n}`, platform } });
  assert.equal(reg.status, 201, reg.text);
  return { userId: r.body.employee.userId as string, bearer: login.body.accessToken as string, installationId, deviceId: reg.body.id as string };
}

/** Serves `bytes` and returns an artifact for it, signed for `version`. */
function artifact(target: string, version: string, bytes = Buffer.from(`package ${target} ${version} ${randomUUID()}`), signature?: string) {
  const name = `${randomUUID()}.tar.gz`;
  files.set(`/${name}`, bytes);
  return { target, url: `${pkgBase}/${name}`, signature: signature ?? sigFor(bytes, version) };
}
const create = (body: Record<string, unknown>, cookie = superCookie) => api("/desktop-updates/releases", { method: "POST", cookie, body });
const setStatus = (id: string, status: string, cookie = superCookie, reason?: string) => api(`/desktop-updates/releases/${id}/status`, { method: "POST", cookie, body: { status, reason } });
const manifest = (target: string, arch: string, version: string, device?: string) => api(`/desktop-updates/manifest/${target}/${arch}/${version}`, { device });
async function published(version: string, extra: Record<string, unknown> = {}, targets = ["darwin-aarch64", "windows-x86_64"]) {
  const r = await create({ version, artifacts: targets.map((t) => artifact(t, version)), ...extra });
  assert.equal(r.status, 201, r.text);
  const p = await setStatus(r.body.id, "PUBLISHED");
  assert.equal(p.status, 200, p.text);
  return p.body;
}

before(async () => {
  pkgServer = createServer((req, res) => {
    const body = files.get(req.url ?? "");
    if (files404 || !body) return void res.writeHead(404).end();
    res.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise<void>((r) => pkgServer.listen(0, "127.0.0.1", r));
  pkgBase = `http://127.0.0.1:${(pkgServer.address() as { port: number }).port}`;
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await adminUser("ceo@example.com", "SUPER_ADMIN");
  await adminUser("it@example.com", null);
  superCookie = await webLogin("ceo@example.com");
  itCookie = await webLogin("it@example.com");
});
beforeEach(async () => {
  (app.get(AuthService).loginByIp as unknown as { hits: Map<string, unknown> }).hits.clear();
  files404 = false;
  // Each test starts with nothing served (release events are append-only, so earlier releases are disabled, not deleted).
  await db.execute("UPDATE desktop_releases SET status = 'DISABLED'");
});
after(async () => {
  await app.close();
  pkgServer.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("desktop updates", () => {
  test("nothing published: 204; a draft and a disabled release are never served", async () => {
    assert.equal((await manifest("darwin", "aarch64", "0.2.0")).status, 204);
    const r = await create({ version: "1.0.0", artifacts: [artifact("darwin-aarch64", "1.0.0")] });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, "DRAFT");
    assert.equal((await manifest("darwin", "aarch64", "0.2.0")).status, 204, "draft not served");
  });

  test("publish verifies every package; the manifest is the Tauri dynamic format plus policy fields", async () => {
    const body = Buffer.from("a mac package");
    const r = await create({ version: "1.1.0", notes: "Fixes", policy: "RECOMMENDED", postponeHours: 8, artifacts: [artifact("darwin-aarch64", "1.1.0", body), artifact("windows-x86_64", "1.1.0")] });
    const p = await setStatus(r.body.id, "PUBLISHED");
    assert.equal(p.status, 200, p.text);
    const mac = p.body.artifacts.find((a: { target: string }) => a.target === "darwin-aarch64");
    assert.equal(mac.sizeBytes, body.length);
    assert.equal(mac.sha256, createHash("sha256").update(body).digest("hex"));
    assert.ok(mac.verifiedAt);
    const m = await manifest("darwin", "aarch64", "1.0.0");
    assert.equal(m.status, 200, m.text);
    assert.deepEqual(Object.keys(m.body).sort(), ["minimumVersion", "mandatory", "notes", "policy", "postponeHours", "pub_date", "releaseId", "signature", "sizeBytes", "url", "version"].sort());
    assert.equal(m.body.version, "1.1.0");
    assert.equal(m.body.url, mac.url);
    assert.equal(m.body.policy, "RECOMMENDED");
    assert.equal(m.body.postponeHours, 8);
    assert.equal(m.body.mandatory, false);
    assert.equal(m.body.sizeBytes, body.length);
    // Same or newer installed version, unknown platform, Intel without an Intel package, junk version: 204.
    for (const [t, a, v] of [["darwin", "aarch64", "1.1.0"], ["darwin", "aarch64", "2.0.0"], ["linux", "x86_64", "1.0.0"], ["darwin", "x86_64", "1.0.0"], ["darwin", "aarch64", "abc"]] as const) {
      assert.equal((await manifest(t, a, v)).status, 204, `${t}-${a} ${v}`);
    }
    assert.equal((await manifest("windows", "x86_64", "1.0.0")).body.version, "1.1.0");
  });

  test("publishing is refused for a bad signature, wrong key, wrong bound version, missing file, or a lower version", async () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    const bytes = Buffer.from("pkg");
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["2.0.1", artifact("darwin-aarch64", "2.0.1", bytes, sigFor(Buffer.from("other bytes"), "2.0.1")), /does not match the file/],
      ["2.0.2", artifact("darwin-aarch64", "2.0.2", bytes, sigFor(bytes, "2.0.2", other, Buffer.alloc(8, 9))), /Signed with key 0909090909090909, but this server expects key 8877665544332211/],
      ["2.0.3", artifact("darwin-aarch64", "2.0.3", bytes, sigFor(bytes, "1.9.0")), /signed for version 1.9.0, not 2.0.3/],
    ];
    for (const [version, a, re] of cases) {
      const r = await create({ version, artifacts: [a] });
      assert.equal(r.status, 201, r.text);
      const p = await setStatus(r.body.id, "PUBLISHED");
      assert.equal(p.status, 400, p.text);
      assert.match(p.body.message, re);
      assert.equal((await api("/desktop-updates/releases", { cookie: superCookie })).body.find((x: { id: string }) => x.id === r.body.id).status, "DRAFT");
    }
    files404 = true;
    const missing = await create({ version: "2.1.0", artifacts: [artifact("darwin-aarch64", "2.1.0")] });
    assert.match((await setStatus(missing.body.id, "PUBLISHED")).body.message, /download failed \(HTTP 404\)/);
    files404 = false;
    const none = await create({ version: "2.2.0" });
    assert.equal((await setStatus(none.body.id, "PUBLISHED")).status, 400, "no packages");
    assert.equal((await manifest("darwin", "aarch64", "1.0.0")).status, 204, "nothing failed got served");
    await published("3.0.0");
    const lower = await create({ version: "2.9.0", artifacts: [artifact("darwin-aarch64", "2.9.0")] });
    const r = await setStatus(lower.body.id, "PUBLISHED");
    assert.equal(r.status, 409);
    assert.match(r.body.message, /3.0.0 is already published/);
    // https only (plain http only to this machine, outside production).
    assert.equal((await create({ version: "3.1.0", artifacts: [{ ...artifact("darwin-aarch64", "3.1.0"), url: "http://example.com/a.tar.gz" }] })).status, 400);
    assert.equal((await create({ version: "3.1.1", artifacts: [{ ...artifact("darwin-aarch64", "3.1.1"), url: "ftp://example.com/a" }] })).status, 400);
  });

  test("rollout admits a stable share of installations; mandatory and minimum version bypass it", async () => {
    const rel = await published("4.0.0", { rolloutPercent: 30 });
    const ids = Array.from({ length: 200 }, () => randomUUID());
    let admitted = 0;
    for (const id of ids) {
      const m = await manifest("darwin", "aarch64", "3.5.0", id);
      const expected = rolloutBucket(rel.id, id) < 30;
      assert.equal(m.status, expected ? 200 : 204);
      if (expected) admitted++;
    }
    assert.ok(admitted > 30 && admitted < 100, `~30% of 200, got ${admitted}`);
    assert.equal((await manifest("darwin", "aarch64", "3.5.0")).status, 204, "no installation id: only a 100% rollout");
    // Minimum supported version 3.9.0: installations below it get the update whatever their bucket.
    assert.equal((await api(`/desktop-updates/releases/${rel.id}`, { method: "PATCH", cookie: superCookie, body: { minimumVersion: "3.9.0" } })).status, 200);
    for (const id of ids.slice(0, 20)) {
      const m = await manifest("darwin", "aarch64", "3.5.0", id);
      assert.equal(m.status, 200);
      assert.equal(m.body.mandatory, true);
      assert.equal(m.body.minimumVersion, "3.9.0");
    }
    // At or above the minimum: optional again, and back under the rollout.
    const out = ids.find((id) => rolloutBucket(rel.id, id) >= 30)!;
    assert.equal((await manifest("darwin", "aarch64", "3.9.0", out)).status, 204);
    assert.equal((await api(`/desktop-updates/releases/${rel.id}`, { method: "PATCH", cookie: superCookie, body: { minimumVersion: "4.1.0" } })).status, 400, "minimum above the release");
  });

  test("a MANDATORY release is mandatory for every older installation; disabling it stops it at once", async () => {
    const rel = await published("5.0.0", { policy: "MANDATORY", rolloutPercent: 0 });
    const m = await manifest("windows", "x86_64", "4.0.0", randomUUID());
    assert.equal(m.status, 200);
    assert.equal(m.body.mandatory, true);
    // Admin (IT) may disable (kill switch) but not publish.
    assert.equal((await setStatus(rel.id, "DISABLED", itCookie, "Crash on start")).status, 200);
    assert.equal((await manifest("windows", "x86_64", "4.0.0", randomUUID())).status, 204);
    assert.equal((await setStatus(rel.id, "PUBLISHED", itCookie)).status, 403);
    const hist = await api(`/desktop-updates/releases/${rel.id}/history`, { cookie: itCookie });
    assert.deepEqual(hist.body.map((e: { action: string }) => e.action), ["RELEASE_DISABLED", "RELEASE_PUBLISHED", "RELEASE_VERIFIED", "RELEASE_CREATED"]);
    assert.equal(hist.body[0].reason, "Crash on start");
    assert.equal(hist.body[0].actor, "it@example.com");
  });

  test("TESTING reaches administrators' own devices only", async () => {
    const r = await create({ version: "6.0.0", artifacts: [artifact("darwin-aarch64", "6.0.0")] }, itCookie);
    assert.equal(r.status, 201, "Admin (IT) drafts");
    assert.equal((await setStatus(r.body.id, "TESTING", itCookie)).status, 200, "Admin (IT) moves to Testing (verified)");
    const staff = await desktopEmployee();
    const tester = await desktopEmployee();
    await db.execute({ sql: "UPDATE users SET role = 'ADMIN' WHERE id = ?", args: [tester.userId] });
    assert.equal((await manifest("darwin", "aarch64", "5.0.0", staff.installationId)).status, 204);
    assert.equal((await manifest("darwin", "aarch64", "5.0.0")).status, 204);
    assert.equal((await manifest("darwin", "aarch64", "5.0.0", tester.installationId)).body.version, "6.0.0");
  });

  test("permissions: employees cannot see or change releases; Admin (IT) cannot change a published release's behaviour", async () => {
    const e = await desktopEmployee();
    for (const [path, method] of [["/desktop-updates/releases", "GET"], ["/desktop-updates/releases", "POST"], ["/desktop-updates/devices", "GET"]] as const) {
      assert.equal((await api(path, { method, bearer: e.bearer, body: method === "POST" ? { version: "9.0.0" } : undefined })).status, 403, `${method} ${path}`);
    }
    const rel = await published("7.0.0");
    assert.equal((await api(`/desktop-updates/releases/${rel.id}`, { method: "PATCH", cookie: itCookie, body: { rolloutPercent: 100 } })).status, 403);
    const edited = await api(`/desktop-updates/releases/${rel.id}`, { method: "PATCH", cookie: itCookie, body: { notes: "Clearer notes" } });
    assert.equal(edited.status, 200, "notes stay editable");
    assert.deepEqual([edited.body.notes, edited.body.policy, edited.body.rolloutPercent, edited.body.status], ["Clearer notes", rel.policy, rel.rolloutPercent, "PUBLISHED"], "only notes changed");
    assert.equal((await api(`/desktop-updates/releases/${rel.id}`, { method: "PATCH", cookie: superCookie, body: { artifacts: [] } })).status, 409, "published packages are fixed");
    assert.equal((await create({ version: "7.0.0" })).status, 409, "duplicate version");
    assert.equal((await create({ version: "7.0" })).status, 400);
  });

  test("devices report their update state; an upgrade is recorded; web sessions and other employees' devices cannot report", async () => {
    const e = await desktopEmployee("windows");
    const report = (body: Record<string, unknown>, bearer = e.bearer, device = e.installationId) => api("/desktop-updates/status", { method: "POST", bearer, device, body });
    assert.equal((await report({ installedVersion: "0.2.0", availableVersion: "0.3.0", state: "AVAILABLE" })).status, 204);
    assert.equal((await report({ installedVersion: "0.2.0", availableVersion: "0.3.0", state: "FAILED", failureReason: "Not enough disk space" })).status, 204);
    let row = (await api("/desktop-updates/devices", { cookie: itCookie })).body.find((d: { deviceId: string }) => d.deviceId === e.deviceId);
    assert.equal(row.state, "FAILED");
    assert.equal(row.failureReason, "Not enough disk space");
    assert.equal(row.lastUpdatedAt, null);
    assert.equal((await report({ installedVersion: "0.3.0", state: "UP_TO_DATE" })).status, 204);
    row = (await api("/desktop-updates/devices", { cookie: itCookie })).body.find((d: { deviceId: string }) => d.deviceId === e.deviceId);
    assert.equal(row.installedVersion, "0.3.0");
    assert.equal(row.lastUpdatedFrom, "0.2.0");
    assert.ok(row.lastUpdatedAt);
    assert.equal(row.failureReason, null);
    const other = await desktopEmployee();
    assert.equal((await report({ installedVersion: "0.3.0", state: "UP_TO_DATE" }, other.bearer, e.installationId)).status, 403, "not your device");
    assert.equal((await report({ installedVersion: "0.3.0", state: "UP_TO_DATE" }, e.bearer, "")).status, 403, "no installation id");
    assert.equal((await report({ installedVersion: "zzz", state: "UP_TO_DATE" })).status, 400);
    assert.equal((await api("/desktop-updates/status", { method: "POST", cookie: superCookie, body: { installedVersion: "0.3.0", state: "UP_TO_DATE" } })).status, 403, "web session");
    // Revoked: no longer reports; leaves the list.
    await api(`/devices/${e.deviceId}/revoke`, { method: "POST", cookie: itCookie, body: {} });
    assert.ok(!(await api("/desktop-updates/devices", { cookie: itCookie })).body.some((d: { deviceId: string }) => d.deviceId === e.deviceId));
  });
});

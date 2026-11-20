// Smoke test: serves the production build and checks each route renders. Run after `pnpm build`.
// Data and auth behaviour are covered by the API integration tests; pages here render without a session.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const port = 3100;
const server = spawn("pnpm", ["exec", "next", "start", "--port", String(port)], { stdio: "ignore" });
const get = (path) => fetch(`http://localhost:${port}${path}`).then(async (r) => ({ status: r.status, html: await r.text() }));

const ROUTES = {
  "/": ["Checking your session"],
  "/login": ["Insight", "Workfolio", "Sign in to the admin dashboard", 'type="password"'],
  "/setup-password": ["Set your password"],
  "/employees": ["Checking your session"],
  "/employees/new": ["Checking your session"],
  "/live-team": ["Checking your session"],
  "/attendance": ["Checking your session"],
  "/timesheets": ["Checking your session"],
  "/timesheets/00000000-0000-4000-8000-000000000000": ["Checking your session"],
  "/corrections": ["Checking your session"],
  "/leave": ["Checking your session"],
  "/holidays": ["Checking your session"],
  "/teams": ["Checking your session"],
  "/alerts": ["Checking your session"],
  "/projects": ["Checking your session"],
  "/reports": ["Checking your session"],
  "/reports/scheduled": ["Checking your session"],
  "/websites": ["Checking your session"],
  "/roles": ["Checking your session"],
  "/audit": ["Checking your session"],
  "/notifications": ["Checking your session"],
  "/account": ["Checking your session"],
  "/my": ["Checking your session"],
  "/my/attendance": ["Checking your session"],
  "/my/activity": ["Checking your session"],
  "/my/websites": ["Checking your session"],
  "/my/screenshots": ["Checking your session"],
  "/my/projects": ["Checking your session"],
  "/my/tasks": ["Checking your session"],
  "/my/leave": ["Checking your session"],
  "/my/reports": ["Checking your session"],
  "/my/profile": ["Checking your session"],
  "/activity": ["Checking your session"],
  "/settings": ["Checking your session"],
  "/settings/schedule": ["Checking your session"],
  "/settings/labels": ["Checking your session"],
  "/desktop-updates": ["Checking your session"],
  "/screenshots": ["Checking your session"],
  "/employees/00000000-0000-4000-8000-000000000000": ["Checking your session"],
};

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await get("/login").then((r) => r.status === 200, () => false);
  }
  assert.ok(up, "dashboard did not respond");
  for (const [path, texts] of Object.entries(ROUTES)) {
    const { status, html } = await get(path);
    assert.equal(status, 200, `${path} returned ${status}`);
    for (const text of texts) assert.ok(html.includes(text), `${path} missing: ${text}`);
  }
  // Desktop installers: every manifest entry is a real file in public/downloads with the recorded size and
  // SHA-256, served as-is; and nothing sits in public/downloads that the manifest does not vouch for.
  const releases = JSON.parse(readFileSync(new URL("../src/lib/desktop-releases.json", import.meta.url), "utf8"));
  const dir = new URL("../public/downloads/", import.meta.url);
  const all = Object.values(releases).filter(Boolean);
  // VPS-hosted (Caddy /desktop-downloads/, outside git): only the link shape is checkable here; the deploy
  // runbook verifies size and SHA-256 on the server.
  for (const r of all.filter((r) => r.href !== undefined)) {
    assert.match(r.file, /^[A-Za-z0-9][\w.-]*\.(dmg|exe)$/, `installer file name: ${r.file}`);
    assert.equal(r.href, `/desktop-downloads/${r.file}`, `${r.file} href`);
    assert.match(r.sha256, /^[0-9a-f]{64}$/, `${r.file} sha256`);
  }
  const listed = all.filter((r) => r.href === undefined);
  for (const r of listed) {
    assert.match(r.file, /^[\w.-]+\.(dmg|exe)$/, `installer file name: ${r.file}`);
    const bytes = readFileSync(new URL(r.file, dir));
    assert.equal(bytes.length, r.sizeBytes, `${r.file} size`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), r.sha256, `${r.file} sha256`);
    const res = await fetch(`http://localhost:${port}/downloads/${r.file}`);
    assert.equal(res.status, 200, `/downloads/${r.file} returned ${res.status}`);
    assert.equal(createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex"), r.sha256, `/downloads/${r.file} served bytes`);
  }
  const present = existsSync(dir) ? readdirSync(dir) : [];
  assert.deepEqual(present.sort(), listed.map((r) => r.file).sort(), "public/downloads must hold exactly the installers in desktop-releases.json");
  console.log(`desktop installers: ${listed.length} verified in public/downloads (${listed.map((r) => r.file).join(", ") || "none"}); VPS-hosted: ${all.length - listed.length}`);
  console.log(`dashboard smoke test: PASS (${Object.keys(ROUTES).length} routes)`);
} finally {
  server.kill();
}

// Smoke test: serves the production build and checks each route renders. Run after `pnpm build`.
// Data and auth behaviour are covered by the API integration tests; pages here render without a session.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 3100;
const server = spawn("pnpm", ["exec", "next", "start", "--port", String(port)], { stdio: "ignore" });
const get = (path) => fetch(`http://localhost:${port}${path}`).then(async (r) => ({ status: r.status, html: await r.text() }));

const ROUTES = {
  "/": ["Checking your session"],
  "/login": ["Insight", "Workfolio", "Sign in to the admin dashboard", 'type="password"'],
  "/setup-password": ["Set your password"],
  "/employees": ["Checking your session"],
  "/employees/new": ["Checking your session"],
  "/attendance": ["Checking your session"],
  "/timesheets": ["Checking your session"],
  "/timesheets/00000000-0000-4000-8000-000000000000": ["Checking your session"],
  "/corrections": ["Checking your session"],
  "/activity": ["Checking your session"],
  "/settings": ["Checking your session"],
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
  console.log(`dashboard smoke test: PASS (${Object.keys(ROUTES).length} routes)`);
} finally {
  server.kill();
}

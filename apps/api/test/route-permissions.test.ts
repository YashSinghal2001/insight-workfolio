// Route permission audit (reflection over every controller registered in AppModule): each route handler
// is either explicitly @Public() or carries @RequirePermission(...). The guard denies unauthenticated
// requests by default, but a route with neither would be open to every signed-in account, so it fails here.
import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";

const { AppModule } = await import("../dist/app.module.js");

// Keys from auth.guard.ts (Public / RequirePermission) and @nestjs/common (route path / method).
const PUBLIC = "auth:public";
const PERMISSION = "auth:permission";
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD", "SEARCH"];

/** The only routes reachable without a session. Each has its own credential or exposes nothing. */
const PUBLIC_ALLOW_LIST = [
  "GET /health",
  "GET /ready",
  "POST /auth/login", // email + password, rate limited
  "POST /auth/refresh", // refresh token (cookie or body)
  "POST /auth/logout", // revokes the presented refresh token only
  "POST /auth/setup-password", // one-time setup token
  "POST /websites/extension/pair", // one-time pairing code
  "GET /websites/extension/state", // extension token
  "POST /websites/extension/intervals", // extension token
  "POST /websites/extension/disconnect", // extension token
  "GET /storage/google-drive/oauth/callback", // Google's redirect: single-use state + PKCE + browser-binding cookie
  "GET /storage/onedrive/oauth/callback", // Microsoft's redirect: single-use state + PKCE + browser-binding cookie
  "GET /desktop-updates/manifest/:target/:arch/:version", // Tauri updater manifest: public metadata, packages are signed
].sort();

/** Signed-in but no permission: open to every active account by design. Kept explicit so a new one fails. None today. */
const AUTHENTICATED_ONLY: string[] = [];

const join = (...parts: string[]) => "/" + parts.flatMap((p) => p.split("/")).filter(Boolean).join("/");

function routes() {
  const out: { route: string; isPublic: boolean; permission: string | undefined }[] = [];
  for (const ctrl of Reflect.getMetadata("controllers", AppModule) as (new (...a: never[]) => unknown)[]) {
    const base = [Reflect.getMetadata("path", ctrl) ?? ""].flat()[0] as string;
    const classPublic = Reflect.getMetadata(PUBLIC, ctrl) === true;
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === "constructor" || typeof handler !== "function") continue;
      const method = Reflect.getMetadata("method", handler);
      if (method === undefined) continue; // not a route handler
      for (const path of [Reflect.getMetadata("path", handler) ?? ""].flat() as string[]) {
        out.push({
          route: `${METHODS[method]} ${join(base, path)}`,
          isPublic: Reflect.getMetadata(PUBLIC, handler) === true || classPublic,
          permission: Reflect.getMetadata(PERMISSION, handler) ?? Reflect.getMetadata(PERMISSION, ctrl),
        });
      }
    }
  }
  return out;
}

test("every route is either @Public() or has an explicit @RequirePermission()", () => {
  const all = routes();
  assert.ok(all.length > 50, `found ${all.length} routes; reflection broken?`);
  const missing = all.filter((r) => !r.isPublic && !r.permission).map((r) => r.route);
  assert.deepEqual(missing.filter((r) => !AUTHENTICATED_ONLY.includes(r)), [], "routes without an explicit permission");
  for (const r of AUTHENTICATED_ONLY) assert.ok(all.some((x) => x.route === r), `${r} no longer exists: drop it from the list`);
  const both = all.filter((r) => r.isPublic && r.permission).map((r) => r.route);
  assert.deepEqual(both, [], "a permission on a public route is never checked (the guard returns early)");
});

test("the set of public routes is exactly the allow-list", () => {
  assert.deepEqual(routes().filter((r) => r.isPublic).map((r) => r.route).sort(), PUBLIC_ALLOW_LIST);
});

test("no duplicate method + path (a later handler would be shadowed)", () => {
  const seen = routes().map((r) => r.route);
  assert.deepEqual(seen.filter((r, i) => seen.indexOf(r) !== i), []);
});

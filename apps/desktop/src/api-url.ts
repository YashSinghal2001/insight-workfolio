/**
 * Which API URLs a desktop build may talk to (see docs/deployment.md, "Desktop app").
 * - "development": `tauri dev` / `vite` and `tauri build --debug` bundles (the packaged checks in
 *   scripts/verify-*-packaged.mjs). https anywhere, or plain http to this machine only.
 * - "production": release bundles. https only.
 */
export type ApiUrlMode = "development" | "production";

export const DEV_API_URL = "http://localhost:4000";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The normalized API base URL (origin + optional path, no trailing slash), or throws with the reason. */
export function resolveApiUrl(raw: string | undefined, mode: ApiUrlMode): string {
  const value = raw?.trim() || (mode === "development" ? DEV_API_URL : "");
  if (!value) throw new Error("No API URL configured. Release builds need an https:// API URL (see docs/deployment.md).");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The configured API URL is not a valid URL: ${value}`);
  }
  if (url.username || url.password) throw new Error("The API URL must not contain a user name or password.");
  if (url.search || url.hash || /[?#]/.test(value)) throw new Error("The API URL must not contain a query string or fragment.");
  if (url.protocol === "http:") {
    if (!LOOPBACK.has(url.hostname)) throw new Error(`The API URL must use https:// (plain http is only for this computer): ${value}`);
    if (mode !== "development") throw new Error(`Release builds need an https:// API URL, not ${value}.`);
  } else if (url.protocol !== "https:") {
    throw new Error(`The API URL must use https:// (got ${url.protocol}).`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

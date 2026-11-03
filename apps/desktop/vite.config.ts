import { defineConfig, loadEnv } from "vite";
import { resolveApiUrl, type ApiUrlMode } from "./src/api-url.ts";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig(({ command, mode }) => {
  // The Tauri CLI sets TAURI_ENV_DEBUG=true for `tauri dev` / `tauri build --debug` and leaves it
  // unset for release builds; TAURI_ENV_PLATFORM is set for any Tauri-driven build.
  const apiMode: ApiUrlMode = command === "serve" || process.env.TAURI_ENV_DEBUG === "true" ? "development" : "production";
  if (command === "build" && apiMode === "production" && process.env.TAURI_ENV_PLATFORM) {
    // A release bundle: refuse to build one that would not start, or whose CSP does not allow its API.
    const env = loadEnv(mode, process.cwd(), "VITE_");
    const url = resolveApiUrl(env.VITE_API_URL, "production");
    if (process.env.WORKFOLIO_CSP_ORIGIN !== new URL(url).origin) {
      throw new Error("Release builds must be made with `pnpm package` (scripts/desktop-config.mjs) so the CSP matches the API URL.");
    }
    // Shown to administrators; without it a release would show the dev http://localhost:3000.
    if (!env.VITE_DASHBOARD_URL?.startsWith("https://")) {
      throw new Error("Release builds need an https:// VITE_DASHBOARD_URL: set WORKFOLIO_DASHBOARD_URL for `pnpm package`.");
    }
  }
  return {
    define: { __WORKFOLIO_API_MODE__: JSON.stringify(apiMode) },
    // Keep Rust errors visible and use the fixed port Tauri expects.
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
      watch: { ignored: ["**/src-tauri/**"] },
    },
  };
});

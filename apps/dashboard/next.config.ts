import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

/**
 * NEXT_PUBLIC_API_URL is baked into the bundle at build time (src/lib/config.ts). Refuse anything
 * but https, or plain http to this machine (local builds, tests and browser harnesses).
 * `next build` (NODE_ENV=production) also refuses it unset/empty, so a deploy can never silently ship
 * the http://localhost:4000 fallback (DEP-05). Local builds: NEXT_PUBLIC_API_URL=http://localhost:4000.
 * `next dev` / `next start` keep the fallback.
 */
function checkApiUrl(phase: string) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  // `next typegen` (typecheck) also loads this in the build phase: only the `build` command counts.
  const building = phase === PHASE_PRODUCTION_BUILD && process.argv.slice(2).includes("build");
  if (!apiUrl && building && process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_API_URL is required for `next build`: the https API URL for deploys, or http://localhost:4000 for local builds",
    );
  }
  if (apiUrl) {
    let url: URL;
    try {
      url = new URL(apiUrl);
    } catch {
      throw new Error(`NEXT_PUBLIC_API_URL is not a valid URL: ${apiUrl}`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error(`NEXT_PUBLIC_API_URL must use https:// (plain http only for localhost): ${apiUrl}`);
    }
  }
}

/** Response headers for every route. No script-src CSP: Next's inline bootstrap scripts need it unset. */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default function config(phase: string): NextConfig {
  checkApiUrl(phase);
  return nextConfig;
}

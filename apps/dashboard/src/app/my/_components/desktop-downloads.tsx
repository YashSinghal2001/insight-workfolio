"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, StatusBadge } from "@/components/kit";
import { dayLabel } from "@/components/my-ui";
import { Card, Notice, buttonClass } from "@/components/ui";
import bundled from "@/lib/desktop-releases.json";

/**
 * A verified installer. Source of truth on the VPS: /desktop-downloads/desktop-releases.json, written only by the
 * publish pipeline after upload and HTTPS verification (deploy/scripts/desktop-downloads-receiver.py). The bundled
 * src/lib/desktop-releases.json is the fallback when that is unreachable or malformed (local dev, before the
 * Caddy route exists). Bundled entries without href are files in public/downloads/, checked by scripts/smoke.mjs.
 * null = no verified installer: the card says so, with no link.
 */
interface Release {
  version: string;
  /** YYYY-MM-DD */
  releasedAt: string;
  file: string;
  /** Hosted on the VPS outside git (Caddy `/desktop-downloads/`), instead of public/downloads/<file>. */
  href?: string;
  arch: string;
  sizeBytes: number;
  sha256: string;
  /** Plain-text release notes (the release tag's message), when the release has any. */
  notes?: string;
}

const PLATFORMS: { id: "macos" | "windows"; name: string; ext: string; requires: string; unsigned: string; steps: ReactNode[] }[] = [
  {
    id: "macos",
    name: "macOS",
    ext: ".dmg",
    requires: "macOS 14 or later",
    unsigned: "This build is not yet signed by Apple, so macOS blocks the first launch until you allow it (step 3).",
    steps: [
      "Open the downloaded .dmg file and drag Insight Workfolio into Applications.",
      "Open Insight Workfolio from Applications. macOS says it cannot verify the app: choose Done.",
      "Open System Settings › Privacy & Security, scroll to the message about Insight Workfolio and choose Open Anyway, then Open.",
      "Sign in with the same email and password you use here. If macOS asks for keychain access, choose Always Allow.",
    ],
  },
  {
    id: "windows",
    name: "Windows",
    ext: ".exe",
    requires: "Windows 10 (21H2 or later) or Windows 11",
    unsigned: "This build is not yet signed, so Windows SmartScreen shows “Windows protected your PC” (step 2).",
    steps: [
      "Run the downloaded .exe file. No administrator account is needed.",
      "If SmartScreen appears, choose More info, then Run anyway.",
      "Open Insight Workfolio from the Start menu. Its icon may sit in the hidden-icons area (^) of the taskbar.",
      "Sign in with the same email and password you use here.",
    ],
  },
];

const MANIFEST_URL = "/desktop-downloads/desktop-releases.json";
const HREF = /^\/desktop-downloads\/[A-Za-z0-9][A-Za-z0-9._-]*\.(exe|dmg)$/;
const FILE = /^[\w.-]+\.(dmg|exe)$/;

/** Only a well-formed entry with a same-origin installer link is shown; anything else is ignored. */
function asRelease(x: unknown): Release | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const ok =
    typeof r.version === "string" && /^\d+\.\d+\.\d+$/.test(r.version) &&
    typeof r.releasedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.releasedAt) &&
    typeof r.file === "string" && FILE.test(r.file) &&
    (r.href === undefined || (typeof r.href === "string" && HREF.test(r.href))) &&
    typeof r.arch === "string" && r.arch.length <= 80 &&
    typeof r.sizeBytes === "number" && Number.isSafeInteger(r.sizeBytes) && r.sizeBytes > 0 &&
    typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) &&
    (r.notes === undefined || (typeof r.notes === "string" && r.notes.length <= 4000));
  return ok ? { version: r.version, releasedAt: r.releasedAt, file: r.file, href: r.href, arch: r.arch, sizeBytes: r.sizeBytes, sha256: r.sha256, notes: r.notes } as Release : null;
}

/** The published manifest when reachable and valid per platform; the bundled copy otherwise. */
function useReleases(): Record<string, Release | null> {
  const [live, setLive] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let active = true;
    fetch(MANIFEST_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => { if (active && j && typeof j === "object") setLive(j as Record<string, unknown>); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const fallback = bundled as Record<string, unknown>;
  return Object.fromEntries(PLATFORMS.map((p) => [p.id, asRelease(live?.[p.id]) ?? asRelease(fallback[p.id])]));
}

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

const noSubscription = () => () => {};
/** The computer this page is open on, from the browser; null when unknown (server render, phones, Linux). */
function detectPlatform(): "macos" | "windows" | null {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return "windows";
  // iPadOS reports "Macintosh" too; it has touch points, a Mac does not.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints < 2 ? "macos" : null;
}

/** Desktop app downloads on the employee dashboard: one card per platform, from the verified release manifest. */
export function DesktopDownloads() {
  const releases = useReleases();
  const here = useSyncExternalStore(noSubscription, detectPlatform, () => null);
  // The installer for this computer comes first; the other one stays available for a second machine.
  const platforms = [...PLATFORMS].sort((a, b) => Number(b.id === here) - Number(a.id === here));
  return (
    <section aria-label="Desktop app" className="mb-6">
      <h2 className="text-lg font-semibold">Desktop app</h2>
      <p className="mt-1 mb-3 text-sm text-muted">
        Attendance and activity are recorded by the Insight Workfolio desktop app. Install it on your work computer and sign in with this account.
        Your account works on one computer at a time: to move to another, ask an administrator to release the current one first.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {platforms.map((p) => {
          const r = releases[p.id] ?? null;
          return (
            <Card
              key={p.id}
              title={p.name}
              actions={
                <span className="flex flex-wrap items-center gap-2">
                  {p.id === here && <StatusBadge tone="info">This computer</StatusBadge>}
                  <StatusBadge tone={r ? "success" : "neutral"}>{r ? `Latest version ${r.version}` : "Not available yet"}</StatusBadge>
                </span>
              }
            >
              <div data-platform={p.id} className="flex flex-col gap-3 text-sm">
                {r ? (
                  <>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                      <dt className="text-muted">Released</dt>
                      <dd>{dayLabel(r.releasedAt)}</dd>
                      <dt className="text-muted">Works on</dt>
                      <dd>{r.arch}; {p.requires}</dd>
                      <dt className="text-muted">Size</dt>
                      <dd>{mb(r.sizeBytes)}</dd>
                    </dl>
                    <div>
                      <a href={r.href ?? `/downloads/${encodeURIComponent(r.file)}`} download={r.file} className={buttonClass}>
                        Download for {p.name} ({p.ext})
                      </a>
                    </div>
                    {r.notes && (
                      <div>
                        <p className="font-medium">What&apos;s new in {r.version}</p>
                        <p className="mt-1 whitespace-pre-line text-muted">{r.notes}</p>
                      </div>
                    )}
                    <Notice tone="warning">{p.unsigned} Only install a copy downloaded from this page.</Notice>
                    <details>
                      <summary className="cursor-pointer font-medium text-brand">How to install</summary>
                      <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5">
                        {p.steps.map((s, i) => <li key={i}>{s}</li>)}
                      </ol>
                      <p className="mt-2 text-xs text-muted">
                        To check the file, compare its SHA-256: <code className="break-all">{r.sha256}</code>
                      </p>
                    </details>
                  </>
                ) : (
                  <>
                    <p className="text-muted">There is no {p.name} installer to download yet. Your administrator will tell you when it is ready.</p>
                    <Button disabledReason="Not available yet">Download for {p.name} ({p.ext})</Button>
                  </>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

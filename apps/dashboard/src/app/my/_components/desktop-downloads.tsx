"use client";

import type { ReactNode } from "react";
import { Button, StatusBadge } from "@/components/kit";
import { dayLabel } from "@/components/my-ui";
import { Card, Notice, buttonClass } from "@/components/ui";
import releases from "@/lib/desktop-releases.json";

/**
 * A verified installer in public/downloads/ (served as /downloads/<file>). An entry is added to
 * src/lib/desktop-releases.json only together with its file; scripts/smoke.mjs fails when the file is
 * missing or its size or SHA-256 differ. null = no verified installer: the card says so, with no link.
 */
interface Release {
  version: string;
  /** YYYY-MM-DD */
  releasedAt: string;
  file: string;
  arch: string;
  sizeBytes: number;
  sha256: string;
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

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** Desktop app downloads on the employee dashboard: one card per platform, from the verified release manifest. */
export function DesktopDownloads() {
  return (
    <section aria-label="Desktop app" className="mb-6">
      <h2 className="text-lg font-semibold">Desktop app</h2>
      <p className="mt-1 mb-3 text-sm text-muted">
        Attendance and activity are recorded by the Insight Workfolio desktop app. Install it on your work computer and sign in with this account.
        Your account works on one computer at a time: to move to another, ask an administrator to release the current one first.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {PLATFORMS.map((p) => {
          const r = (releases as Record<string, Release | null>)[p.id] ?? null;
          return (
            <Card key={p.id} title={p.name} actions={<StatusBadge tone={r ? "success" : "neutral"}>{r ? `Version ${r.version}` : "Not available yet"}</StatusBadge>}>
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
                      <a href={`/downloads/${encodeURIComponent(r.file)}`} download={r.file} className={buttonClass}>
                        Download for {p.name} ({p.ext})
                      </a>
                    </div>
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

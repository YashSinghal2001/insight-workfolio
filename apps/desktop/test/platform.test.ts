import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { appNapText, collectorStateText, decideScreenshots, type ScreenshotInputs } from "../src/monitoring.ts";
import { applyStaticWording, platformOf, setPlatform, STATIC_TEXT, wordingFor, words } from "../src/platform.ts";
import { project } from "../src/sync.ts";

const mac = wordingFor("macos");
const win = wordingFor("windows");

test("platformOf maps app_info.platform (Rust consts::OS)", () => {
  assert.equal(platformOf("macos"), "macos");
  assert.equal(platformOf("windows"), "windows");
  assert.equal(platformOf("linux"), "other");
  assert.equal(platformOf(undefined), "other");
  assert.equal(wordingFor("other"), mac, "unsupported OS keeps the default wording");
});

test("Windows wording: tray, taskbar, sign-in, no screen permission, generic sleep, Exit", () => {
  assert.match(win.hiddenNotice, /system tray \(notification area\)/);
  assert.match(win.hiddenNotice, /Exit Insight Workfolio/);
  assert.equal(win.hideDockIcon, "Hide the taskbar button (tray only)");
  assert.equal(win.launchAtLogin, "Open at sign-in");
  assert.equal(win.permissionHelp, "Windows doesn't ask for screen-capture permission. Your organisation's notice explains what is captured.");
  assert.equal(win.permissionRequestable, false);
  assert.equal(win.asleep, "Computer asleep. Nothing is recorded.");
  assert.equal(win.quit, "Exit");
  for (const [key, text] of Object.entries(win)) {
    if (typeof text === "string") assert.doesNotMatch(text, /\bMac\b|macOS|menu bar|Dock|App Nap|System Settings|\blog in\b/, `windows.${key}`);
  }
});

test("macOS wording is unchanged and matches the static HTML (browser default)", () => {
  assert.equal(mac.hideDockIcon, "Hide the Dock icon (menu bar only)");
  assert.equal(mac.launchAtLogin, "Open at login");
  assert.equal(mac.asleep, "Mac asleep. Nothing is recorded.");
  assert.equal(mac.quit, "Quit");
  assert.equal(mac.permissionRequestable, true);
  // index.html carries the macOS texts; every swapped id exists there with exactly that text.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const [id, key] of Object.entries(STATIC_TEXT)) {
    const m = html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</`));
    assert.ok(m, `#${id} in index.html`);
    const text = m[1].replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    assert.equal(text, mac[key], `#${id}`);
  }
});

test("applyStaticWording sets every mapped element", () => {
  const els = new Map<string, { textContent: string | null }>();
  applyStaticWording(win, (id) => (els.has(id) ? els.get(id)! : (els.set(id, { textContent: null }), els.get(id)!)));
  assert.equal(els.size, Object.keys(STATIC_TEXT).length);
  assert.equal(els.get("pref-launchAtLogin-label")!.textContent, "Open at sign-in");
  applyStaticWording(win, () => null); // missing elements are skipped
});

test("monitoring texts follow the platform; default is macOS", () => {
  const on = { collecting: true, currentApp: { name: "Code" }, idle: false, idleSinceMs: null, locked: false };
  const clock = () => "09:30";
  assert.equal(collectorStateText({ ...on, asleep: true }, true, clock), "Mac asleep. Nothing is recorded.");
  assert.equal(collectorStateText({ ...on, asleep: true }, true, clock, win), "Computer asleep. Nothing is recorded.");
  assert.match(collectorStateText({ ...on, locked: true }, true, clock, win), /^Screen locked/);
  assert.match(appNapText({ collecting: true, appNapPrevented: true }, win)!, /efficiency mode is off/);

  setPlatform("windows");
  try {
    assert.equal(words(), win);
    assert.match(appNapText({ collecting: true, appNapPrevented: true })!, /efficiency mode/);
  } finally {
    setPlatform("macos");
  }
});

test("NEEDS_PERMISSION never mentions macOS on Windows (should not occur there)", () => {
  const i: ScreenshotInputs = {
    signedIn: true, supported: true, deviceStatus: "ACTIVE", enabled: true, consented: true, permission: false,
    projection: project({ state: "CLOCKED_IN", missingClockOut: false, serverTime: "2026-10-12T08:00:00.000Z", session: { id: "s", clockInAt: "2026-10-12T08:00:00.000Z", clockOutAt: null, status: "OPEN", corrected: false, clockInSource: "ONLINE", breaks: [] } }, []),
    pendingClockIn: false, unverified: false, error: null,
  };
  assert.match(decideScreenshots(i).reason, /in macOS/);
  const d = decideScreenshots(i, win);
  assert.equal(d.mode, "NEEDS_PERMISSION");
  assert.doesNotMatch(d.reason, /macOS/);
});

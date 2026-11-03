// Platform wording: one UI for macOS and Windows. Pure (no DOM, no Tauri), so node tests cover it.
// The platform comes from the shell's `app_info.platform` (Rust std::env::consts::OS: "macos" | "windows" | …);
// the browser (dev:web, headless suites) keeps the macOS wording.

export type Platform = "macos" | "windows" | "other";

export const platformOf = (os: unknown): Platform => (os === "macos" || os === "windows" ? os : "other");

const MAC = {
  /** First-close notice (#hidden-notice). */
  hiddenNotice:
    "Insight Workfolio keeps running in the menu bar while you are signed in, so attendance, activity monitoring and screenshots continue exactly as shown here. Open this window again from the menu bar icon. To stop recording, choose Quit Insight Workfolio from that menu.",
  statusHint:
    "The menu bar shows the same status. Below: attendance, then screenshots (permission, next and last capture, uploads, storage, privacy masks and your acknowledgement) and activity monitoring.",
  showSeconds: "Show seconds in the menu bar",
  showSecondsHint: "The menu bar shows how long you have been working or on your break. Turn this on to see seconds too.",
  hideDockIcon: "Hide the Dock icon (menu bar only)",
  hideDockIconHint: "Insight Workfolio then appears only in the menu bar at the top of the screen. Open this window from the menu bar icon.",
  launchAtLogin: "Open at login",
  launchAtLoginHint: "Starts Insight Workfolio when you log in to this Mac. It does not clock you in: you still clock in yourself.",
  closeHint:
    "Closing this window keeps the app running in the menu bar. Quitting Insight Workfolio stops activity monitoring and screenshots until you open it again. It does not clock you out: clock out first if your shift is over.",
  permissionLabel: "Screen recording permission",
  permissionHelp:
    "macOS asks you to allow screen recording. If you already declined, open System Settings › Privacy & Security › Screen & System Audio Recording, turn on Insight Workfolio, then quit and reopen this app. You can turn it off there at any time; screenshots then stop.",
  /** Whether the "Allow screen recording…" button exists on this OS. */
  permissionRequestable: true,
  permissionWaiting: "Waiting for you to allow screen recording for this app in macOS. No screenshots are taken until then.",
  asleep: "Mac asleep. Nothing is recorded.",
  powerOptOut: "App Nap is off for this app while recording so samples stay on time; your Mac can still sleep normally.",
  quit: "Quit",
};

export type Wording = typeof MAC;

const WINDOWS: Wording = {
  hiddenNotice:
    "Insight Workfolio keeps running in the system tray (notification area) while you are signed in, so attendance, activity monitoring and screenshots continue exactly as shown here. Open this window again from the tray icon. To stop recording, right-click the tray icon and choose Exit Insight Workfolio.",
  statusHint:
    "The system tray icon shows the same status (point at it to see the time). Below: attendance, then screenshots (next and last capture, uploads, storage, privacy masks and your acknowledgement) and activity monitoring.",
  showSeconds: "Show seconds in the tray tooltip",
  showSecondsHint: "Pointing at the tray icon shows how long you have been working or on your break. Turn this on to see seconds too.",
  hideDockIcon: "Hide the taskbar button (tray only)",
  hideDockIconHint: "Insight Workfolio then appears only in the system tray (notification area). Open this window from the tray icon.",
  launchAtLogin: "Open at sign-in",
  launchAtLoginHint:
    "Starts Insight Workfolio when you sign in to Windows. It is listed in Task Manager › Startup apps. It does not clock you in: you still clock in yourself.",
  closeHint:
    "Closing this window keeps the app running in the system tray. Exiting Insight Workfolio stops activity monitoring and screenshots until you open it again. It does not clock you out: clock out first if your shift is over.",
  permissionLabel: "Screen capture permission",
  permissionHelp: "Windows doesn't ask for screen-capture permission. Your organisation's notice explains what is captured.",
  permissionRequestable: false,
  // Windows has no screen-capture permission, so this should never show; worded generically just in case.
  permissionWaiting: "Screen capture is not available right now. No screenshots are taken until it is.",
  asleep: "Computer asleep. Nothing is recorded.",
  powerOptOut: "Windows efficiency mode is off for this app while recording so samples stay on time; your computer can still sleep normally.",
  quit: "Exit",
};

export const wordingFor = (p: Platform): Wording => (p === "windows" ? WINDOWS : MAC);

/** Static index.html texts swapped per platform: element id → wording key (the HTML holds the macOS text). */
export const STATIC_TEXT: Readonly<Record<string, keyof Wording>> = {
  "hidden-notice-text": "hiddenNotice",
  "status-hint": "statusHint",
  "pref-showSeconds-label": "showSeconds",
  "pref-showSeconds-hint": "showSecondsHint",
  "pref-hideDockIcon-label": "hideDockIcon",
  "pref-hideDockIcon-hint": "hideDockIconHint",
  "pref-launchAtLogin-label": "launchAtLogin",
  "pref-launchAtLogin-hint": "launchAtLoginHint",
  "close-hint": "closeHint",
  "shot-permission-label": "permissionLabel",
  "shot-permission-help": "permissionHelp",
};

/** Applies the wording to the static page texts (DOM lookup injected so tests need no document). */
export function applyStaticWording(w: Wording, byId: (id: string) => { textContent: string | null } | null) {
  for (const [id, key] of Object.entries(STATIC_TEXT)) {
    const el = byId(id);
    if (el) el.textContent = String(w[key]);
  }
}

// Current platform for the UI modules (set once from app_info; default macOS for the browser).
let current: Platform = "macos";
export const setPlatform = (p: Platform) => void (current = p);
export const words = (): Wording => wordingFor(current);

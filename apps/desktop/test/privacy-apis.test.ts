// Static privacy guard (QA): the desktop app reads how long ago the last input happened and which
// application is in front, and nothing else about input. This fails the build if a keyboard/mouse hook,
// event tap, key-state read, window-title read or clipboard access appears in the Rust or TypeScript
// sources, or if the set of input-related OS calls changes without this file being updated on purpose.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "target" || name === "gen" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}
const read = (p: string) => readFileSync(p, "utf8");
/** Comments say what is NOT collected ("no window titles, …"): only code is checked. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "")).join("\n");

const RUST = files(join(ROOT, "src-tauri/src"), /\.rs$/);
const TS = files(join(ROOT, "src"), /\.ts$/);
const CONFIG = [join(ROOT, "src-tauri/Cargo.toml"), join(ROOT, "src-tauri/tauri.conf.json"), ...files(join(ROOT, "src-tauri/capabilities"), /\.json$/), join(ROOT, "package.json")];

function hits(paths: string[], patterns: [string, RegExp][], strip = true): string[] {
  const found: string[] = [];
  for (const p of paths) {
    const lines = (strip ? code(read(p)) : read(p)).split("\n");
    lines.forEach((line, i) => {
      for (const [what, re] of patterns) if (re.test(line)) found.push(`${relative(ROOT, p)}:${i + 1} ${what}: ${line.trim().slice(0, 120)}`);
    });
  }
  return found;
}

const FORBIDDEN_NATIVE: [string, RegExp][] = [
  ["key state", /GetAsyncKeyState|GetKeyState|GetKeyboardState|GetKeyNameText|MapVirtualKey|ToUnicode|VkKeyScan|CGEventSourceKeyState|CGEventSourceButtonState|CGEventSourceFlagsState/],
  ["input hook", /SetWindowsHookEx|WH_KEYBOARD|WH_MOUSE|LowLevelKeyboardProc|LowLevelMouseProc|RegisterRawInputDevices|GetRawInputData|RAWINPUT|RegisterHotKey/],
  ["event tap / monitor", /CGEventTap|CGEventCreate|CGEventGet|CGEventPost|NSEvent|addGlobalMonitor|addLocalMonitor|IOHIDManager|IOHIDDevice|IOHIDValue|kIOHID/],
  ["window title", /GetWindowText|GetWindowTextLength|WM_GETTEXT|InternalGetWindowText|GetClassName|kCGWindowName|kCGWindowOwnerName|SCWindow.*title|\.title\(\)/],
  ["accessibility tree", /AXUIElement|AXIsProcessTrusted|kAXTitle|kAXValue|kAXFocused|UIAutomation|IUIAutomation|AccessibleObjectFromWindow/],
  ["clipboard", /[Cc]lipboard|NSPasteboard|OpenClipboard|GetClipboardData|CF_UNICODETEXT/],
  ["input crates", /\b(rdev|device_query|enigo|inputbot|willhook|multiinput|arboard|copypasta|cli_clipboard|global_hotkey)\b/],
  ["browser content", /AppleScript|osascript|NSAppleScript|document\.URL|tabs\.query/],
];

test("Rust sources: no hook, event tap, key state, window title, accessibility or clipboard API", () => {
  assert.ok(RUST.length >= 10, `expected the native sources, found ${RUST.length}`);
  assert.deepEqual(hits(RUST, FORBIDDEN_NATIVE), []);
});

test("Cargo and Tauri configuration: no input, clipboard, shortcut, shell or filesystem plugin or permission", () => {
  const forbidden: [string, RegExp][] = [
    ...FORBIDDEN_NATIVE.filter(([what]) => what === "input crates" || what === "clipboard"),
    ["tauri plugin", /tauri-plugin-(clipboard|global-shortcut|shell|fs|http|os|process|dialog)|plugin-(clipboard|global-shortcut|shell|fs)/],
    ["capability", /"(clipboard-manager|global-shortcut|shell|fs):/],
    // GetLastInputInfo lives in KeyboardAndMouse (allowed, checked by name below); these features have no legitimate use here.
    ["windows feature", /Win32_UI_Input_(Ime|Pointer|Touch|XboxController)|Win32_UI_TextServices|Win32_UI_Accessibility|Win32_System_DataExchange|"Win32_UI_Input"\s*[,\]]/],
  ];
  assert.deepEqual(hits(CONFIG, forbidden, false), []);
  const permissions = CONFIG.filter((p) => p.includes("capabilities")).flatMap((p) => (JSON.parse(read(p)) as { permissions: string[] }).permissions);
  assert.deepEqual(permissions.sort(), ["core:default", "notification:allow-notify"], "the webview's permissions are exactly these");
});

test("TypeScript sources: no clipboard access and no document- or window-wide key or pointer capture", () => {
  assert.ok(TS.length >= 10, `expected the webview sources, found ${TS.length}`);
  const forbidden: [string, RegExp][] = [
    ["clipboard", /navigator\.clipboard|clipboardData|execCommand\(\s*["'](copy|paste|cut)|addEventListener\(\s*["'](copy|paste|cut)["']/],
    ["global key/pointer listener", /(window|document|document\.body|document\.documentElement|globalThis)\s*\.\s*addEventListener\(\s*["'](key(down|up|press)|mouse(move|down|up)|pointer(move|down|up)|wheel|input|beforeinput)["']/],
    ["on* global handler", /(window|document)\s*\.\s*on(key(down|up|press)|mouse(move|down|up)|pointer(move|down|up)|paste|copy)\s*=/],
    ["tauri input plugin", /@tauri-apps\/plugin-(clipboard|global-shortcut|shell|fs)/],
  ];
  assert.deepEqual(hits(TS, forbidden), []);
  // The one key listener: arrow-key navigation inside the app's own tab list (records.ts); nothing is stored or sent.
  const keyListeners = hits(TS, [["key listener", /addEventListener\(\s*["']key(down|up|press)["']/]]);
  assert.deepEqual(keyListeners.map((h) => h.split(":")[0]), ["src/records.ts"], `key listeners: ${keyListeners.join(" | ")}`);
  assert.match(keyListeners[0]!, /\[role=tablist\]/, "scoped to the tab list element");
});

test("the input-related OS calls are exactly the known set (a counter and the foreground process, nothing else)", () => {
  // Every foreign symbol from the input / window / event families that the native code mentions.
  const family = /\b(CGEvent[A-Za-z]*|CGWindowList[A-Za-z]*|CGSession[A-Za-z]*|GetLastInputInfo|GetForegroundWindow|GetWindowThreadProcessId|GetGUIThreadInfo|GetFocus|GetActiveWindow|GetCursorPos|GetWindow[A-Z][A-Za-z]*|EnumWindows|EnumChildWindows|QueryFullProcessImageNameW|GetModuleFileNameExW|WTSQuerySessionInformationW|OpenInputDesktop|NSWorkspace[A-Za-z]*|NSRunningApplication)\b/g;
  const used = new Set<string>();
  for (const p of RUST) for (const m of code(read(p)).matchAll(family)) used.add(m[1]!);
  const allowed = new Set([
    // Idle time: seconds / ticks since the last input event. A number, never the event.
    "CGEventSourceSecondsSinceLastEventType", "GetLastInputInfo",
    // Foreground application: process id of the front window -> application name and identifier.
    "CGWindowListCopyWindowInfo", "NSRunningApplication", "GetForegroundWindow", "GetWindowThreadProcessId", "EnumChildWindows", "QueryFullProcessImageNameW",
    // Lock / session state.
    "CGSessionCopyCurrentDictionary", "OpenInputDesktop", "WTSQuerySessionInformationW",
  ]);
  const unexpected = [...used].filter((s) => !allowed.has(s) && !/^NSWorkspace/.test(s)).sort();
  assert.deepEqual(unexpected, [], "new input/window API: review it, then add it here deliberately");
  for (const must of ["CGEventSourceSecondsSinceLastEventType", "GetLastInputInfo", "CGWindowListCopyWindowInfo", "GetForegroundWindow"]) assert.ok(used.has(must), `${must} is no longer used: update this guard`);
  // NSWorkspace is used for notifications (sleep, wake, session) only.
  const workspace = [...used].filter((s) => /^NSWorkspace/.test(s)).sort();
  assert.ok(workspace.every((s) => s === "NSWorkspace" || /Notification$/.test(s)), workspace.join(", "));
});

test("the window list is read for the layer and owner process id only (never the title or owner name)", () => {
  const keys = new Set<string>();
  for (const p of RUST) for (const m of code(read(p)).matchAll(/"(kCG[A-Za-z]+)"/g)) keys.add(m[1]!);
  assert.deepEqual([...keys].sort(), ["kCGSSessionOnConsoleKey", "kCGWindowLayer", "kCGWindowOwnerPID"]);
  assert.ok([...read(join(ROOT, "src-tauri/src/activity.rs")).matchAll(/"(CGSSession[A-Za-z]+)"/g)].every((m) => m[1] === "CGSSessionScreenIsLocked"));
});

test("what leaves the device about 'now' is a state, a timestamp and the capture state: nothing else", async () => {
  const { activityCurrentSchema, activitySyncSchema, activityIntervalSchema } = await import("@workfolio/shared");
  const since = new Date().toISOString();
  assert.equal(activityCurrentSchema.safeParse({ state: "IDLE", since, screenshot: "OK" }).success, true);
  for (const extra of [{ windowTitle: "x" }, { title: "x" }, { url: "https://x" }, { keys: 3 }, { keystrokes: 3 }, { clicks: 1 }, { idleMs: 1 }, { applicationName: "x" }, { clipboard: "x" }]) {
    assert.equal(activityCurrentSchema.safeParse({ state: "IDLE", since, ...extra }).success, false, JSON.stringify(extra));
    assert.equal(activitySyncSchema.safeParse({ sentAt: since, platform: "macos", intervals: [], current: { state: "IDLE", since }, ...extra }).success, false, JSON.stringify(extra));
  }
  const interval = { id: "8f2f0b1e-6c1d-4c58-9d55-3a8f0a8d4b11", kind: "ACTIVE", applicationIdentifier: "com.example.app", applicationName: "Example", startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: since };
  assert.equal(activityIntervalSchema.safeParse(interval).success, true, "control");
  for (const extra of [{ windowTitle: "x" }, { title: "x" }, { url: "https://x" }, { keystrokes: 3 }, { mouseClicks: 3 }, { documentName: "x" }]) {
    assert.equal(activityIntervalSchema.safeParse({ ...interval, ...extra }).success, false, JSON.stringify(extra));
  }
});

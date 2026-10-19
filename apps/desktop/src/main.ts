import { invoke } from "@tauri-apps/api/core";
import {
  API_PREFIX,
  attendanceTotals,
  DEVICE_HEADER,
  formatDuration,
  transition,
  type AttendanceCurrent,
  type AttendanceEventType,
  type AttendanceSession,
  type DeviceStatusResponse,
  type MeResponse,
  type SyncResponse,
} from "@workfolio/shared";
import { initActivity } from "./activity-ui.ts";
import { initScreenshots } from "./screenshot-ui.ts";
import { initRecords } from "./records.ts";
import { ApiClient, HttpError, profileOf, restoreSession, type CachedProfile, type TokenStore } from "./session.ts";
import { project, SyncEngine, type QueuedEvent } from "./sync.ts";

const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const POLL_MS = 15_000;
const IN_TAURI = "__TAURI_INTERNALS__" in window;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

// ---- Native storage ----------------------------------------------------------
// Refresh token + installation ID: OS credential store. Queue + non-secret cache: SQLite.
// Both live in Rust (src-tauri). In a plain browser (`pnpm dev:web`) everything is memory-only.

const memory = new Map<string, string>();
const memoryQueue: QueuedEvent[] = [];

const tokens: TokenStore = {
  load: () => (IN_TAURI ? invoke<string | null>("load_refresh_token") : Promise.resolve(memory.get("refresh") ?? null)),
  save: async (token) => void (IN_TAURI ? await invoke("save_refresh_token", { token }) : memory.set("refresh", token)),
  clear: async () => void (IN_TAURI ? await invoke("clear_refresh_token") : memory.delete("refresh")),
};

const installationId = (): Promise<string> => {
  if (IN_TAURI) return invoke<string>("installation_id");
  if (!memory.has("installation")) memory.set("installation", crypto.randomUUID());
  return Promise.resolve(memory.get("installation")!);
};

/** Non-secret local cache. An unreadable entry counts as missing: a cache must never block sign-in. */
async function kvGet<T>(key: string): Promise<T | null> {
  const raw = IN_TAURI ? await invoke<string | null>("kv_get", { key }) : (memory.get(`kv:${key}`) ?? null);
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    console.error(`ignoring unreadable cache entry ${key}`);
    return null;
  }
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const raw = value === null ? null : JSON.stringify(value);
  if (IN_TAURI) await invoke("kv_set", { key, value: raw });
  else if (raw === null) memory.delete(`kv:${key}`);
  else memory.set(`kv:${key}`, raw);
}

/** Queue scoped to one employee on one registered device. */
function queueFor(userId: string, deviceId: string) {
  const mine = (e: QueuedEvent) => e.userId === userId && e.deviceId === deviceId;
  const keep = (pred: (e: QueuedEvent) => boolean) => void memoryQueue.splice(0, memoryQueue.length, ...memoryQueue.filter(pred));
  return {
    add: async (event: QueuedEvent) => (IN_TAURI ? invoke<void>("queue_add", { event }) : void memoryQueue.push(event)),
    list: async (): Promise<QueuedEvent[]> =>
      IN_TAURI ? invoke<QueuedEvent[]>("queue_list", { userId, deviceId }) : memoryQueue.filter(mine).map((e) => ({ ...e })),
    ack: async (ids: string[]) => (IN_TAURI ? invoke<void>("queue_ack", { ids }) : keep((e) => !ids.includes(e.id))),
    reject: async (id: string, reason: string) =>
      IN_TAURI
        ? invoke<void>("queue_reject", { id, reason })
        : void Object.assign(memoryQueue.find((e) => e.id === id)!, { status: "REJECTED", reason }),
    dismiss: async () =>
      IN_TAURI ? invoke<void>("queue_dismiss_rejected", { userId, deviceId }) : keep((e) => !(mine(e) && e.status === "REJECTED")),
  };
}

// ---- State --------------------------------------------------------------------

const client = new ApiClient(API_URL, tokens);

const app = {
  profile: null as CachedProfile | null,
  /** false = working offline from the cached identity; actions are queued. */
  online: false,
  installationId: "",
  platform: "macos" as "macos" | "windows",
  device: null as DeviceStatusResponse | null,
  /** Last attendance state confirmed by the server. */
  current: null as AttendanceCurrent | null,
  queued: [] as QueuedEvent[],
  queue: null as ReturnType<typeof queueFor> | null,
  engine: null as SyncEngine | null,
  apiUp: false,
  /** Server clock minus this computer's clock, from the last server response. */
  clockOffsetMs: 0,
  /** Set when a damaged queue file was moved aside at startup. */
  queueRecovered: null as string | null,
};

const cacheKey = (name: string) => `${name}:${app.profile!.userId}`;
const pendingCount = () => app.queued.filter((e) => (e.status ?? "PENDING") === "PENDING").length;

const records = initRecords({
  client,
  timeZone: () => app.profile?.timezone ?? null,
  online: () => app.online && app.apiUp,
  pendingCount,
});

const activity = initActivity({
  client,
  inTauri: IN_TAURI,
  kvGet,
  kvSet,
  formatTime: (iso) => formatTime(iso),
  state: () => ({
    profile: app.profile,
    online: app.online,
    platform: app.platform,
    installationId: app.installationId,
    deviceStatus: app.device?.status ?? null,
    deviceId: app.device?.status === "ACTIVE" ? app.device.device!.id : null,
    current: app.current,
    queued: app.queued,
    attendancePhase: app.engine?.status.phase,
  }),
});

const screenshots = initScreenshots({
  client,
  inTauri: IN_TAURI,
  kvGet,
  kvSet,
  formatTime: (iso) => formatTime(iso),
  state: () => ({
    profile: app.profile,
    installationId: app.installationId,
    deviceStatus: app.device?.status ?? null,
    deviceId: app.device?.status === "ACTIVE" ? app.device.device!.id : null,
    current: app.current,
    queued: app.queued,
    attendancePhase: app.engine?.status.phase,
  }),
});

/** Remember how far this computer's clock is from the server's (display only; the server corrects times). */
function noteServerTime(current: AttendanceCurrent) {
  app.clockOffsetMs = Date.parse(current.serverTime) - Date.now();
}
const deviceHeaders = () => ({ [DEVICE_HEADER]: app.installationId });

// ---- Session lifecycle ------------------------------------------------------------

function show(view: "loading" | "login" | "signed-in") {
  $("#auth-loading").hidden = view !== "loading";
  $("#login-view").hidden = view !== "login";
  $("#signed-in-view").hidden = view !== "signed-in";
}

function loginError(message: string | null) {
  $("#login-error").hidden = !message;
  $("#login-error").textContent = message ?? "";
}

async function boot() {
  show("loading");
  // Keychain reads block while macOS asks the user for permission (e.g. after an unsigned rebuild).
  const slow = setTimeout(() => {
    $("#auth-loading").textContent =
      "Waiting for access to your saved sign-in in the system keychain. If a permission dialog is open, choose Allow.";
  }, 3000);
  try {
    await bootSession();
  } finally {
    clearTimeout(slow);
  }
}

async function bootSession() {
  const cached = await kvGet<CachedProfile>("profile");
  try {
    const r = await restoreSession(client, tokens, cached);
    if (r.kind !== "signed-out") return await enter(r.profile, r.kind === "online");
    if (!r.offline && cached) await kvSet("profile", null); // the session ended server-side
    show("login");
    if (r.offline) loginError("Can't reach the server to restore your session. Check your connection.");
    else if (cached) loginError("Your session has ended. Please sign in again.");
  } catch (err) {
    show("login");
    loginError(err instanceof Error ? err.message : "Something went wrong.");
  }
}

/** Signed in (online) or working offline from the cached identity. */
async function enter(profile: CachedProfile, online: boolean) {
  app.profile = profile;
  app.online = online;
  await kvSet("profile", profile);
  app.installationId = await installationId();
  app.queueRecovered = await kvGet<string>("queue_recovered");
  if (online) {
    await loadDevice();
    if (app.device?.status === "ACTIVE") await loadCurrent();
  } else {
    app.device ??= await kvGet<DeviceStatusResponse>(cacheKey("device"));
    app.current ??= await kvGet<AttendanceCurrent>(cacheKey("current"));
  }
  await startSync();
  show("signed-in");
  render();
  await activity.enter();
  await screenshots.enter();
}

async function loadDevice() {
  app.device = await client.request<DeviceStatusResponse>("GET", "/devices/me", undefined, deviceHeaders());
  await kvSet(cacheKey("device"), app.device);
}

async function loadCurrent() {
  app.current = await client.request<AttendanceCurrent>("GET", "/attendance/current");
  noteServerTime(app.current);
  await kvSet(cacheKey("current"), app.current);
}

async function startSync() {
  const deviceId = app.device?.status === "ACTIVE" ? app.device.device!.id : null;
  // A revoked device keeps its queue visible (not uploadable) so nothing disappears silently.
  if (app.device?.status === "REVOKED" && app.device.device && !app.queue) app.queue = queueFor(app.profile!.userId, app.device.device.id);
  if (!deviceId || app.engine) return reloadQueue();
  app.queue = queueFor(app.profile!.userId, deviceId);
  app.engine = new SyncEngine(
    app.queue,
    ({ sentAt, items }) =>
      client.request<SyncResponse>(
        "POST",
        "/attendance/sync",
        { sentAt, events: items.map(({ id, type, occurredAt }) => ({ id, type, occurredAt })) },
        deviceHeaders(),
      ),
    {
      onStatus: (s) => {
        render();
        if (s.phase === "blocked") void onBlocked();
      },
      onSynced: ({ current }, at) => {
        app.current = current;
        noteServerTime(current);
        records.refresh();
        // Activity uploads wait for attendance to be in sync: kick once the acked events are gone from app.queued.
        void reloadQueue().then(() => (activity.kick(), screenshots.kick()));
        void kvSet(cacheKey("current"), current);
        void kvSet(cacheKey("lastSync"), at);
      },
    },
    await kvGet<string>(cacheKey("lastSync")),
  );
  await reloadQueue();
  void app.engine.kick().then(reloadQueue);
}

/** 401 after a failed refresh: the session is gone. 403: device revoked. Never retried blindly. */
async function onBlocked() {
  if (!(await tokens.load())) {
    return signOut(false, "Your session has ended. Please sign in again; unsynced events stay on this device.");
  }
  await loadDevice().catch(() => undefined);
  render();
}

async function reloadQueue() {
  app.queued = app.queue ? await app.queue.list() : [];
  render();
}

/** Back online: upgrade an offline session, or just retry the queue. */
async function onReconnect() {
  if (app.profile && !app.online) {
    const r = await restoreSession(client, tokens, app.profile).catch(() => null);
    if (r?.kind === "online") return enter(r.profile, true);
    if (r?.kind === "signed-out" && !r.offline) return signOut(false, "Your session has ended. Please sign in again.");
  }
  if (app.engine) void app.engine.kick().then(reloadQueue);
}

async function signOut(revoke: boolean, message: string | null = null) {
  await activity.signOut(); // stop monitoring first
  await screenshots.signOut();
  app.engine?.stop();
  if (revoke) await client.logout();
  else await tokens.clear();
  await kvSet("profile", null);
  // Queued events are kept (scoped to employee + device) and upload on the next sign-in here.
  Object.assign(app, { profile: null, online: false, device: null, current: null, queued: [], queue: null, engine: null });
  void records.showTab("today");
  show("login");
  loginError(message);
}

// ---- Rendering ----------------------------------------------------------------

const STATE_LABEL = { CLOCKED_OUT: "Clocked out", CLOCKED_IN: "Clocked in", ON_BREAK: "On break" } as const;

/** UTC instant shown in the employee's timezone. */
function formatTime(iso: string) {
  const tz = app.profile!.timezone;
  return `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso))} (${tz})`;
}

const totalsOf = (s: AttendanceSession) =>
  attendanceTotals({ start: s.clockInAt, end: s.clockOutAt }, s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt })));

function render() {
  if (!app.profile) return;
  $("#identity-name").textContent = app.profile.fullName;
  $("#identity-code").textContent = app.profile.employeeCode;
  $("#identity-email").textContent = app.profile.email;
  $("#mode-badge").hidden = app.online;
  $("#mode-badge").textContent = "Offline mode";

  const status = app.device?.status;
  $("#device-register").hidden = !(app.online && status === "NOT_REGISTERED" && !app.device?.otherActiveDevice);
  const blocked = !app.device
    ? "Connect to the internet once to set up this device."
    : status === "REVOKED"
      ? `This device was revoked by an administrator. Attendance can't be recorded from it.${
          pendingCount() ? ` ${pendingCount()} unsynced event(s) from this device can't be uploaded; request a correction for those times.` : ""
        }`
      : status === "NOT_REGISTERED" && app.device.otherActiveDevice
        ? "Another device is already registered for your account. Ask an administrator to revoke it, then check again."
        : status === "NOT_REGISTERED" && !app.online
          ? "Connect to the internet to register this device."
          : null;
  $("#device-blocked").hidden = !blocked;
  $("#device-blocked-text").textContent = blocked ?? "";
  $("#attendance").hidden = status !== "ACTIVE";
  $("#sync").hidden = status !== "ACTIVE";

  const pending = app.queued.filter((e) => (e.status ?? "PENDING") === "PENDING");
  const skewMin = Math.round(Math.abs(app.clockOffsetMs) / 60_000);
  $("#clock-warning").hidden = skewMin < 2;
  $("#clock-warning").textContent = `This computer's clock is about ${skewMin} min ${app.clockOffsetMs > 0 ? "behind" : "ahead of"} the server. Recorded times are corrected by the server.`;
  $("#queue-recovered").hidden = !app.queueRecovered;
  $("#queue-recovered-text").textContent =
    `The local attendance queue was damaged and has been set aside (${app.queueRecovered}). Events in it were not uploaded; request corrections for any missing times.`;
  renderAttendance();
  renderSync(pending, app.queued.filter((e) => e.status === "REJECTED"));
  activity.update(); // monitoring follows attendance immediately (e.g. a break pauses it)
  screenshots.update();
  $("#logout-warning").hidden = !pending.length;
  $("#logout-warning").textContent = `${pending.length} unsynced event(s) stay on this device and upload when you next sign in here.`;
}

function renderAttendance() {
  const p = project(app.current, app.queued);
  $("#att-state").textContent = p ? STATE_LABEL[p.state] : "Unknown";
  $("#att-state").dataset.state = p?.state ?? "UNKNOWN";
  const active = p?.session && p.state !== "CLOCKED_OUT" ? p.session : null;
  const t = active && totalsOf(active);
  $("#att-clock-in").textContent = active ? formatTime(active.clockInAt) : "—";
  $("#att-elapsed").textContent = t ? formatDuration(t.elapsedMs) : "—";
  $("#att-breaks").textContent = t ? `${formatDuration(t.breakMs)}${p!.state === "ON_BREAK" ? " (on break now)" : ""}` : "—";
  $("#att-net").textContent = t ? formatDuration(t.netMs) : "—";

  const last = p?.state === "CLOCKED_OUT" && p.session?.clockOutAt ? p.session : null;
  const hint = !p
    ? "Status unknown until this device reaches the server once."
    : p.unsynced
      ? `Includes ${p.unsynced} change(s) not yet synced. Times use this device's clock until the server confirms them.`
      : last
        ? `Last shift: ${formatTime(last.clockInAt)} to ${formatTime(last.clockOutAt!)}, worked ${formatDuration(totalsOf(last).netMs)}.`
        : null;
  $("#att-preview").hidden = !hint;
  $("#att-preview").textContent = hint ?? "";

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) {
    button.disabled = !p || !transition(p.state, button.dataset.action as AttendanceEventType);
  }
}

function renderSync(pending: QueuedEvent[], rejected: QueuedEvent[]) {
  const s = app.engine?.status;
  const failed = rejected.length > 0 || s?.phase === "error" || s?.phase === "blocked";
  const [label, tone] = failed
    ? ["Sync failed", "bad"]
    : pending.length
      ? s?.phase === "syncing"
        ? ["Syncing…", "warn"]
        : ["Pending offline", "warn"]
      : ["Synced", "good"];
  $("#sync-state").textContent = label;
  $("#sync-state").dataset.tone = tone;
  $("#sync-pending").textContent = String(pending.length);
  $("#sync-last").textContent = s?.lastSyncAt ? formatTime(s.lastSyncAt) : "Never";

  const retryIn = s?.retryAt ? Math.max(0, Math.ceil((s.retryAt - Date.now()) / 1000)) : 0;
  const detail =
    s?.phase === "offline"
      ? `Server unreachable. Retrying in ${retryIn}s.`
      : s?.phase === "error"
        ? `Server error: ${s.error}. Retrying in ${retryIn}s.`
        : s?.phase === "blocked"
          ? (s.error ?? "Sync is blocked.")
          : null;
  $("#sync-detail").hidden = !detail;
  $("#sync-detail").textContent = detail ?? "";

  $("#sync-rejected").hidden = !rejected.length;
  $("#sync-rejected-list").replaceChildren(
    ...rejected.map((e) => {
      const li = document.createElement("li");
      li.textContent = `${STATE_ACTION[e.type]} at ${formatTime(e.occurredAt)}: ${e.reason ?? "rejected"}`;
      return li;
    }),
  );
}

const STATE_ACTION = { CLOCK_IN: "Clock in", BREAK_START: "Break start", BREAK_END: "Break end", CLOCK_OUT: "Clock out" } as const;

// ---- Actions ------------------------------------------------------------------

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) {
  button.addEventListener("click", async () => {
    const type = button.dataset.action as AttendanceEventType;
    const p = project(app.current, app.queued);
    if (!app.queue || !app.engine || !p || !transition(p.state, type)) return;
    // Durable queue first; the upload happens afterwards (now, or when back online).
    await app.queue.add({
      id: crypto.randomUUID(),
      userId: app.profile!.userId,
      deviceId: app.device!.device!.id,
      type,
      occurredAt: new Date().toISOString(),
      status: "PENDING",
    });
    await reloadQueue();
    void app.engine.kick().then(reloadQueue);
  });
}

$<HTMLFormElement>("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement; // currentTarget is null after the first await
  const data = new FormData(form);
  $<HTMLButtonElement>("#login-submit").disabled = true;
  loginError(null);
  try {
    await client.login(String(data.get("email")), String(data.get("password")));
    form.reset();
    await enter(profileOf(await client.request<MeResponse>("GET", "/auth/me")), true);
  } catch (err) {
    loginError(
      err instanceof HttpError
        ? err.status === 429
          ? "Too many attempts. Wait a few minutes and try again."
          : err.status === 401
            ? "Invalid email or password."
            : err.message
        : "Can't reach the server. Check your connection.",
    );
  } finally {
    $<HTMLButtonElement>("#login-submit").disabled = false;
  }
});

$<HTMLFormElement>("#device-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = String(new FormData(e.currentTarget as HTMLFormElement).get("deviceName"));
  $<HTMLButtonElement>("#device-submit").disabled = true;
  $("#device-error").hidden = true;
  try {
    await client.request("POST", "/devices/register", { installationId: app.installationId, deviceName: name, platform: app.platform });
    await loadDevice();
    await loadCurrent();
    await startSync();
  } catch (err) {
    $("#device-error").hidden = false;
    $("#device-error").textContent = err instanceof HttpError ? err.message : "Can't reach the server. Check your connection.";
  } finally {
    $<HTMLButtonElement>("#device-submit").disabled = false;
    render();
  }
});

$("#device-recheck").addEventListener("click", async () => {
  if (!app.online) return onReconnect();
  await loadDevice().catch(() => undefined);
  await startSync();
});

$("#sync-now").addEventListener("click", () => void onReconnect());
$("#sync-dismiss").addEventListener("click", async () => {
  await app.queue?.dismiss();
  await reloadQueue();
});
$("#logout").addEventListener("click", () => void signOut(true));
$("#queue-recovered-dismiss").addEventListener("click", async () => {
  await kvSet("queue_recovered", null);
  app.queueRecovered = null;
  render();
});

// ---- Connection status ----------------------------------------------------------

async function checkApi() {
  const up = await fetch(`${API_URL}${API_PREFIX}/health`, { cache: "no-store" }).then((r) => r.ok, () => false);
  $("#api-dot").className = `dot ${up ? "online" : "offline"}`;
  $("#api-label").textContent = up ? "Online" : "Offline — server unreachable";
  if (up && !app.apiUp) void onReconnect();
  app.apiUp = up;
}

async function showAppInfo() {
  if (IN_TAURI) {
    const info = await invoke<{ version: string; trackingEnabled: boolean; platform: string }>("app_info");
    $("#version").textContent = `v${info.version}`;
    if (info.platform === "macos" || info.platform === "windows") app.platform = info.platform;
  } else {
    app.platform = navigator.userAgent.includes("Windows") ? "windows" : "macos";
  }
  $<HTMLInputElement>("#device-form input[name=deviceName]").value = app.platform === "macos" ? "My Mac" : "My PC";
}

window.addEventListener("online", () => void checkApi());
setInterval(checkApi, POLL_MS);
setInterval(render, 1000); // live durations and retry countdown
showAppInfo().catch((err) => console.error("app_info failed", err));
void checkApi().then(boot);

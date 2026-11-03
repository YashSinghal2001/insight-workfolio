// Insight Workfolio website time. Records the DOMAIN of the active tab in the focused normal browser
// window, only while the server says collection is allowed (policy on, notice acknowledged, clocked in,
// not on a break) and the computer is not idle. Never paths, queries, titles, page content or history;
// the extension does not run in incognito windows ("incognito": "not_allowed").
import { BATCH_MAX, hostOf, trimQueue, Tracker, uploadError } from "./tracker.js";

let idleSeconds = 300; // replaced by the organization's idle threshold from the server
let tracker = new Tracker();
let allowed = false;
let busy = false;

const get = (keys) => chrome.storage.local.get(keys);
const set = (items) => chrome.storage.local.set(items);

async function badge() {
  const { token } = await get("token");
  await chrome.action.setBadgeText({ text: !token ? "" : allowed ? "ON" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: allowed ? "#15803d" : "#6b7280" });
  await chrome.action.setTitle({ title: !token ? "Insight Workfolio: not connected" : allowed ? "Insight Workfolio: recording website domain names" : "Insight Workfolio: not recording" });
}

/** `{ status, body }` (body null unless 2xx), or null when not connected or disconnected on the server (401). */
async function api(path, init = {}) {
  const { token, apiBase } = await get(["token", "apiBase"]);
  if (!token) return null;
  const res = await fetch(`${apiBase}/api/v1/websites/extension/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  if (res.status === 401) {
    await chrome.storage.local.remove(["token", "employee"]); // disconnected on the server
    allowed = false;
    return null;
  }
  return { status: res.status, body: res.ok ? await res.json() : null };
}

/** What is eligible right now: the host of the active tab in a focused, normal, non-incognito window. */
async function host() {
  if (!allowed || (await chrome.idle.queryState(idleSeconds)) !== "active") return null;
  const win = await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
  if (!win || !win.focused || win.state === "minimized" || win.incognito || win.type !== "normal") return null;
  const tab = win.tabs?.find((t) => t.active);
  return tab && !tab.incognito ? hostOf(tab.url) : null;
}

async function observe() {
  const done = tracker.observe(await host(), Date.now());
  await chrome.storage.session.set({ current: tracker.current });
  if (done.length) {
    const { queue = [] } = await get("queue");
    await set({ queue: trimQueue([...queue, ...done], Date.now()) });
  }
}

async function refreshState() {
  const state = (await api("state"))?.body;
  allowed = !!state?.collect;
  await set({ lastState: state ? { collect: state.collect, reasons: state.reasons, at: new Date().toISOString() } : null });
  if (state?.intervalMaxSeconds) tracker.maxMs = Math.min(300, state.intervalMaxSeconds) * 1000;
  if (state?.idleSeconds && state.idleSeconds !== idleSeconds) {
    idleSeconds = state.idleSeconds;
    chrome.idle.setDetectionInterval(idleSeconds);
  }
  await badge();
}

async function upload() {
  const { queue = [] } = await get("queue");
  if (!queue.length) return;
  const batch = queue.slice(0, BATCH_MAX);
  const r = await api("intervals", { method: "POST", body: JSON.stringify({ sentAt: new Date().toISOString(), intervals: batch }) }).catch(() => null);
  if (!r) return; // offline or disconnected: kept (and trimmed) for the next try
  if (!r.body) {
    // Refused (4xx) or server error: kept for the next try; a refusal is shown in the popup.
    if (r.status >= 400 && r.status < 500) await set({ lastUpload: { at: new Date().toISOString(), error: uploadError(r.status) } });
    return;
  }
  const sent = new Set(batch.map((i) => i.id)); // accepted, duplicates and rejections are all final
  const { queue: now = [] } = await get("queue");
  await set({ queue: now.filter((i) => !sent.has(i.id)), lastUpload: { at: new Date().toISOString(), results: r.body.results.length } });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await refreshState();
    await observe();
    await upload();
  } finally {
    busy = false;
  }
}

chrome.idle.setDetectionInterval(idleSeconds);
chrome.alarms.create("tick", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void tick());
chrome.tabs.onActivated.addListener(() => void observe());
chrome.tabs.onUpdated.addListener((_id, change, tab) => tab.active && change.url && void observe());
chrome.windows.onFocusChanged.addListener(() => void observe());
chrome.windows.onBoundsChanged.addListener(() => void observe()); // e.g. minimized: no longer in front
// Between events, look again every few seconds while the worker is awake (alarms are 30 s at best).
setInterval(() => void observe(), 5000);
chrome.idle.onStateChanged.addListener(() => void observe());
chrome.runtime.onStartup.addListener(() => void tick());
chrome.runtime.onInstalled.addListener(() => void tick());
// The popup asks for "send now" and "refresh"; nothing else is accepted.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== "tick") return false;
  tick().then(() => reply({ ok: true }), (err) => reply({ ok: false, error: String(err) }));
  return true;
});
chrome.storage.session.get("current").then(({ current }) => (tracker = new Tracker({ current: current ?? null })));
void tick();

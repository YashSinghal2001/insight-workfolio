// Pure logic (no browser APIs), unit-tested in tracker.test.mjs.

/** The domain of a web page address, or null: only http(s) pages count, and only the host leaves this function. */
export function hostOf(url) {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Turns "this host is in front now" observations into intervals: a change of host (or null: nothing
 * eligible in front) ends the current one; one host for longer than maxMs is split. Intervals under
 * 1 s are dropped. If nothing was observed for longer than gapMs (the computer slept, or the browser
 * was not running), the interval ends at the last observation: that time is never counted.
 */
export class Tracker {
  constructor({ maxMs = 300_000, gapMs = 90_000, newId = () => crypto.randomUUID(), current = null } = {}) {
    this.maxMs = maxMs;
    this.gapMs = gapMs;
    this.newId = newId;
    this.current = current; // { host, start, seen } | null
  }

  observe(host, now) {
    const out = [];
    const close = (end) => {
      if (end - this.current.start >= 1000) out.push({ id: this.newId(), domain: this.current.host, startedAt: new Date(this.current.start).toISOString(), endedAt: new Date(end).toISOString() });
    };
    if (this.current && now - (this.current.seen ?? this.current.start) > this.gapMs) {
      close(Math.min(this.current.seen ?? this.current.start, this.current.start + this.maxMs));
      this.current = null;
    }
    if (this.current && (this.current.host !== host || now - this.current.start >= this.maxMs)) {
      const end = Math.min(now, this.current.start + this.maxMs);
      close(end);
      this.current = this.current.host === host && host ? { host, start: end, seen: now } : null;
    }
    if (!this.current && host) this.current = { host, start: now, seen: now };
    else if (this.current) this.current.seen = now;
    return out;
  }
}

/** Keeps the upload queue bounded: at most `max` items, none older than `maxAgeMs` (the server refuses those anyway). */
export const trimQueue = (queue, now, max = 500, maxAgeMs = 23 * 3_600_000) => queue.filter((i) => now - Date.parse(i.endedAt) < maxAgeMs).slice(-max);

/** Intervals per upload: the server's WEBSITE_BATCH_MAX (checked by apps/api/test/extension-contract.e2e.test.ts). */
export const BATCH_MAX = 100;

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/**
 * The server address typed into the popup, normalized (no trailing slash), or throws with a message
 * for the popup. Same rule as the desktop app in development (apps/desktop/src/api-url.ts): https
 * anywhere, plain http only to this computer; no user name, password, query or fragment.
 */
export function apiBaseOf(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The server address is not a valid URL (e.g. https://workfolio.example.com).");
  }
  if (url.username || url.password) throw new Error("The server address must not contain a user name or password.");
  if (url.search || url.hash || /[?#]/.test(value)) throw new Error("The server address must not contain '?' or '#'.");
  if (url.protocol === "http:" ? !LOOPBACK.has(url.hostname) : url.protocol !== "https:") {
    throw new Error("The server address must start with https:// (plain http:// only for this computer, e.g. http://localhost:4000).");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * The one host permission the popup requests at Connect: exactly the API's origin (scheme, host,
 * port), never a wildcard. `apiBase` must come from apiBaseOf. Must stay inside the manifest's
 * optional_host_permissions (https://*\/*, http://localhost/*, http://127.0.0.1/*).
 */
export const originPatternOf = (apiBase) => `${new URL(apiBase).origin}/*`;

/** What the popup shows when the server refuses an upload (4xx other than 401). Never URLs or domains. */
export const uploadError = (status) =>
  status === 429
    ? "The server asked to slow down (HTTP 429). Waiting intervals will be sent later."
    : `The server refused the upload (HTTP ${status}). Intervals are kept and retried; if this continues, contact your administrator.`;

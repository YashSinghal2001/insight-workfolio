import { API_PREFIX, type ApiError } from "@workfolio/shared";
import { API_URL } from "./config";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;
let sessionEnded: (() => void) | null = null;

/**
 * Registers the callback run when an authenticated request still gets 401 after the refresh attempt
 * (the session is over: expired, revoked or signed out in another tab). The auth provider uses it to
 * go anonymous so the layouts redirect to /login. Pass null to unregister.
 */
export function onSessionEnded(fn: (() => void) | null) {
  sessionEnded = fn;
}

const rotate = () =>
  fetch(`${API_URL}${API_PREFIX}/auth/refresh`, { method: "POST", credentials: "include" }).then((r) => r.ok, () => false);

/**
 * One refresh at a time per tab (concurrent 401s share it) and across tabs: the Web Locks API
 * queues other tabs, which then rotate with the already-renewed cookie instead of replaying the
 * old one (a replay looks like token theft and ends the session).
 */
function refreshSession(): Promise<boolean> {
  refreshing ??= (typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("workfolio-refresh", rotate)
    : rotate()
  ).finally(() => (refreshing = null));
  return refreshing;
}

/** Sends with the HttpOnly session cookies; an expired access token is refreshed once, transparently. */
async function request(path: string, method: string, body: unknown): Promise<Response> {
  const send = () =>
    fetch(`${API_URL}${API_PREFIX}${path}`, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let res = await send();
  const retriable = !path.startsWith("/auth/") || path === "/auth/me";
  if (res.status === 401 && retriable) {
    if (await refreshSession()) res = await send();
    if (res.status === 401) sessionEnded?.();
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    const message = Array.isArray(err?.message) ? err.message.join("\n") : (err?.message ?? res.statusText);
    throw new ApiRequestError(res.status, message || "Request failed");
  }
  return res;
}

/** Calls the API with the HttpOnly session cookies. Tokens are never visible to this code. */
export async function api<T>(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await request(path, method, body);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/**
 * Binary download (screenshots) through the authenticated API. Only the expected media type is
 * accepted; the caller turns it into a short-lived object URL and revokes it when done, so no
 * image URL is shareable or cached by the browser.
 */
export async function apiBlob(path: string, expectedType: string): Promise<Blob> {
  const res = await request(path, "GET", undefined);
  if (res.headers.get("content-type") !== expectedType) throw new ApiRequestError(502, "Unexpected response type");
  return res.blob();
}

/** Raw authenticated response (file downloads such as the timesheet export): same refresh and errors as api(). */
export const apiResponse = (path: string) => request(path, "GET", undefined);

export const errorMessage = (err: unknown) =>
  err instanceof ApiRequestError ? err.message : "Could not reach the API. Check your connection and try again.";

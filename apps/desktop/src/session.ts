// Auth transport and session restoration. No Tauri imports, so node tests can drive it.
import { API_PREFIX, type DesktopLoginResponse, type MeResponse } from "@workfolio/shared";

/** Refresh-token storage: the OS credential store in the app. */
export interface TokenStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** True for "server unreachable" (fetch threw), as opposed to an HTTP error response. */
export const isNetworkError = (err: unknown) => !(err instanceof HttpError);

export class ApiClient {
  /** Memory only; never persisted. */
  private accessToken: string | null = null;

  private readonly baseUrl: string;
  private readonly tokens: TokenStore;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string, tokens: TokenStore, fetchFn: typeof fetch = (...a) => fetch(...a)) {
    this.baseUrl = baseUrl;
    this.tokens = tokens;
    this.fetchFn = fetchFn;
  }

  /** JSON bodies by default; binary bodies (screenshots) are sent as-is with the caller's content-type. */
  private async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const binary = body instanceof ArrayBuffer || body instanceof Uint8Array;
    const res = await this.fetchFn(`${this.baseUrl}${API_PREFIX}${path}`, {
      method,
      headers: {
        ...(body !== undefined && !binary && { "content-type": "application/json" }),
        ...headers,
        ...(this.accessToken && { authorization: `Bearer ${this.accessToken}` }),
      },
      body: body === undefined ? undefined : binary ? (body as BodyInit) : JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = await res.json().then((b: { message?: unknown }) => b.message, () => undefined);
      throw new HttpError(res.status, Array.isArray(msg) ? msg.join("; ") : typeof msg === "string" ? msg : `HTTP ${res.status}`);
    }
    return res.status === 204 ? undefined : res.json();
  }

  async login(email: string, password: string): Promise<DesktopLoginResponse> {
    const session = (await this.send("POST", "/auth/login", { email, password, client: "desktop" })) as DesktopLoginResponse;
    this.accessToken = session.accessToken;
    await this.tokens.save(session.refreshToken);
    return session;
  }

  private refreshing: Promise<boolean> | null = null;

  /**
   * Rotates the stored refresh token. false = session gone (401, token cleared). Throws when offline.
   * Concurrent callers share one request: presenting the same token twice looks like token theft
   * to the server and revokes the session.
   */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.rotate().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async rotate(): Promise<boolean> {
    const refreshToken = await this.tokens.load();
    if (!refreshToken) return false;
    try {
      const session = (await this.send("POST", "/auth/refresh", { refreshToken })) as DesktopLoginResponse;
      this.accessToken = session.accessToken;
      await this.tokens.save(session.refreshToken);
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        this.accessToken = null;
        await this.tokens.clear();
        return false;
      }
      throw err;
    }
  }

  /** Authenticated call; on 401 refreshes once and retries. */
  async request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    try {
      return (await this.send(method, path, body, headers)) as T;
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 401) || !(await this.refresh())) throw err;
      return (await this.send(method, path, body, headers)) as T;
    }
  }

  /** Server-side revocation is best effort; local credentials are always forgotten. */
  async logout(): Promise<void> {
    const refreshToken = await this.tokens.load();
    if (refreshToken) await this.send("POST", "/auth/logout", { refreshToken }).catch(() => undefined);
    this.accessToken = null;
    await this.tokens.clear();
  }
}

/** Non-secret identity cached locally so the app can start offline. */
export interface CachedProfile {
  userId: string;
  fullName: string;
  employeeCode: string;
  email: string;
  timezone: string;
}

export function profileOf(me: MeResponse): CachedProfile {
  return {
    userId: me.user.id,
    fullName: me.employee?.fullName ?? me.user.email,
    employeeCode: me.employee?.employeeCode ?? "—",
    email: me.user.email,
    timezone: me.employee?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export type Restored =
  | { kind: "online"; profile: CachedProfile; me: MeResponse }
  /** Server unreachable but a session token and cached identity exist: work offline. */
  | { kind: "offline"; profile: CachedProfile }
  | { kind: "signed-out"; offline: boolean };

/**
 * App start: rotate the stored refresh token. Revoked/expired sessions sign out (token cleared);
 * an unreachable server keeps the token and falls back to the cached profile.
 */
export async function restoreSession(client: ApiClient, tokens: TokenStore, cachedProfile: CachedProfile | null): Promise<Restored> {
  if (!(await tokens.load())) return { kind: "signed-out", offline: false };
  try {
    if (!(await client.refresh())) return { kind: "signed-out", offline: false };
    const me = await client.request<MeResponse>("GET", "/auth/me");
    return { kind: "online", profile: profileOf(me), me };
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    return cachedProfile ? { kind: "offline", profile: cachedProfile } : { kind: "signed-out", offline: true };
  }
}

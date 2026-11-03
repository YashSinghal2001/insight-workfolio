"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { MeResponse } from "@workfolio/shared";
import { api, ApiRequestError, onSessionEnded } from "@/lib/api";

type Auth =
  | { status: "loading" }
  /** expired: the session ended while signed in (layouts redirect to /login?expired=1). */
  | { status: "anonymous"; expired?: boolean }
  | { status: "error"; message: string }
  | { status: "authenticated"; me: MeResponse };

const AuthContext = createContext<{ auth: Auth; reload: () => Promise<void>; logout: () => Promise<void> } | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth>({ status: "loading" });
  const signingOut = useRef(false);

  const reload = useCallback(async () => {
    try {
      setAuth({ status: "authenticated", me: await api<MeResponse>("/auth/me") });
    } catch (err) {
      // Keep an "expired" anonymous state set by the session-ended callback during this request.
      setAuth((a) =>
        err instanceof ApiRequestError && err.status === 401
          ? a.status === "anonymous" ? a : { status: "anonymous" }
          : { status: "error", message: "Could not reach the API." },
      );
    }
  }, []);

  const logout = useCallback(async () => {
    signingOut.current = true; // in-flight 401s during a deliberate sign-out are not an "expired" session
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setAuth({ status: "anonymous" });
    signingOut.current = false;
  }, []);

  useEffect(() => {
    // Only a session that was signed in can "end"; anonymous probes (e.g. /login) are ignored.
    onSessionEnded(() => {
      if (!signingOut.current) setAuth((a) => (a.status === "authenticated" ? { status: "anonymous", expired: true } : a));
    });
    return () => onSessionEnded(null);
  }, []);

  useEffect(() => {
    // Initial session probe.
    reload();
  }, [reload]);

  return <AuthContext value={{ auth, reload, logout }}>{children}</AuthContext>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

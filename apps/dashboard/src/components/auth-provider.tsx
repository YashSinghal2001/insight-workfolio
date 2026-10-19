"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { MeResponse } from "@workfolio/shared";
import { api, ApiRequestError } from "@/lib/api";

type Auth =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "error"; message: string }
  | { status: "authenticated"; me: MeResponse };

const AuthContext = createContext<{ auth: Auth; reload: () => Promise<void>; logout: () => Promise<void> } | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setAuth({ status: "authenticated", me: await api<MeResponse>("/auth/me") });
    } catch (err) {
      setAuth(
        err instanceof ApiRequestError && err.status === 401
          ? { status: "anonymous" }
          : { status: "error", message: "Could not reach the API." },
      );
    }
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setAuth({ status: "anonymous" });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial session probe
    reload();
  }, [reload]);

  return <AuthContext value={{ auth, reload, logout }}>{children}</AuthContext>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

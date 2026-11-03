"use client";

import { useCallback, useEffect, useState } from "react";
import { API_PREFIX, type ReadinessResponse } from "@workfolio/shared";
import { API_URL } from "@/lib/config";

type State = "checking" | "ready" | "degraded" | "offline";

const STYLES: Record<State, { dot: string; label: string }> = {
  checking: { dot: "bg-gray-400 animate-pulse", label: "Checking API…" },
  ready: { dot: "bg-emerald-500", label: "API connected" },
  degraded: { dot: "bg-amber-500", label: "API up, dependencies not ready" },
  offline: { dot: "bg-red-500", label: "API unreachable" },
};

const POLL_MS = 15_000;

async function probe(): Promise<State> {
  try {
    const health = await fetch(`${API_URL}${API_PREFIX}/health`, { cache: "no-store" });
    if (!health.ok) return "offline";
    const ready = await fetch(`${API_URL}${API_PREFIX}/ready`, { cache: "no-store" });
    const body = (await ready.json()) as ReadinessResponse;
    return ready.ok && body.status === "ready" ? "ready" : "degraded";
  } catch {
    return "offline";
  }
}

export function ApiStatus() {
  const [state, setState] = useState<State>("checking");

  const check = useCallback(async () => setState(await probe()), []);

  useEffect(() => {
    let active = true;
    const run = () => probe().then((s) => active && setState(s));
    run();
    const id = setInterval(run, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const { dot, label } = STYLES[state];
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden />
      <span className="sr-only sm:not-sr-only">{label}</span>
      {(state === "offline" || state === "degraded") && (
        <button
          type="button"
          onClick={() => {
            setState("checking");
            check();
          }}
          className="rounded border border-border px-2 py-0.5 text-xs hover:bg-background"
        >
          Retry
        </button>
      )}
    </div>
  );
}

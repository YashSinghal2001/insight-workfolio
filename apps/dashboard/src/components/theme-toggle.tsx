"use client";

import { useSyncExternalStore } from "react";
import { resolveTheme, writeTheme, type Theme } from "@/lib/theme";

// The applied theme is <html data-theme> (set before first paint by THEME_SCRIPT); the toggle notifies listeners.
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
const applied = (): Theme => resolveTheme(document.documentElement.dataset.theme);

function storage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Light/Dark switch for the top bar; the choice is remembered per browser ("iw-theme"). */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, applied, () => "light" as Theme);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    writeTheme(storage(), next);
    listeners.forEach((fn) => fn());
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={theme === "dark"}
      aria-label="Dark theme"
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      data-testid="theme-toggle"
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-muted hover:text-foreground"
    >
      <span aria-hidden>{theme === "dark" ? "☾" : "☀"}</span>
      <span aria-hidden>{theme === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}

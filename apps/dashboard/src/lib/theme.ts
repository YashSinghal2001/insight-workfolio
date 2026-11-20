/** Explicit per-browser theme choice. Light is the default; dark only when chosen. */
export type Theme = "light" | "dark";

export const THEME_KEY = "iw-theme";

export function resolveTheme(stored: unknown): Theme {
  return stored === "dark" ? "dark" : "light";
}

/** Stored choice, or light when storage is unavailable (private mode, blocked site data). */
export function readTheme(storage: Pick<Storage, "getItem"> | undefined): Theme {
  try {
    return resolveTheme(storage?.getItem(THEME_KEY));
  } catch {
    return "light";
  }
}

/** Remembers the choice; returns false when storage refuses (the theme still applies for this page). */
export function writeTheme(storage: Pick<Storage, "setItem"> | undefined, theme: Theme): boolean {
  try {
    storage?.setItem(THEME_KEY, theme);
    return !!storage;
  } catch {
    return false;
  }
}

/**
 * Runs in <head> before first paint so a stored dark choice never flashes light. Inline is fine: the app sets
 * no CSP script-src (next.config.ts only sends frame-ancestors). Mirrors readTheme.
 */
export const THEME_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;

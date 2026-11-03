// Settings tab: app preferences stored and applied by the native shell (prefs_get / prefs_set).
import { invoke } from "@tauri-apps/api/core";

export interface Prefs {
  showSeconds: boolean;
  hideDockIcon: boolean;
  launchAtLogin: boolean;
}

const KEYS = ["showSeconds", "hideDockIcon", "launchAtLogin"] as const;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const box = (key: keyof Prefs) => $<HTMLInputElement>(`#pref-${key}`);

function message(sel: string, text: string | null) {
  $(sel).hidden = !text;
  $(sel).textContent = text ?? "";
}

export function initPrefs(inTauri: boolean) {
  const render = (p: Prefs) => KEYS.forEach((k) => (box(k).checked = !!p[k]));
  const disableAll = () => KEYS.forEach((k) => (box(k).disabled = true));

  if (!inTauri) {
    disableAll();
    return message("#prefs-status", "These settings are available in the desktop app only.");
  }
  invoke<Prefs>("prefs_get").then(render, (err) => {
    disableAll();
    message("#prefs-error", `Settings could not be loaded: ${err}`);
  });

  for (const key of KEYS) {
    box(key).addEventListener("change", async () => {
      const el = box(key);
      el.disabled = true;
      message("#prefs-error", null);
      try {
        render(await invoke<Prefs>("prefs_set", { [key]: el.checked }));
      } catch (err) {
        el.checked = !el.checked; // the setting did not change
        message("#prefs-error", `Could not change this setting: ${err}`);
      } finally {
        el.disabled = false;
      }
    });
  }
}
